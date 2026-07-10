/********************************** (C) COPYRIGHT *******************************
 * File Name          : gattprofile.h
 * Author             : KeyGo v3.5 (CH582M 移植)
 * Date               : 2026/06/30
 * Description        : BLE Key-Go GATT 服务 (UUID=0xFF00)
 *                       FF01: RSSI 写入 (WO, 无加密)
 *                       FF02: 状态通知 (Notify, 无加密)
 *                       FF03: 命令写入 (WO, 无加密)
 *                       FF04: 设备序列号 (RO, 无加密)
 *                       连接即可读写，无加密要求
 *********************************************************************************/

#ifndef GATTPROFILE_H
#define GATTPROFILE_H

#ifdef __cplusplus
extern "C" {
#endif

#include "CONFIG.h"

/*********************************************************************
 * CONSTANTS
 */

// Profile Parameter IDs
#define SIMPLEPROFILE_CHAR1         0  // FF01: RSSI 值 (Write Only)
#define SIMPLEPROFILE_CHAR2         1  // FF02: 状态通知 (Notify)
#define SIMPLEPROFILE_CHAR3         2  // FF03: 命令 (Write Only)
#define SIMPLEPROFILE_CHAR4         3  // FF04: 序列号 (Read Only)

// Simple Profile Service UUID
#define SIMPLEPROFILE_SERV_UUID     0xFF00

// Characteristic UUIDs (与 ESP32 v3.5 保持一致)
#define SIMPLEPROFILE_CHAR1_UUID    0xFF01   // RSSI input
#define SIMPLEPROFILE_CHAR2_UUID    0xFF02   // Status notify (v3.5: was FF04)
#define SIMPLEPROFILE_CHAR3_UUID    0xFF03   // Command input
#define SIMPLEPROFILE_CHAR4_UUID    0xFF04   // Serial read

// Service bit field
#define SIMPLEPROFILE_SERVICE       0x00000001

// ★ v3.5: Characteristic buffer lengths (MTU=23 默认, 建议协商至 247+)
//   ★ v3.5.1: FF01 从 20→80 — 需容纳配置字符串 "unlock=-39 lock=-46 uc=2 lc=3 dlock=5000" (~45 字节)
#define SIMPLEPROFILE_CHAR1_LEN     80    // FF01: RSSI 注入 + 配置下发 (key=value 格式)
#define SIMPLEPROFILE_CHAR2_LEN     200   // FF02: JSON 状态
#define SIMPLEPROFILE_CHAR3_LEN     80    // FF03: 命令文本（含 AUTH:<64hex> ≈ 69 字节）
#define SIMPLEPROFILE_CHAR4_LEN     12    // FF04: 序列号 (12 hex chars)

/*********************************************************************
 * TYPEDEFS
 */

// Callback when a characteristic value has changed
typedef void (*simpleProfileChange_t)(uint8_t paramID, uint8_t *pValue, uint16_t len);

typedef struct
{
    simpleProfileChange_t pfnSimpleProfileChange; // Called when characteristic value changes
} simpleProfileCBs_t;

/*********************************************************************
 * API FUNCTIONS
 */

extern bStatus_t SimpleProfile_AddService(uint32_t services);
extern bStatus_t SimpleProfile_RegisterAppCBs(simpleProfileCBs_t *appCallbacks);
extern bStatus_t SimpleProfile_SetParameter(uint8_t param, uint16_t len, void *value);
extern bStatus_t SimpleProfile_GetParameter(uint8_t param, void *value);

/*
 * simpleProfile_Notify - Send notification via FF02
 *   connHandle - connection handle
 *   pNoti      - pointer to notification structure
 */
extern bStatus_t simpleProfile_Notify(uint16_t connHandle, attHandleValueNoti_t *pNoti);

extern uint16_t simpleProfile_GetHandle(uint8_t charID);

/*********************************************************************
*********************************************************************/

#ifdef __cplusplus
}
#endif

#endif
