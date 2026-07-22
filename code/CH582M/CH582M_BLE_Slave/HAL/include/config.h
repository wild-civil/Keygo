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

#include "CH58x_common.h"

/* ─────────────────────────────────────────────────────────────────
 * ★ KeyGo v3.5 GPIO 引脚定义 (CH582M 硬件)
 *   参考 ESP32 映射: UNLOCK=2, LOCK=3, TRUNK=4, KEY_POWER=5, LED=8, BIND=9
 *   CH582M 使用 PB 端口对应关系:
 *     PB4  = LED (开发板丝印 PB4)
 *     PB22 = KEY1 (BIND 按键)
 *     PA4  = UNLOCK
 *     PA5  = LOCK
 *     PA6  = TRUNK
 *     PA7  = KEY_POWER
 * ───────────────────────────────────────────────────────────────── */
#define PIN_UNLOCK_GPIO             GPIO_Pin_4   // PA4 → 解锁
#define PIN_LOCK_GPIO               GPIO_Pin_5   // PA5 → 上锁
#define PIN_TRUNK_GPIO              GPIO_Pin_6   // PA6 → 后备箱
#define PIN_KEYPOWER_GPIO           GPIO_Pin_7   // PA7 → 钥匙电源
/* ★ Phase 2: ebike RIDE 输出引脚。默认复用 TRUNK 脚(PA6)——电动车 PCB 应将
 *   RIDE 触发线接到此处；若硬件另有独立 RIDE 脚，改此宏即可。 */
#define PIN_RIDE_GPIO               GPIO_Pin_6   // PA6 → 电瓶车 RIDE(快速双击)

#define PIN_UNLOCK_PORT             GPIOA
#define PIN_LOCK_PORT               GPIOA
#define PIN_TRUNK_PORT              GPIOA
#define PIN_KEYPOWER_PORT           GPIOA
#define PIN_RIDE_PORT               GPIOA

/* ─────────────────────────────────────────────────────────────────
 * 默认配置值 (可通过 MRS IDE 项目预处理覆盖)
 * ───────────────────────────────────────────────────────────────── */

/* 【硬件模块】KeyGo 需要 LED 和 KEY */
#ifndef HAL_KEY
#define HAL_KEY                             TRUE
#endif
#ifndef HAL_LED
#define HAL_LED                             FALSE   /* KeyGo 自行管理 PB4 LED，关闭 HAL LED 子系统以免极性冲突 */
#endif

/* 【MAC】使用芯片出厂 MAC */
#ifndef BLE_MAC
#define BLE_MAC                             FALSE
#endif

/* 【DCDC】 */
#ifndef DCDC_ENABLE
#define DCDC_ENABLE                         FALSE
#endif

/* 【SLEEP】默认关闭, 后续优化功耗 */
#ifndef HAL_SLEEP
#define HAL_SLEEP                           FALSE
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

/* 【RTC】内部 32K */
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
#define BLE_TX_POWER                        LL_TX_POWEER_0_DBM
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

#endif

