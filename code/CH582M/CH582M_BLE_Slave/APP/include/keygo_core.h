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

/* ─────────────────────────────────────────────────────────────────
 * ★ v3.5: 可运行时配置的 RSSI 阈值 (替代原来的 #define 硬编码)
 *    由 App 通过 FF01 下发，KeyGo_ParseConfig() 解析并更新
 * ───────────────────────────────────────────────────────────────── */
extern int16_t g_cfgUnlockThreshold;     // RSSI 解锁阈值 (默认 -55)
extern int16_t g_cfgLockThreshold;       // RSSI 锁车阈值 (默认 -75)
extern uint8_t g_cfgUnlockCount;         // 解锁需连续满足次数 (默认 3)
extern uint8_t g_cfgLockCount;           // 锁车需连续满足次数 (默认 5)
extern uint16_t g_cfgDisconnectLockMs;   // 断连自动锁车延时 ms (默认 5000)

// ★ FF01 配置解析: "unlock=-30 lock=-45 uc=2 lc=3 interval=500 dlock=5000"
//    返回: 0=无配置变更, 1=有配置变更需通知 App
uint8_t KeyGo_ParseConfig(const char *line);

#endif
