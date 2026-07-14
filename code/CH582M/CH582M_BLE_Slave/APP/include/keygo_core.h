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
 * 固件版本号（单一真源）
 * ───────────────────────────────────────────────────────────────── */
/* ★ v3.33.0: 固件版本号 — 横幅 / [INIT] FW Version / FF02 status "v" 字段共用同一宏。
 *   升级版本时只改这一处即可全局生效；App 据此做兼容性检查与烧录探针。 */
#define KEYGO_FW_VERSION   "3.33.2"

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
void KeyGo_GPIO_PulseEnd(void);    // TMOS 事件回调：结束当前 GPIO 脉冲
/* [LED_BEGIN] 后备箱 LED 闪烁 TMOS 回调 (每 500ms 翻转 PB4, 共 5 次)
 *   低功耗: 去掉 LED 时注释掉此声明 [LED_END] */
void KeyGo_LedTrunkBlinkHandler(void);
/* [LED_BEGIN] 骑行 LED 闪烁 TMOS 回调 (每 500ms 翻转 PB4, 共 2 次亮灭；参照后备箱)
 *   低功耗: 去掉 LED 时注释掉此声明 [LED_END] */
void KeyGo_LedRideBlinkHandler(void);


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

// ★ 绑定层回写报文（FF02 Notify）：BIND:/NONCE:/AUTH:/UNBIND:/DENY: 等短消息
void KeyGo_SendRawNotify(const char *msg);
void KeyGo_FlushRawNotify(void);   // ★ 2026-07-11: 延迟发送队列消费（SBP_DEFERRED_RAW_EVT 任务内调用）

/* ─────────────────────────────────────────────────────────────────
 * ★ 方案A（2026-07-12）：未鉴权连接时长限制 —— 防 DoS 占用唯一连接槽
 *   场景：攻击者持续连接但不 BIND/AUTH，占住 CH582 唯一连接槽 → 车主连不进来。
 *   做法：连接建立时记时戳；若超时(默认30s)仍未 AUTH/BIND → 下发提示并强断让槽。
 *   取消：AUTH/BIND 成功即清零计时（车主/合法用户长连不受限，手慢也不被误踢）。
 * ───────────────────────────────────────────────────────────────── */
#define UNBOUND_CONN_TIMEOUT_MS   30000   // 已连接但从未 AUTH/BIND 的超时(ms)
extern uint32_t g_unauthConnStartMs;      // 连接建立时记时戳；AUTH/BIND 成功或断连清零(=0)
void KeyGo_CancelUnauthTimer(void);       // AUTH/BIND 成功时调用，取消计时

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
extern uint8_t  g_cfgAutoLockEnable;      // ★ v3.24: 自动锁使能(1=启用 RSSI 自动锁, 0=手动模式禁用)
extern uint16_t g_cfgManualCooldownMs;   // ★ v3.7: 手动命令冷却时间 ms (默认 8000, 范围 2000~30000)
extern uint16_t g_cfgRssiPeriodMs;       // ★ v3.13: 固件 RSSI 读取间隔 ms (默认 500, 范围 100~2000)
extern uint8_t  g_cfgKalmanR;            // ★ v3.13: 卡尔曼滤波器 R 值 (默认 25, 范围 1~50)

// ★ FF01 配置解析: "unlock=-30 lock=-45 uc=2 lc=3 interval=500 dlock=5000 cooldown_ms=8000"
//    返回: 0=无配置变更, 1=有配置变更需通知 App
uint8_t KeyGo_ParseConfig(const char *line);

// ★ v3.13: RSSI 读取周期 ms → TMOS ticks 转换（供 peripheral.c 使用）
uint16_t KeyGo_GetRssiPeriodTicks(void);

// ★ v3.15-#15: 断连锁车延时 ms → TMOS ticks 转换（供 peripheral.c 使用）
//   返回 (uint16_t) 保证 ≤ 65535 ticks (~41s), g_cfgDisconnectLockMs 上限 60000ms
uint16_t KeyGo_GetDisconnectLockTicks(void);

// ── ★ v3.5.1: 配置持久化到 DataFlash (解决设备重启后阈值丢失) ──
//    ★ 2026-07-12 修复 DataFlash 地址基准：WCH 的 EEPROM_READ/WRITE 的 StartAddr 是
//      【相对 DataFlash 基地址 0x70000 的偏移】，绝非物理地址！
//      佐证：MCU.c 的 Lib_Read_Flash 用 BLE_SNV_ADDR=0x07E00(偏移) 且 SNV/LTK 工作正常。
//      正确物理地址 = 0x70000 + 偏移。原误用物理地址 0x77000 → 偏移变成 0x77000(>0x8000 上限)越界 → 全部失败。
//      物理 0x77000 = 偏移 0x7000，位于 BLE SNV(0x77E00) 之前，安全不冲突。
#define KEYGO_CFG_ADDR          0x7000      // 物理 0x77000 = 0x70000 + 0x7000
#define KEYGO_CFG_MAGIC         0x4B474346  // "KGCF"

void KeyGo_LoadConfig(void);    // 上电时从 DataFlash 恢复配置
void KeyGo_SaveConfig(void);    // 配置变更后持久化到 DataFlash

/* ─────────────────────────────────────────────────────────────────
 * ★ Phase 2: 双模式(汽车/电瓶车) — 接口声明
 *   g_deviceMode: 0=car(默认) / 1=ebike，权威值来自 DataFlash MODE_ADDR，
 *   仅在本文件(keygo_core.c)内使用（static），故不在此声明。
 *   状态 JSON 通过 m 字段上报，App 据此渲染不同第三键(后备箱/骑行)。
 * ───────────────────────────────────────────────────────────────── */
void KeyGo_LoadMode(void);                 // 上电时从 DataFlash 恢复模式
void KeyGo_SaveMode(uint8_t mode);         // 持久化模式到 DataFlash
void KeyGo_Ride(void);                      // ebike: 输出「快速双击」脉冲
void KeyGo_RidePulseHandler(void);          // SBP_GPIO_RIDE_EVT 双脉冲序列回调

#endif
