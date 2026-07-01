/********************************** (C) COPYRIGHT *******************************
 * File Name          : peripheral.h
 * Author             : KeyGo v3.5 (CH582M 移植)
 * Date               : 2026/06/30
 * Description        : BLE Key-Go 主应用 — 事件定义 & 全局结构体
 *********************************************************************************/

#ifndef PERIPHERAL_H
#define PERIPHERAL_H

#ifdef __cplusplus
extern "C" {
#endif

/*********************************************************************
 * INCLUDES
 */
#include "CONFIG.h"

/*********************************************************************
 * CONSTANTS
 */

// ── TMOS 事件掩码 ──
#define SBP_START_DEVICE_EVT        0x0001  // 启动设备 (GAP Role)
#define SBP_PERIODIC_EVT            0x0002  // 周期性任务 (状态机 + 通知)
#define SBP_READ_RSSI_EVT           0x0004  // 读取 RSSI
#define SBP_PARAM_UPDATE_EVT        0x0008  // 更新连接参数
#define SBP_PHY_UPDATE_EVT          0x0010  // PHY 更新
#define SBP_STATE_MACHINE_EVT       0x0080  // 状态机轮询
#define SBP_GPIO_PULSE_END_EVT      0x0100  // GPIO 脉冲结束（非阻塞延迟）
#define SBP_COMMAND_PARSE_EVT       0x0200  // 命令解析

// ── 定时周期 (单位: TMOS tick ≈ 0.625ms) ──
#define SBP_PERIODIC_EVT_PERIOD        1600   // ~1s  系统状态更新
#define SBP_READ_RSSI_EVT_PERIOD       800    // ~500ms RSSI 读取
#define SBP_STATE_MACHINE_PERIOD       200    // ~125ms 状态机轮询
#define SBP_PARAM_UPDATE_DELAY         6400   // ~4s   连接参数更新

// ── GPIO 脉冲宽度 (TMOS tick, 1 tick ≈ 0.625ms) ──
#define GPIO_PULSE_LOCK_TICKS          320    // ~200ms  解锁/锁车
#define GPIO_PULSE_TRUNK_TICKS         3200    // ~2000ms  后备箱长按

// 广播间隔 = N × 0.625ms    （范围 20~10,240 → 12.5ms~6.4s）
#define DEFAULT_ADVERTISING_INTERVAL     80   // 50ms

// 连接参数
#define DEFAULT_DESIRED_MIN_CONN_INTERVAL    6     // 7.5ms   连接间隔   = N × 1.25ms     （范围 6~3,200 → 7.5ms~4s）
#define DEFAULT_DESIRED_MAX_CONN_INTERVAL    100   // 125ms
#define DEFAULT_DESIRED_SLAVE_LATENCY        0
#define DEFAULT_DESIRED_CONN_TIMEOUT         100   // 1s      连接超时   = N × 10ms       （范围 10~3,200 → 100ms~32s）

// Company Identifier: WCH
#define WCH_COMPANY_ID                       0x07D7

/*********************************************************************
 * TYPEDEFS
 */

// ── 连接状态 (对齐 ESP32) ──
typedef enum {
    KSTATE_LOCKED   = 0,
    KSTATE_UNLOCKED = 1,
    KSTATE_ACTION   = 2
} KeyState_t;

// ── 连接信息 ──
typedef struct
{
    uint16_t connHandle;
    uint16_t connInterval;
    uint16_t connSlaveLatency;
    uint16_t connTimeout;
} peripheralConnItem_t;

// ── Kalman 滤波器 (1D) ──
typedef struct {
    float Q;          // 过程噪声
    float R;          // 测量噪声
    float P;          // 估计协方差
    float K;          // Kalman gain
    float X;          // 状态估计
    uint8_t  init;    // 是否已初始化
} KalmanFilter1D_t;

/*********************************************************************
 * GLOBAL VARIABLES (extern)
 */

// 核心状态 
extern KeyState_t g_keyState;
extern uint8_t    g_deviceConnected;

// 任务 ID（keygo_core 需要 tmos_start_task）
extern uint8_t    Peripheral_TaskID;

// 连接列表
extern peripheralConnItem_t peripheralConnList;

/*********************************************************************
 * FUNCTIONS
 */

// 主初始化
extern void Peripheral_Init(void);

// 事件处理 (TMOS)
extern uint16_t Peripheral_ProcessEvent(uint8_t task_id, uint16_t events);

/*********************************************************************
*********************************************************************/

#ifdef __cplusplus
}
#endif

#endif
