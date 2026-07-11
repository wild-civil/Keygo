/********************************** (C) COPYRIGHT *******************************
 * File Name          : peripheral.h
 * Author             : KeyGo v3.13 (CH582M)
 * Date               : 2026/07/02
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
#define SBP_BATTERY_CHECK_EVT       0x0020  // ★ v3.13: 电池电量检测
#define SBP_STATE_MACHINE_EVT       0x0080  // 状态机轮询
#define SBP_GPIO_PULSE_END_EVT      0x0100  // GPIO 脉冲结束（非阻塞延迟）
/* ★ v3.16-#4: SBP_COMMAND_PARSE_EVT (0x0200) 已移除 — 全代码库无引用，死定义
 *   命令解析直接通过 simpleProfileChangeCB → KeyGo_HandleCommand 同步执行，
 *   不需要 TMOS 事件。释放 0x0200 位供未来使用。 */
/* [LED_BEGIN] ──────── 后备箱 LED 闪烁 ────────
 *   复用 0x0200 位 — 直接操作 GPIO PB4，绕过 HAL LED 层避免竞态
 *   500ms ON / 500ms OFF ×5 次 = 5s 总时长
 *   低功耗: 去掉 LED 时注释掉这个事件 —──── [LED_END] */
#define SBP_LED_TRUNK_BLINK_EVT     0x0200
#define SBP_ADV_RESTART_EVT         0x0400  // ★ v3.13: advertising 重启兜底（BLE Controller 偶发卡死时重试）
#define SBP_DISCONNECT_LOCK_EVT     0x0800  // ★ v3.15-#15: 断连延时锁车（c. disconnectLockMs）
#define SBP_DEFERRED_STATUS_EVT     0x1000  // ★ 2026-07-10: 绑定层短报文(BIND:OK等)后延迟发状态，避免抢占通知队列导致短报文被丢
#define SBP_DEFERRED_RAW_EVT        0x2000  // ★ 2026-07-11: 绑定层短报文(BIND:/NONCE:/AUTH:/UNBIND:/DENY:)延迟发送队列消费。原实现在 FF03 写回调内同步发通知，写事务缓冲区仍占用（且 BIND 紧跟 Bonding_Save Flash 写会关中断/占总线）→ GATT_bm_alloc 偶发失败、通知被丢。改为写回调只入队 + 启动本事件，由 TMOS 任务在写回调之外逐个发送（与 status 同可靠通道）。

// ── 定时周期 (单位: TMOS tick ≈ 0.625ms) ──
#define SBP_PERIODIC_EVT_PERIOD        1600   // ~1s  系统状态更新
#define SBP_READ_RSSI_EVT_PERIOD       800    // ~500ms RSSI 读取
#define SBP_STATE_MACHINE_PERIOD       200    // ~125ms 状态机轮询
#define SBP_PARAM_UPDATE_DELAY         6400   // ~4s   连接参数更新
#define SBP_ADV_RESTART_DELAY          320    // ★ v3.13: ~200ms advertising 恢复延迟（给 BLE Controller 缓冲时间）
#define SBP_ADV_RESTART_MAX_RETRIES    3      // ★ v3.13: 最多重试 3 次（总计 ~800ms 恢复窗口）
#define SBP_BATTERY_CHECK_PERIOD        48000  // ★ v3.13: ~30s 电池检测间隔

// ── GPIO 脉冲宽度 (TMOS tick, 1 tick ≈ 0.625ms) ──
#define GPIO_PULSE_LOCK_TICKS          320    // ~200ms  解锁/锁车
#define GPIO_PULSE_TRUNK_TICKS         3200    // ~2000ms  后备箱长按
/* [LED_BEGIN] 后备箱 LED 闪烁半周期 (500ms = 800 ticks) [LED_END] */
#define LED_TRUNK_BLINK_TICKS          800

// 广播间隔 = N × 0.625ms    （范围 20~10,240 → 12.5ms~6.4s）
#define DEFAULT_ADVERTISING_INTERVAL     80   // 50ms

// 连接参数
/* ──────────────────────────────────────────────────────────────────
 * 连接参数调优 (v3.15 分析记录, 暂未实施)
 *
 * 当前值:
 *   MIN interval=6  (7.5ms)  — 激进, 部分国产 ROM 最低只支持 15ms
 *   MAX interval=100 (125ms)
 *   Latency=0                — 每次连接事件必须响应
 *   Timeout=100    (1s)      — 1s 无通信即断开
 *
 * 待观察指标:
 *   反复出现"扫描到了但连接失败" → 优先改 MIN→12 (15ms)
 *   弱信号环境频繁闪断           → 考虑 Timeout→200 (2s) 或启用 Latency
 *
 * 改动方案 A: MIN interval 6→12 (15ms) — 推荐优先实施
 *   + 兼容性大幅提升: 多数国产 ROM 最低 11.25~15ms, 7.5ms 可能被拒绝
 *   + 省电 ~50%: 连接事件频率减半 (133→66 次/s)
 *   + 弱信号更稳: 丢包后有更长重传窗口
 *   - RSSI 采样频率减半 (~80→~40 次/s), 但有 Kalman 滤波器, 足够
 *   - BLE 吞吐量减半 (~17→~8 KB/s), KeyGo 只传几十字节 JSON, 无影响
 *
 * 改动方案 B: Timeout 100→200 (1s→2s) — 视实际情况决定
 *   + 弱信号容错增加: 扛过短时遮挡 (手机放口袋/转身 1~2s)
 *   - 用户走出范围后 APP 要 2s 才知道断连, 体验变差
 *   - 断连自动锁车延迟增加
 *   x 不建议超过 2s (锁控设备 "快速感知断开" 比 "容忍弱信号" 更重要)
 *
 * 备选方案 C: 不改 Timeout, 启用 Latency (e.g. Latency=3)
 *   + 容许多次连接事件不响应, 但物理超时不变
 *   + 即保留 1s 快速检测, 又容忍短时遮挡
 *   x 需两端协商, Android 支持不一
 *
 * 如何改动:
 *   仅修改此文件中的宏值即可, 会自动传播到:
 *     peripheral.c → 广播数据 / 连接请求 / 参数更新请求
 * ────────────────────────────────────────────────────────────────── */
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
    uint8_t  peerAddr[6];     // ★ 对端手机 BLE MAC（链路建立时填充，供绑定/鉴权使用）
    uint8_t  peerAddrType;    // ★ ADDRTYPE_PUBLIC / ADDRTYPE_RANDOM
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
