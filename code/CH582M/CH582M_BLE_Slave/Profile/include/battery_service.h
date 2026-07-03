/********************************** (C) COPYRIGHT *******************************
 * File Name          : battery_service.h
 * Author             : KeyGo v3.13
 * Date               : 2026/07/03
 * Description        : BLE Battery Service (0x180F) header
 *                      Battery Level characteristic (0x2A19): Read + Notify
 *********************************************************************************/

#ifndef __BATTERY_SERVICE_H__
#define __BATTERY_SERVICE_H__

#ifdef __cplusplus
extern "C" {
#endif

#include "CONFIG.h"

/* ── Service UUID ── */
#define BATT_SERV_UUID       0x180F

/* ── Characteristic UUID ── */
#define BATT_LEVEL_UUID      0x2A19
#define BATT_LEVEL_LEN       1          // uint8_t: 0 ~ 100 (%)
#define BATT_LEVEL_VALUE_POS 2          // index of Battery Level Value in attribute table

/* ── API ── */
bStatus_t  Battery_AddService(void);
void       Battery_UpdateLevel(void);
uint8_t    Battery_GetLevel(void);
void       Battery_Notify(void);           // 手动触发 Notify

#ifdef __cplusplus
}
#endif

#endif /* __BATTERY_SERVICE_H__ */
