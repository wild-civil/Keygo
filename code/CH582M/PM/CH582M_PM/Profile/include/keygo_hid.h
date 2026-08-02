/********************************** (C) COPYRIGHT *******************************
 * File Name          : keygo_hid.h
 * Author             : KeyGo（CH582M 主固件）
 * Version            : v3.34.0
 * Date               : 2026/07/16
 * Description        : 无App模式 HID 锚点（策略 A · 被动锚点）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 设计原则（慢工出细活 · 清晰可溯）
 * ─────────────────────────────────────────────────────────────────────────
 * ① 策略 A（保留主固件自定义 GAPRole）：本模块【只注册 HID-over-GATT
 *    服务数据库】，绝不接管 GAP Role（不调用 HidDev_Init / HidDev_Register /
 *    GAPRole_PeripheralStartDevice）。主固件的 Peripheral_PeripheralCBs
 *    （断连锁车 / RSSI / 命令路由 / 30s 超时强断）原样保留。
 *
 * ② 自包含、零外部耦合：不引入 WCH 的 hiddev.c / hidconsumerservice.c，
 *    避免其与主固件已有的 battery_service.c（同名不同 API）、scanparamservice
 *    冲突（重复 0x180F 服务 / 缺失句柄依赖）。HID 专属常量用 KG_ 前缀
 *    在本文件自定义，取值与 BLE HID-over-GATT 规范 / WCH HID 例程完全一致，
 *    且与主固件 LIB(CH58xBLE_ROM.h) 中的同名 UUID 不重名、不重定义。
 *    通用 ATT/GATT UUID（primaryServiceUUID / characterUUID /
 *    clientCharCfgUUID / GATT_CLIENT_CHAR_CFG_UUID / GATT_REPORT_REF_UUID）
 *    仍直接引用 LIB。
 *
 * ③ 目的：让 OS（Android HOGP）把设备当 HID 外设，已配对时像键鼠一样
 *    【无 App 参与】自动重连 + 静默加密。OS 据 GATT 库中的 0x1812 +
 *    Report Map 识别 HID，与本模块是否接管 GAP 无关。
 *
 * ④ 广播含 0x1812：由 peripheral.c 的 Peripheral_BuildAdvertData() 把
 *    HID_SERV_UUID 加入 16-bit UUID 列表（见 peripheral.c）。
 *
 * ⑤ 不实现真实 HID 报告收发（被动锚点）：Protocol Mode / Control Point /
 *    CCCD 仅作合规读写，不向 OS 实际发送 HID 报告。Report Map 为
 *    Consumer(音量±) 范例，仅供 OS 建立 HID 设备所需。
 * ─────────────────────────────────────────────────────────────────────────
 */

#ifndef KEYGO_HID_H
#define KEYGO_HID_H

/* ★ 不显式 include 任何 gatt 头：gattAttribute_t / gattServiceCBs_t / GATT_PERMIT_* /
 *   ATT_ERR_* / bStatus_t 等全部由 CONFIG.h（peripheral.c 与 keygo_hid.c 均已先包含）
 *   经 BLE LIB 头文件传递定义（与 battery_service.c 仅 include "CONFIG.h" 即可使用这些类型一致）。
 *   本头由 peripheral.c 在 CONFIG.h 之后 include，类型已可见。 */

/* ── HID 服务专属常量（自包含，KG_ 前缀避免与 LIB 重定义）
 *    取值对齐 WCH HID 例程(hiddev.h / hidconsumer.h) 与 BLE HID 规范 ── */
#define KG_HID_SERV_UUID          0x1812   // Human Interface Device
#define KG_HID_INFORMATION_UUID   0x2A4A   // HID Information
#define KG_REPORT_MAP_UUID        0x2A4B   // Report Map
#define KG_HID_CTRL_PT_UUID      0x2A4C   // HID Control Point
#define KG_REPORT_UUID            0x2A4D   // Report
#define KG_PROTOCOL_MODE_UUID     0x2A4E   // Protocol Mode

#define KG_HID_FEATURE_FLAGS         0x01    // RemoteWake（与 Spike 一致）
#define KG_HID_PROTOCOL_MODE_BOOT  0x00    // Boot Protocol Mode
#define KG_HID_PROTOCOL_MODE_REPORT 0x01   // Report Protocol Mode
#define KG_HID_PROTOCOL_MODE_LEN   1       // Protocol Mode value length
#define KG_HID_INFORMATION_LEN     4       // HID Information value length
#define KG_HID_REPORT_REF_LEN     2       // HID Report Reference Descriptor length
#define KG_HID_EXT_REPORT_REF_LEN 2       // External Report Reference Descriptor length

#define KG_HID_CMD_SUSPEND       0x00    // Control Point: Suspend
#define KG_HID_CMD_EXIT_SUSPEND  0x01    // Control Point: Exit Suspend

#define KG_HID_RPT_ID_CONSUMER_IN 1      // Consumer input report ID
#define KG_HID_RPT_ID_FEATURE     0       // Feature report ID
#define KG_HID_REPORT_TYPE_INPUT  1       // Input report
#define KG_HID_REPORT_TYPE_FEATURE 3      // Feature report

/* ── 对外接口 ── */
bStatus_t KeyGo_Hid_AddService(void);

#endif /* KEYGO_HID_H */

/******************************** endfile @ keygo_hid.h ******************************/
