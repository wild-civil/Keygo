#ifndef __GATT_SERVICE_H__
#define __GATT_SERVICE_H__

#include "config.h"

/* ============================================================
 *  GATT 服务应用层逻辑
 *  FF00 Service
 *    FF01: Write (配置)
 *    FF02: Read + Notify (状态 JSON)
 *    FF03: Write (命令)
 *    FF04: Read (序列号)
 *
 *  注意: 此文件只包含应用层逻辑
 *  BLE 协议栈底层回调需要在主程序中适配 WCH BLE 库
 * ============================================================ */

#define GATT_MAX_RX_LEN    256
#define GATT_MAX_TX_LEN    512

void GattSrv_Init(void);

void GattSrv_OnConfigWrite(const uint8_t *data, uint16_t len);
void GattSrv_OnCommandWrite(const uint8_t *data, uint16_t len);
uint16_t GattSrv_OnStatusRead(uint8_t *buf, uint16_t bufLen);
uint16_t GattSrv_OnSerialRead(uint8_t *buf, uint16_t bufLen);

void GattSrv_BuildStatusJson(char *buf, uint16_t bufLen);
void GattSrv_NotifyStatus(void);

bool GattSrv_ParseConfig(const char *line);
void GattSrv_HandleCommand(const char *cmd);

extern void (*gattNotifyCallback)(uint16_t connHandle, const uint8_t *data, uint16_t len);
extern void (*gattDisconnectCallback)(uint16_t connHandle);

#endif
