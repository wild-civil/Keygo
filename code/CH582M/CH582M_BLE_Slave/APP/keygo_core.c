/********************************** (C) COPYRIGHT *******************************
 * File Name          : keygo_core.c
 * Author             : KeyGo v3.33.0 (CH582M)
 * Date               : 2026/07/02
 * Description        : GPIO + Kalman + RSSI + 状态机 + JSON 通知 + 命令解析
 *********************************************************************************/

#include "keygo_core.h"
#include "bonding.h"
#include "gattprofile.h"
#include "peripheral.h"   // ★ 2026-07-11: 引用 SBP_DEFERRED_RAW_EVT 事件常量
#include <stdlib.h>   /* atoi */
#include "CH58x_common.h"  /* EEPROM_READ / EEPROM_WRITE / EEPROM_ERASE */

extern uint8_t Peripheral_TaskID;   // ★ 2026-07-11: 跨文件启动延迟发送任务（定义在 peripheral.c）

/* ─────────────────────────────────────────────────────────────────
 * 宏定义 (模块内部)
 * ───────────────────────────────────────────────────────────────── */

#define SPIKE_DISCARD_COUNT         2
// ★ v3.6-fixH: 从 3000ms → 8000ms，匹配 App 端 8s 冷却
// ★ v3.7: MANUAL_COOLDOWN_MS 从宏改为 uint16_t 变量 g_manualCooldownMs，
//         可在运行时通过 App 下发 "cooldown_ms=N" 修改，并持久化到 DataFlash
//         bug: 固件冷却 3s 到期后状态机恢复运行，仅 ~5.5s 后即可自动覆盖手动操作，
//               用户看到 App 显示"冷却 8s"但实际只有 3s 有效
#define STATUS_JSON_MAX_LEN         256  // ★ v3.33: 新增 fwsec 能力字段，从 224 扩到 256 留余量
/* ★ 固件版本号 KEYGO_FW_VERSION 已上提到 keygo_core.h 单一真源（横幅 / [INIT] FW Version / FF02 "v" 共用），此处不再重复定义 */

/* ★ v3.33: fwsec —— 安全协议能力版本（FF02 status JSON "fwsec" 字段）
 *   用途：后续「授权体系（多 owner / 管理员 / 限时·限次绑定码）」是破坏性协议升级，
 *         App 连接后读取 fwsec 决定走「旧单码路径」还是「新授权体系路径」，
 *         避免新固件配旧 App / 旧固件配新 App 时协议错配。
 *   语义约定（只增不改）：
 *     缺失该字段（旧固件） → App 视为 0：基础裸协议（早期无 HMAC/C1）
 *     fwsec = 1            → 当前基线：BIND/AUTH(HMAC) + C1 命令签名 + 单绑定码 + Phase2 双模式
 *     fwsec = 2（规划中）  → 授权体系 v1：per-identity authEntry + phoneId + 多 owner/管理员
 *     fwsec = 3（规划中）  → 授权体系 v2：限时/限次 guest entry
 *   ★ 升级 fwsec 时必须同步更新 App 端的能力判断（stores/ble.js 的 fwSec 分流）。 */
#define KEYGO_FWSEC                 1

/* ★ v3.15: TMOS 时间转换常量
 *   TMOS tick ≈ 0.625ms = 5/8 ms → ms = ticks × 5 ÷ 8, ticks = ms × 8 ÷ 5 */
#define TMOS_TICK_NUM               5    // 1 tick = 5/8 ms → 分子
#define TMOS_TICK_DEN               8    // 1 tick = 5/8 ms → 分母
#define MS_TO_TMOS_TICK_NUM         8    // ms → ticks: 乘 8
#define MS_TO_TMOS_TICK_DEN         5    // ms → ticks: 除 5

/* ★ v3.15: RSSI 相关常量 */
#define RSSI_UNINITIALIZED        (-999)   // RSSI 未初始化哨兵值（整数）
#define RSSI_UNINITIALIZED_F      (-999.0f)// RSSI 未初始化哨兵值（浮点）
#define RSSI_SPIKE_THRESHOLD_DBM  25.0f    // 单次 RSSI 跳变 >25dBm 视为毛刺
#define RSSI_PERIOD_TICKS_MIN      100     // RSSI 读取周期下限 ~62.5ms
#define RSSI_PERIOD_TICKS_MAX      4000    // RSSI 读取周期上限 ~2500ms

/* ★ v3.15: Kalman 滤波器初始化默认值 */
#define KALMAN_DEFAULT_Q           1.0f   // 过程噪声协方差
#define KALMAN_DEFAULT_P           1.0f   // 初始估计协方差
#define KALMAN_INITIAL_X          -80.0f  // 初始状态估计 (~-80dBm 典型空旷区)

/* ★ v3.15-#12: 参数合法范围常量 — 替代原代码中的裸数字（魔术数字）
 *   用于配置下发 (ParseConfig) 和 Flash 加载 (LoadConfig) 时的边界检查。
 *   改动仅是给已有的数字起名，不改变任何逻辑行为。 */
#define RSSI_THRESHOLD_MIN       -100      // RSSI 阈值合法性下限 (dBm)
#define COUNT_MIN                   1      // 解锁/锁车累计次数下限
#define COUNT_MAX                  30      // 解锁/锁车累计次数上限
#define KALMAN_R_MIN                1      // Kalman 滤波器 R 值下限
#define KALMAN_R_MAX               50      // Kalman 滤波器 R 值上限
#define RSSI_PERIOD_MIN_MS        100      // RSSI 读取周期下限 (ms)
#define RSSI_PERIOD_MAX_MS       2000      // RSSI 读取周期上限 (ms)
#define COOLDOWN_MIN_MS          2000      // 手动命令冷却时间下限 (ms)
#define COOLDOWN_MAX_MS         30000      // 手动命令冷却时间上限 (ms)
#define DLOCK_MAX_MS            60000      // 断连自动锁车延时上限 (ms)
#define COOLDOWN_DEFAULT_MS      8000      // 冷却时间默认值 (旧格式兜底)

/* ★ v3.15-#16: GPIO 脉冲动作看门狗 — TMOS 漏掉脉冲结束事件时的兜底保护
 *   KeyGo_Unlock/Lock/Trunk 启动 ~200ms~2s 的脉冲，如果 SBP_GPIO_PULSE_END_EVT
 *   因极端竞态丢失，g_actionActive 永远为 1 → 状态机永久停止。
 *   看门狗周期 = 最长脉冲(trunk=2s) × 2 + 余量 = 4s，TMOS 未响应则强制清零 */
#define ACTION_WATCHDOG_MS         4000      // GPIO 脉冲看门狗超时 (ms)

/* ★ v3.16-P1: 字符串相等判断封装 — 解决 tmos_memcmp 语义陷阱
 *   ─────────────────────────────────────────────────────────────────
 *   问题：TMOS SDK 的 tmos_memcmp(a,b,n) 返回值与标准 C 的 memcmp 完全相反！
 *       • tmos_memcmp  → TRUE (非零) = 相等，FALSE (零) = 不相等
 *       • memcmp       → 0 = 相等，非零 = 不相等
 *   如果新成员或将来移植时把两者搞混，会导致 if 条件完全写反，全线 bug。
 *
 *   解决：统一用 KEYGO_STREQ 宏做字符串相等判断，语义自明：
 *       if (KEYGO_STREQ(p, "unlock", 6))  → "p 的前 6 字节等于 'unlock'？"
 *   将来即使 SDK 升级 / 移植到其他平台，只需改这一处宏定义即可。
 *   ───────────────────────────────────────────────────────────────── */
#define KEYGO_STREQ(ptr, str, n)    tmos_memcmp((ptr), (str), (n))

/* ─────────────────────────────────────────────────────────────────
 * ★ Phase 2: 双模式(汽车/电瓶车) — DataFlash 模式存储
 *   KEYGO_MODE_ADDR: 偏移 0x7300(物理 0x77300)，位于 BINDCODE(0x7200) 之后独立页，
 *   不与其他区域重叠。单字节: 0xFF=未初始化(默认 car) / 0=car / 1=ebike。
 * ───────────────────────────────────────────────────────────────── */
#ifndef KEYGO_MODE_ADDR
#define KEYGO_MODE_ADDR   0x7300   /* 物理 0x77300 = DATA_FLASH_ADDR(0x70000) + 偏移 0x7300 */
#endif

/* ─────────────────────────────────────────────────────────────────
 * ★ v3.5: 可运行时配置的 RSSI 阈值 (替代原来的 #define 硬编码)
 *    由 App 通过 FF01 下发 "unlock=-30 lock=-45 uc=2..." 更新
 *    默认值与 App 端 store 初始值保持一致
 * ───────────────────────────────────────────────────────────────── */
int16_t  g_cfgUnlockThreshold   = -45;   // RSSI 解锁阈值
int16_t  g_cfgLockThreshold     = -65;   // RSSI 锁车阈值
uint8_t  g_cfgUnlockCount       = 2;     // 解锁需连续满足次数
uint8_t  g_cfgLockCount         = 3;     // 锁车需连续满足次数
uint16_t g_cfgDisconnectLockMs  = 5000;  // 断连自动锁车延时 ms
// ★ v3.24: 自动锁使能开关 (1=启用 RSSI 自动解锁/上锁, 0=手动模式禁用自动锁)
uint8_t  g_cfgAutoLockEnable    = 1;     // 由 App 通过 FF01 下发 "autolock=0/1" 控制
// ★ v3.7: 可运行时配置的 RSSI 冷却时间 (替代 #define MANUAL_COOLDOWN_MS)
uint16_t g_cfgManualCooldownMs  = 8000;  // 手动命令冷却时间 ms (范围 2000~30000)
// ★ v3.13: 固件 RSSI 读取周期 + 卡尔曼响应速度
uint16_t g_cfgRssiPeriodMs      = 500;   // GAP RSSI 读取间隔 ms (范围 100~2000, 默认 500)
uint8_t  g_cfgKalmanR           = 15;    // 卡尔曼滤波器 R 值 (范围 1~50, 默认 15)

uint8_t  g_encRequired       = 0;     // ★ 方案1: 无 App 模式(OS 系统配对)使能标志
uint32_t g_sysPasscode        = 123456u; // ★ 方案1 扩展: 系统配对码(OS SMP passkey)，默认 123456，与绑定码独立

/* ─────────────────────────────────────────────────────────────────
 * 模块内部状态 (仅 keygo_core 可见)
 * ───────────────────────────────────────────────────────────────── */

// Kalman
static KalmanFilter1D_t g_kalman;                   // 由 InitKalmanFilter() 初始化 

// RSSI
static int16_t  g_latestRSSI        = RSSI_UNINITIALIZED;
static float    g_filteredRSSI      = RSSI_UNINITIALIZED_F;
/* ★ v3.15-#17: 移除 g_rssiBuffer[8]/g_rssiBufIdx — 旧滑动窗口 RSSI 死代码，
 *   Kalman 滤波器已完全替代，两个变量全代码库无任何引用，占用 18B RAM */
static uint8_t  g_spikeConsecutive  = 0;
/* ★ v3.15-fix8: float 类型与 Kalman 滤波器一致，避免 int→float 隐式截断歧义 */
static float    g_lastRawRSSI       = RSSI_UNINITIALIZED_F;
static uint8_t  g_rssiUpdated       = 0;    // ★ 新 Kalman 样本标记

// 状态机
static uint8_t  g_unlockCounter     = 0;
static uint8_t  g_lockCounter       = 0;
// ★ v3.31 方案B: 上次经 FF02 上报的计数（事件驱动上报用，0xFF 哨兵保证首包必发）
static uint8_t  s_lastReportedUcnt  = 0xFF;
static uint8_t  s_lastReportedLcnt  = 0xFF;
static uint8_t  g_actionActive      = 0;
static uint16_t g_pulsePinMask      = 0;     // 当前脉冲的引脚掩码
static uint32_t g_actionStartMs     = 0;     // ★ v3.15-#16: 脉冲启动时间戳，看门狗用
static uint8_t  g_manualCooldown    = 0;
static uint32_t g_lastCommandMs     = 0;

// 命令处理
static char     g_customName[21]    = {0};
static uint8_t  g_deviceMode       = 0;     // ★ Phase 2: 设备模式 0=car(默认) / 1=ebike

/* [LED_BEGIN] ──────── 后备箱 LED 闪烁状态机 ────────
 *   g_ledBlinkLocked=1 时 KeyGo_Unlock/Lock 不会改变 LED 状态
 *   g_ledTrunkBlinkToggle=0~9 共 10 次翻转 = 5 次亮灭 (500ms ON + 500ms OFF per cycle)
 *   低功耗: 去掉 LED 时注释掉这两个变量 ——————————— [LED_END] */
static uint8_t  g_ledBlinkLocked     = 0;
static uint8_t  g_ledTrunkBlinkToggle = 0;
static uint8_t  g_ledRideBlinkToggle  = 0;   // ★ Phase 2: 骑行 LED 闪烁翻转计数 (4 次 = 2 亮灭)

/* ─────────────────────────────────────────────────────────────────
 * 前向声明
 * ───────────────────────────────────────────────────────────────── */
static void InitKalmanFilter(void);
static float UpdateKalman(float measurement);

/* ─────────────────────────────────────────────────────────────────
 * 工具函数
 * ───────────────────────────────────────────────────────────────── */

uint32_t Peripheral_GetSystemMs(void)
{
    return TMOS_GetSystemClock() * TMOS_TICK_NUM / TMOS_TICK_DEN;
}

/* ★ 方案A（2026-07-12）：未鉴权连接计时起点。
 *   连接建立(Peripheral_LinkEstablished)时置为当前系统 ms；
 *   AUTH/BIND 成功(KeyGo_CancelUnauthTimer)或断连(Peripheral_LinkTerminated)清零。 */
uint32_t g_unauthConnStartMs = 0;

/* ★ 方案A（2026-07-12）：AUTH/BIND 成功 → 取消未鉴权计时（合法用户长连不受限） */
void KeyGo_CancelUnauthTimer(void)
{
    g_unauthConnStartMs = 0;
}

/* ─────────────────────────────────────────────────────────────────
 * GPIO 控制
 * ───────────────────────────────────────────────────────────────── */

void KeyGo_FactoryReset_GPIO_Init(void);   // ★ 长按恢复出厂：隐藏按键轮询任务初始化（定义见 GPIO 段末尾）

void KeyGo_GPIO_Init(void)
{
    /* ★ 2026-07-11: 开机即打印固件版本号，作为"新固件是否真正烧入"的硬探针。
     *   与 [FF03] 同一串口窗口。若上电后看不到 "FW Version: 3.30.4-rc5"，
     *   说明烧的是旧 hex（Clean+Rebuild 未生效），与 App 控制台 fwVersion= 互证。 */
    PRINT("[INIT] FW Version: %s\n", KEYGO_FW_VERSION);

    GPIOA_ModeCfg(PIN_UNLOCK_GPIO, GPIO_ModeOut_PP_5mA);
    GPIOA_ModeCfg(PIN_LOCK_GPIO, GPIO_ModeOut_PP_5mA);
    GPIOA_ModeCfg(PIN_TRUNK_GPIO, GPIO_ModeOut_PP_5mA);
    GPIOA_ModeCfg(PIN_KEYPOWER_GPIO, GPIO_ModeOut_PP_5mA);

    GPIOA_ResetBits(PIN_UNLOCK_GPIO);
    GPIOA_ResetBits(PIN_LOCK_GPIO);
    GPIOA_ResetBits(PIN_TRUNK_GPIO);
    GPIOA_ResetBits(PIN_KEYPOWER_GPIO);

    KeyGo_KeyPower(1);
    /* ──────── [LED_BEGIN] PB4 LED 状态指示 ────────
     * 电路: PB4 → 1kΩ 限流电阻 → LED 正极 (+) → LED 负极 (-) → GND
     *   PB4 高电平 → 电流 PB4→电阻→LED→GND → LED 亮
     *   PB4 低电平 → 无电位差 → LED 灭
     * 低功耗注意事项: 后期量产需关闭 LED 时，搜索 [LED_BEGIN]/[LED_END]
     *   标记删除/注释掉所有被标记的代码块即可完全移除 LED 功能。
     *   这两行 (GPIOB_ModeCfg + ResetBits) 也要一起注释掉。
     * ──────────────────────────────────────────── */
    GPIOB_ModeCfg(GPIO_Pin_4, GPIO_ModeOut_PP_5mA);  // ★ 必须配置 push-pull 输出模式 (HAL 的 LED1_DDR 只设了方向位)
    GPIOB_ResetBits(GPIO_Pin_4);                      // 初始状态 = 锁车 → LED 灭 (低电平)
    KeyGo_FactoryReset_GPIO_Init();                   // ★ 隐藏按键(PB22/BOOT) 长按恢复出厂轮询任务
    PRINT("[GPIO] Initialized (PA4=UNLOCK, PA5=LOCK, PA6=TRUNK, PA7=KEY_POWER, PB4=LED, PB22=FR_BTN)\n");
}

/* ─────────────────────────────────────────────────────────────────
 * ★ 长按恢复出厂 (隐藏按键 PB22/BOOT) — BLE 通知为主 + LED 为辅
 *
 *   【触发】PB22(BOOT) 被拉低(按钮接地) 持续 KEYGO_FR_HOLD_MS(默认 8000ms)。
 *   【前提】RST(PB23) 是硬件复位脚，**刻意不参与检测**——
 *          若按钮同时短接 RST，长按会误复位芯片导致无法累计 5s；
 *          仅在"按住按钮+上电/点按RST进入ISP"恢复路径上才有意义。
 *          故检测脚只用 BOOT(PB22)。
 *   【反馈】BLE 通知为主（RESET:ARM / RESET:HOLD:NN / RESET:CANCEL / RESET:OK），
 *          连接时手机 App 实时可见；LED 为辅（低功耗常态灭，按住时本地闪烁），
 *          即便断连不连手机也能靠 LED 确认。
 *   【安全】阈值 8s + 需持续按住（松开即取消），避免误触恢复出厂清掉绑定。
 *   【LED 反馈】0~5s 灭(可自由松手取消) → 5~8s 慢闪(警示"再按住即复位") → ≥8s 快闪(复位已触发/完成确认)，即便断连不连手机也能靠 LED 确认。
 *   ★ 独立 TMOS 任务：自带 16 位事件空间，避免与 Peripheral 任务事件位冲突
 *     （Peripheral 任务的 16 个事件位已全部占用）。
 * ───────────────────────────────────────────────────────────────── */
#ifndef KEYGO_FACTORY_RESET_PIN
#define KEYGO_FACTORY_RESET_PIN    GPIO_Pin_22      // PB22 = BOOT (隐藏按键)
#endif
#define KEYGO_FR_HOLD_MS           8000             // 长按阈值(ms)：持续按住 8s 才恢复出厂
#define KEYGO_FR_SLOW_AT_MS        5000             // 5s 后开始慢闪(警示)，8s 后快闪(已完成)
#define KEYGO_FR_POLL_TICKS        160              // ~100ms 轮询(1 tick≈0.625ms)
#define KEYGO_FR_TOGGLE_SLOW_MS    500              // 慢闪半周期(5~8s 警示)
#define KEYGO_FR_TOGGLE_FAST_MS    100              // 快闪半周期(≥8s 复位确认)
#define KEYGO_FR_CONFIRM_MS        600              // 到阈值后确认窗口(给 BLE 空口发 RESET:OK)

#define KEYGO_FR_POLL_EVT          0x0001
static uint8_t  KeyGo_FactoryReset_TaskID = INVALID_TASK_ID;

/* 状态：0=idle 1=arming(按住累计中) 2=confirming(已到阈值, 即将复位) */
static uint8_t  g_frState     = 0;
static uint32_t g_frStartMs   = 0;
static uint32_t g_frLedNextMs = 0;
static uint8_t  g_frLedOn     = 0;
static uint8_t  g_frFast      = 0;
static uint8_t  g_frLastPct   = 0;
static uint32_t g_frConfirmMs = 0;

/* BLE 通知（无连接时 KeyGo_SendRawNotify 内部直接 return，安全） */
static void KeyGo_FactoryReset_SendBle(const char *msg)
{
    KeyGo_SendRawNotify(msg);
}

/* 擦除全部持久化（信任列表 / 绑定码 / 配置 / 模式），回到出厂默认 */
static void KeyGo_FactoryReset_DoErase(void)
{
    PRINT("[FR] factory reset: erasing all DataFlash...\n");
    Bonding_EraseAll();          // 信任列表(owner)清空
    Bonding_ResetBindCode();     // 绑定码重置回默认 123456
    EEPROM_ERASE(KEYGO_CFG_ADDR, 256);    // 配置页(阈值/cooldown/autolock...)
    EEPROM_ERASE(KEYGO_MODE_ADDR, 256);   // 模式页(car/ebike)
    EEPROM_ERASE(KEYGO_ENCRYPT_ADDR, 256);// ★ 方案1: 无 App 模式标志位
    EEPROM_ERASE(KEYGO_PASSCODE_ADDR, 256);// ★ 方案1 扩展: 系统配对码(恢复默认 123456)
    g_encRequired = 0;                    // 运行态同步为关闭(即将重启，重启后从 0xFF 加载仍为 0)
    g_sysPasscode = 123456u;              // 运行态同步为默认(即将重启，重启后从 0xFF 加载仍为默认)
    PRINT("[FR] all erased, will reboot\n");
}

/* 100ms 轮询：检测隐藏按键长按 → 反馈 + 到阈值复位 */
static void KeyGo_FactoryReset_Poll(void)
{
    uint8_t pressed = (GPIOB_ReadPortPin(KEYGO_FACTORY_RESET_PIN) == 0) ? 1 : 0;
    uint32_t now = Peripheral_GetSystemMs();

    if (g_frState == 0) {
        if (pressed) {
            g_frState     = 1;
            g_frStartMs   = now;
            g_frLedNextMs = now;
            g_frLedOn     = 0;
            g_frFast      = 0;
            g_frLastPct   = 0;
            /* 停掉可能残留的 LED 闪烁任务，独占 PB4 做反馈 */
            tmos_stop_task(Peripheral_TaskID, SBP_LED_TRUNK_BLINK_EVT);
            tmos_stop_task(Peripheral_TaskID, SBP_LED_RIDE_BLINK_EVT);
            g_ledBlinkLocked = 0;
            KeyGo_FactoryReset_SendBle("RESET:ARM");
            PRINT("[FR] button down, arming...\n");
        }
        return;
    }

    if (g_frState == 1) {  // arming：按住累计中
        if (!pressed) {    // 提前松开 → 取消
            if (g_keyState == KSTATE_UNLOCKED) GPIOB_SetBits(GPIO_Pin_4);
            else                               GPIOB_ResetBits(GPIO_Pin_4);
            KeyGo_FactoryReset_SendBle("RESET:CANCEL");
            PRINT("[FR] released early, cancelled\n");
            g_frState = 0;
            return;
        }
        uint32_t held = now - g_frStartMs;
        uint8_t  pct  = (held >= KEYGO_FR_HOLD_MS) ? 100
                                                       : (uint8_t)((held * 100) / KEYGO_FR_HOLD_MS);
        /* BLE 进度通知(25/50/75/100 各发一次) */
        if      (pct >= 25 && pct < 50 && g_frLastPct < 25) { g_frLastPct = 25; KeyGo_FactoryReset_SendBle("RESET:HOLD:25"); }
        else if (pct >= 50 && pct < 75 && g_frLastPct < 50) { g_frLastPct = 50; KeyGo_FactoryReset_SendBle("RESET:HOLD:50"); }
        else if (pct >= 75 && pct < 100 && g_frLastPct < 75) { g_frLastPct = 75; KeyGo_FactoryReset_SendBle("RESET:HOLD:75"); }
        /* LED 反馈：0~5s 灭(可自由松手取消)；5~8s 慢闪(警示)；≥8s 快闪(复位已触发/完成确认) */
        uint8_t fast = (held >= KEYGO_FR_HOLD_MS) ? 1 : 0;
        uint8_t slow = (!fast && held >= KEYGO_FR_SLOW_AT_MS) ? 1 : 0;
        if (!fast && !slow) {
            /* 0~5s：保持 LED 灭，不闪烁 */
            if (g_frLedOn) { g_frLedOn = 0; GPIOB_ResetBits(GPIO_Pin_4); g_frLedNextMs = now; }
        } else {
            uint8_t f = fast ? 1 : 0;
            if (f != g_frFast) { g_frFast = f; g_frLedNextMs = now; g_frLedOn = 0; }
            if (now >= g_frLedNextMs) {
                g_frLedOn ^= 1;
                if (g_frLedOn) GPIOB_SetBits(GPIO_Pin_4); else GPIOB_ResetBits(GPIO_Pin_4);
                g_frLedNextMs = now + (f ? KEYGO_FR_TOGGLE_FAST_MS : KEYGO_FR_TOGGLE_SLOW_MS);
            }
        }
        if (pct >= 100) {   // 阈值到达 → 进入确认窗口
            g_frState     = 2;
            g_frConfirmMs = now + KEYGO_FR_CONFIRM_MS;
            g_frLastPct   = 100;
            KeyGo_FactoryReset_SendBle("RESET:OK");  // 给 BLE 空口时间送达 + LED 确认快闪
            PRINT("[FR] threshold reached, confirming...\n");
        }
        return;
    }

    if (g_frState == 2) {  // confirming：持续快闪, 到确认窗口后真正复位
        if (now >= g_frLedNextMs) {
            g_frLedOn ^= 1;
            if (g_frLedOn) GPIOB_SetBits(GPIO_Pin_4); else GPIOB_ResetBits(GPIO_Pin_4);
            g_frLedNextMs = now + KEYGO_FR_TOGGLE_FAST_MS;
        }
        if (now >= g_frConfirmMs) {
            KeyGo_FactoryReset_DoErase();
            /* 复位前拉低控制引脚防误动(与看门狗/adv 重启复位一致) */
            GPIOA_ResetBits(GPIO_Pin_4 | GPIO_Pin_5 | GPIO_Pin_6 | GPIO_Pin_7);
            GPIOB_ResetBits(GPIO_Pin_4);
            SYS_ResetExecute();   // 完整重启 → 以出厂默认(未绑定/car/默认阈值)重新初始化
        }
        return;
    }
}

uint16_t KeyGo_FactoryReset_ProcessEvent(uint8_t task_id, uint16_t events)
{
    if (events & SYS_EVENT_MSG) {
        uint8_t *pMsg;
        if ((pMsg = tmos_msg_receive(task_id)) != NULL) tmos_msg_deallocate(pMsg);
        return (events ^ SYS_EVENT_MSG);
    }
    if (events & KEYGO_FR_POLL_EVT) {
        KeyGo_FactoryReset_Poll();
        tmos_start_task(task_id, KEYGO_FR_POLL_EVT, KEYGO_FR_POLL_TICKS);
        return (events ^ KEYGO_FR_POLL_EVT);
    }
    return 0;
}

void KeyGo_FactoryReset_GPIO_Init(void)
{
    /* BOOT(PB22) 配为输入上拉；按钮按下→接地→读 0。常态高电平=正常启动(不进ISP)。 */
    GPIOB_ModeCfg(KEYGO_FACTORY_RESET_PIN, GPIO_ModeIN_PU);
    KeyGo_FactoryReset_TaskID = TMOS_ProcessEventRegister(KeyGo_FactoryReset_ProcessEvent);
    tmos_start_task(KeyGo_FactoryReset_TaskID, KEYGO_FR_POLL_EVT, KEYGO_FR_POLL_TICKS);
    PRINT("[FR] factory-reset poll task started (pin PB22/BOOT, hold=%dms)\n", KEYGO_FR_HOLD_MS);
}

void KeyGo_Unlock(void)
{
    if (g_actionActive) return;    // 已有脉冲进行中，跳过
    g_actionActive  = 1;
    g_actionStartMs = Peripheral_GetSystemMs();  // ★ v3.15-#16: 看门狗启动时间
    g_pulsePinMask  = PIN_UNLOCK_GPIO;
    /* [LED_BEGIN] 解锁 → PB4 高电平 = LED 亮
     *   后备箱闪烁期间跳过 (g_ledBlinkLocked=1)，闪烁结束后恢复 [LED_END] */
    if (!g_ledBlinkLocked) { GPIOB_SetBits(GPIO_Pin_4); }
    PRINT("[KEY] unlock\n");
    GPIOA_SetBits(PIN_UNLOCK_GPIO);
    tmos_start_task(Peripheral_TaskID, SBP_GPIO_PULSE_END_EVT, GPIO_PULSE_LOCK_TICKS);
}

void KeyGo_Lock(void)
{
    if (g_actionActive) return;
    g_actionActive  = 1;
    g_actionStartMs = Peripheral_GetSystemMs();  // ★ v3.15-#16: 看门狗启动时间
    g_pulsePinMask  = PIN_LOCK_GPIO;
    /* [LED_BEGIN] 锁车 → PB4 低电平 = LED 灭
     *   后备箱闪烁期间跳过，闪烁结束后恢复 [LED_END] */
    if (!g_ledBlinkLocked) { GPIOB_ResetBits(GPIO_Pin_4); }
    PRINT("[KEY] lock\n");
    GPIOA_SetBits(PIN_LOCK_GPIO);
    tmos_start_task(Peripheral_TaskID, SBP_GPIO_PULSE_END_EVT, GPIO_PULSE_LOCK_TICKS);
}

void KeyGo_Trunk(void)
{
    if (g_actionActive) return;
    g_actionActive  = 1;
    g_actionStartMs = Peripheral_GetSystemMs();  // ★ v3.15-#16: 看门狗启动时间
    g_pulsePinMask  = PIN_TRUNK_GPIO;
    /* [LED_BEGIN] 后备箱 → PB4 闪烁 5 次 (500ms ON / 500ms OFF ×5 周期 = 5s)
     *   设置 g_ledBlinkLocked=1 防止闪烁期间 Unlock/Lock 覆盖 LED [LED_END] */
    if (!g_ledBlinkLocked) {
        g_ledBlinkLocked = 1;
        g_ledTrunkBlinkToggle = 0;
        GPIOB_SetBits(GPIO_Pin_4);                 // 第 1 个 500ms: LED ON (高电平)
        tmos_start_task(Peripheral_TaskID, SBP_LED_TRUNK_BLINK_EVT, LED_TRUNK_BLINK_TICKS);
    }
    PRINT("[KEY] trunk\n");
    GPIOA_SetBits(PIN_TRUNK_GPIO);
    tmos_start_task(Peripheral_TaskID, SBP_GPIO_PULSE_END_EVT, GPIO_PULSE_TRUNK_TICKS);
}

/* ─────────────────────────────────────────────────────────────────
 * ★ Phase 2: ebike 骑行 — 输出「快速双击」脉冲（模拟电动车遥控双击启动骑行）
 *   序列: ON 100ms → OFF 150ms → ON 100ms → OFF。由 KeyGo_RidePulseHandler
 *   按 g_rideStep 推进。仅 ebike 模式调用；car 模式由 HandleCommand 直接拒绝。
 * ───────────────────────────────────────────────────────────────── */
static uint8_t g_rideStep = 0;

void KeyGo_Ride(void)
{
    if (g_rideStep != 0) return;   // 上一轮双脉冲未结束，忽略
    g_rideStep = 0;
    GPIOA_SetBits(PIN_RIDE_GPIO);  // 第 1 个脉冲 ON（继电器控制，与 LED 解耦）
    tmos_start_task(Peripheral_TaskID, SBP_GPIO_RIDE_EVT, RIDE_HALF_TICKS);

    /* [LED_BEGIN] 骑行 → PB4 闪烁 2 次 (500ms ON / 500ms OFF ×2 = 2s)
     *   与后备箱同机制：独立事件 + 干净状态机，结束可靠恢复，杜绝「卡死」
     *   设置 g_ledBlinkLocked=1 防止闪烁期间 Unlock/Lock 覆盖 LED [LED_END] */
    if (!g_ledBlinkLocked) {
        g_ledBlinkLocked = 1;
        g_ledRideBlinkToggle = 0;
        GPIOB_SetBits(GPIO_Pin_4);                 // 第 1 个 500ms: LED ON (高电平)
        tmos_start_task(Peripheral_TaskID, SBP_LED_RIDE_BLINK_EVT, LED_RIDE_BLINK_TICKS);
    }
    PRINT("[RIDE] ride start (ebike), led blink 2x\n");
}

void KeyGo_RidePulseHandler(void)
{
    g_rideStep++;
    if (g_rideStep == 1) {              // 第 1 个脉冲 OFF
        GPIOA_ResetBits(PIN_RIDE_GPIO);
        tmos_start_task(Peripheral_TaskID, SBP_GPIO_RIDE_EVT, RIDE_GAP_TICKS);
    } else if (g_rideStep == 2) {       // 第 2 个脉冲 ON
        GPIOA_SetBits(PIN_RIDE_GPIO);
        tmos_start_task(Peripheral_TaskID, SBP_GPIO_RIDE_EVT, RIDE_HALF_TICKS);
    } else {                            // 第 2 个脉冲 OFF，结束（LED 由独立事件负责恢复）
        GPIOA_ResetBits(PIN_RIDE_GPIO);
        g_rideStep = 0;
        PRINT("[RIDE] ride pulse end\n");
    }
}

/*
 * TMOS 事件回调：脉冲时间到达，复位 GPIO 引脚
 */
void KeyGo_GPIO_PulseEnd(void)
{
    GPIOA_ResetBits(g_pulsePinMask);
    g_pulsePinMask  = 0;
    g_actionActive  = 0;
    PRINT("[KEY] pulse end\n");
}

void KeyGo_KeyPower(uint8_t on)
{
    if (on)
        GPIOA_SetBits(PIN_KEYPOWER_GPIO);
    else
        GPIOA_ResetBits(PIN_KEYPOWER_GPIO);
}

/* [LED_BEGIN] ──────── 后备箱 LED 闪烁 TMOS 回调 ────────
 *   500ms 周期翻转 PB4，共 10 次翻转 = 5 次亮灭循环
 *   完成后恢复 LED 到当前锁状态 (解锁=亮, 锁车=灭)
 *   低功耗: 去掉 LED 时整个函数 + 声明一起注释掉 ──── [LED_END] */
void KeyGo_LedTrunkBlinkHandler(void)
{
    g_ledTrunkBlinkToggle++;
    if (g_ledTrunkBlinkToggle >= 10) {
        /* 闪烁结束 → 恢复 LED 到当前锁状态 */
        g_ledBlinkLocked = 0;
        g_ledTrunkBlinkToggle = 0;
        if (g_keyState == KSTATE_UNLOCKED) {
            GPIOB_SetBits(GPIO_Pin_4);     // 解锁 → LED 亮 (高电平)
        } else {
            GPIOB_ResetBits(GPIO_Pin_4);   // 锁车 → LED 灭 (低电平)
        }
        PRINT("[LED] trunk blink end, restored to %s\n",
              g_keyState == KSTATE_UNLOCKED ? "ON (HIGH)" : "OFF (LOW)");
        return;
    }
    /* 翻转 LED: 奇数翻转 → OFF (低电平), 偶数翻转 → ON (高电平) */
    if (g_ledTrunkBlinkToggle & 1) {
        GPIOB_ResetBits(GPIO_Pin_4);   // odd → OFF
    } else {
        GPIOB_SetBits(GPIO_Pin_4);     // even → ON
    }
    tmos_start_task(Peripheral_TaskID, SBP_LED_TRUNK_BLINK_EVT, LED_TRUNK_BLINK_TICKS);
}

/* [LED_BEGIN] ──────── 骑行 LED 闪烁 TMOS 回调 (参照后备箱) ────────
 *   500ms 周期翻转 PB4，共 4 次翻转 = 2 次亮灭循环（模拟按了两下开关）
 *   完成后恢复 LED 到当前锁状态 (解锁=亮, 锁车=灭)
 *   低功耗: 去掉 LED 时整个函数 + 声明一起注释掉 ──── [LED_END] */
void KeyGo_LedRideBlinkHandler(void)
{
    g_ledRideBlinkToggle++;
    if (g_ledRideBlinkToggle >= 4) {
        /* 闪烁结束 → 恢复 LED 到当前锁状态 */
        g_ledBlinkLocked = 0;
        g_ledRideBlinkToggle = 0;
        if (g_keyState == KSTATE_UNLOCKED) {
            GPIOB_SetBits(GPIO_Pin_4);     // 解锁 → LED 亮 (高电平)
        } else {
            GPIOB_ResetBits(GPIO_Pin_4);   // 锁车 → LED 灭 (低电平)
        }
        PRINT("[LED] ride blink end, restored to %s\n",
              g_keyState == KSTATE_UNLOCKED ? "ON (HIGH)" : "OFF (LOW)");
        return;
    }
    /* 翻转 LED: 奇数翻转 → OFF (低电平), 偶数翻转 → ON (高电平) */
    if (g_ledRideBlinkToggle & 1) {
        GPIOB_ResetBits(GPIO_Pin_4);   // odd → OFF
    } else {
        GPIOB_SetBits(GPIO_Pin_4);     // even → ON
    }
    tmos_start_task(Peripheral_TaskID, SBP_LED_RIDE_BLINK_EVT, LED_RIDE_BLINK_TICKS);
}

/* ─────────────────────────────────────────────────────────────────
 * Kalman 滤波
 * ───────────────────────────────────────────────────────────────── */

static void InitKalmanFilter(void)
{
    g_kalman.Q    = KALMAN_DEFAULT_Q;
    g_kalman.R    = (float)g_cfgKalmanR;  // ★ v3.13: 使用运行时配置，不再硬编码
    g_kalman.P    = KALMAN_DEFAULT_P;
    g_kalman.K    = 0.0f;
    g_kalman.X    = KALMAN_INITIAL_X;
    g_kalman.init = 0;
}

void KeyGo_ResetKalman(void)
{
    InitKalmanFilter();
    g_spikeConsecutive = 0;
    g_lastRawRSSI      = RSSI_UNINITIALIZED_F;
    g_filteredRSSI     = RSSI_UNINITIALIZED_F;
    g_latestRSSI       = RSSI_UNINITIALIZED;
}

static void KeyGo_ClearRawQueue(void);  // 前向声明：清空 raw 短报文队列（定义见下方）

/*
 * 重置全部运行时状态 (连接建立 / 断开时调用)
 */
void KeyGo_ResetState(void)
{
    KeyGo_ResetKalman();
    g_rssiUpdated     = 0;
    g_unlockCounter   = 0;
    g_lockCounter     = 0;
    g_actionActive    = 0;
    g_pulsePinMask    = 0;
    g_actionStartMs   = 0;   // ★ v3.15-#16: 看门狗时间戳清零
    g_manualCooldown  = 0;
    /* [LED_BEGIN] 清理后备箱闪烁状态机，保持 LED 当前状态不变
     *   断连/重连时不应改变 LED (锁车=灭, 解锁=亮 已反映真实状态) [LED_END] */
    g_ledBlinkLocked  = 0;
    g_ledTrunkBlinkToggle = 0;
    g_ledRideBlinkToggle  = 0;

    /* ★ 2026-07-12 fix3：清空 raw 短报文队列。断连/重连都调本函数，
     *   若不清理，上一条连接未发完的 AUTH:OK/NONCE 会残留到新连接 flush，
     *   导致 App 误置 sessionAuthed 或 _requestNonce 拿到旧 nonce → 首轮 AUTH:FAIL。 */
    KeyGo_ClearRawQueue();
}

static float UpdateKalman(float measurement)
{
    if (!g_kalman.init) {
        g_kalman.X    = measurement;
        g_kalman.init = 1;
        return measurement;
    }
    float P_pred = g_kalman.P + g_kalman.Q;
    g_kalman.K = P_pred / (P_pred + g_kalman.R);
    g_kalman.X = g_kalman.X + g_kalman.K * (measurement - g_kalman.X);
    g_kalman.P = (1.0f - g_kalman.K) * P_pred;
    return g_kalman.X;
}

/* ─────────────────────────────────────────────────────────────────
 * RSSI 处理
 * ───────────────────────────────────────────────────────────────── */

void KeyGo_RssiProcess(int8_t rssi)
{
    if (rssi >= 0) return;

    g_latestRSSI = rssi;
    float r = (float)rssi;

    /* ★ v3.15-fix8: g_lastRawRSSI 改为 float，类型统一后使用 fabsf 简化判断 */
    if (g_lastRawRSSI != RSSI_UNINITIALIZED_F) {
        float delta = r - g_lastRawRSSI;
        if (delta > RSSI_SPIKE_THRESHOLD_DBM || delta < -RSSI_SPIKE_THRESHOLD_DBM) {
            g_spikeConsecutive++;
        } else {
            g_spikeConsecutive = 0;
        }
    }
    g_lastRawRSSI = r;

    if (g_spikeConsecutive < SPIKE_DISCARD_COUNT) {
        g_filteredRSSI = UpdateKalman(r);
        g_rssiUpdated = 1;   // ★ 标记：新 Kalman 样本已产出
    }
}

/* ─────────────────────────────────────────────────────────────────
 * 状态机
 * ───────────────────────────────────────────────────────────────── */

void KeyGo_ProcessStateMachine(void)
{
    /* ★ v3.15-#16: GPIO 脉冲看门狗 — TMOS SBP_GPIO_PULSE_END_EVT 漏触发兜底
     *   正常路径：脉冲到期 → TMOS 调 KeyGo_GPIO_PulseEnd() → g_actionActive=0
     *   异常路径：事件丢失 → g_actionActive 永远=1 → 后续所有操作阻塞
     *   看门狗：启动 4s 后（2× 最长 trunk 脉冲）若仍未清零，强制复位。 */
    if (g_actionActive) {
        if (Peripheral_GetSystemMs() - g_actionStartMs >= ACTION_WATCHDOG_MS) {
            PRINT("[WATCHDOG] GPIO pulse stuck %lums, force clearing\n",
                  (unsigned long)(Peripheral_GetSystemMs() - g_actionStartMs));
            KeyGo_GPIO_PulseEnd();  // 强制清零，状态机恢复运行
        } else {
            return;                 // 脉冲正常进行中，跳过状态机
        }
    }

    if (g_manualCooldown) {
        uint32_t now = Peripheral_GetSystemMs();
        // ★ v3.7: 使用可配置变量 g_cfgManualCooldownMs 替代硬编码宏
        if (now - g_lastCommandMs >= g_cfgManualCooldownMs) {
            g_manualCooldown = 0;
            PRINT("[STATE] manual command cooldown ended\n");
        } else {
            return;
        }
    }

    /* ★ v3.15-#16: g_actionActive 检查已上移至函数顶部看门狗处理，
     *   此处仅需检查滤波器是否初始化 */
    if (g_filteredRSSI == RSSI_UNINITIALIZED_F) return;

    // ★ v3.24: 手动模式 (autolock=0) 完全禁用 RSSI 自动锁，只响应手动 UNLOCK/LOCK 命令
    //   解决露营等贴身场景 RSSI 抖动导致车锁反复解锁/上锁的问题
    if (!g_cfgAutoLockEnable) return;

    // ★ 2026-07-10 修复：未绑定的设备不响应 RSSI 自动解锁/上锁。
    //   否则任何靠近的手机都能触发解锁，绑定形同虚设——必须先 BIND（默认码）建立信任。
    //   手动 UNLOCK/LOCK 命令仍有独立会话鉴权门控（见 Peripheral_HandleFF03）。
    if (Bonding_Count() == 0) return;

    // ★ 方案A+B 合并闸门（2026-07-12 晚修正）：RSSI 近场解锁须「链路已加密 OR 本连接已会话鉴权」。
    //   纯方案A(LINK_ENCRYPTED)的坑：链路加密只在 bond 后、且 Android 常在「断连重连」时才自动加密，
    //   保持连接时(前台/后台)链路往往未加密→闸门永久拦截→走近不解锁（用户实测复现）。
    //   故改为 OR：
    //     · App 活着且跑过 AUTH（前台服务 Keygo-Foreground 自动 AUTH）→ IsSessionAuthed=true → 立刻解锁；
    //     · App 被杀 + 已配对 + OS 自动重连加密 → LINK_ENCRYPTED=true → 仍能走近解锁（方案A 收益保留）；
    //     · 陌生人连上、既未 bond 也未 AUTH → 两者皆 false → 拦截。
    //   残留风险：Just Works 配对无需密码，任何手机可主动 createBond→LINK_ENCRYPTED=true→RSSI 解锁，
    //   与「物理手机即钥匙」模型一致，属已知取舍。
    if (!linkDB_State(peripheralConnList.connHandle, LINK_ENCRYPTED) &&
        !Bonding_IsSessionAuthed(peripheralConnList.connHandle)) return;

    // ★ 只在有新 Kalman 样本时才计数（每 ~500ms 一次，而非每 125ms）
    if (!g_rssiUpdated) return;
    g_rssiUpdated = 0;

    // ★ v3.5: 使用可运行时配置的阈值变量 (非 #define 硬编码)
    if (g_filteredRSSI > g_cfgUnlockThreshold) {
        // ★ v3.31 方案B-修正: 计数器钳制在配置值，已解锁且仍处解锁区时不再无限 ++
        //   （否则解锁后 g_keyState==UNLOCKED 不进清零分支，计数一路飙到 10/2 等）。
        //   钳制后：解锁瞬间计到 uc → 触发解锁；之后恒为 uc/uc「定格」，App 显示 N/N 不再溢出。
        // if (g_unlockCounter < g_cfgUnlockCount) g_unlockCounter++; // 之前版本：g_unlockCounter++;  
        g_unlockCounter++; // ★ v3.31 方案B: 直接 ++（计数溢出由 App 端 Math.min 钳制显示，固件保持原样避免锁车阈值响应延迟）
        g_lockCounter = 0;
        if (g_unlockCounter >= g_cfgUnlockCount && g_keyState != KSTATE_UNLOCKED) {
            g_keyState = KSTATE_UNLOCKED;
            g_unlockCounter = 0;
            PRINT("[STATE] unlock threshold reached (RSSI=%d > %d, count=%d)\n",
                  (int)g_filteredRSSI, g_cfgUnlockThreshold, g_cfgUnlockCount);
            KeyGo_Unlock();
        }
    } else if (g_filteredRSSI < g_cfgLockThreshold) {
        // ★ v3.31 方案B: 同上，锁车计数器钳制在配置值，定格 N/N
        // if (g_lockCounter < g_cfgLockCount) g_lockCounter++; // 之前版本：g_lockCounter++; 
        g_lockCounter++; // ★ v3.31 方案B: 同上，计数溢出由 App 端 Math.min 处理
        g_unlockCounter = 0;
        if (g_lockCounter >= g_cfgLockCount && g_keyState != KSTATE_LOCKED) {
            g_keyState = KSTATE_LOCKED;
            g_lockCounter = 0;
            PRINT("[STATE] lock threshold reached (RSSI=%d < %d, count=%d)\n",
                  (int)g_filteredRSSI, g_cfgLockThreshold, g_cfgLockCount);
            KeyGo_Lock();
        }
    } else {
        g_unlockCounter = 0;
        g_lockCounter = 0;
    }

    // ★ v3.31 方案B: 事件驱动状态上报——计数器变化即发，让 App 实时显示「确认进度 N/总」。
    //   区间 th 与计数器同步变化（进解锁区→ucnt++/th=1；进锁车区→lcnt++/th=2；中性区→清零/th=0），
    //   故比较计数器即可覆盖 th 变化。固定 1s 心跳(SBP_PERIODIC_EVT)仍保留作在线保活，
    //   两者结合使流量与采样间隔(interval)解耦，不再 1s 周期 flood。
    if (g_unlockCounter != s_lastReportedUcnt ||
        g_lockCounter   != s_lastReportedLcnt) {
        KeyGo_NotifyStatus();
    }
}

/* ─────────────────────────────────────────────────────────────────
 * JSON 状态通知 (FF02 Notify)
 * ───────────────────────────────────────────────────────────────── */

static uint8_t s_statusRetry = 0;  // ★ 2026-07-11 fix2: 状态通知发送失败重试计数

void KeyGo_NotifyStatus(void)
{
    if (!g_deviceConnected || peripheralConnList.connHandle == GAP_CONNHANDLE_INIT)
        return;

    char json[STATUS_JSON_MAX_LEN];
    char d2[24] = "";

    if (g_customName[0]) {
        const char *src = g_customName;
        char       *dst = d2;
        uint8_t     i   = 0;
        while (*src && i < 20) {
            if (*src == '"') { *dst++ = '\\'; i++; }
            *dst++ = *src++;
            i++;
        }
        *dst = '\0';
    }

    // ★ v3.31 方案B: 当前区间（供 App 显示确认进度/状态）
    //   0=中性区 1=解锁区(f>解锁阈值) 2=锁车区(f<锁车阈值)；未初始化时按中性处理
    uint8_t th = 0;
    if (g_filteredRSSI != RSSI_UNINITIALIZED_F) {
        if (g_filteredRSSI > g_cfgUnlockThreshold)      th = 1;
        else if (g_filteredRSSI < g_cfgLockThreshold)   th = 2;
    }
    // ★ 记录本次将上报的计数，供事件驱动去重（避免每样本重复发）
    s_lastReportedUcnt = g_unlockCounter;
    s_lastReportedLcnt = g_lockCounter;

    int n = snprintf(json, sizeof(json),
        "{\"c\":1,\"st\":\"%s\",\"r\":%d,\"f\":%d,\"d2\":\"%s\",\"cd\":%d,\"kr\":%d,\"al\":%d,\"bn\":%d,\"v\":\"%s\",\"uc\":%d,\"lc\":%d,\"ucnt\":%d,\"lcnt\":%d,\"th\":%d,\"m\":%d,\"pair\":%d,\"fwsec\":%d}",
        g_keyState == KSTATE_LOCKED   ? "LOCKED"   :
        g_keyState == KSTATE_UNLOCKED ? "UNLOCKED" : "ACTION",
        (int)g_latestRSSI,
        (int)(g_filteredRSSI != RSSI_UNINITIALIZED_F ? (int)g_filteredRSSI : RSSI_UNINITIALIZED),
        d2,
        (int)g_cfgManualCooldownMs,  // ★ v3.7: 上报当前冷却时间，App 端同步
        (int)g_cfgKalmanR,           // ★ v3.13: 上报 kalmanR，App 同步 kalmanR
        (int)g_cfgAutoLockEnable,    // ★ v3.24: 上报自动锁使能状态，App 可显示/调试
        (int)(Bonding_Count() > 0 ? 1 : 0),  // ★ 2026-07-10: 已绑定标志，作为 BIND:OK 的兜底确证（status 可靠送达）
        KEYGO_FW_VERSION,            /* ★ v3.16-#26: 固件版本号上报，App 可做兼容性检查 */
        (int)g_cfgUnlockCount,       // ★ v3.31 方案B: 设备当前解锁确认次数配置（回显验证）
        (int)g_cfgLockCount,         // ★ v3.31 方案B: 设备当前锁车确认次数配置
        (int)g_unlockCounter,        // ★ v3.31 方案B: 当前解锁进度计数（实时进度）
        (int)g_lockCounter,          // ★ v3.31 方案B: 当前锁车进度计数
        (int)th,                    // ★ v3.31 方案B: 当前区间
        (int)g_deviceMode,           // ★ Phase 2: 设备模式 0=car / 1=ebike
        (int)g_encRequired,          // ★ 方案1: 无 App 模式(OS 系统配对)使能标志，App 据此反映开关/判断弹窗
        (int)KEYGO_FWSEC);           // ★ v3.33: 安全协议能力版本（授权体系升级总闸门）

    if (n > 0 && n < (int)sizeof(json)) {
        attHandleValueNoti_t noti;
        noti.len    = (uint16_t)n;
        noti.pValue = GATT_bm_alloc(peripheralConnList.connHandle, ATT_HANDLE_VALUE_NOTI,
                                    noti.len, NULL, 0);
        if (noti.pValue) {
            tmos_memcpy(noti.pValue, json, noti.len);
            if (simpleProfile_Notify(peripheralConnList.connHandle, &noti) != SUCCESS) {
                GATT_bm_free((gattMsg_t *)&noti, ATT_HANDLE_VALUE_NOTI);
                /* ★ 2026-07-11 fix2：状态通知发送失败（写事务忙 / bm_alloc 失败）也重试，
                 *   否则绑定后紧跟的 status(bn=1) 可能丢失 → App 的 bn 兜底确认失效。
                 *   重排 SBP_DEFERRED_STATUS_EVT 再发一次（上限防死循环）。 */
                if (s_statusRetry < 6) {
                    s_statusRetry++;
                    tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
                    PRINT("[STATUS] notify fail, retry=%d\n", s_statusRetry);
                }
            } else {
                s_statusRetry = 0;
            }
        }
    }
    /* ★ v3.16-#10: JSON 截断或编码错误 → 打印警告，方便排查
     *   snprintf 返回值 >= sizeof(json) 表示 JSON 被截断（超长自定义名称、
     *   extreme 配置值等场景），此前静默丢弃没有任何提示 */
    else {
        PRINT("[WARN] NotifyStatus JSON trunc: snprintf=%d, max=%d\n", n, (int)sizeof(json));
    }
}

/*********************************************************************
 * @fn      KeyGo_SendRawNotify
 * @brief   绑定层回写短报文（FF02 Notify）：BIND:/NONCE:/AUTH:/UNBIND:/DENY: 等。
 *          长度受 FF02 特征值容量限制（SIMPLEPROFILE_CHAR2_LEN）。
 *********************************************************************/
/* ─────────────────────────────────────────────────────────────────
 * ★ 2026-07-11 修复：绑定层短报文延迟发送队列
 *   原实现 KeyGo_SendRawNotify 在 FF03 写回调里【同步】调用 GATT_bm_alloc +
 *   simpleProfile_Notify 发送通知。在 CH582M BLE 协议栈下，写回调执行时 ATT 事务
 *   缓冲区仍被占用（且 BIND 紧跟 Bonding_Save() Flash 写，会关中断/占总线），
 *   导致 GATT_bm_alloc 偶发失败或通知被丢弃 —— 表现为 App 侧 BIND:OK / NONCE /
 *   AUTH 回包时有时无（status 走 SBP_DEFERRED_STATUS_EVT 延迟任务，所以稳）。
 *   改为：写回调内只【入队】并启动 SBP_DEFERRED_RAW_EVT（TMOS 任务，写回调之外），
 *   由 KeyGo_FlushRawNotify 在任务里逐个发送，与 status 走同一可靠通道。
 * ───────────────────────────────────────────────────────────────── */
#define RAW_Q_SLOTS   6           // 短报文频率极低，6 槽足够
#define RAW_Q_MAXLEN  48          // NONCE: + 32hex=38；DENY:AUTH_REQ: + 32hex=46；留余量
static char    s_rawQ[RAW_Q_SLOTS][RAW_Q_MAXLEN];
static uint8_t s_rawQHead   = 0;  // 下一个入队位置
static uint8_t s_rawQTail   = 0;  // 下一个出队位置
static uint8_t s_rawQPending = 0;
static uint8_t s_rawRetry   = 0;  // ★ 失败重试计数（防死循环）

void KeyGo_SendRawNotify(const char *msg)
{
    if (!g_deviceConnected || peripheralConnList.connHandle == GAP_CONNHANDLE_INIT)
        return;

    uint16_t n = 0;
    while (msg[n] && n < RAW_Q_MAXLEN - 1) { s_rawQ[s_rawQHead][n] = msg[n]; n++; }
    if (n == 0) return;
    s_rawQ[s_rawQHead][n] = 0;

    // 入队并启动延迟发送任务（写回调之外再发，避开 ATT 缓冲区占用 / Flash 写关中断）
    if (s_rawQPending < RAW_Q_SLOTS) {
        s_rawQHead = (s_rawQHead + 1) % RAW_Q_SLOTS;
        s_rawQPending++;
        /* ★ 2026-07-11 fix2：首踢延迟 8(≈5ms) 先试，若 ATT 事务仍忙被拒，
         *    FlushRawNotify 会以 32(≈20ms，与状态通知同档) 退避重试，直到成功。 */
        tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_RAW_EVT, 8);
        PRINT("[RAW] enqueue '%s' pending=%d\n", msg, s_rawQPending);
    }
    // 队列满则丢弃最旧未发（极低概率，绑定类报文频率极低）
}

/** ★ 2026-07-11: 由 SBP_DEFERRED_RAW_EVT 任务调用，消费一个延迟短报文。
 *   ★ fix2：发送失败（ATT 事务忙 / bm_alloc 失败）不再静默丢弃，
 *   保留在队首并以更大延迟重试（上限 6 次，避免死循环）。并打印发送结果便于定位。 */
void KeyGo_FlushRawNotify(void)
{
    if (!g_deviceConnected || peripheralConnList.connHandle == GAP_CONNHANDLE_INIT)
        return;
    if (s_rawQPending == 0) return;

    char *m = s_rawQ[s_rawQTail];
    uint16_t n = 0;
    while (m[n]) n++;

    bStatus_t st = 0xFF;  // 0xFF = 失败（非 SUCCESS）
    if (n > 0) {
        attHandleValueNoti_t noti;
        noti.len    = n;
        noti.pValue = GATT_bm_alloc(peripheralConnList.connHandle, ATT_HANDLE_VALUE_NOTI, n, NULL, 0);
        if (noti.pValue) {
            tmos_memcpy(noti.pValue, m, n);
            st = simpleProfile_Notify(peripheralConnList.connHandle, &noti);
            if (st != SUCCESS) {
                GATT_bm_free((gattMsg_t *)&noti, ATT_HANDLE_VALUE_NOTI);
            }
        } else {
            st = 0xFE;  // bm_alloc 失败
        }
    }
    PRINT("[RAW] flush '%s' st=%d retry=%d pending=%d\n", m, (int)st, s_rawRetry, s_rawQPending);

    if (st == SUCCESS) {
        s_rawRetry = 0;
        s_rawQTail = (s_rawQTail + 1) % RAW_Q_SLOTS;
        s_rawQPending--;
    } else {
        /* 发送失败：保留在队首重试；超过上限则丢弃，避免占满队列/死循环 */
        s_rawRetry++;
        if (s_rawRetry >= 6) {
            PRINT("[RAW] drop after %d retries: %s\n", s_rawRetry, m);
            s_rawRetry = 0;
            s_rawQTail = (s_rawQTail + 1) % RAW_Q_SLOTS;
            s_rawQPending--;
        }
    }

    // 队列还有剩余 → 再排一次任务（失败重试用 32≈20ms 退避，成功续发也用此档，稳妥）
    if (s_rawQPending > 0) {
        tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_RAW_EVT, 32);
    }
}

/* ★ 2026-07-12 fix3：清空 raw 短报文延迟发送队列。
 *   在 KeyGo_ResetState()（连接建立/断开/Init 均调用）末尾调用，确保新连接从一个
 *   干净的队列开始，杜绝跨连接残留报文 flush 给新连接（隐患 A）。
 *   注意：只清队列变量、不调用 tmos_stop_task —— 残留的 SBP_DEFERRED_RAW_EVT 任务
 *   在队列清空后会被 FlushRawNotify 的 (s_rawQPending==0) 早返回安全吸收；而 Init 阶段
 *   调 tmos_stop_task 会破坏该延迟发送任务的后续启动/执行，导致 BIND:OK/NONCE/AUTH
 *   全部发不出（验证失败回归，已弃用）。 */
static void KeyGo_ClearRawQueue(void)
{
    s_rawQHead    = 0;
    s_rawQTail    = 0;
    s_rawQPending = 0;
    s_rawRetry    = 0;
}

/* ─────────────────────────────────────────────────────────────────
 * 命令处理 (NAME / TRUNK / UNLOCK / LOCK)
 * ───────────────────────────────────────────────────────────────── */

void KeyGo_HandleCommand(const char *cmd, uint16_t len)
{
    if (len < 2) return;

    char upper[50] = {0};
    uint16_t i;
    for (i = 0; i < len && i < sizeof(upper) - 1; i++) {
        upper[i] = (cmd[i] >= 'a' && cmd[i] <= 'z') ? cmd[i] - 32 : cmd[i];
    }

    /* ★ v3.15-fix1: 冷却期仅应在 GPIO 操作 (TRUNK/UNLOCK/LOCK) 后触发
     *   NAME:xxx 和 STATUS 等请求不应占用冷却期
     *   → 将 cooldown 移至各 GPIO 分支内部 */
    // NAME:xxx
    if (len > 5 && upper[0] == 'N' && upper[1] == 'A' && upper[2] == 'M' && upper[3] == 'E' && upper[4] == ':') {
        const char *name    = cmd + 5;
        uint8_t     nameLen = len - 5;
        if (nameLen > 20) nameLen = 20;
        tmos_memset(g_customName, 0, sizeof(g_customName));
        tmos_memcpy(g_customName, name, nameLen);
        PRINT("[NAME] set to: %s\n", g_customName);
        KeyGo_NotifyStatus();
        return;
    }

    // TRUNK (精确匹配 5 字节，排除 TRUNKED/TRUNKING 等)
    if (len == 5 && upper[0] == 'T' && upper[1] == 'R' && upper[2] == 'U' && upper[3] == 'N' && upper[4] == 'K') {
        /* ★ v3.15-fix1: 命令执行前设置冷却期，防止连续操作抖动 */
        g_manualCooldown  = 1;
        g_lastCommandMs   = Peripheral_GetSystemMs();
        // ★ v3.15-#14: 重置状态机计数器，与 UNLOCK/LOCK 行为一致
        //   避免后备箱操作后冷却期内，旧累积计数在冷却结束后意外触发自动锁/解锁
        g_unlockCounter  = 0;
        g_lockCounter    = 0;
        KeyGo_Trunk();
        return;
    }

    // UNLOCK (精确匹配 6 字节，排除 UNLOCKED/UNLOCKING 等)
    if (len == 6 && upper[0] == 'U' && upper[1] == 'N' && upper[2] == 'L' && upper[3] == 'O' && upper[4] == 'C' && upper[5] == 'K') {
        /* ★ v3.15-fix1: 冷却期仅在 GPIO 操作后触发 */
        g_manualCooldown  = 1;
        g_lastCommandMs   = Peripheral_GetSystemMs();
        g_keyState       = KSTATE_UNLOCKED;
        // ★ v3.6-fixH: 重置状态机计数器，防止冷却结束后累积的旧计数触发自动操作
        //   bug: 手动解锁后冷却期内计数未清零，冷却结束后状态机立即用累积计数覆盖手动状态
        g_unlockCounter  = 0;
        g_lockCounter    = 0;
        KeyGo_Unlock();
        KeyGo_NotifyStatus();
        return;
    }

    // LOCK (精确匹配 4 字节，排除 LOCKED/LOCKER/LOCKING 等)
    if (len == 4 && upper[0] == 'L' && upper[1] == 'O' && upper[2] == 'C' && upper[3] == 'K') {
        /* ★ v3.15-fix1: 冷却期仅在 GPIO 操作后触发 */
        g_manualCooldown  = 1;
        g_lastCommandMs   = Peripheral_GetSystemMs();
        g_keyState       = KSTATE_LOCKED;
        // ★ v3.6-fixH: 同上，重置计数器
        g_unlockCounter  = 0;
        g_lockCounter    = 0;
        KeyGo_Lock();
        KeyGo_NotifyStatus();
        return;
    }

    // ★ Phase 2: MODE:car / MODE:ebike (精确匹配 MODE: 前缀)
    if (len > 5 && upper[0] == 'M' && upper[1] == 'O' && upper[2] == 'D' && upper[3] == 'E' && upper[4] == ':') {
        const char *val = cmd + 5;
        uint8_t mode;
        if      (KEYGO_STREQ(val, "car",   3)) mode = 0;
        else if (KEYGO_STREQ(val, "ebike", 5)) mode = 1;
        else { PRINT("[MODE] unknown value: %s\n", val); return; }
        KeyGo_SaveMode(mode);
        KeyGo_NotifyStatus();
        return;
    }

    // ★ Phase 2: RIDE (精确匹配 4 字节，电瓶车骑行)
    if (len == 4 && upper[0] == 'R' && upper[1] == 'I' && upper[2] == 'D' && upper[3] == 'E') {
        if (g_deviceMode == 1) {
            KeyGo_Ride();
            PRINT("[RIDE] ride (ebike)\n");
        } else {
            // car 模式 RIDE 无意义 → 拒绝
            KeyGo_SendRawNotify("DENY:NOT_SUPPORTED");
            PRINT("[RIDE] denied: not ebike mode\n");
        }
        return;
    }

    PRINT("[CMD] unknown: %s\n", cmd);
}

/* ─────────────────────────────────────────────────────────────────
 * ★ v3.13: RSSI 周期 ms → TMOS ticks 转换
 *   1 TMOS tick ≈ 0.625ms, 所以 ticks = ms * 8 / 5
 * ───────────────────────────────────────────────────────────────── */
uint16_t KeyGo_GetRssiPeriodTicks(void)
{
    uint32_t ticks = (uint32_t)g_cfgRssiPeriodMs * MS_TO_TMOS_TICK_NUM / MS_TO_TMOS_TICK_DEN;
    if (ticks < RSSI_PERIOD_TICKS_MIN) return RSSI_PERIOD_TICKS_MIN;   // 下限 ~62.5ms
    if (ticks > RSSI_PERIOD_TICKS_MAX) return RSSI_PERIOD_TICKS_MAX;   // 上限 ~2500ms
    return (uint16_t)ticks;
}

/* ★ v3.15-#15: 断连锁车延时 ms → TMOS ticks 转换
 *   1 TMOS tick ≈ 0.625ms → ticks = ms × 8 / 5
 *   g_cfgDisconnectLockMs 上限 60000ms → 96000 ticks, uint16_t 安全
 *   dlockMs == 0 时返回 0（调用方判断为立即锁车，不启动定时器） */
uint16_t KeyGo_GetDisconnectLockTicks(void)
{
    if (g_cfgDisconnectLockMs == 0) return 0;
    uint32_t ticks = (uint32_t)g_cfgDisconnectLockMs * MS_TO_TMOS_TICK_NUM / MS_TO_TMOS_TICK_DEN;
    return (uint16_t)ticks;
}

/* ─────────────────────────────────────────────────────────────────
 * ★ v3.5: FF01 配置解析 (KeyGo_ParseConfig)
 *
 *   解析 App 通过 FF01 下发的配置文本:
 *     "unlock=-30 lock=-45 uc=2 lc=3 interval=500 dlock=5000 cooldown_ms=8000 kr=25"
 *
 * ★ v3.12: 分类持久化策略
 *   Per-phone (仅存 RAM): unlock lock uc lc interval dlock
 *     → 手机每次连接后下发专属配置，不写 Flash（避免反复擦写损耗寿命）
 *   Per-device (写 DataFlash): cooldown_ms
 *     → 冷却时间是设备级参数，所有手机共用，变更时写入 Flash
 *
 *   与 ESP32 版本的 parseConfigLine() 功能等效。
 *   返回: 0=无配置变更, 1=有配置变更
 *
 *   注意: 纯 RSSI 值 ("-50") 或 "rssi=-50" 由此函数的外部调用者处理，
 *         本函数只处理非 RSSI 的配置 key。
 * ───────────────────────────────────────────────────────────────── */
uint8_t KeyGo_ParseConfig(const char *line)
{
    if (!line || line[0] == '\0') return 0;

    uint8_t changed = 0;
    uint8_t cooldown_changed = 0;   // ★ v3.12: 仅 cooldown_ms 变更时写 Flash（设备级参数）
    const char *p = line;

    while (*p) {
        // 跳过前导空格
        while (*p == ' ') p++;
        if (*p == '\0') break;

        // 找到 '='
        const char *eq = p;
        while (*eq && *eq != '=' && *eq != ' ') eq++;
        if (*eq != '=') { p = eq; continue; }

        // 提取 key (p 到 eq)
        uint8_t keyLen = (uint8_t)(eq - p);
        if (keyLen == 0) { p = eq + 1; continue; }

        // ★ 跳过 "rssi" key — RSSI 值由外部调用者处理
        if (keyLen == 4 && p[0] == 'r' && p[1] == 's' && p[2] == 's' && p[3] == 'i') {
            p = eq + 1;
            while (*p && *p != ' ') p++;
            continue;
        }

        // 提取 value (eq+1 到下一个空格或结束)
        const char *valStart = eq + 1;
        const char *valEnd = valStart;
        while (*valEnd && *valEnd != ' ') valEnd++;

        int val = 0;
        {
            const char *vp = valStart;
            int sign = 1;
            if (*vp == '-') { sign = -1; vp++; }
            else if (*vp == '+') { vp++; }
            while (*vp >= '0' && *vp <= '9') {
                val = val * 10 + (*vp - '0');
                vp++;
            }
            val *= sign;
        }

        // ── 匹配 key 并更新对应变量 ──
        if      (keyLen == 6 && KEYGO_STREQ(p, "unlock", 6))   { g_cfgUnlockThreshold = (int16_t)val; changed = 1; }
        else if (keyLen == 4 && KEYGO_STREQ(p, "lock", 4))     { g_cfgLockThreshold = (int16_t)val;   changed = 1; }
        else if (keyLen == 2 && KEYGO_STREQ(p, "uc", 2))       { g_cfgUnlockCount = (uint8_t)val;     changed = 1; }
        else if (keyLen == 2 && KEYGO_STREQ(p, "lc", 2))       { g_cfgLockCount = (uint8_t)val;       changed = 1; }
        // ★ v3.13: interval 改为控制固件 RSSI 读取周期 (原为 App 轮询间隔，已废弃)
        else if (keyLen == 8 && KEYGO_STREQ(p, "interval", 8)) {
            if (val >= RSSI_PERIOD_MIN_MS && val <= RSSI_PERIOD_MAX_MS && g_cfgRssiPeriodMs != (uint16_t)val) {
                g_cfgRssiPeriodMs = (uint16_t)val;
                changed = 1;
            }
        }
        else if (keyLen == 5 && KEYGO_STREQ(p, "dlock", 5))    { g_cfgDisconnectLockMs = (uint16_t)val; changed = 1; }
        // ★ v3.13: Kalman R 值 (kr)
        else if (keyLen == 2 && KEYGO_STREQ(p, "kr", 2)) {
            if (val >= KALMAN_R_MIN && val <= KALMAN_R_MAX && g_cfgKalmanR != (uint8_t)val) {
                g_cfgKalmanR = (uint8_t)val;
                g_kalman.R = (float)g_cfgKalmanR;
                /* ★ v3.16-#24: R 值变更后重置滤波器内部状态
                 *   bug: 旧 P 已收敛到极小值 → 新 R 几乎无效果（假平滑）
                 *   例如从 kr=1（极快响应）切到 kr=50（极度平滑），
                 *   旧 P≈0 → K≈0 → 新测量值权重极低 → 滤波器"卡死"
                 *   重置 P + init → 下一帧 Kalman 用新 R 重新初始化 X */
                g_kalman.P = KALMAN_DEFAULT_P;
                g_kalman.init = 0;
                changed = 1;
                PRINT("[KALMAN] R updated to %d, filter reset\n", val);
            }
        }
        // ★ v3.7 / v3.12: 冷却时间 cooldown_ms (长度 11)
        //   ★ 设备级参数（写入 DataFlash，所有连接此设备的手机共用）
        //   ★ 仅在值实际变化且合法时标记 cooldown_changed（触发 Flash 保存）
        else if (keyLen == 11 && KEYGO_STREQ(p, "cooldown_ms", 11)) {
            if (val >= COOLDOWN_MIN_MS && val <= COOLDOWN_MAX_MS && g_cfgManualCooldownMs != (uint16_t)val) {
                g_cfgManualCooldownMs = (uint16_t)val;
                cooldown_changed = 1;
                changed = 1;
            }
        }
        // ★ v3.24: 自动锁使能 autolock (长度 8) — 手动模式由 App 下发 autolock=0 关闭 RSSI 自动锁
        else if (keyLen == 8 && KEYGO_STREQ(p, "autolock", 8)) {
            uint8_t en = (val != 0) ? 1 : 0;
            if (g_cfgAutoLockEnable != en) {
                g_cfgAutoLockEnable = en;
                changed = 1;
                PRINT("[CONFIG] autolock=%d\n", g_cfgAutoLockEnable);
            }
        }

        p = valEnd;
    }

    if (changed) {
        PRINT("[CONFIG] updated: unlock=%d lock=%d uc=%d lc=%d dlock=%d interval=%d kr=%d\n",
              g_cfgUnlockThreshold, g_cfgLockThreshold, g_cfgUnlockCount,
              g_cfgLockCount, g_cfgDisconnectLockMs, g_cfgRssiPeriodMs, g_cfgKalmanR);
        // ★ 配置变更后重置计数器，避免旧阈值下的累积计数影响新阈值判断
        g_unlockCounter = 0;
        g_lockCounter   = 0;
        // ★ v3.12: 仅 cooldown_ms 写 DataFlash（设备级参数，所有手机共用）
        //   unlock/lock/uc/lc/dlock/interval 仅存 RAM，由手机每次连接后下发（per-phone 个性化）
        if (cooldown_changed) {
            KeyGo_SaveConfig();
        }
    }

    return changed;
}

/* ─────────────────────────────────────────────────────────────────
 * ★ v3.5.1: 配置持久化到 DataFlash（v3.12: 仅 cooldown_ms 自动调用）
 *
 * ★ v3.12: 此函数仅由 ParseConfig 在 cooldown_ms 值变更时自动调用。
 *   冷却时间是设备级参数，写入 Flash 确保所有手机共享同一值。
 *   其他参数 (unlock/lock/uc/lc/dlock) 不写 Flash（per-phone 方案）。
 *
 *   使用 DataFlash【偏移 0x7000(物理 0x77000)~0x70FF】区域存储配置 (BLE SNV 在偏移 0x07E00)
 *   ★ 2026-07-12 修复：EEPROM 地址是相对 DataFlash 基地址 0x70000 的【偏移】，非物理地址。
 *   写入前先擦除页 (256 字节对齐)，然后写入 16 字节配置块
 *   格式: [magic:4][unlock:2][lock:2][uc:1][lc:1][dlock:2][checksum:1][cooldown_ms:2][pad:1]
 *   checksum = XOR over magic+values (前 12 字节)
 * ───────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────
 * ★ Phase 2: 设备模式(汽车/电瓶车) 持久化
 *   0=car(默认) / 1=ebike。MODE_ADDR 未初始化(0xFF) → 视为 car。
 *   DataFlash 写只能 1→0，故 car→ebike(0→1) 需先擦页再写；ebike→car(1→0) 无需擦。
 *   为简单稳妥，SaveMode 总是先擦 MODE 页(256B)再写单字节。
 * ───────────────────────────────────────────────────────────────── */
void KeyGo_LoadMode(void)
{
    uint8_t val = 0xFF;
    if (EEPROM_READ(KEYGO_MODE_ADDR, &val, 1) == 0 && val != 0xFF) {
        g_deviceMode = (val == 1) ? 1 : 0;
    } else {
        g_deviceMode = 0;  // 默认 car
    }
    PRINT("[MODE] loaded mode=%d (raw=%d)\n", g_deviceMode, val);
}

void KeyGo_SaveMode(uint8_t mode)
{
    uint8_t val = (mode ? 1 : 0);
    EEPROM_ERASE(KEYGO_MODE_ADDR, 256);   // 擦本页（MODE 独占 0x7300 页）
    if (EEPROM_WRITE(KEYGO_MODE_ADDR, &val, 1) != 0) {
        PRINT("[MODE] save FAILED\n");
    } else {
        g_deviceMode = val;
        PRINT("[MODE] saved mode=%d\n", val);
    }
}

/* ─────────────────────────────────────────────────────────────────
 * ★ 方案1: 无 App 模式(OS 系统配对)标志持久化
 *   g_encRequired=1 → 固件配对模式 INITIATE(连接即主动发 Slave Security Request
 *   → OS 弹 passkey 窗 → 配对 → 之后 OS 加密重连, 无 App 也能解锁)。
 *   单字节存于 KEYGO_ENCRYPT_ADDR(默认 0xFF=未初始化→关闭)。
 * ───────────────────────────────────────────────────────────────── */
void KeyGo_LoadEncrypt(void)
{
    uint8_t b = 0xFF;
    if (EEPROM_READ(KEYGO_ENCRYPT_ADDR, &b, 1) == 0 && b != 0xFF) {
        g_encRequired = (b & 0x01) ? 1 : 0;
    } else {
        g_encRequired = 0;   // 未初始化 → 默认关闭(明文最大兼容)
    }
    PRINT("[ENC] loaded encRequired=%d\n", g_encRequired);
}

void KeyGo_SaveEncrypt(uint8_t v)
{
    uint8_t b = (v ? 1 : 0);
    EEPROM_ERASE(KEYGO_ENCRYPT_ADDR, 256);   // DataFlash 写只能 1→0，改值前先擦本页
    if (EEPROM_WRITE(KEYGO_ENCRYPT_ADDR, &b, 1) != 0) {
        PRINT("[ENC] save FAILED\n");
    } else {
        g_encRequired = b;
        PRINT("[ENC] saved encRequired=%d\n", b);
    }
}

/* ─────────────────────────────────────────────────────────────────
 * ★ 方案1 扩展: 系统配对码(OS SMP passkey)持久化 —— 与绑定码完全独立。
 *   仅接受 6 位数字(100000~999999)；未初始化/越界 → 默认 123456。
 * ───────────────────────────────────────────────────────────────── */
void KeyGo_LoadPasscode(void)
{
    uint32_t v = 0;
    if (EEPROM_READ(KEYGO_PASSCODE_ADDR, (uint8_t *)&v, 4) == 0 &&
        v >= 100000u && v <= 999999u) {
        g_sysPasscode = v;
    } else {
        g_sysPasscode = 123456u;   // 未初始化/越界 → 默认
    }
    PRINT("[PASS] loaded sysPasscode=%lu\n", (unsigned long)g_sysPasscode);
}

void KeyGo_SavePasscode(uint32_t v)
{
    EEPROM_ERASE(KEYGO_PASSCODE_ADDR, 256);   // DataFlash 写只能 1→0，改值前先擦本页
    if (EEPROM_WRITE(KEYGO_PASSCODE_ADDR, (uint8_t *)&v, 4) != 0) {
        PRINT("[PASS] save FAILED\n");
    } else {
        g_sysPasscode = v;
        PRINT("[PASS] saved sysPasscode=%lu\n", (unsigned long)v);
    }
}

void KeyGo_LoadConfig(void)
{
    __attribute__((aligned(4))) uint8_t buf[16] = {0};
    int rc = EEPROM_READ(KEYGO_CFG_ADDR, buf, 16);
    if (rc != 0) {
        PRINT("[CONFIG] EEPROM_READ failed (rc=%d), using defaults\n", rc);
        return;
    }

    // 校验 magic
    /* ★ v3.15-fix3: 改用字节拼装替代指针强转 ((uint32_t*)buf)
     *   Cortex-M0 不支持非对齐内存访问，栈上 buf 对齐非标准保证
     *   若编译器未字对齐 buf，*(uint32_t*)buf 会触发 HardFault */
    uint32_t magic = (uint32_t)buf[0] | ((uint32_t)buf[1] << 8) |
                     ((uint32_t)buf[2] << 16) | ((uint32_t)buf[3] << 24);
    if (magic != KEYGO_CFG_MAGIC) {
        PRINT("[CONFIG] No saved config (magic mismatch), using defaults\n");
        return;
    }

    // 校验 checksum (XOR over first 12 bytes)
    uint8_t csum = 0;
    for (uint8_t i = 0; i < 12; i++) csum ^= buf[i];
    if (csum != buf[12]) {
        PRINT("[CONFIG] Checksum mismatch, using defaults\n");
        return;
    }

    // 恢复配置
    /* ★ v3.15-fix3: 字节拼装，避免未对齐访问 (LE) */
    g_cfgUnlockThreshold  = (int16_t)((uint16_t)buf[4] | ((uint16_t)buf[5] << 8));
    g_cfgLockThreshold    = (int16_t)((uint16_t)buf[6] | ((uint16_t)buf[7] << 8));
    g_cfgUnlockCount      = buf[8];
    g_cfgLockCount        = buf[9];
    g_cfgDisconnectLockMs = (uint16_t)buf[10] | ((uint16_t)buf[11] << 8);
    // ★ v3.7: 读取 cooldownMs（buf[13-14]），旧格式此处为 0，需兜底
    {
        uint16_t cd = (uint16_t)buf[13] | ((uint16_t)buf[14] << 8);
        if (cd >= COOLDOWN_MIN_MS && cd <= COOLDOWN_MAX_MS) {
            g_cfgManualCooldownMs = cd;
        } else {
            g_cfgManualCooldownMs = COOLDOWN_DEFAULT_MS;  // 旧格式或越界 → 默认 8s
        }
    }

    // 合理性校验（使用命名常量替代魔术数字）
    if (g_cfgUnlockThreshold >= 0 || g_cfgUnlockThreshold < RSSI_THRESHOLD_MIN) g_cfgUnlockThreshold = -45;
    if (g_cfgLockThreshold >= 0 || g_cfgLockThreshold < RSSI_THRESHOLD_MIN)     g_cfgLockThreshold   = -65;
    if (g_cfgUnlockCount < COUNT_MIN || g_cfgUnlockCount > COUNT_MAX)           g_cfgUnlockCount     = 2;
    if (g_cfgLockCount < COUNT_MIN || g_cfgLockCount > COUNT_MAX)               g_cfgLockCount       = 3;
    if (g_cfgDisconnectLockMs > DLOCK_MAX_MS)                                   g_cfgDisconnectLockMs = 5000;

    PRINT("[CONFIG] Loaded from flash: unlock=%d lock=%d uc=%d lc=%d dlock=%d cooldown_ms=%d\n",
          g_cfgUnlockThreshold, g_cfgLockThreshold, g_cfgUnlockCount,
          g_cfgLockCount, g_cfgDisconnectLockMs, g_cfgManualCooldownMs);
}

void KeyGo_SaveConfig(void)
{
    // 擦除配置页 (256 字节，页对齐)
    EEPROM_ERASE(KEYGO_CFG_ADDR, 256);

    __attribute__((aligned(4))) uint8_t buf[16] = {0};
    __attribute__((aligned(4))) uint8_t rbuf[16];

    /* ★ v3.15-fix3: 字节写入替代指针强转，确保对齐安全 (LE) */
    // Magic (4 bytes, LE)
    buf[0] = (uint8_t)(KEYGO_CFG_MAGIC);
    buf[1] = (uint8_t)(KEYGO_CFG_MAGIC >> 8);
    buf[2] = (uint8_t)(KEYGO_CFG_MAGIC >> 16);
    buf[3] = (uint8_t)(KEYGO_CFG_MAGIC >> 24);

    // 配置值 (int16_t, LE)
    buf[4] = (uint8_t)(g_cfgUnlockThreshold);
    buf[5] = (uint8_t)(g_cfgUnlockThreshold >> 8);
    buf[6] = (uint8_t)(g_cfgLockThreshold);
    buf[7] = (uint8_t)(g_cfgLockThreshold >> 8);
    buf[8]  = g_cfgUnlockCount;
    buf[9]  = g_cfgLockCount;

    // uint16_t disconnectLockMs (LE)
    buf[10] = (uint8_t)(g_cfgDisconnectLockMs);
    buf[11] = (uint8_t)(g_cfgDisconnectLockMs >> 8);

    // ★ v3.7: cooldownMs 存于 buf[13-14]（旧格式为 padding=0，兼容）
    buf[13] = (uint8_t)(g_cfgManualCooldownMs);
    buf[14] = (uint8_t)(g_cfgManualCooldownMs >> 8);

    // Checksum: XOR over first 12 bytes（不含 cooldownMs，保持向后兼容）
    buf[12] = 0;
    for (uint8_t i = 0; i < 12; i++) buf[12] ^= buf[i];

    if (EEPROM_WRITE(KEYGO_CFG_ADDR, buf, 16) != 0) {
        PRINT("[CONFIG] Save to flash FAILED\n");
        return;
    }
    /* 写后读回校验, 确认真正落盘 */
    if (EEPROM_READ(KEYGO_CFG_ADDR, rbuf, 16) != 0 ||
        tmos_memcmp(rbuf, buf, 16) == 0) {   /* tmos_memcmp: 0=不同 → 校验失败 */
        PRINT("[CONFIG] Save verify FAILED (not persisted)\n");
        return;
    }
    PRINT("[CONFIG] Saved to flash OK (verified)\n");
}

/*********************************************************************
 *********************************************************************/
