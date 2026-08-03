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
/* ★ fix22: 0x0004 原为 SBP_READ_RSSI_EVT（独立定期读 RSSI，每 500ms 一次唤醒）。
 *   现 RSSI 读取已合并到 KeyGo_ProcessStateMachine 内联（每 2 tick 读一次），
 *   消除一个独立睡眠→唤醒周期，省 ~40µA。0x0004 位释放可用。 */
#define SBP_PARAM_UPDATE_EVT        0x0008  // 更新连接参数
/* ★ v3.36.3-fix19 (P6 低功耗): 复用 0x0010 位作为「广播降速」定时器事件。
 *   原 SBP_PHY_UPDATE_EVT(0x0010) 从未作为 TMOS 任务事件被 tmos_start_task/事件处理使用
 *   （PHY 更新走 GAP_MSG_EVENT 的 GAP_PHY_UPDATE_EVENT 消息分支，与任务事件位是两套命名空间），
 *   故此位长期空闲，安全复用。0x0001~0x4000 其余 14 位已满，0x8000=SYS_EVENT_MSG 保留。 */
#define SBP_ADV_SLOWDOWN_EVT        0x0010  // ★ P6: 快广播窗口到期 → 切慢速广播
#define SBP_BATTERY_CHECK_EVT       0x0020  // ★ v3.13: 电池电量检测
#define SBP_STATE_MACHINE_EVT       0x0080  // 状态机轮询
#define SBP_GPIO_PULSE_END_EVT      0x0100  // GPIO 脉冲结束（非阻塞延迟）
/* ★ v3.16-#4: SBP_COMMAND_PARSE_EVT (0x0200) 已移除 — 全代码库无引用，死定义
 *   命令解析直接通过 simpleProfileChangeCB → KeyGo_HandleCommand 同步执行，
 *   不需要 TMOS 事件。释放 0x0200 位供未来使用。 */
/* ★ 骑行退出链式上锁事件（0x0040，原 LED_RIDE_BLINK 位）：
 *   解锁脉冲结束(SBP_GPIO_PULSE_END_EVT)后，延迟本事件输出 LOCK，完成「先解锁退出骑行→上锁」。
 *   改独立事件（不再依赖状态机 125ms 轮询）的好处：①时序确定(延迟 tick 精确)；
 *   ②HAL_SLEEP 下 TMOS 由 RTC 唤醒触发，比状态机轮询更可靠。 */
#define SBP_RIDE_EXIT_LOCK_EVT       0x0040
/* [LED_REMOVED] 后备箱 LED 闪烁事件已删除：LED 改为跟随 GPIO 脉冲，腾出 0x0200 仍空闲可用。 */
#define SBP_ADV_RESTART_EVT         0x0400  // ★ v3.13: advertising 重启兜底（BLE Controller 偶发卡死时重试）
#define SBP_DISCONNECT_LOCK_EVT     0x0800  // ★ v3.15-#15: 断连延时锁车（c. disconnectLockMs）
#define SBP_DEFERRED_STATUS_EVT     0x1000  // ★ 2026-07-10: 绑定层短报文(BIND:OK等)后延迟发状态，避免抢占通知队列导致短报文被丢
#define SBP_DEFERRED_RAW_EVT        0x2000  // ★ 2026-07-11: 绑定层短报文(BIND:/NONCE:/AUTH:/UNBIND:/DENY:)延迟发送队列消费。原实现在 FF03 写回调内同步发通知，写事务缓冲区仍占用（且 BIND 紧跟 Bonding_Save Flash 写会关中断/占总线）→ GATT_bm_alloc 偶发失败、通知被丢。改为写回调只入队 + 启动本事件，由 TMOS 任务在写回调之外逐个发送（与 status 同可靠通道）。
#define SBP_UNBOUND_TIMEOUT_EVT     0x4000  // ★ 方案A（2026-07-12）：未鉴权连接超时后延迟强断（先让 BIND:TIMEOUT 通知 flush 再断链）
/* ★ 注意：RIDE 事件位严禁用 0x8000！0x8000 是 OSAL/TMOS 的 SYS_EVENT_MSG 保留位
 *   （见 LIB/CH58xBLE_ROM.h: SYS_EVENT_MSG=0x8000）。Peripheral_ProcessEvent 顶部
 *   `if(events & SYS_EVENT_MSG) return (events ^ SYS_EVENT_MSG);` 会先把 0x8000 当系统消息
 *   处理并清掉，导致 KeyGo_RidePulseHandler 永远到不了 → ebike 点骑行后蓝 LED 永久常亮
 *   （car 后备箱用 0x0100 不受影响才正常）。故 RIDE 改到空闲位 0x0200（原 COMMAND_PARSE 已删、确认空闲）。 */
#define SBP_GPIO_RIDE_EVT         0x0200  // ★ Phase 2: ebike RIDE 双脉冲序列回调（务必避开 0x8000=SYS_EVENT_MSG）

// ── 定时周期 (单位: TMOS tick ≈ 0.625ms) ──
#define SBP_PERIODIC_EVT_PERIOD        3200   // ~2s  系统状态更新 (fix21: 1s→2s)
/* ★ fix22: SBP_READ_RSSI_EVT_PERIOD 已移除 — RSSI 读取合并到状态机内联，不再独立定时 */
#define SBP_STATE_MACHINE_PERIOD       1600   // ~1s  状态机轮询 (fix22: 500ms→1s, 连接态二次省电)
#define SBP_PARAM_UPDATE_DELAY         6400   // ~4s   连接参数更新
#define SBP_ADV_RESTART_DELAY          320    // ★ v3.13: ~200ms advertising 恢复延迟（给 BLE Controller 缓冲时间）
#define SBP_ADV_RESTART_MAX_RETRIES    3      // ★ v3.13: 最多重试 3 次（总计 ~800ms 恢复窗口）
#define SBP_BATTERY_CHECK_PERIOD        48000  // ★ v3.13: ~30s 电池检测间隔

// ── GPIO 脉冲宽度 (TMOS tick, 1 tick ≈ 0.625ms) ──
/* ★ 人按键手感（2026-07-30）：人按遥控按键一般较慢。解锁/锁车/喇叭改为 ~500ms（模拟真人较慢的单击手感）；
 *   后备箱保持 5s（模拟车钥匙后备箱）。RIDE 双脉冲见下。 */
#define GPIO_PULSE_LOCK_TICKS          800    // ~500ms  解锁/锁车/喇叭（真人较慢单击手感）
#define GPIO_PULSE_TRUNK_TICKS         8000    // ~5000ms  后备箱长按（模拟车钥匙后备箱 5s）
/* ★ Phase 2: ebike RIDE 双脉冲（模拟电动车遥控双击启动骑行）
 *   —— 这两个值决定「点击速度」，可按真车遥控器手感调整 ——
 *   序列: ON(RIDE_HALF_TICKS) → OFF(RIDE_GAP_TICKS) → ON(RIDE_HALF_TICKS) → OFF
 *   默认约 350ms 按下 / 200ms 间隔（真人较慢双击，肉眼清晰识别为「按两下」而非常亮）。
 *   1 tick ≈ 0.625ms */
#define RIDE_HALF_TICKS             560     // ~350ms  「按下」时长（双击中每一次，真人较慢单击手感）
#define RIDE_GAP_TICKS              320     // ~200ms  两次点击间隔（清晰分开两次按下）
#define RIDE_EXIT_LOCK_DELAY_TICKS  3200    // ~2000ms  解锁脉冲结束后延迟 2s 输出 LOCK（先解锁退出骑行，隔 2s 再上锁）


// 广播间隔 = N × 0.625ms    （范围 20~10,240 → 12.5ms~6.4s）
#define DEFAULT_ADVERTISING_INTERVAL     80   // 50ms

/* ★ v3.36.3-fix19 (P6 低功耗): 断连/上电后「快广播窗口 + 慢速待机」两段式广播。
 *   动机：断连态原一直 50ms 高频广播（bonding.c 自注"20ms 较耗电"），是待机最大耗电点。
 *   策略：上电/断连后先保持快广播 ADV_FAST_WINDOW_TICKS（用户主动靠近时即时发现），
 *         窗口到期切慢速 ADV_SLOW_INT_TICKS（省电），一连上连接即取消定时器。
 *   ★ 一键开关：ADV_SLOWDOWN_ENABLE=0 即完全回到旧行为（恒 50ms 快广播），回归可秒关。
 *   ★ 安全约束：慢速仅影响「可发现性/重连速度」，不改连接参数、不触发任何控制逻辑；
 *         慢速下重连/自动解锁发现变慢约 +1~2s（代价，需真机权衡）。 */
#define ADV_SLOWDOWN_ENABLE          1      // 1=启用 P6 广播降速；0=关闭(恒快广播，旧行为)
#define ADV_FAST_WINDOW_TICKS       16000   // ★ 快广播窗口时长 ≈10s（= N×0.625ms）。可按产品调：30s=48000
#define ADV_FAST_WINDOW_MS          (ADV_FAST_WINDOW_TICKS * 5 / 4)   // ≈10000ms，仅日志用
#define ADV_SLOW_INT_TICKS          8000    // ★ 低功耗: 慢速广播间隔 =5s（=8000×0.625ms）; 发现变慢+2~3s (fix21: 2s→5s)
#define ADV_SLOW_INT_MS             (ADV_SLOW_INT_TICKS * 5 / 4)       // =5000ms，仅日志用

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
#define DEFAULT_DESIRED_MAX_CONN_INTERVAL    320   // 400ms   (fix21 P3-C: 125ms→400ms，连接事件频率降至 ~1/3)
/* ★ P3-A（v3.36.3-fix18）+ P3-C（fix21）低功耗连接参数：
 *   从机延迟 4（可跳过最多 4 个连接事件）+ MAX interval 400ms。
 *   有效间隔: 400ms × (4+1) = 2000ms（iOS 上限），射频收发降至约 1/3.2（vs 原 1/5）。
 *   自动解锁最大延迟由 <125ms 升至 <2s（略慢但可接受）。
 *   ★ 安全约束（必须满足，否则手机会拒绝/频繁断连）：
 *      BLE spec: (latency+1) × max_interval × 2 < timeout
 *      = 5 × 400ms × 2 = 4000ms < 6000ms(600×10ms) ✓
 *      iOS 软限: (latency+1) × max_interval ≤ 2s → 5 × 400ms = 2s ✓ 刚好卡线上。
 *      Android 完全兼容 400ms 间隔。
 *   ★ 回退：若连接异常/解锁太慢，将 MAX_INTERVAL 改回 100(125ms) 即可。 */
#define DEFAULT_DESIRED_SLAVE_LATENCY        4
#define DEFAULT_DESIRED_CONN_TIMEOUT         600   // 6s      连接超时   = N × 10ms       （范围 10~3,200 → 100ms~32s）

// Company Identifier: WCH
#define WCH_COMPANY_ID                       0x07D7

/*********************************************************************
 * TYPEDEFS
 */

// ── 连接状态 (对齐 ESP32) ──
typedef enum {
    KSTATE_LOCKED   = 0,
    KSTATE_UNLOCKED = 1,
    KSTATE_ACTION   = 2,
    KSTATE_RIDE     = 3   // ★ v3.36.3-fix8: 电瓶车骑行态（解锁+启动骑行），状态报文 st 报 "RIDE"，App 显示「骑行模式」
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
