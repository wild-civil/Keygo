/********************************** (C) COPYRIGHT *******************************
 * File Name          : keygo_core.c
 * Author             : KeyGo v3.5 (CH582M)
 * Date               : 2026/06/30
 * Description        : GPIO + Kalman + RSSI + 状态机 + JSON 通知 + 命令解析
 *********************************************************************************/

#include "keygo_core.h"
#include "gattprofile.h"

/* ─────────────────────────────────────────────────────────────────
 * 宏定义 (模块内部)
 * ───────────────────────────────────────────────────────────────── */

// RSSI 阈值
#define RSSI_UNLOCK_THRESHOLD   -55
#define RSSI_LOCK_THRESHOLD     -75
#define UNLOCK_COUNT_REQUIRED   3
#define LOCK_COUNT_REQUIRED     5
#define SPIKE_DISCARD_COUNT     2
#define MANUAL_COOLDOWN_MS      3000
#define STATUS_JSON_MAX_LEN     180

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

// 状态机
static uint8_t  g_unlockCounter     = 0;
static uint8_t  g_lockCounter       = 0;
static uint8_t  g_actionActive      = 0;
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
    PRINT("[KEY] unlock\n");
    GPIOA_SetBits(PIN_UNLOCK_GPIO);
    mDelaymS(500);
    GPIOA_ResetBits(PIN_UNLOCK_GPIO);
}

void KeyGo_Lock(void)
{
    PRINT("[KEY] lock\n");
    GPIOA_SetBits(PIN_LOCK_GPIO);
    mDelaymS(500);
    GPIOA_ResetBits(PIN_LOCK_GPIO);
}

void KeyGo_Trunk(void)
{
    PRINT("[KEY] trunk\n");
    GPIOA_SetBits(PIN_TRUNK_GPIO);
    mDelaymS(500);
    GPIOA_ResetBits(PIN_TRUNK_GPIO);
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
    g_unlockCounter  = 0;
    g_lockCounter    = 0;
    g_actionActive   = 0;
    g_manualCooldown = 0;
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
        if (r - g_lastRawRSSI > 20.0f || g_lastRawRSSI - r > 20.0f) {
            g_spikeConsecutive++;
        } else {
            g_spikeConsecutive = 0;
        }
    }
    g_lastRawRSSI = r;

    if (g_spikeConsecutive < SPIKE_DISCARD_COUNT) {
        g_filteredRSSI = UpdateKalman(r);
    }
}

/* ─────────────────────────────────────────────────────────────────
 * 状态机
 * ───────────────────────────────────────────────────────────────── */

void KeyGo_ProcessStateMachine(void)
{
    if (g_manualCooldown) {
        uint32_t now = Peripheral_GetSystemMs();
        if (now - g_lastCommandMs >= MANUAL_COOLDOWN_MS) {
            g_manualCooldown = 0;
            PRINT("[STATE] manual command cooldown ended\n");
        } else {
            return;
        }
    }

    if (g_filteredRSSI == -999.0f || g_actionActive) return;

    if (g_filteredRSSI > RSSI_UNLOCK_THRESHOLD) {
        g_unlockCounter++;
        g_lockCounter = 0;
        if (g_unlockCounter >= UNLOCK_COUNT_REQUIRED && g_keyState != KSTATE_UNLOCKED) {
            g_keyState = KSTATE_UNLOCKED;
            g_unlockCounter = 0;
            PRINT("[STATE] unlock threshold reached\n");
            KeyGo_Unlock();
        }
    } else if (g_filteredRSSI < RSSI_LOCK_THRESHOLD) {
        g_lockCounter++;
        g_unlockCounter = 0;
        if (g_lockCounter >= LOCK_COUNT_REQUIRED && g_keyState != KSTATE_LOCKED) {
            g_keyState = KSTATE_LOCKED;
            g_lockCounter = 0;
            PRINT("[STATE] lock threshold reached\n");
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
        "{\"c\":1,\"st\":\"%s\",\"r\":%d,\"f\":%d,\"d2\":\"%s\"}",
        g_keyState == KSTATE_LOCKED   ? "LOCKED"   :
        g_keyState == KSTATE_UNLOCKED ? "UNLOCKED" : "ACTION",
        (int)g_latestRSSI,
        (int)(g_filteredRSSI != -999.0f ? (int)g_filteredRSSI : -999),
        d2);

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
        g_keyState = KSTATE_UNLOCKED;
        KeyGo_Unlock();
        KeyGo_NotifyStatus();
        return;
    }

    // LOCK
    if (len >= 4 && upper[0] == 'L' && upper[1] == 'O' && upper[2] == 'C' && upper[3] == 'K') {
        g_keyState = KSTATE_LOCKED;
        KeyGo_Lock();
        KeyGo_NotifyStatus();
        return;
    }

    PRINT("[CMD] unknown: %s\n", cmd);
}

/*********************************************************************
 *********************************************************************/
