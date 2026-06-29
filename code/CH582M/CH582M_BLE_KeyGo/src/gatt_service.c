#include "gatt_service.h"
#include "config_storage.h"
#include "kalman_filter.h"
#include "state_machine.h"
#include "relay_ctrl.h"
#include "ble_security.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <ctype.h>

/* ============================================================
 *  GATT 服务应用层逻辑
 *  保持与 ESP32 v3.5 版本的协议 100% 兼容
 * ============================================================ */

void (*gattNotifyCallback)(uint16_t connHandle, const uint8_t *data, uint16_t len) = NULL;
void (*gattDisconnectCallback)(uint16_t connHandle) = NULL;

static char status_json_buf[GATT_MAX_TX_LEN];
static char cmd_buf[GATT_MAX_RX_LEN];

static KalmanFilter_t kf;

void GattSrv_Init(void) {
    memset(status_json_buf, 0, sizeof(status_json_buf));
    memset(cmd_buf, 0, sizeof(cmd_buf));
    Kalman_Init(&kf, g_cfg.kf_q, g_cfg.kf_r);
}

void GattSrv_BuildStatusJson(char *buf, uint16_t bufLen) {
    if (!buf || bufLen == 0) return;

    char snHex[7];
    snprintf(snHex, sizeof(snHex), "%02X%02X%02X",
             g_cfg.deviceMac[3], g_cfg.deviceMac[4], g_cfg.deviceMac[5]);

    const char *d2 = g_st.encryptionEstablished ? g_cfg.customDeviceName : "";

    snprintf(buf, bufLen,
        "{\"c\":%d,\"enc\":%d,\"bdd\":%d,\"st\":\"%s\","
        "\"r\":%d,\"f\":%d,"
        "\"ul\":%d,\"lk\":%d,\"hy\":%d,\"uc\":%d,\"lc\":%d,\"mc\":%d,"
        "\"dn\":\"%s\",\"d2\":\"%s\",\"sn\":\"%s\","
        "\"pm\":%d,\"pd\":%d,\"pce\":%d}",
        g_st.deviceConnected ? 1 : 0,
        g_st.encryptionEstablished ? 1 : 0,
        g_st.hasBondedDevices ? 1 : 0,
        StateMachine_GetStateString(),
        g_st.latestRSSI,
        (int)g_st.filteredRSSI,
        g_cfg.rssiUnlockThreshold,
        g_cfg.rssiLockThreshold,
        g_cfg.rssiHysteresisDb,
        g_cfg.unlockCountRequired,
        g_cfg.lockCountRequired,
        g_st.manualCommandCooldown ? 1 : 0,
        g_cfg.deviceName,
        d2,
        snHex,
        g_st.pairingModeActive ? 1 : 0,
        g_cfg.pinDefault ? 1 : 0,
        g_st.pinChangeError
    );
}

void GattSrv_NotifyStatus(void) {
    if (!gattNotifyCallback) return;
    if (!g_st.deviceConnected) return;

    GattSrv_BuildStatusJson(status_json_buf, sizeof(status_json_buf));
    gattNotifyCallback(g_st.connectionHandle,
                       (const uint8_t *)status_json_buf,
                       strlen(status_json_buf));
}

uint16_t GattSrv_OnStatusRead(uint8_t *buf, uint16_t bufLen) {
    GattSrv_BuildStatusJson((char *)buf, bufLen);
    return strlen((char *)buf);
}

uint16_t GattSrv_OnSerialRead(uint8_t *buf, uint16_t bufLen) {
    if (bufLen < SERIAL_NUMBER_LEN) return 0;
    memcpy(buf, g_cfg.serialNumber, SERIAL_NUMBER_LEN);
    return SERIAL_NUMBER_LEN;
}

bool GattSrv_ParseConfig(const char *line) {
    if (!line) return false;

    char lineBuf[GATT_MAX_RX_LEN];
    strncpy(lineBuf, line, sizeof(lineBuf) - 1);
    lineBuf[sizeof(lineBuf) - 1] = '\0';

    bool changed = false;
    char *pos = lineBuf;

    while (*pos) {
        while (*pos == ' ') pos++;
        if (*pos == '\0') break;

        char *eq = strchr(pos, '=');
        if (!eq) break;

        *eq = '\0';
        char *key = pos;
        char *val = eq + 1;

        char *sp = strchr(val, ' ');
        if (sp) {
            *sp = '\0';
            pos = sp + 1;
        } else {
            pos = val + strlen(val);
        }

        if (strcmp(key, "unlock") == 0) {
            g_cfg.rssiUnlockThreshold = (int16_t)atoi(val);
            changed = true;
        } else if (strcmp(key, "lock") == 0) {
            g_cfg.rssiLockThreshold = (int16_t)atoi(val);
            changed = true;
        } else if (strcmp(key, "hyst") == 0) {
            g_cfg.rssiHysteresisDb = (int16_t)atoi(val);
            changed = true;
        } else if (strcmp(key, "spike") == 0) {
            g_cfg.rssiSpikeRejectDb = (int16_t)atoi(val);
            changed = true;
        } else if (strcmp(key, "uc") == 0) {
            g_cfg.unlockCountRequired = (uint16_t)atoi(val);
            changed = true;
        } else if (strcmp(key, "lc") == 0) {
            g_cfg.lockCountRequired = (uint16_t)atoi(val);
            changed = true;
        } else if (strcmp(key, "interval") == 0) {
            g_cfg.rssiSampleIntervalMs = (uint16_t)atoi(val);
            changed = true;
        } else if (strcmp(key, "dlock") == 0) {
            g_cfg.disconnectLockDelayMs = (uint16_t)atoi(val);
            changed = true;
        } else if (strcmp(key, "q") == 0) {
            g_cfg.kf_q = (float)atof(val);
            kf.q = g_cfg.kf_q;
            Kalman_Reset(&kf);
            changed = true;
        } else if (strcmp(key, "r") == 0) {
            g_cfg.kf_r = (float)atof(val);
            kf.r = g_cfg.kf_r;
            Kalman_Reset(&kf);
            changed = true;
        } else if (strcmp(key, "rssi") == 0) {
            int16_t rssiVal = (int16_t)atoi(val);
            g_st.latestRSSI = rssiVal;
            int16_t outRssi;
            if (!SpikeReject_Process(rssiVal, g_st.filteredRSSI,
                                     g_cfg.rssiSpikeRejectDb,
                                     SPIKE_CONSECUTIVE_REQUIRED, &outRssi)) {
                g_st.filteredRSSI = Kalman_Update(&kf, (float)outRssi);
                g_st.rssiInitialized = true;
            }
        }
    }

    return changed;
}

static void handleSetName(const char *name) {
    if (!name) return;
    size_t len = strlen(name);
    if (len > MAX_CUSTOM_NAME_LEN) len = MAX_CUSTOM_NAME_LEN;
    strncpy(g_cfg.customDeviceName, name, len);
    g_cfg.customDeviceName[len] = '\0';
    Storage_SaveFromGlobal();
    GattSrv_NotifyStatus();
}

static void handleChangePin(const char *params) {
    if (!params) return;

    char paramsBuf[GATT_MAX_RX_LEN];
    strncpy(paramsBuf, params, sizeof(paramsBuf) - 1);
    paramsBuf[sizeof(paramsBuf) - 1] = '\0';

    char *colon = strchr(paramsBuf, ':');
    if (!colon) {
        g_st.pinChangeError = 2;
        GattSrv_NotifyStatus();
        g_st.pinChangeError = 0;
        return;
    }

    *colon = '\0';
    char *oldPin = paramsBuf;
    char *newPin = colon + 1;

    uint8_t err = 0;
    if (!BLESec_ChangePin(oldPin, newPin, &err)) {
        g_st.pinChangeError = err;
        GattSrv_NotifyStatus();
        g_st.pinChangeError = 0;
        return;
    }

    g_st.pinChangeError = 0;
}

void GattSrv_HandleCommand(const char *cmd) {
    if (!cmd || strlen(cmd) == 0) return;

    char upperCmd[GATT_MAX_RX_LEN];
    strncpy(upperCmd, cmd, sizeof(upperCmd) - 1);
    upperCmd[sizeof(upperCmd) - 1] = '\0';
    for (size_t i = 0; i < strlen(upperCmd); i++) {
        upperCmd[i] = toupper(upperCmd[i]);
    }

    if (strncmp(upperCmd, "NAME:", 5) == 0) {
        handleSetName(cmd + 5);
        return;
    }

    if (strncmp(upperCmd, "PIN:", 4) == 0) {
        handleChangePin(cmd + 4);
        return;
    }

    if (strcmp(upperCmd, "UNLOCK") == 0) {
        Relay_ExecuteUnlock();
        g_st.currentState = STATE_UNLOCKED;
        StateMachine_Reset();
        g_st.manualCommandTimestampMs = GetSysTickMs();
        g_st.manualCommandCooldown = true;
        GattSrv_NotifyStatus();
    } else if (strcmp(upperCmd, "LOCK") == 0) {
        Relay_ExecuteLock();
        g_st.currentState = STATE_LOCKED;
        StateMachine_Reset();
        g_st.manualCommandTimestampMs = GetSysTickMs();
        g_st.manualCommandCooldown = true;
        GattSrv_NotifyStatus();
    } else if (strcmp(upperCmd, "TRUNK") == 0) {
        Relay_ExecuteTrunk();
        GattSrv_NotifyStatus();
    } else if (strcmp(upperCmd, "STATUS") == 0) {
        GattSrv_NotifyStatus();
    }
}

void GattSrv_OnConfigWrite(const uint8_t *data, uint16_t len) {
    if (!data || len == 0) return;
    if (len >= GATT_MAX_RX_LEN) len = GATT_MAX_RX_LEN - 1;

    char buf[GATT_MAX_RX_LEN];
    memcpy(buf, data, len);
    buf[len] = '\0';

    if (GattSrv_ParseConfig(buf)) {
        Storage_SaveFromGlobal();
        GattSrv_NotifyStatus();
    }
}

void GattSrv_OnCommandWrite(const uint8_t *data, uint16_t len) {
    if (!data || len == 0) return;
    if (len >= GATT_MAX_RX_LEN) len = GATT_MAX_RX_LEN - 1;

    char buf[GATT_MAX_RX_LEN];
    memcpy(buf, data, len);
    buf[len] = '\0';

    char *trimmed = buf;
    while (*trimmed == ' ' || *trimmed == '\r' || *trimmed == '\n') trimmed++;
    size_t tlen = strlen(trimmed);
    while (tlen > 0 && (trimmed[tlen - 1] == ' ' || trimmed[tlen - 1] == '\r' || trimmed[tlen - 1] == '\n')) {
        trimmed[--tlen] = '\0';
    }

    GattSrv_HandleCommand(trimmed);
}
