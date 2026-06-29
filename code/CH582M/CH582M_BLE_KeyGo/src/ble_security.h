#ifndef __BLE_SECURITY_H__
#define __BLE_SECURITY_H__

#include "config.h"

/* ============================================================
 *  BLE 安全 / Bonding 模块
 *  LE Secure Connections + 静态 PIN
 *
 *  注意: 此文件包含应用层安全逻辑
 *  底层 SM 回调需要在主程序中适配 WCH BLE 库
 * ============================================================ */

void BLESec_Init(void);
bool BLESec_ValidatePin(const char *pin);
bool BLESec_ChangePin(const char *oldPin, const char *newPin, uint8_t *errorCode);
void BLESec_DeleteAllBonds(void);
int  BLESec_CountBondedDevices(void);

bool BLESec_IsEncryptionEnabled(void);
void BLESec_SetEncryptionState(bool encrypted);

void BLESec_OnPassKeyRequest(void);
void BLESec_OnAuthComplete(bool success);

#endif
