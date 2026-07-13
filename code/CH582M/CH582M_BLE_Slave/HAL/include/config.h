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

/* 【SNV】Bonding 持久化 — 使用 DataFlash 最后 512 字节 */
#ifndef BLE_SNV
#define BLE_SNV                             TRUE
#endif
#ifndef BLE_SNV_ADDR
#define BLE_SNV_ADDR                        0x77E00-FLASH_ROM_MAX_SIZE
#endif
#ifndef BLE_SNV_BLOCK
#define BLE_SNV_BLOCK                       256
#endif
#ifndef BLE_SNV_NUM
#define BLE_SNV_NUM                         1
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

