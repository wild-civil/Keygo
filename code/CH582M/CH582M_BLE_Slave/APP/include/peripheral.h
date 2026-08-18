/********************************** (C) COPYRIGHT *******************************
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
#define SBP_ADV_ULTRA_SLOW_EVT      0x0004  // [废弃] fix24 超慢广播降速事件；2026-08-05 停用（无任何启动源，处理分支已 #if 0）
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
#define SBP_PERIODIC_EVT_PERIOD        1600   // ~1s  系统状态更新 (P16: 改善RSSI响应, 代价可忽略)
/* ★ fix22: SBP_READ_RSSI_EVT_PERIOD 已移除 — RSSI 读取合并到状态机内联，不再独立定时 */
#define SBP_STATE_MACHINE_PERIOD       1600   // ~1s  状态机轮询 (P16: RSSI有效更新从~4s→~2s, 用户体验改善显著)
#define SBP_PARAM_UPDATE_DELAY         6400   // ~4s   首次连接参数更新延迟（连上后等手机稳定再请求）
#define SBP_PARAM_UPDATE_PERIOD        48000  // ★ fix23: ~30s 连接参数更新周期性重试（确保手机接受长间隔）
#define SBP_ADV_RESTART_DELAY          320    // ★ v3.13: ~200ms advertising 恢复延迟（给 BLE Controller 缓冲时间）
#define SBP_ADV_RESTART_MAX_RETRIES    3      // ★ v3.13: 最多重试 3 次（总计 ~800ms 恢复窗口）
#define SBP_BATTERY_CHECK_PERIOD       48000  // ★ v3.13: ~30s 电池检测间隔

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


/* ★ MA(seconds, ticks_per_second): 将「秒」转换为 TMOS tick 数（1 tick ≈ 0.625ms = 1600 tick/s）。
 *   用法: MA(5, 1600) = 5×1600 = 8000 ticks = 5s。用于广播/连接参数等常量定义的可读性提升。 */
#define MA(sec, tps)  ((sec) * (tps))

// 广播间隔 = N × 0.625ms    （范围 20~10,240 → 12.5ms~6.4s）
// ──────────────────────────────────────────────────────────────────

/* ★ Bonding 配对窗口广播间隔（活跃，非废弃）
 *   仅在 Bonding_ApplyPairingMode() 配对窗口内临时使用，与断连态恒定广播无关。 */
#define DEFAULT_ADVERTISING_INTERVAL     80   // 80 ticks = 50ms（非加密配对默认）；加密配对用 32 ticks = 20ms

// ── 以下为历史遗留：2026-08-05 已废弃的降速链宏 ────────────────────
//   当前策略为「断连态恒定广播、不降速」（见 KeyGo_AdvEnterFastWindow
//   与 ADV_SLOWDOWN_ENABLE），以保证可发现性。慢速/超慢/快窗降速事件
//   (SBP_ADV_SLOWDOWN_EVT / SBP_ADV_ULTRA_SLOW_EVT) 已无任何地方启动，
//   故相关处理分支与宏均为死代码。保留此处注释说明其来源，便于将来
//   若需恢复「超慢广播省电」时参考（但会牺牲可发现性，已否决）。
// #define ADV_ULTRA_SLOW_DELAY_TICKS     MA(5 * 60, 1600)  // [废弃] 5 min
// #define ADV_ULTRA_SLOW_INT_TICKS       MA(30,     1600)  // [废弃] 30 s
// #define ADV_FAST_WINDOW_TICKS       MA(3,  1600)   // [废弃] 快窗 ≈3s（No-App 曾用）
// #define ADV_FAST_WINDOW_MS          (ADV_FAST_WINDOW_TICKS * 5 / 8)
// #define ADV_FAST_WINDOW_TICKS_NOAPP MA(15, 1600)   // [废弃] No-App 快窗 ≈15s
// #define ADV_FAST_WINDOW_MS_NOAPP    (ADV_FAST_WINDOW_TICKS_NOAPP * 5 / 8)
// #define ADV_SLOW_INT_TICKS          MA(5,  1600)   // [废弃] 慢速 5s
// #define ADV_SLOW_INT_MS             (ADV_SLOW_INT_TICKS * 5 / 8)

/* ── 当前生效：恒定广播（不降速）──  */
/* 断连态恒定广播，保证手机始终可发现（用户要求，不牺牲可发现性）。
 * No-App 模式 150ms / 普通模式 120ms（现为统一 150ms，见 keygo_core.h）。 */
#define ADV_CONST_NOAPP_TICKS        240       // 150 ms
#define ADV_CONST_NORMAL_TICKS       240       // 150 ms（原 192=120ms，2026-08-05 统一为 150ms）

/* ★ ADV_SLOWDOWN_ENABLE: 保留为真以启用「恒定广播」分支。
 *   历史含义曾含降速链，现恒定广播路径下该宏仅作占位，
 *   慢速/超慢分支已在 peripheral.c 中注释为死代码。 */
#define ADV_SLOWDOWN_ENABLE          1

/* ──────────────────────────────────────────────────────────────────
 * 连接参数调优 (pm-test P15-final 经验移植到 PCB-V1)
 *
 * 当前值:
 *   MIN interval=128 (160ms)
 *   MAX interval=256 (320ms)
 *   Latency=2        — 最多跳 2 个连接事件，每轮 GATT 最慢 ~720ms
 *   Timeout=2000     — 20s 无通信即断开
 *
 * 选值依据:
 *   - 160ms MIN: 足够 BLE 稳定通信，向下兼容大部分手机
 *   - 320ms MAX: 空闲时节省连接事件频率
 *   - LATENCY=2: 平衡省电与响应速度（AUTH<15s 远低于 30s 死线）
 *   - 20s TO: (2+1)×320ms×2=1920ms < 20000ms ✓ 充足余量
 *     iOS: (2+1)×320ms=960ms ≤ 2s ✓ 余量充足
 *
 * 安全约束验证：
 *   CONN_TIMEOUT(×10ms) > MAX_INTERVAL(×1.25ms) × (latency+1) × 2
 *   = 20000ms > 320ms × 3 × 2 = 1920ms ✓
 *
 * 如何改动:
 *   仅修改此文件中的宏值即可, 会自动传播到:
 *     peripheral.c → 广播数据 / 连接请求 / 参数更新请求
 * ────────────────────────────────────────────────────────────────── */
#define DEFAULT_DESIRED_MIN_CONN_INTERVAL    128   // 160ms   连接态待机间隔下限（手机可协商在此~MAX之间）
#define DEFAULT_DESIRED_MAX_CONN_INTERVAL    256   // 320ms   连接态待机间隔上限（手机可选择 160~320ms）
/* ★ LATENCY=2: 最多跳过 2 个连接事件。每轮 GATT 最慢 (2+1)×~240=720ms，AUTH 总时长 <15s，远低于 30s 超时死线。
 *   若仍需更快 → LATENCY=0（追求最小延迟）；更省电 → LATENCY=3（需验证 AUTH 不超时）。 */
#define DEFAULT_DESIRED_SLAVE_LATENCY        2
#define DEFAULT_DESIRED_CONN_TIMEOUT         2000  // 20s     连接超时   = N × 10ms       （范围 10~3,200 → 100ms~32s）

/* ★★ 连接前广播声明快值组（2026-08-18 绑定验证提速）
 *   用于广播/扫描响应里的 Slave Connection Interval Range 字段，让手机**发起连接时**
 *   就按快间隔建立（AUTH 全程在快节奏下跑，绑定验证 ~3s → ~1~1.5s）。
 *   - 仅影响"连接建立瞬间的初始间隔"，手机可采纳也可忽略（个别 ROM 忽略→收益打折但不退化）。
 *   - AUTH 完成后由 SBP_PARAM_UPDATE_EVT 用下方 DEFAULT_DESIRED_* 调回 160~320ms/LAT=2 省电，机制零改动。
 *   - 注意：这是"声明"不是"请求"，不触发规范对从机参数更新请求的频率限制（规避 30s 拒绝窗）。
 *   - 单值组 MIN==MAX 缩小手机协商空间，提高快间隔采纳率；LAT=0 不跳事件，最低延迟。 */
#define ADV_FAST_MIN_CONN_INTERVAL    24    // 30ms    连接前广播声明：初始间隔下限
#define ADV_FAST_MAX_CONN_INTERVAL    48    // 60ms    连接前广播声明：初始间隔上限（MIN==MAX 同值）

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
