/********************************** (C) COPYRIGHT *******************************
 * File Name          : keygo_core.h
 * Author             : KeyGo v3.5 (CH582M)
 * Date               : 2026/06/30
 * Description        : GPIO + Kalman + RSSI + 状态机 + 通知 + 命令
 *********************************************************************************/

#ifndef KEYGO_CORE_H
#define KEYGO_CORE_H

#include "peripheral.h"

/* ─────────────────────────────────────────────────────────────────
 * 公开接口
 * ───────────────────────────────────────────────────────────────── */

// 工具函数 (TMOS → ms)
uint32_t Peripheral_GetSystemMs(void);

// GPIO 控制
void KeyGo_GPIO_Init(void);
void KeyGo_Unlock(void);
void KeyGo_Lock(void);
void KeyGo_Trunk(void);
void KeyGo_KeyPower(uint8_t on);

// Kalman 滤波
void KeyGo_ResetKalman(void);

// 重置全部运行时状态 (连接/断连时调用)
void KeyGo_ResetState(void);

// RSSI 处理
void KeyGo_RssiProcess(int8_t rssi);

// 状态机
void KeyGo_ProcessStateMachine(void);

// JSON 状态通知 (FF02 Notify)
void KeyGo_NotifyStatus(void);

// 命令处理 (NAME/TRUNK/UNLOCK/LOCK)
void KeyGo_HandleCommand(const char *cmd, uint16_t len);

#endif
