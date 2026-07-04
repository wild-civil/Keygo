/********************************** (C) COPYRIGHT *******************************
 * File Name          : keygo_core.c
 * Author             : KeyGo v3.13 (CH582M)
 * Date               : 2026/07/02
 * Description        : GPIO + Kalman + RSSI + 状态机 + JSON 通知 + 命令解析
 *********************************************************************************/

#include "keygo_core.h"
#include "gattprofile.h"
#include <stdlib.h>   /* atoi */
#include "CH58x_common.h"  /* EEPROM_READ / EEPROM_WRITE / EEPROM_ERASE */

/* ─────────────────────────────────────────────────────────────────
 * 宏定义 (模块内部)
 * ───────────────────────────────────────────────────────────────── */

#define SPIKE_DISCARD_COUNT         2
// ★ v3.6-fixH: 从 3000ms → 8000ms，匹配 App 端 8s 冷却
// ★ v3.7: MANUAL_COOLDOWN_MS 从宏改为 uint16_t 变量 g_manualCooldownMs，
//         可在运行时通过 App 下发 "cooldown_ms=N" 修改，并持久化到 DataFlash
//         bug: 固件冷却 3s 到期后状态机恢复运行，仅 ~5.5s 后即可自动覆盖手动操作，
//               用户看到 App 显示"冷却 8s"但实际只有 3s 有效
#define STATUS_JSON_MAX_LEN         200  // ★ 加了 cd 字段，json 更长，从 180 扩到 200

/* ★ v3.15: TMOS 时间转换常量
 *   TMOS tick ≈ 0.625ms = 5/8 ms → ms = ticks × 5 ÷ 8, ticks = ms × 8 ÷ 5 */
#define TMOS_TICK_NUM               5    // 1 tick = 5/8 ms → 分子
#define TMOS_TICK_DEN               8    // 1 tick = 5/8 ms → 分母
#define MS_TO_TMOS_TICK_NUM         8    // ms → ticks: 乘 8
#define MS_TO_TMOS_TICK_DEN         5    // ms → ticks: 除 5

/* ★ v3.15: RSSI 相关常量 */
#define RSSI_UNINITIALIZED        (-999)   // RSSI 未初始化哨兵值（整数）
#define RSSI_UNINITIALIZED_F      (-999.0f)// RSSI 未初始化哨兵值（浮点）
#define RSSI_SPIKE_THRESHOLD_DBM  25.0f    // 单次 RSSI 跳变 >25dBm 视为毛刺
#define RSSI_PERIOD_TICKS_MIN      100     // RSSI 读取周期下限 ~62.5ms
#define RSSI_PERIOD_TICKS_MAX      4000    // RSSI 读取周期上限 ~2500ms

/* ★ v3.15: Kalman 滤波器初始化默认值 */
#define KALMAN_DEFAULT_Q           1.0f   // 过程噪声协方差
#define KALMAN_DEFAULT_P           1.0f   // 初始估计协方差
#define KALMAN_INITIAL_X          -80.0f  // 初始状态估计 (~-80dBm 典型空旷区)

/* ★ v3.15-#12: 参数合法范围常量 — 替代原代码中的裸数字（魔术数字）
 *   用于配置下发 (ParseConfig) 和 Flash 加载 (LoadConfig) 时的边界检查。
 *   改动仅是给已有的数字起名，不改变任何逻辑行为。 */
#define RSSI_THRESHOLD_MIN       -100      // RSSI 阈值合法性下限 (dBm)
#define COUNT_MIN                   1      // 解锁/锁车累计次数下限
#define COUNT_MAX                  30      // 解锁/锁车累计次数上限
#define KALMAN_R_MIN                1      // Kalman 滤波器 R 值下限
#define KALMAN_R_MAX               50      // Kalman 滤波器 R 值上限
#define RSSI_PERIOD_MIN_MS        100      // RSSI 读取周期下限 (ms)
#define RSSI_PERIOD_MAX_MS       2000      // RSSI 读取周期上限 (ms)
#define COOLDOWN_MIN_MS          2000      // 手动命令冷却时间下限 (ms)
#define COOLDOWN_MAX_MS         30000      // 手动命令冷却时间上限 (ms)
#define DLOCK_MAX_MS            60000      // 断连自动锁车延时上限 (ms)
#define COOLDOWN_DEFAULT_MS      8000      // 冷却时间默认值 (旧格式兜底)

/* ★ v3.15-#16: GPIO 脉冲动作看门狗 — TMOS 漏掉脉冲结束事件时的兜底保护
 *   KeyGo_Unlock/Lock/Trunk 启动 ~200ms~2s 的脉冲，如果 SBP_GPIO_PULSE_END_EVT
 *   因极端竞态丢失，g_actionActive 永远为 1 → 状态机永久停止。
 *   看门狗周期 = 最长脉冲(trunk=2s) × 2 + 余量 = 4s，TMOS 未响应则强制清零 */
#define ACTION_WATCHDOG_MS         4000      // GPIO 脉冲看门狗超时 (ms)

/* ─────────────────────────────────────────────────────────────────
 * ★ v3.5: 可运行时配置的 RSSI 阈值 (替代原来的 #define 硬编码)
 *    由 App 通过 FF01 下发 "unlock=-30 lock=-45 uc=2..." 更新
 *    默认值与 App 端 store 初始值保持一致
 * ───────────────────────────────────────────────────────────────── */
int16_t  g_cfgUnlockThreshold   = -45;   // RSSI 解锁阈值
int16_t  g_cfgLockThreshold     = -65;   // RSSI 锁车阈值
uint8_t  g_cfgUnlockCount       = 2;     // 解锁需连续满足次数
uint8_t  g_cfgLockCount         = 3;     // 锁车需连续满足次数
uint16_t g_cfgDisconnectLockMs  = 5000;  // 断连自动锁车延时 ms
// ★ v3.7: 可运行时配置的 RSSI 冷却时间 (替代 #define MANUAL_COOLDOWN_MS)
uint16_t g_cfgManualCooldownMs  = 8000;  // 手动命令冷却时间 ms (范围 2000~30000)
// ★ v3.13: 固件 RSSI 读取周期 + 卡尔曼响应速度
uint16_t g_cfgRssiPeriodMs      = 500;   // GAP RSSI 读取间隔 ms (范围 100~2000, 默认 500)
uint8_t  g_cfgKalmanR           = 15;    // 卡尔曼滤波器 R 值 (范围 1~50, 默认 15)

/* ─────────────────────────────────────────────────────────────────
 * 模块内部状态 (仅 keygo_core 可见)
 * ───────────────────────────────────────────────────────────────── */

// Kalman
static KalmanFilter1D_t g_kalman;                   // 由 InitKalmanFilter() 初始化 

// RSSI
static int16_t  g_latestRSSI        = RSSI_UNINITIALIZED;
static float    g_filteredRSSI      = RSSI_UNINITIALIZED_F;
/* ★ v3.15-#17: 移除 g_rssiBuffer[8]/g_rssiBufIdx — 旧滑动窗口 RSSI 死代码，
 *   Kalman 滤波器已完全替代，两个变量全代码库无任何引用，占用 18B RAM */
static uint8_t  g_spikeConsecutive  = 0;
/* ★ v3.15-fix8: float 类型与 Kalman 滤波器一致，避免 int→float 隐式截断歧义 */
static float    g_lastRawRSSI       = RSSI_UNINITIALIZED_F;
static uint8_t  g_rssiUpdated       = 0;    // ★ 新 Kalman 样本标记

// 状态机
static uint8_t  g_unlockCounter     = 0;
static uint8_t  g_lockCounter       = 0;
static uint8_t  g_actionActive      = 0;
static uint16_t g_pulsePinMask      = 0;     // 当前脉冲的引脚掩码
static uint32_t g_actionStartMs     = 0;     // ★ v3.15-#16: 脉冲启动时间戳，看门狗用
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
    return TMOS_GetSystemClock() * TMOS_TICK_NUM / TMOS_TICK_DEN;
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
    g_actionStartMs = Peripheral_GetSystemMs();  // ★ v3.15-#16: 看门狗启动时间
    g_pulsePinMask  = PIN_UNLOCK_GPIO;
    PRINT("[KEY] unlock\n");
    GPIOA_SetBits(PIN_UNLOCK_GPIO);
    tmos_start_task(Peripheral_TaskID, SBP_GPIO_PULSE_END_EVT, GPIO_PULSE_LOCK_TICKS);
}

void KeyGo_Lock(void)
{
    if (g_actionActive) return;
    g_actionActive  = 1;
    g_actionStartMs = Peripheral_GetSystemMs();  // ★ v3.15-#16: 看门狗启动时间
    g_pulsePinMask  = PIN_LOCK_GPIO;
    PRINT("[KEY] lock\n");
    GPIOA_SetBits(PIN_LOCK_GPIO);
    tmos_start_task(Peripheral_TaskID, SBP_GPIO_PULSE_END_EVT, GPIO_PULSE_LOCK_TICKS);
}

void KeyGo_Trunk(void)
{
    if (g_actionActive) return;
    g_actionActive  = 1;
    g_actionStartMs = Peripheral_GetSystemMs();  // ★ v3.15-#16: 看门狗启动时间
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
    g_kalman.Q    = KALMAN_DEFAULT_Q;
    g_kalman.R    = (float)g_cfgKalmanR;  // ★ v3.13: 使用运行时配置，不再硬编码
    g_kalman.P    = KALMAN_DEFAULT_P;
    g_kalman.K    = 0.0f;
    g_kalman.X    = KALMAN_INITIAL_X;
    g_kalman.init = 0;
}

void KeyGo_ResetKalman(void)
{
    InitKalmanFilter();
    g_spikeConsecutive = 0;
    g_lastRawRSSI      = RSSI_UNINITIALIZED_F;
    g_filteredRSSI     = RSSI_UNINITIALIZED_F;
    g_latestRSSI       = RSSI_UNINITIALIZED;
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
    g_actionStartMs   = 0;   // ★ v3.15-#16: 看门狗时间戳清零
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

    /* ★ v3.15-fix8: g_lastRawRSSI 改为 float，类型统一后使用 fabsf 简化判断 */
    if (g_lastRawRSSI != RSSI_UNINITIALIZED_F) {
        float delta = r - g_lastRawRSSI;
        if (delta > RSSI_SPIKE_THRESHOLD_DBM || delta < -RSSI_SPIKE_THRESHOLD_DBM) {
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
    /* ★ v3.15-#16: GPIO 脉冲看门狗 — TMOS SBP_GPIO_PULSE_END_EVT 漏触发兜底
     *   正常路径：脉冲到期 → TMOS 调 KeyGo_GPIO_PulseEnd() → g_actionActive=0
     *   异常路径：事件丢失 → g_actionActive 永远=1 → 后续所有操作阻塞
     *   看门狗：启动 4s 后（2× 最长 trunk 脉冲）若仍未清零，强制复位。 */
    if (g_actionActive) {
        if (Peripheral_GetSystemMs() - g_actionStartMs >= ACTION_WATCHDOG_MS) {
            PRINT("[WATCHDOG] GPIO pulse stuck %lums, force clearing\n",
                  (unsigned long)(Peripheral_GetSystemMs() - g_actionStartMs));
            KeyGo_GPIO_PulseEnd();  // 强制清零，状态机恢复运行
        } else {
            return;                 // 脉冲正常进行中，跳过状态机
        }
    }

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

    /* ★ v3.15-#16: g_actionActive 检查已上移至函数顶部看门狗处理，
     *   此处仅需检查滤波器是否初始化 */
    if (g_filteredRSSI == RSSI_UNINITIALIZED_F) return;

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
        "{\"c\":1,\"st\":\"%s\",\"r\":%d,\"f\":%d,\"d2\":\"%s\",\"cd\":%d,\"kr\":%d}",
        g_keyState == KSTATE_LOCKED   ? "LOCKED"   :
        g_keyState == KSTATE_UNLOCKED ? "UNLOCKED" : "ACTION",
        (int)g_latestRSSI,
        (int)(g_filteredRSSI != RSSI_UNINITIALIZED_F ? (int)g_filteredRSSI : RSSI_UNINITIALIZED),
        d2,
        (int)g_cfgManualCooldownMs,  // ★ v3.7: 上报当前冷却时间，App 端同步
        (int)g_cfgKalmanR);           // ★ v3.13: 上报 kalmanR，App 同步 kalmanR

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

    /* ★ v3.15-fix1: 冷却期仅应在 GPIO 操作 (TRUNK/UNLOCK/LOCK) 后触发
     *   NAME:xxx 和 STATUS 等请求不应占用冷却期
     *   → 将 cooldown 移至各 GPIO 分支内部 */
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

    // TRUNK (精确匹配 5 字节，排除 TRUNKED/TRUNKING 等)
    if (len == 5 && upper[0] == 'T' && upper[1] == 'R' && upper[2] == 'U' && upper[3] == 'N' && upper[4] == 'K') {
        /* ★ v3.15-fix1: 命令执行前设置冷却期，防止连续操作抖动 */
        g_manualCooldown  = 1;
        g_lastCommandMs   = Peripheral_GetSystemMs();
        // ★ v3.15-#14: 重置状态机计数器，与 UNLOCK/LOCK 行为一致
        //   避免后备箱操作后冷却期内，旧累积计数在冷却结束后意外触发自动锁/解锁
        g_unlockCounter  = 0;
        g_lockCounter    = 0;
        KeyGo_Trunk();
        return;
    }

    // UNLOCK (精确匹配 6 字节，排除 UNLOCKED/UNLOCKING 等)
    if (len == 6 && upper[0] == 'U' && upper[1] == 'N' && upper[2] == 'L' && upper[3] == 'O' && upper[4] == 'C' && upper[5] == 'K') {
        /* ★ v3.15-fix1: 冷却期仅在 GPIO 操作后触发 */
        g_manualCooldown  = 1;
        g_lastCommandMs   = Peripheral_GetSystemMs();
        g_keyState       = KSTATE_UNLOCKED;
        // ★ v3.6-fixH: 重置状态机计数器，防止冷却结束后累积的旧计数触发自动操作
        //   bug: 手动解锁后冷却期内计数未清零，冷却结束后状态机立即用累积计数覆盖手动状态
        g_unlockCounter  = 0;
        g_lockCounter    = 0;
        KeyGo_Unlock();
        KeyGo_NotifyStatus();
        return;
    }

    // LOCK (精确匹配 4 字节，排除 LOCKED/LOCKER/LOCKING 等)
    if (len == 4 && upper[0] == 'L' && upper[1] == 'O' && upper[2] == 'C' && upper[3] == 'K') {
        /* ★ v3.15-fix1: 冷却期仅在 GPIO 操作后触发 */
        g_manualCooldown  = 1;
        g_lastCommandMs   = Peripheral_GetSystemMs();
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
    uint32_t ticks = (uint32_t)g_cfgRssiPeriodMs * MS_TO_TMOS_TICK_NUM / MS_TO_TMOS_TICK_DEN;
    if (ticks < RSSI_PERIOD_TICKS_MIN) return RSSI_PERIOD_TICKS_MIN;   // 下限 ~62.5ms
    if (ticks > RSSI_PERIOD_TICKS_MAX) return RSSI_PERIOD_TICKS_MAX;   // 上限 ~2500ms
    return (uint16_t)ticks;
}

/* ★ v3.15-#15: 断连锁车延时 ms → TMOS ticks 转换
 *   1 TMOS tick ≈ 0.625ms → ticks = ms × 8 / 5
 *   g_cfgDisconnectLockMs 上限 60000ms → 96000 ticks, uint16_t 安全
 *   dlockMs == 0 时返回 0（调用方判断为立即锁车，不启动定时器） */
uint16_t KeyGo_GetDisconnectLockTicks(void)
{
    if (g_cfgDisconnectLockMs == 0) return 0;
    uint32_t ticks = (uint32_t)g_cfgDisconnectLockMs * MS_TO_TMOS_TICK_NUM / MS_TO_TMOS_TICK_DEN;
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
            if (val >= RSSI_PERIOD_MIN_MS && val <= RSSI_PERIOD_MAX_MS && g_cfgRssiPeriodMs != (uint16_t)val) {
                g_cfgRssiPeriodMs = (uint16_t)val;
                changed = 1;
            }
        }
        else if (keyLen == 5 && tmos_memcmp(p, "dlock", 5))    { g_cfgDisconnectLockMs = (uint16_t)val; changed = 1; }
        // ★ v3.13: Kalman R 值 (kr)
        else if (keyLen == 2 && tmos_memcmp(p, "kr", 2)) {
            if (val >= KALMAN_R_MIN && val <= KALMAN_R_MAX && g_cfgKalmanR != (uint8_t)val) {
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
            if (val >= COOLDOWN_MIN_MS && val <= COOLDOWN_MAX_MS && g_cfgManualCooldownMs != (uint16_t)val) {
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
    /* ★ v3.15-fix3: 改用字节拼装替代指针强转 ((uint32_t*)buf)
     *   Cortex-M0 不支持非对齐内存访问，栈上 buf 对齐非标准保证
     *   若编译器未字对齐 buf，*(uint32_t*)buf 会触发 HardFault */
    uint32_t magic = (uint32_t)buf[0] | ((uint32_t)buf[1] << 8) |
                     ((uint32_t)buf[2] << 16) | ((uint32_t)buf[3] << 24);
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
    /* ★ v3.15-fix3: 字节拼装，避免未对齐访问 (LE) */
    g_cfgUnlockThreshold  = (int16_t)((uint16_t)buf[4] | ((uint16_t)buf[5] << 8));
    g_cfgLockThreshold    = (int16_t)((uint16_t)buf[6] | ((uint16_t)buf[7] << 8));
    g_cfgUnlockCount      = buf[8];
    g_cfgLockCount        = buf[9];
    g_cfgDisconnectLockMs = (uint16_t)buf[10] | ((uint16_t)buf[11] << 8);
    // ★ v3.7: 读取 cooldownMs（buf[13-14]），旧格式此处为 0，需兜底
    {
        uint16_t cd = (uint16_t)buf[13] | ((uint16_t)buf[14] << 8);
        if (cd >= COOLDOWN_MIN_MS && cd <= COOLDOWN_MAX_MS) {
            g_cfgManualCooldownMs = cd;
        } else {
            g_cfgManualCooldownMs = COOLDOWN_DEFAULT_MS;  // 旧格式或越界 → 默认 8s
        }
    }

    // 合理性校验（使用命名常量替代魔术数字）
    if (g_cfgUnlockThreshold >= 0 || g_cfgUnlockThreshold < RSSI_THRESHOLD_MIN) g_cfgUnlockThreshold = -45;
    if (g_cfgLockThreshold >= 0 || g_cfgLockThreshold < RSSI_THRESHOLD_MIN)     g_cfgLockThreshold   = -65;
    if (g_cfgUnlockCount < COUNT_MIN || g_cfgUnlockCount > COUNT_MAX)           g_cfgUnlockCount     = 2;
    if (g_cfgLockCount < COUNT_MIN || g_cfgLockCount > COUNT_MAX)               g_cfgLockCount       = 3;
    if (g_cfgDisconnectLockMs > DLOCK_MAX_MS)                                   g_cfgDisconnectLockMs = 5000;

    PRINT("[CONFIG] Loaded from flash: unlock=%d lock=%d uc=%d lc=%d dlock=%d cooldown_ms=%d\n",
          g_cfgUnlockThreshold, g_cfgLockThreshold, g_cfgUnlockCount,
          g_cfgLockCount, g_cfgDisconnectLockMs, g_cfgManualCooldownMs);
}

void KeyGo_SaveConfig(void)
{
    // 擦除配置页 (256 字节，页对齐)
    EEPROM_ERASE(KEYGO_CFG_ADDR, 256);

    uint8_t buf[16] = {0};

    /* ★ v3.15-fix3: 字节写入替代指针强转，确保对齐安全 (LE) */
    // Magic (4 bytes, LE)
    buf[0] = (uint8_t)(KEYGO_CFG_MAGIC);
    buf[1] = (uint8_t)(KEYGO_CFG_MAGIC >> 8);
    buf[2] = (uint8_t)(KEYGO_CFG_MAGIC >> 16);
    buf[3] = (uint8_t)(KEYGO_CFG_MAGIC >> 24);

    // 配置值 (int16_t, LE)
    buf[4] = (uint8_t)(g_cfgUnlockThreshold);
    buf[5] = (uint8_t)(g_cfgUnlockThreshold >> 8);
    buf[6] = (uint8_t)(g_cfgLockThreshold);
    buf[7] = (uint8_t)(g_cfgLockThreshold >> 8);
    buf[8]  = g_cfgUnlockCount;
    buf[9]  = g_cfgLockCount;

    // uint16_t disconnectLockMs (LE)
    buf[10] = (uint8_t)(g_cfgDisconnectLockMs);
    buf[11] = (uint8_t)(g_cfgDisconnectLockMs >> 8);

    // ★ v3.7: cooldownMs 存于 buf[13-14]（旧格式为 padding=0，兼容）
    buf[13] = (uint8_t)(g_cfgManualCooldownMs);
    buf[14] = (uint8_t)(g_cfgManualCooldownMs >> 8);

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
