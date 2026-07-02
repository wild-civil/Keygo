/********************************** (C) COPYRIGHT *******************************
 * File Name          : keygo_core.c
 * Author             : KeyGo v3.5 (CH582M)
 * Date               : 2026/06/30
 * Description        : GPIO + Kalman + RSSI + 状态机 + JSON 通知 + 命令解析
 *********************************************************************************/

#include "keygo_core.h"
#include "gattprofile.h"
#include <stdlib.h>   /* atoi */
#include "CH58x_common.h"  /* EEPROM_READ / EEPROM_WRITE / EEPROM_ERASE */

/* ─────────────────────────────────────────────────────────────────
 * 宏定义 (模块内部)
 * ───────────────────────────────────────────────────────────────── */

#define SPIKE_DISCARD_COUNT     2
// ★ v3.6-fixH: 从 3000ms → 8000ms，匹配 App 端 8s 冷却
// ★ v3.7: MANUAL_COOLDOWN_MS 从宏改为 uint16_t 变量 g_manualCooldownMs，
//         可在运行时通过 App 下发 "cooldown_ms=N" 修改，并持久化到 DataFlash
//         bug: 固件冷却 3s 到期后状态机恢复运行，仅 ~5.5s 后即可自动覆盖手动操作，
//               用户看到 App 显示"冷却 8s"但实际只有 3s 有效
#define STATUS_JSON_MAX_LEN     200  // ★ 加了 cd 字段，json 更长，从 180 扩到 200

/* ─────────────────────────────────────────────────────────────────
 * ★ v3.5: 可运行时配置的 RSSI 阈值 (替代原来的 #define 硬编码)
 *    由 App 通过 FF01 下发 "unlock=-30 lock=-45 uc=2..." 更新
 *    默认值与 App 端 store 初始值保持一致
 * ───────────────────────────────────────────────────────────────── */
int16_t  g_cfgUnlockThreshold   = -45;   // RSSI 解锁阈值
int16_t  g_cfgLockThreshold     = -65;   // RSSI 锁车阈值
uint8_t  g_cfgUnlockCount       = 3;     // 解锁需连续满足次数
uint8_t  g_cfgLockCount         = 5;     // 锁车需连续满足次数
uint16_t g_cfgDisconnectLockMs  = 5000;  // 断连自动锁车延时 ms
// ★ v3.7: 可运行时配置的 RSSI 冷却时间 (替代 #define MANUAL_COOLDOWN_MS)
uint16_t g_cfgManualCooldownMs  = 8000;  // 手动命令冷却时间 ms (范围 2000~30000)
// ★ v3.13: 固件 RSSI 读取周期 + 卡尔曼响应速度
uint16_t g_cfgRssiPeriodMs      = 500;   // GAP RSSI 读取间隔 ms (范围 100~2000, 默认 500)
uint8_t  g_cfgKalmanR           = 25;    // 卡尔曼滤波器 R 值 (范围 1~50, 默认 25)

/* ─────────────────────────────────────────────────────────────────
 * 模块内部状态 (仅 keygo_core 可见)
 * ───────────────────────────────────────────────────────────────── */

// Kalman
static KalmanFilter1D_t g_kalman    = {1.0f, 25.0f, 1.0f, 0.0f, -80.0f, 0};

// RSSI
static int16_t  g_latestRSSI        = -999;
static float    g_filteredRSSI      = -999.0f;
static int16_t  g_rssiBuffer[8]     = {0};
static uint8_t  g_rssiBufIdx        = 0;
static uint8_t  g_spikeConsecutive  = 0;
static int16_t  g_lastRawRSSI       = -999;
static uint8_t  g_rssiUpdated       = 0;    // ★ 新 Kalman 样本标记

// 状态机
static uint8_t  g_unlockCounter     = 0;
static uint8_t  g_lockCounter       = 0;
static uint8_t  g_actionActive      = 0;
static uint16_t g_pulsePinMask      = 0;     // 当前脉冲的引脚掩码
static uint8_t  g_manualCooldown    = 0;
static uint32_t g_lastCommandMs     = 0;

// 命令处理
static char     g_customName[21]    = {0};

/* ─────────────────────────────────────────────────────────────────
 * 前向声明
 * ───────────────────────────────────────────────────────────────── */
static void InitKalmanFilter(void);
static float UpdateKalman(float measurement);

/* ─────────────────────────────────────────────────────────────────
 * 工具函数
 * ───────────────────────────────────────────────────────────────── */

uint32_t Peripheral_GetSystemMs(void)
{
    return TMOS_GetSystemClock() * 5 / 8;
}

/* ─────────────────────────────────────────────────────────────────
 * GPIO 控制
 * ───────────────────────────────────────────────────────────────── */

void KeyGo_GPIO_Init(void)
{
    GPIOA_ModeCfg(PIN_UNLOCK_GPIO, GPIO_ModeOut_PP_5mA);
    GPIOA_ModeCfg(PIN_LOCK_GPIO, GPIO_ModeOut_PP_5mA);
    GPIOA_ModeCfg(PIN_TRUNK_GPIO, GPIO_ModeOut_PP_5mA);
    GPIOA_ModeCfg(PIN_KEYPOWER_GPIO, GPIO_ModeOut_PP_5mA);

    GPIOA_ResetBits(PIN_UNLOCK_GPIO);
    GPIOA_ResetBits(PIN_LOCK_GPIO);
    GPIOA_ResetBits(PIN_TRUNK_GPIO);
    GPIOA_ResetBits(PIN_KEYPOWER_GPIO);

    KeyGo_KeyPower(1);
    PRINT("[GPIO] Initialized (PA4=UNLOCK, PA5=LOCK, PA6=TRUNK, PA7=KEY_POWER)\n");
}

void KeyGo_Unlock(void)
{
    if (g_actionActive) return;    // 已有脉冲进行中，跳过
    g_actionActive  = 1;
    g_pulsePinMask  = PIN_UNLOCK_GPIO;
    PRINT("[KEY] unlock\n");
    GPIOA_SetBits(PIN_UNLOCK_GPIO);
    tmos_start_task(Peripheral_TaskID, SBP_GPIO_PULSE_END_EVT, GPIO_PULSE_LOCK_TICKS);
}

void KeyGo_Lock(void)
{
    if (g_actionActive) return;
    g_actionActive  = 1;
    g_pulsePinMask  = PIN_LOCK_GPIO;
    PRINT("[KEY] lock\n");
    GPIOA_SetBits(PIN_LOCK_GPIO);
    tmos_start_task(Peripheral_TaskID, SBP_GPIO_PULSE_END_EVT, GPIO_PULSE_LOCK_TICKS);
}

void KeyGo_Trunk(void)
{
    if (g_actionActive) return;
    g_actionActive  = 1;
    g_pulsePinMask  = PIN_TRUNK_GPIO;
    PRINT("[KEY] trunk\n");
    GPIOA_SetBits(PIN_TRUNK_GPIO);
    tmos_start_task(Peripheral_TaskID, SBP_GPIO_PULSE_END_EVT, GPIO_PULSE_TRUNK_TICKS);
}

/*
 * TMOS 事件回调：脉冲时间到达，复位 GPIO 引脚
 */
void KeyGo_GPIO_PulseEnd(void)
{
    GPIOA_ResetBits(g_pulsePinMask);
    g_pulsePinMask  = 0;
    g_actionActive  = 0;
    PRINT("[KEY] pulse end\n");
}

void KeyGo_KeyPower(uint8_t on)
{
    if (on)
        GPIOA_SetBits(PIN_KEYPOWER_GPIO);
    else
        GPIOA_ResetBits(PIN_KEYPOWER_GPIO);
}

/* ─────────────────────────────────────────────────────────────────
 * Kalman 滤波
 * ───────────────────────────────────────────────────────────────── */

static void InitKalmanFilter(void)
{
    g_kalman.Q    = 1.0f;
    g_kalman.R    = 25.0f;
    g_kalman.P    = 1.0f;
    g_kalman.K    = 0.0f;
    g_kalman.X    = -80.0f;
    g_kalman.init = 0;
}

void KeyGo_ResetKalman(void)
{
    InitKalmanFilter();
    g_spikeConsecutive = 0;
    g_lastRawRSSI      = -999;
    g_filteredRSSI     = -999.0f;
    g_latestRSSI       = -999;
}

/*
 * 重置全部运行时状态 (连接建立 / 断开时调用)
 */
void KeyGo_ResetState(void)
{
    KeyGo_ResetKalman();
    g_rssiUpdated     = 0;
    g_unlockCounter   = 0;
    g_lockCounter     = 0;
    g_actionActive    = 0;
    g_pulsePinMask    = 0;
    g_manualCooldown  = 0;
}

static float UpdateKalman(float measurement)
{
    if (!g_kalman.init) {
        g_kalman.X    = measurement;
        g_kalman.init = 1;
        return measurement;
    }
    float P_pred = g_kalman.P + g_kalman.Q;
    g_kalman.K = P_pred / (P_pred + g_kalman.R);
    g_kalman.X = g_kalman.X + g_kalman.K * (measurement - g_kalman.X);
    g_kalman.P = (1.0f - g_kalman.K) * P_pred;
    return g_kalman.X;
}

/* ─────────────────────────────────────────────────────────────────
 * RSSI 处理
 * ───────────────────────────────────────────────────────────────── */

void KeyGo_RssiProcess(int8_t rssi)
{
    if (rssi >= 0) return;

    g_latestRSSI = rssi;
    float r = (float)rssi;

    if (g_lastRawRSSI != -999) {
        if (r - g_lastRawRSSI > 25.0f || g_lastRawRSSI - r > 25.0f) { // 设定毛刺阈值 20→25dBm——减少对真实信号移动的误判
            g_spikeConsecutive++;
        } else {
            g_spikeConsecutive = 0;
        }
    }
    g_lastRawRSSI = r;

    if (g_spikeConsecutive < SPIKE_DISCARD_COUNT) {
        g_filteredRSSI = UpdateKalman(r);
        g_rssiUpdated = 1;   // ★ 标记：新 Kalman 样本已产出
    }
}

/* ─────────────────────────────────────────────────────────────────
 * 状态机
 * ───────────────────────────────────────────────────────────────── */

void KeyGo_ProcessStateMachine(void)
{
    if (g_manualCooldown) {
        uint32_t now = Peripheral_GetSystemMs();
        // ★ v3.7: 使用可配置变量 g_cfgManualCooldownMs 替代硬编码宏
        if (now - g_lastCommandMs >= g_cfgManualCooldownMs) {
            g_manualCooldown = 0;
            PRINT("[STATE] manual command cooldown ended\n");
        } else {
            return;
        }
    }

    if (g_filteredRSSI == -999.0f || g_actionActive) return;

    // ★ 只在有新 Kalman 样本时才计数（每 ~500ms 一次，而非每 125ms）
    if (!g_rssiUpdated) return;
    g_rssiUpdated = 0;

    // ★ v3.5: 使用可运行时配置的阈值变量 (非 #define 硬编码)
    if (g_filteredRSSI > g_cfgUnlockThreshold) {
        g_unlockCounter++;
        g_lockCounter = 0;
        if (g_unlockCounter >= g_cfgUnlockCount && g_keyState != KSTATE_UNLOCKED) {
            g_keyState = KSTATE_UNLOCKED;
            g_unlockCounter = 0;
            PRINT("[STATE] unlock threshold reached (RSSI=%d > %d, count=%d)\n",
                  (int)g_filteredRSSI, g_cfgUnlockThreshold, g_cfgUnlockCount);
            KeyGo_Unlock();
        }
    } else if (g_filteredRSSI < g_cfgLockThreshold) {
        g_lockCounter++;
        g_unlockCounter = 0;
        if (g_lockCounter >= g_cfgLockCount && g_keyState != KSTATE_LOCKED) {
            g_keyState = KSTATE_LOCKED;
            g_lockCounter = 0;
            PRINT("[STATE] lock threshold reached (RSSI=%d < %d, count=%d)\n",
                  (int)g_filteredRSSI, g_cfgLockThreshold, g_cfgLockCount);
            KeyGo_Lock();
        }
    } else {
        g_unlockCounter = 0;
        g_lockCounter = 0;
    }
}

/* ─────────────────────────────────────────────────────────────────
 * JSON 状态通知 (FF02 Notify)
 * ───────────────────────────────────────────────────────────────── */

void KeyGo_NotifyStatus(void)
{
    if (!g_deviceConnected || peripheralConnList.connHandle == GAP_CONNHANDLE_INIT)
        return;

    char json[STATUS_JSON_MAX_LEN];
    char d2[24] = "";

    if (g_customName[0]) {
        const char *src = g_customName;
        char       *dst = d2;
        uint8_t     i   = 0;
        while (*src && i < 20) {
            if (*src == '"') { *dst++ = '\\'; i++; }
            *dst++ = *src++;
            i++;
        }
        *dst = '\0';
    }

    int n = snprintf(json, sizeof(json),
        "{\"c\":1,\"st\":\"%s\",\"r\":%d,\"f\":%d,\"d2\":\"%s\",\"cd\":%d}",
        g_keyState == KSTATE_LOCKED   ? "LOCKED"   :
        g_keyState == KSTATE_UNLOCKED ? "UNLOCKED" : "ACTION",
        (int)g_latestRSSI,
        (int)(g_filteredRSSI != -999.0f ? (int)g_filteredRSSI : -999),
        d2,
        (int)g_cfgManualCooldownMs);  // ★ v3.7: 上报当前冷却时间，App 端同步

    if (n > 0 && n < (int)sizeof(json)) {
        attHandleValueNoti_t noti;
        noti.len    = (uint16_t)n;
        noti.pValue = GATT_bm_alloc(peripheralConnList.connHandle, ATT_HANDLE_VALUE_NOTI,
                                    noti.len, NULL, 0);
        if (noti.pValue) {
            tmos_memcpy(noti.pValue, json, noti.len);
            if (simpleProfile_Notify(peripheralConnList.connHandle, &noti) != SUCCESS) {
                GATT_bm_free((gattMsg_t *)&noti, ATT_HANDLE_VALUE_NOTI);
            }
        }
    }
}

/* ─────────────────────────────────────────────────────────────────
 * 命令处理 (NAME / TRUNK / UNLOCK / LOCK)
 * ───────────────────────────────────────────────────────────────── */

void KeyGo_HandleCommand(const char *cmd, uint16_t len)
{
    if (len < 2) return;

    char upper[50] = {0};
    uint16_t i;
    for (i = 0; i < len && i < sizeof(upper) - 1; i++) {
        upper[i] = (cmd[i] >= 'a' && cmd[i] <= 'z') ? cmd[i] - 32 : cmd[i];
    }

    g_manualCooldown  = 1;
    g_lastCommandMs   = Peripheral_GetSystemMs();

    // NAME:xxx
    if (len > 5 && upper[0] == 'N' && upper[1] == 'A' && upper[2] == 'M' && upper[3] == 'E' && upper[4] == ':') {
        const char *name    = cmd + 5;
        uint8_t     nameLen = len - 5;
        if (nameLen > 20) nameLen = 20;
        tmos_memset(g_customName, 0, sizeof(g_customName));
        tmos_memcpy(g_customName, name, nameLen);
        PRINT("[NAME] set to: %s\n", g_customName);
        KeyGo_NotifyStatus();
        return;
    }

    // TRUNK
    if (len >= 5 && upper[0] == 'T' && upper[1] == 'R' && upper[2] == 'U' && upper[3] == 'N' && upper[4] == 'K') {
        KeyGo_Trunk();
        return;
    }

    // UNLOCK
    if (len >= 6 && upper[0] == 'U' && upper[1] == 'N' && upper[2] == 'L' && upper[3] == 'O' && upper[4] == 'C' && upper[5] == 'K') {
        g_keyState       = KSTATE_UNLOCKED;
        // ★ v3.6-fixH: 重置状态机计数器，防止冷却结束后累积的旧计数触发自动操作
        //   bug: 手动解锁后冷却期内计数未清零，冷却结束后状态机立即用累积计数覆盖手动状态
        g_unlockCounter  = 0;
        g_lockCounter    = 0;
        KeyGo_Unlock();
        KeyGo_NotifyStatus();
        return;
    }

    // LOCK
    if (len >= 4 && upper[0] == 'L' && upper[1] == 'O' && upper[2] == 'C' && upper[3] == 'K') {
        g_keyState       = KSTATE_LOCKED;
        // ★ v3.6-fixH: 同上，重置计数器
        g_unlockCounter  = 0;
        g_lockCounter    = 0;
        KeyGo_Lock();
        KeyGo_NotifyStatus();
        return;
    }

    PRINT("[CMD] unknown: %s\n", cmd);
}

/* ─────────────────────────────────────────────────────────────────
 * ★ v3.13: RSSI 周期 ms → TMOS ticks 转换
 *   1 TMOS tick ≈ 0.625ms, 所以 ticks = ms * 8 / 5
 * ───────────────────────────────────────────────────────────────── */
uint16_t KeyGo_GetRssiPeriodTicks(void)
{
    uint32_t ticks = (uint32_t)g_cfgRssiPeriodMs * 8 / 5;
    if (ticks < 100) return 100;    // 下限 ~62.5ms
    if (ticks > 4000) return 4000;  // 上限 ~2500ms
    return (uint16_t)ticks;
}

/* ─────────────────────────────────────────────────────────────────
 * ★ v3.5: FF01 配置解析 (KeyGo_ParseConfig)
 *
 *   解析 App 通过 FF01 下发的配置文本:
 *     "unlock=-30 lock=-45 uc=2 lc=3 interval=500 dlock=5000 cooldown_ms=8000 kr=25"
 *
 * ★ v3.12: 分类持久化策略
 *   Per-phone (仅存 RAM): unlock lock uc lc interval dlock
 *     → 手机每次连接后下发专属配置，不写 Flash（避免反复擦写损耗寿命）
 *   Per-device (写 DataFlash): cooldown_ms
 *     → 冷却时间是设备级参数，所有手机共用，变更时写入 Flash
 *
 *   与 ESP32 版本的 parseConfigLine() 功能等效。
 *   返回: 0=无配置变更, 1=有配置变更
 *
 *   注意: 纯 RSSI 值 ("-50") 或 "rssi=-50" 由此函数的外部调用者处理，
 *         本函数只处理非 RSSI 的配置 key。
 * ───────────────────────────────────────────────────────────────── */
uint8_t KeyGo_ParseConfig(const char *line)
{
    if (!line || line[0] == '\0') return 0;

    uint8_t changed = 0;
    uint8_t cooldown_changed = 0;   // ★ v3.12: 仅 cooldown_ms 变更时写 Flash（设备级参数）
    const char *p = line;

    while (*p) {
        // 跳过前导空格
        while (*p == ' ') p++;
        if (*p == '\0') break;

        // 找到 '='
        const char *eq = p;
        while (*eq && *eq != '=' && *eq != ' ') eq++;
        if (*eq != '=') { p = eq; continue; }

        // 提取 key (p 到 eq)
        uint8_t keyLen = (uint8_t)(eq - p);
        if (keyLen == 0) { p = eq + 1; continue; }

        // ★ 跳过 "rssi" key — RSSI 值由外部调用者处理
        if (keyLen == 4 && p[0] == 'r' && p[1] == 's' && p[2] == 's' && p[3] == 'i') {
            p = eq + 1;
            while (*p && *p != ' ') p++;
            continue;
        }

        // 提取 value (eq+1 到下一个空格或结束)
        const char *valStart = eq + 1;
        const char *valEnd = valStart;
        while (*valEnd && *valEnd != ' ') valEnd++;

        int val = 0;
        {
            const char *vp = valStart;
            int sign = 1;
            if (*vp == '-') { sign = -1; vp++; }
            else if (*vp == '+') { vp++; }
            while (*vp >= '0' && *vp <= '9') {
                val = val * 10 + (*vp - '0');
                vp++;
            }
            val *= sign;
        }

        // ── 匹配 key 并更新对应变量 ──
        if      (keyLen == 6 && tmos_memcmp(p, "unlock", 6))   { g_cfgUnlockThreshold = (int16_t)val; changed = 1; }
        else if (keyLen == 4 && tmos_memcmp(p, "lock", 4))     { g_cfgLockThreshold = (int16_t)val;   changed = 1; }
        else if (keyLen == 2 && tmos_memcmp(p, "uc", 2))       { g_cfgUnlockCount = (uint8_t)val;     changed = 1; }
        else if (keyLen == 2 && tmos_memcmp(p, "lc", 2))       { g_cfgLockCount = (uint8_t)val;       changed = 1; }
        // ★ v3.13: interval 改为控制固件 RSSI 读取周期 (原为 App 轮询间隔，已废弃)
        else if (keyLen == 8 && tmos_memcmp(p, "interval", 8)) {
            if (val >= 100 && val <= 2000 && g_cfgRssiPeriodMs != (uint16_t)val) {
                g_cfgRssiPeriodMs = (uint16_t)val;
                changed = 1;
            }
        }
        else if (keyLen == 5 && tmos_memcmp(p, "dlock", 5))    { g_cfgDisconnectLockMs = (uint16_t)val; changed = 1; }
        // ★ v3.13: Kalman R 值 (kr)
        else if (keyLen == 2 && tmos_memcmp(p, "kr", 2)) {
            if (val >= 1 && val <= 50 && g_cfgKalmanR != (uint8_t)val) {
                g_cfgKalmanR = (uint8_t)val;
                g_kalman.R = (float)g_cfgKalmanR;
                changed = 1;
                PRINT("[KALMAN] R updated to %d\n", val);
            }
        }
        // ★ v3.7 / v3.12: 冷却时间 cooldown_ms (长度 11)
        //   ★ 设备级参数（写入 DataFlash，所有连接此设备的手机共用）
        //   ★ 仅在值实际变化且合法时标记 cooldown_changed（触发 Flash 保存）
        else if (keyLen == 11 && tmos_memcmp(p, "cooldown_ms", 11)) {
            if (val >= 2000 && val <= 30000 && g_cfgManualCooldownMs != (uint16_t)val) {
                g_cfgManualCooldownMs = (uint16_t)val;
                cooldown_changed = 1;
                changed = 1;
            }
        }

        p = valEnd;
    }

    if (changed) {
        PRINT("[CONFIG] updated: unlock=%d lock=%d uc=%d lc=%d dlock=%d interval=%d kr=%d\n",
              g_cfgUnlockThreshold, g_cfgLockThreshold, g_cfgUnlockCount,
              g_cfgLockCount, g_cfgDisconnectLockMs, g_cfgRssiPeriodMs, g_cfgKalmanR);
        // ★ 配置变更后重置计数器，避免旧阈值下的累积计数影响新阈值判断
        g_unlockCounter = 0;
        g_lockCounter   = 0;
        // ★ v3.12: 仅 cooldown_ms 写 DataFlash（设备级参数，所有手机共用）
        //   unlock/lock/uc/lc/dlock/interval 仅存 RAM，由手机每次连接后下发（per-phone 个性化）
        if (cooldown_changed) {
            KeyGo_SaveConfig();
        }
    }

    return changed;
}

/* ─────────────────────────────────────────────────────────────────
 * ★ v3.5.1: 配置持久化到 DataFlash（v3.12: 仅 cooldown_ms 自动调用）
 *
 * ★ v3.12: 此函数仅由 ParseConfig 在 cooldown_ms 值变更时自动调用。
 *   冷却时间是设备级参数，写入 Flash 确保所有手机共享同一值。
 *   其他参数 (unlock/lock/uc/lc/dlock) 不写 Flash（per-phone 方案）。
 *
 *   使用 DataFlash 0x77000~0x770FF 区域存储配置 (BLE SNV 在 0x77E00)
 *   写入前先擦除页 (256 字节对齐)，然后写入 16 字节配置块
 *   格式: [magic:4][unlock:2][lock:2][uc:1][lc:1][dlock:2][checksum:1][cooldown_ms:2][pad:1]
 *   checksum = XOR over magic+values (前 12 字节)
 * ───────────────────────────────────────────────────────────────── */

void KeyGo_LoadConfig(void)
{
    uint8_t buf[16] = {0};
    if (EEPROM_READ(KEYGO_CFG_ADDR, buf, 16) != 0) {
        PRINT("[CONFIG] EEPROM_READ failed, using defaults\n");
        return;
    }

    // 校验 magic
    uint32_t magic = *((uint32_t*)buf);
    if (magic != KEYGO_CFG_MAGIC) {
        PRINT("[CONFIG] No saved config (magic mismatch), using defaults\n");
        return;
    }

    // 校验 checksum (XOR over first 12 bytes)
    uint8_t csum = 0;
    for (uint8_t i = 0; i < 12; i++) csum ^= buf[i];
    if (csum != buf[12]) {
        PRINT("[CONFIG] Checksum mismatch, using defaults\n");
        return;
    }

    // 恢复配置
    g_cfgUnlockThreshold  = *((int16_t*)(buf + 4));
    g_cfgLockThreshold    = *((int16_t*)(buf + 6));
    g_cfgUnlockCount      = buf[8];
    g_cfgLockCount        = buf[9];
    g_cfgDisconnectLockMs = *((uint16_t*)(buf + 10));
    // ★ v3.7: 读取 cooldownMs（buf[13-14]），旧格式此处为 0，需兜底
    {
        uint16_t cd = *((uint16_t*)(buf + 13));
        if (cd >= 2000 && cd <= 30000) {
            g_cfgManualCooldownMs = cd;
        } else {
            g_cfgManualCooldownMs = 8000;  // 旧格式或越界 → 默认 8s
        }
    }

    // 合理性校验
    if (g_cfgUnlockThreshold >= 0 || g_cfgUnlockThreshold < -100) g_cfgUnlockThreshold = -45;
    if (g_cfgLockThreshold >= 0 || g_cfgLockThreshold < -100)     g_cfgLockThreshold   = -65;
    if (g_cfgUnlockCount < 1 || g_cfgUnlockCount > 30)           g_cfgUnlockCount     = 3;
    if (g_cfgLockCount < 1 || g_cfgLockCount > 30)               g_cfgLockCount       = 5;
    if (g_cfgDisconnectLockMs > 60000)                           g_cfgDisconnectLockMs = 5000;

    PRINT("[CONFIG] Loaded from flash: unlock=%d lock=%d uc=%d lc=%d dlock=%d cooldown_ms=%d\n",
          g_cfgUnlockThreshold, g_cfgLockThreshold, g_cfgUnlockCount,
          g_cfgLockCount, g_cfgDisconnectLockMs, g_cfgManualCooldownMs);
}

void KeyGo_SaveConfig(void)
{
    // 擦除配置页 (256 字节，页对齐)
    EEPROM_ERASE(KEYGO_CFG_ADDR, 256);

    uint8_t buf[16] = {0};

    // Magic (4 bytes)
    *((uint32_t*)buf) = KEYGO_CFG_MAGIC;

    // 配置值
    *((int16_t*)(buf + 4))  = g_cfgUnlockThreshold;
    *((int16_t*)(buf + 6))  = g_cfgLockThreshold;
    buf[8]  = g_cfgUnlockCount;
    buf[9]  = g_cfgLockCount;
    *((uint16_t*)(buf + 10)) = g_cfgDisconnectLockMs;

    // ★ v3.7: cooldownMs 存于 buf[13-14]（旧格式为 padding=0，兼容）
    *((uint16_t*)(buf + 13)) = g_cfgManualCooldownMs;

    // Checksum: XOR over first 12 bytes（不含 cooldownMs，保持向后兼容）
    buf[12] = 0;
    for (uint8_t i = 0; i < 12; i++) buf[12] ^= buf[i];

    if (EEPROM_WRITE(KEYGO_CFG_ADDR, buf, 16) == 0) {
        PRINT("[CONFIG] Saved to flash OK\n");
    } else {
        PRINT("[CONFIG] Save to flash FAILED\n");
    }
}

/*********************************************************************
 *********************************************************************/
