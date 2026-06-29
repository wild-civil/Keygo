#include "ble_security.h"
#include "config_storage.h"
#include "gatt_service.h"

#include <string.h>
#include <stdio.h>
#include <ctype.h>

/* ============================================================
 *  BLE 安全 / Bonding 模块
 *  应用层逻辑：PIN 管理、绑定设备计数、旧 bond 检测
 *
 *  底层 SM (Security Manager) 回调需要在主程序中适配
 *  WCH BLE 库的 SM 接口
 * ============================================================ */

static bool encryption_enabled = false;

void BLESec_Init(void) {
    encryption_enabled = false;
}

bool BLESec_ValidatePin(const char *pin) {
    if (!pin) return false;
    size_t len = strlen(pin);
    if (len < MIN_PIN_LEN || len > MAX_PIN_LEN) return false;
    for (size_t i = 0; i < len; i++) {
        if (!isdigit((unsigned char)pin[i])) return false;
    }
    return true;
}

bool BLESec_ChangePin(const char *oldPin, const char *newPin, uint8_t *errorCode) {
    if (!oldPin || !newPin) {
        if (errorCode) *errorCode = 2;
        return false;
    }

    if (strcmp(oldPin, g_cfg.pairingPin) != 0) {
        if (errorCode) *errorCode = 1;
        return false;
    }

    if (!BLESec_ValidatePin(newPin)) {
        if (errorCode) *errorCode = 2;
        return false;
    }

    BLESec_DeleteAllBonds();

    strncpy(g_cfg.pairingPin, newPin, MAX_PIN_LEN);
    g_cfg.pairingPin[MAX_PIN_LEN] = '\0';
    g_cfg.pinDefault = (strcmp(g_cfg.pairingPin, DEFAULT_PAIRING_PIN) == 0);
    Storage_SaveFromGlobal();

    if (errorCode) *errorCode = 0;
    return true;
}

void BLESec_DeleteAllBonds(void) {
    g_st.hasBondedDevices = false;
    g_st.encryptionEstablished = false;
    g_st.wasBondedOnConnect = false;
    g_st.securityRequestPending = false;

    g_cfg.customDeviceName[0] = '\0';
    Storage_SaveFromGlobal();

    if (g_st.deviceConnected && gattDisconnectCallback) {
        gattDisconnectCallback(g_st.connectionHandle);
    }
}

int BLESec_CountBondedDevices(void) {
    return g_st.hasBondedDevices ? 1 : 0;
}

bool BLESec_IsEncryptionEnabled(void) {
    return encryption_enabled;
}

void BLESec_SetEncryptionState(bool encrypted) {
    encryption_enabled = encrypted;
    g_st.encryptionEstablished = encrypted;
    if (encrypted) {
        g_st.hasBondedDevices = true;
    }
}

void BLESec_OnPassKeyRequest(void) {
    if (g_st.hasBondedDevices) {
        BLESec_DeleteAllBonds();
    }
}

void BLESec_OnAuthComplete(bool success) {
    if (success) {
        g_st.hasBondedDevices = true;
        g_st.encryptionEstablished = true;
        encryption_enabled = true;
    } else {
        if (g_st.hasBondedDevices) {
            BLESec_DeleteAllBonds();
        }
        g_st.encryptionEstablished = false;
        encryption_enabled = false;
    }
    GattSrv_NotifyStatus();
}

uint32_t BLESec_GetPinCode(void) {
    return (uint32_t)atoi(g_cfg.pairingPin);
}
