/********************************** (C) COPYRIGHT *******************************
 * File Name          : CONFIG.h
 * Author             : KeyGo v3.5 (CH582M 移植)
 * Date               : 2026/06/30
 * Description        : 全局配置 — BLE Key-Go for CH582M
 *********************************************************************************/

#ifndef __CONFIG_H
#define __CONFIG_H

#define	ID_CH583							0x83
#define CHIP_ID								ID_CH583

#ifdef CH58xBLE_ROM
#include "CH58xBLE_ROM.H"
#else
#include "CH58xBLE_LIB.H"
#endif

// #define DEBUG                         Debug_UART1   // ★ 临时诊断用，生产关闭

#include "CH58x_common.h"

/* ─────────────────────────────────────────────────────────────────
 * ★ KeyGo v3.5 GPIO 引脚定义 (CH582M 硬件) — 自定义 PCB V03/V04
 *   Unlock=PB5, Lock=PB7, Trunk/Cycling=PB6, Other(喇叭/寻车)=PB4
 *   KEY_POWER(给钥匙供电/驱动PMOS导通)=PB0
 *   LED_R=PB15, LED_B=PB14
 *   PB22 = BIND 按键, RST=PB23, BOOT=PB22(长按恢复出厂)
 * ───────────────────────────────────────────────────────────────── */
#define PIN_UNLOCK_GPIO             GPIO_Pin_5   // PB5 → 解锁
#define PIN_LOCK_GPIO               GPIO_Pin_7   // PB7 → 上锁
#define PIN_TRUNK_GPIO              GPIO_Pin_6   // PB6 → 后备箱/骑行
#define PIN_OTHER_GPIO              GPIO_Pin_4   // PB4 → 第4键(喇叭/寻车)
#define PIN_KEYPOWER_GPIO           GPIO_Pin_0   // PB0 → KEY_POWER(给钥匙供电, 驱动 PMOS 导通)
/* ★ ebike RIDE 输出引脚。复用 TRUNK 脚(PB6)——电动车模式 RIDE 触发线接此处 */
#define PIN_RIDE_GPIO               GPIO_Pin_6   // PB6 → 电瓶车 RIDE(快速双击)

#define PIN_UNLOCK_PORT             GPIOB
#define PIN_LOCK_PORT               GPIOB
#define PIN_TRUNK_PORT              GPIOB
#define PIN_OTHER_PORT              GPIOB
#define PIN_KEYPOWER_PORT           GPIOB
#define PIN_RIDE_PORT               GPIOB

/* ★ 双 LED 指示: 蓝(PB14)=常规状态/命令反馈, 红(PB15)=重大提示(恢复出厂等) */
#define PIN_LED_BLUE_GPIO           GPIO_Pin_14  // PB14 → 蓝色 LED (常规: 解锁亮/锁车灭, TRUNK/RIDE 闪烁, OS重连提示)
#define PIN_LED_BLUE_PORT           GPIOB
#define PIN_LED_RED_GPIO            GPIO_Pin_15  // PB15 → 红色 LED (重大: 长按恢复出厂)
#define PIN_LED_RED_PORT            GPIOB

/* ★ KEY_POWER(PB0) 有效电平: 1=高有效(经NPN反相驱动PMOS) / 0=低有效(直驱PMOS栅极)。
 *   ★ 已确认(2026-07-29): 你的 PCB 为 PMOS 直驱栅极, 低有效 → 拉低 PB0 = 导通供电。 */
#ifndef KEY_POWER_ACTIVE_LEVEL
#define KEY_POWER_ACTIVE_LEVEL      0   // ★ 已确认: PMOS 直驱栅极, 低有效(拉低 PB0 = 导通)
#endif
/* ★ 自动电源管理: 收到命令→上电(等待 KEY_POWER_SETTLE_MS)→执行→空闲 KEY_POWER_HOLD_MS 后自动断电 */
#ifndef KEY_POWER_SETTLE_MS
#define KEY_POWER_SETTLE_MS         100   // 上电后等待钥匙 MCU 启动(POR)稳定
#endif
#ifndef KEY_POWER_HOLD_MS
#define KEY_POWER_HOLD_MS           4000  // 末次命令后保持通电时长(ms), 到期自动断电省电
#endif

/* ─────────────────────────────────────────────────────────────────
 * 默认配置值 (可通过 MRS IDE 项目预处理覆盖)
 * ───────────────────────────────────────────────────────────────── */

/* 【硬件模块】KeyGo 需要 LED 和 KEY */
#ifndef HAL_KEY
#define HAL_KEY                             TRUE
#endif
#ifndef HAL_LED
#define HAL_LED                             FALSE   /* KeyGo 自行管理 PB15 LED，关闭 HAL LED 子系统以免极性冲突 */
#endif

/* 【MAC】使用芯片出厂 MAC */
#ifndef BLE_MAC
#define BLE_MAC                             FALSE
#endif

/* 【DCDC】内部降压变换器 —— 2026-07-30 (v3.36.3-fix17) 启用
 * ★ 硬件前提（自定义 PCB v1 已满足，换板务必逐条确认，否则必须改回 FALSE）：
 *     ① VSW–VDCID 储能电感：CH582M Datasheet 建议 **10uH**（范围 3.3uH~33uH），
 *        额定电流 >250mA，自谐振频率 SRF >11MHz，直流电阻 DCR <1Ω。
 *        若两脚是【直连/旁路】接法，开启 DCDC 等于把开关节点直接短到 VDD → 短路损坏芯片，此宏必须保持 FALSE。
 *     ② VDCID / VDCIA 对地退耦电容：Datasheet 建议 **2.2uF**（支持 0.47uF~4.7uF）。
 *        **容值偏小会降低 BLE 灵敏度约 2dBm**（Datasheet 原文："容值小略省电但降低 BLE 灵敏度 2dBm"）。
 *        最佳 2.2uF（可用 2×1uF 并联≈2uF 近似）；再并 100nF 高频旁路。原理图默认的 0.1uF 低于 datasheet 下限 0.47uF，开启 DCDC 不可用。
 *     ③ VDD33 / VIO33（引脚 3）退耦电容：Datasheet 要求启用 DC-DC 时建议 2.2uF 或 1uF，不启用 DC-DC 时 0.1uF 即可。
 *        VIO33 可与 VDD33 共用同一电容。★ v1 板 VIO33/VDD33 接入 +3V3（XC6206 LDO 输出），
 *        务必确认已在 CH582M 引脚旁布置 ≥1uF 本地退耦（非仅靠上级 LDO 输出电容）。
 *     ④ VSW 脚【不可】挂任何对地电容（开关节点挂电容 = 每周期硬放电，发热且损效率）。
 * ★ 软件路径：peripheral_main.c 的 main() 首行 PWR_DCDCCfg(ENABLE)（受本宏保护）。
 * ★ 与 HAL_SLEEP 兼容：LowPower_Sleep()（StdPeriphDriver/CH58x_pwr.c）在进/出睡眠时
 *     保留 DCDC_EN / DCDC_PRE 位，休眠唤醒后 DCDC 仍生效，无需额外处理。
 * ★ 收益：活跃态 / 连接态电流约降至直通模式的 60%；睡眠态电流几乎不变（睡眠本就极低）。
 * ★ 回退：真机若出现偶发复位、BLE 灵敏度下降、串口乱码，先把本宏改回 FALSE 复测，
 *     以区分是电源纹波问题还是固件逻辑问题。旁路接法下 FALSE 亦安全（电感等效导线，仅无收益）。
 */
#ifndef DCDC_ENABLE
#define DCDC_ENABLE                         FALSE
#endif

/* 【SLEEP】低功耗休眠开关 —— P1+P2 (2026-07-30, v3.36.3-fix12) 已启用
 * ★ 机制：休眠由 BLE 库的 cfg.sleepCB = CH58X_LowPower 驱动（见 HAL/MCU.c:124），
 *   TMOS_SystemProcess() 在无待处理任务时自动调用，主循环 Main_Circulation 无需改动。
 * ★ GPIO 安全：main() 在 HAL_SLEEP=TRUE 时先把 GPIOA/B 全部设输入上拉(peripheral_main.c:189)，
 *   但 Peripheral_Init→KeyGo_GPIO_Init 随后把控制脚(PB4/5/6/7/PB0/14/15)配回输出并保电平，
 *   睡眠期间 GPIO 输出锁存保持 → 继电器/LED 电平不丢、不 float。已真机确认引脚配置完整。
 * ★ 软看门狗兼容：断连后设备持续广播（间隔<2.5s），主循环每次唤醒都置 g_mainLoopAlive=1
 *   （peripheral_main.c:160），故 WDOG_BAT 不会误判死机复位；连接态唤醒更频繁，天然安全。
 *   ? 注意：若将来把广播间隔调到 >2.5s 或实现"完全停广播 deep-park"，需重新评估看门狗，
 *     否则长睡会让 g_mainLoopAlive 连续 5 次(~2.5s)不报到 → 误软复位。
 * ★ 调试提示：抓 UART 日志时若发现 PRINT 被睡眠吞掉，临时设回 FALSE 即可（生产固件保持 TRUE）。
 * ★ DCDC_ENABLE = TRUE（fix17 启用，自焊板已串电感），与休眠无关。 */
#ifndef HAL_SLEEP
#define HAL_SLEEP                           TRUE
#endif
#ifndef SLEEP_RTC_MIN_TIME
#define SLEEP_RTC_MIN_TIME                  US_TO_RTC(1000)
#endif
#ifndef SLEEP_RTC_MAX_TIME
#define SLEEP_RTC_MAX_TIME                  MS_TO_RTC(RTC_TO_MS(RTC_TIMER_MAX_VALUE) - 1000 * 60 * 60)
#endif
#ifndef WAKE_UP_RTC_MAX_TIME
#define WAKE_UP_RTC_MAX_TIME                US_TO_RTC(1400)
#endif

/* 【校准】 */
#ifndef TEM_SAMPLE
#define TEM_SAMPLE                          TRUE
#endif
#ifndef BLE_CALIBRATION_ENABLE
#define BLE_CALIBRATION_ENABLE              TRUE
#endif
#ifndef BLE_CALIBRATION_PERIOD
#define BLE_CALIBRATION_PERIOD              120000
#endif

/* 【SNV】Bonding(LTK) 持久化 — DataFlash 区域重分区（2026-07-17 扩容）
 *   旧默认 BLE_SNV_ADDR=0x77E00-FLASH_ROM_MAX_SIZE(偏移 0x07E00) 仅留 512B，
 *   配 BLE_SNV_NUM=1，曾被误判为「最多 2 台绑定的硅上限」——实为默认布局副产物。
 *   本固件 App 数据区占用 偏移 0x7000~0x7700(CFG/BOND/BINDCODE/MODE/SECEP/ENCRYPT/PASSCODE)，
 *   其后 0x7700~0x07E00 为一段空闲 DataFlash。将 SNV 起点下移到偏移 0x7700、
 *   BLE_SNV_NUM=8(每块 256B → 2KB)，即可真实存 8 个 OS 绑定，覆盖全部 8 个 owner。
 *   末端 0x07F00~0x08000 保留 256B 余量，避免触及 bootloader(phys 0x78000)。
 *   ★ Mesh 说明：本工程链接 CH58xBLE_ROM(非 MESH 变体)，未启用 Mesh，故不存在
 *     Mesh NV 与本 SNV 区冲突；若日后启用 Mesh，其 NV 走独立区域，与本配置无关。
 *   ★ 破坏性：改 SNV 地址=一次性重分区，旧 bond(LTK) 全部失效，需各手机重新配对一次。
 *   MCU.c 守卫：BLE_SNV_ADDR + BLE_SNV_BLOCK*BLE_SNV_NUM ≤ (0x78000-FLASH_ROM_MAX_SIZE=0x8000)。
 *   校验：0x7700 + 256*8 = 0x7F00 < 0x8000 ? */
#ifndef BLE_SNV
#define BLE_SNV                             TRUE
#endif
#ifndef BLE_SNV_ADDR
#define BLE_SNV_ADDR                        0x77700-FLASH_ROM_MAX_SIZE  /* 偏移 0x7700 = phys 0x77700 */
#endif
#ifndef BLE_SNV_BLOCK
#define BLE_SNV_BLOCK                       256
#endif
#ifndef BLE_SNV_NUM
#define BLE_SNV_NUM                         9   /* ★ [v3.36.2-fix-4] 由 MCU.c 边界(0x77700+256*N≤0x78000)推最大=9 块(2304B)。
                                                 *   每条 OS bond 占 6 个 NV ID，故 9 块是「双手机 OS 绑定」能争取到的上限；
                                                 *   是否真能装 2 条取决于 WCH SNV 是否将多个小 NV item 塞进 1 个 256B 块，
                                                 *   需真机用 [DIAG] snvBonds 验证(读到 2=成功)。 */
#endif

/* 【RTC】32K 时钟源：0=外部 32.768K 晶振(PA10/PA11)，1=片内 RC 32K
 * ★ 统一选用内部 RC 32K：功耗更低，且外部晶振需额外晶振+2电容，sleep 时必须 remap 脚防浮空耗电。
 *   CLK_OSC32K=1 时 PA10/PA11 为普通 IO，无浮空风险。 */
#ifndef CLK_OSC32K
#define CLK_OSC32K                          1
#endif

/* 【内存】协议栈堆 */
#ifndef BLE_MEMHEAP_SIZE
#define BLE_MEMHEAP_SIZE                    (1024*6)
#endif

/* 【数据包】增大缓冲区以支持 200 字节通知 */
#ifndef BLE_BUFF_MAX_LEN
#define BLE_BUFF_MAX_LEN                    251   // ★ 支持 MTU 247 (251-4=247 ATT_MTU)
#endif
#ifndef BLE_BUFF_NUM
#define BLE_BUFF_NUM                        5
#endif
#ifndef BLE_TX_NUM_EVENT
#define BLE_TX_NUM_EVENT                    1
#endif
#ifndef BLE_TX_POWER
#define BLE_TX_POWER                        LL_TX_POWEER_MINUS_3_DBM   // ★ P8: -3dBm 省 ~15% TX 电流，钥匙场景足够
#endif

/* 【连接数】仅 1 个从机 */
#ifndef PERIPHERAL_MAX_CONNECTION
#define PERIPHERAL_MAX_CONNECTION           1
#endif
#ifndef CENTRAL_MAX_CONNECTION
#define CENTRAL_MAX_CONNECTION              3
#endif

extern uint32_t MEM_BUF[BLE_MEMHEAP_SIZE / 4];
extern const uint8_t MacAddr[6];

/* ─────────────────────────────────────────────────────────────────
 * ★ 电池电量采样 — 自定义 PCB (V03 / V04)
 *   V03 (已焊): 无外部 ADC → 不定义 BOARD_HAS_EXT_BAT_ADC → 走内部 VBAT
 *               (经 LDO 恒 3.3V, 显示~100%)。
 *   V04 (在途): PB3=BAT_ADC_EN(闸门 GPIO 输出), PA3/AIN6=BAT_ADC(模拟输入)。
 *   打 V04 板时, 在 MRS 预处理(或下方) #define BOARD_HAS_EXT_BAT_ADC 即启用外部采样。
 * ───────────────────────────────────────────────────────────────── */
#define BOARD_HAS_EXT_BAT_ADC             /* ← V04 已打板且焊接 R27/R28=51k+51k 分压, 启用外部电池 ADC */

#ifdef BOARD_HAS_EXT_BAT_ADC
#define BAT_ADC_EN_PIN                  GPIO_Pin_3   // PB3 → BAT_ADC_EN (闸门输出)
#define BAT_ADC_EN_ACTIVE_LEVEL         1            /* ★ 高有效: PB3高→NMOS栅极高→NMOS导通→PMOS栅极拉低→PMOS导通→分压上电; 拉高PB3=开闸 */
#define BAT_ADC_EN_SETTLE_MS            200          // ★ 拉高 EN 后等待分压稳定: 51k+51k 分压 + PA3 端 100nF 电容 → RC≈5ms; 但 CH582M 外部 ADC 单次采样前模拟通道切换+采样电容充电需额外时间, 且从 Sleep 唤醒时模拟域起来也需时间。实测 50ms 偶发饱和(100%), 提到 200ms 留足余量。
#define BAT_ADC_AIN_PIN                 GPIO_Pin_3   // PA3 → AIN6 (BAT_ADC 模拟输入)
#define BAT_ADC_CHANNEL                 CH_EXTIN_6   // PA3 对应 ADC 外部通道 6
#define BAT_ADC_REF_MV                  1050         // CH582M 内部基准 1.05V
#define BAT_ADC_PGA_DIV                 4            // ★ 51k/51k(1:1)分压→节点=Vbat/2≈2.1V(满电); PGA_1_4(÷4)→ADC输入0.525V, 量程利用率~50%
/* 分压: 上(R27,接Vbat)=51k, 下(R28,接GND)=51k → Vnode=Vbat/2 → Vbat=Vnode*2
 *   ★ 实际 adcVal 包含 DC 偏移(实测 4.0V 时 adcVal≈2497, 理论值≈1952, 偏移~545counts),
 *     原因待查(可能分压电阻容差/PCB 漏电路径/PGA 非理想增益)。
 *     当前使用两点经验校准 batt_mV=adcVal×4242/1000-6590, 不再依赖理论 Vnode 比值。
 *     详见 battery_service.c Battery_Init 换算注释。 */
#define BAT_ADC_VBAT_PER_VNODE_X1000   2000         // Vbat/Vnode 比值 ×1000 (51k/51k 分压 → Vbat=Vnode*2)
#define BAT_ADC_FULL_MV                 4200         // 100% 对应电池电压(mV)
#define BAT_ADC_EMPTY_MV                3600         // 0% 对应电池电压(mV) — 3.6V 为软件预警线(平台期末端), 非真截止, 留~10-15%余量防"显示5%瞬间关机"
/* ★ 调试宏(默认关): 定义后 PB3(EN) 常高, 分压网络持续上电, 便于万用表量电池节点电压定位硬件/固件问题。
 *   正常 Release 必须注释掉, 否则分压常通一直漏电。 */
// #define BAT_ADC_EN_ALWAYS_ON

/* ★ 诊断宏(默认开, 验证后请注释): 定义后电量值 = adcVal/41 (0~4095 → 0~99),
 *   直接把"ADC 原始采样值"塞进电量特征让 App 显示, 无需串口即可一刀两断定位:
 *     - 显示≈47 (4.0V 时 adcVal≈1940/41≈47) → ADC 正确采到 1.99V, 问题在换算(可排除)
 *     - 显示≈99 → ADC 饱和(adcVal≈4095), 模拟路由仍没接通
 *   ★ 注意: 开启时 App 显示的是"原始值映射", 不是真实电量%! 验证完必须关。 */
// #define BAT_ADC_DEBUG_RAW
#endif

#endif

