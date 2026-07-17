/********************************** (C) COPYRIGHT *******************************
 * File Name          : peripheral.c
 * Author             : KeyGo v3.35.0 (CH582M)
 * Date               : 2026/07/16
 * Description        : BLE Key-Go 主程序 — 全局状态 + 初始化 + 事件循环 + 连接回调
 *
 * v3.13: advertising 重启兜底机制（BLE Controller 偶发卡死时延迟重试）
 *
 * 模块分工:
 *   keygo_core  → GPIO、Kalman、RSSI、状态机、JSON 通知、命令解析
 *********************************************************************************/

#include "CONFIG.h"
#include "devinfoservice.h"
#include "gattprofile.h"
#include "battery_service.h"
#include "peripheral.h"
#include "keygo_core.h"
#include "keygo_hid.h"      /* ★ v3.34.0: 无App模式 HID 锚点(策略A 被动锚点) */
#include "bonding.h"       /* ★ KeyGo 绑定/授权模块（信任列表 + Bond Manager 回调） */
#include "CH58x_common.h"  /* ★ v3.15-#18: SYS_ResetExecute() 用于 advertising 耗尽时复位 */
#include <stdlib.h>
#include <string.h>
#include "CH58x_uart.h"   /* ★ 2026-07-16: UART1_RecvString 用于主循环串口命令轮询 (DEBUG) */

/* ─────────────────────────────────────────────────────────────────
 * 广播数据
 * ───────────────────────────────────────────────────────────────── */

// ★ 2026-07-16 调试增强: "Scan req from" 日志开关（串口命令可切换，默认开）
uint8_t g_scanLogEnabled = 1;

// 扫描响应（v3.13: 运行时动态构建，名称含 MAC 后 3 字节）
#define SCAN_RSP_MAX_LEN  31
static uint8_t scanRspData[SCAN_RSP_MAX_LEN];
static uint8_t scanRspLen = 0;

// 广播包（★ v3.14: 动态构建，含电池电量）
#define ADVERT_MAX_LEN   31
static uint8_t advertData[ADVERT_MAX_LEN];
static uint8_t advertLen = 0;

/* 想关掉广播电量的话：
* 在 Peripheral_BuildAdvertData() 里把含电量的 AD 字段注释掉（目前是 Service Data 那段），
* 然后把 SBP_START_DEVICE_EVT 里 tmos_start_task 的 SBP_BATTERY_CHECK_EVT 也注释掉（改回只在连接后启动电池检测）。
* 这样 APP 只能连接后通过 GATT Read/Notify 拿到电量。
* 
* ① 注释掉广播包中的电量字段
* （我目前用的3a）：把 [3a] Service Data 段整段注释掉。 让 idx 不再递增，广播包变短 5 字节。 // 注意： ─── 以下两段二选一 ─── 那段注释也改成"已关闭广播电量"之类说明。
* 
* ② 把电池检测从「开机即启动」改为「连接后才启动」
* 需要改两个位置的  "tmos_start_task(Peripheral_TaskID, SBP_BATTERY_CHECK_EVT, SBP_BATTERY_CHECK_PERIOD);" ：
* A. 删掉：SBP_START_DEVICE_EVT 中的启动; 在 "if (events & SBP_START_DEVICE_EVT) {" 中
* B. 保留：连接回调中的启动 — 不动。这个已经是连接后才启动的，不用改。在 peripheralStateNotificationCB 的 GAPROLE_CONNECTED 分支里，原本就有，是连接后启动电池检测的入口。
* 
* ③（可选）连接断开时停止电池检测
* 如果你希望断开连接后也停掉电池检测，可以在 GAPROLE_DISCONNECTED 或 GAPROLE_WAITING 分支里加一句：tmos_stop_task(Peripheral_TaskID, SBP_BATTERY_CHECK_EVT);
*/
static void Peripheral_BuildAdvertData(void)
{
    uint8_t idx = 0;
    uint8_t battLevel = Battery_GetLevel();

    // [0] Flags (必须保留)
    advertData[idx++] = 0x02;
    advertData[idx++] = GAP_ADTYPE_FLAGS;
    advertData[idx++] = GAP_ADTYPE_FLAGS_GENERAL | GAP_ADTYPE_FLAGS_BREDR_NOT_SUPPORTED;

    // [1] Appearance  (保留，手机图标靠它)
    advertData[idx++] = 0x03;
    advertData[idx++] = GAP_ADTYPE_APPEARANCE; // 0x19
    advertData[idx++] = LO_UINT16(GAP_APPEARE_GENERIC_WATCH); //想定义啥自己去appearance.h找，记得包含头文件
    advertData[idx++] = HI_UINT16(GAP_APPEARE_GENERIC_WATCH);

    // [2] 16-bit UUID list (incomplete)：KeyGo 0xFF00 + Battery 0x180F + HID 0x1812
    //     声明设备支持的 Service，手机扫描时可据此显示对应图标；
    //     ★ v3.34.0 加入 HID_SERV_UUID(0x1812) —— 让 OS 在扫描阶段即识别为 HID 外设，
    //       配合 keygo_hid.c 注册的 HID GATT 库，已配对时像键鼠一样自动重连(无App模式)。
    advertData[idx++] = 0x07;
    advertData[idx++] = GAP_ADTYPE_16BIT_MORE;
    advertData[idx++] = 0x00; advertData[idx++] = 0xFF;                                                 // KeyGo Service
    advertData[idx++] = LO_UINT16(BATT_SERV_UUID); advertData[idx++] = HI_UINT16(BATT_SERV_UUID);  // Battery Service
    advertData[idx++] = LO_UINT16(KG_HID_SERV_UUID); advertData[idx++] = HI_UINT16(KG_HID_SERV_UUID);  // HID Service (0x1812)

    // ─── 以下两段二选一，把电量塞进广播包 ───
    //      需要哪种，取消注释对应段即可。

    // [3a] Service Data (推荐): UUID=0x180F + 电池电量% (1 字节)
    //      AD Structure: Length(1) + AD_Type(1) + UUID(2) + Data(1) = 5 字节
    //      语义：我提供 0x180F 服务，当前电量=XX%
    advertData[idx++] = 0x04;
    advertData[idx++] = GAP_ADTYPE_SERVICE_DATA;                            // 0x16
    advertData[idx++] = LO_UINT16(BATT_SERV_UUID);                          // Service UUID 0x180F 小端
    advertData[idx++] = HI_UINT16(BATT_SERV_UUID);
    advertData[idx++] = battLevel;                                          // 电池 0~100%

    // [3b] Manufacturer Specific (备用): WCH + 电池电量% (1 字节)
    //      需要时取消注释此段，同时注释掉上面的 [3a] 段
    // advertData[idx++] = 0x06;
    // advertData[idx++] = GAP_ADTYPE_MANUFACTURER_SPECIFIC;
    // advertData[idx++] = LO_UINT16(WCH_COMPANY_ID);
    // advertData[idx++] = HI_UINT16(WCH_COMPANY_ID);
    // advertData[idx++] = 0x00;          // reserved
    // advertData[idx++] = battLevel;      // 电池 0~100%

    advertLen = idx;
}

static uint8_t attDeviceName[GAP_DEVICE_NAME_LEN] = "";  // v3.13: 运行时动态构建

/* ─────────────────────────────────────────────────────────────────
 * 全局共享状态
 * ───────────────────────────────────────────────────────────────── */

// 核心状态
KeyState_t g_keyState                = KSTATE_LOCKED;
uint8_t    g_deviceConnected         = 0;

// 设备 MAC
static uint8_t g_deviceMac[6]        = {0};

// 连接列表
peripheralConnItem_t peripheralConnList = {GAP_CONNHANDLE_INIT, 0, 0, 0};

// 任务 ID（keygo_core 需通过 extern 访问以调度事件）& MTU
uint8_t  Peripheral_TaskID    = INVALID_TASK_ID;
static uint8_t advRestartRetryCount = 0;  // ★ v3.13: advertising 重启重试计数器
static uint16_t peripheralMTU        = ATT_MTU_SIZE;

/* ★ 2026-07-11: FF03 写累积缓冲（文件级静态，供 Peripheral_HandleFF03 追加解析、
 *   并在 Peripheral_LinkTerminated 断连时清空，防止旧残片跨连接误解析）。声明置于
 *   所有使用它的函数之前，满足 C 先声明后使用。 */


/* ─────────────────────────────────────────────────────────────────
 * 前向声明 (模块内部)
 * ───────────────────────────────────────────────────────────────── */

static void Peripheral_ProcessTMOSMsg(tmos_event_hdr_t *pMsg);
static void Peripheral_ProcessGAPMsg(gapRoleEvent_t *pEvent);
static void peripheralStateNotificationCB(gapRole_States_t newState, gapRoleEvent_t *pEvent);
static void peripheralRssiCB(uint16_t connHandle, int8_t rssi);
static void peripheralParamUpdateCB(uint16_t connHandle, uint16_t interval,
                                    uint16_t latency, uint16_t timeout);
static void Peripheral_LinkEstablished(gapRoleEvent_t *pEvent);
static void Peripheral_LinkTerminated(gapRoleEvent_t *pEvent);
static void simpleProfileChangeCB(uint8_t paramID, uint8_t *pValue, uint16_t len);

/* ─────────────────────────────────────────────────────────────────
 * 回调表
 * ───────────────────────────────────────────────────────────────── */

static gapRolesCBs_t Peripheral_PeripheralCBs = {
    peripheralStateNotificationCB,
    peripheralRssiCB,
    peripheralParamUpdateCB
};

static gapRolesBroadcasterCBs_t Broadcaster_BroadcasterCBs = {
    NULL, NULL
};

static simpleProfileCBs_t Peripheral_SimpleProfileCBs = {
    simpleProfileChangeCB
};

/*********************************************************************
 * ────────────────────── 动态名称构建 ──────────────────────────────
 * v3.13: scanRspData 和 attDeviceName 运行时动态构建，包含 MAC 后 3 字节
 *********************************************************************/

static void Peripheral_BuildBroadcastName(char *out, uint8_t outSize)
{
    snprintf(out, outSize, "KeyGo-%02X%02X%02X",
             g_deviceMac[3], g_deviceMac[4], g_deviceMac[5]);
}

static void Peripheral_BuildScanRspData(void)
{
    char name[16];
    Peripheral_BuildBroadcastName(name, sizeof(name));
    uint8_t nameLen = (uint8_t)strlen(name);

    uint8_t idx = 0;

    scanRspData[idx++] = 1 + nameLen;                      // length
    scanRspData[idx++] = GAP_ADTYPE_LOCAL_NAME_COMPLETE;   // type
    memcpy(&scanRspData[idx], name, nameLen);              // "KeyGo-XXXXXX"
    idx += nameLen;

    scanRspData[idx++] = 0x05;                              // length
    scanRspData[idx++] = GAP_ADTYPE_SLAVE_CONN_INTERVAL_RANGE;
    scanRspData[idx++] = LO_UINT16(DEFAULT_DESIRED_MIN_CONN_INTERVAL);
    scanRspData[idx++] = HI_UINT16(DEFAULT_DESIRED_MIN_CONN_INTERVAL);
    scanRspData[idx++] = LO_UINT16(DEFAULT_DESIRED_MAX_CONN_INTERVAL);
    scanRspData[idx++] = HI_UINT16(DEFAULT_DESIRED_MAX_CONN_INTERVAL);

    scanRspData[idx++] = 0x02;                              // length
    scanRspData[idx++] = GAP_ADTYPE_POWER_LEVEL;
    scanRspData[idx++] = 0;                                 // 0 dBm

    scanRspLen = idx;
}

/*********************************************************************
 * ────────────────────── 初始化 ────────────────────────────────────
 *********************************************************************/

void Peripheral_Init(void)
{
    Peripheral_TaskID = TMOS_ProcessEventRegister(Peripheral_ProcessEvent);

    GetMACAddress(g_deviceMac);

    Peripheral_BuildScanRspData();
    Peripheral_BuildAdvertData();     // ★ v3.14: 动态广播包（含电池电量）
    Peripheral_BuildBroadcastName((char*)attDeviceName, sizeof(attDeviceName));

    PRINT("[INIT] Device Name: %s\n", attDeviceName);

    // ── GAP Role ──
    {
        uint8_t  adv_enable          = TRUE;
        uint16_t desired_min         = DEFAULT_DESIRED_MIN_CONN_INTERVAL;
        uint16_t desired_max         = DEFAULT_DESIRED_MAX_CONN_INTERVAL;

        GAPRole_SetParameter(GAPROLE_ADVERT_ENABLED, sizeof(uint8_t), &adv_enable);
        GAPRole_SetParameter(GAPROLE_SCAN_RSP_DATA, scanRspLen, scanRspData);

        GAPRole_SetParameter(GAPROLE_ADVERT_DATA, advertLen, advertData);
        GAPRole_SetParameter(GAPROLE_MIN_CONN_INTERVAL, sizeof(uint16_t), &desired_min);
        GAPRole_SetParameter(GAPROLE_MAX_CONN_INTERVAL, sizeof(uint16_t), &desired_max);
    }

    {
        // ★ v3.34.0 无App模式(HID锚点)：高占空比广播(20ms)加快 OS 后台自动重连发现；
        //   仅无App模式(g_encRequired=1)启用，普通 App 模式维持默认 50ms 省电。
        //   ? 量产应加「高占空比 N 秒后转低占空比」降速定时器（见计划文档）。
        uint8_t  hidMode  = g_encRequired;
        uint16_t advIntMin = hidMode ? 32 : DEFAULT_ADVERTISING_INTERVAL;  // 无App:20ms / 默认:50ms
        uint16_t advIntMax = hidMode ? 48 : DEFAULT_ADVERTISING_INTERVAL;  // 无App:30ms / 默认:50ms
        GAP_SetParamValue(TGAP_DISC_ADV_INT_MIN, advIntMin);
        GAP_SetParamValue(TGAP_DISC_ADV_INT_MAX, advIntMax);
        GAP_SetParamValue(TGAP_ADV_SCAN_REQ_NOTIFY, ENABLE);
    }

    // ── GATT Services ──
    GGS_AddService(GATT_ALL_SERVICES);
    GATTServApp_AddService(GATT_ALL_SERVICES);
    DevInfo_AddService();
    SimpleProfile_AddService(GATT_ALL_SERVICES);
    Battery_AddService();   // ★ v3.13: Battery Service (0x180F)
    KeyGo_Hid_AddService(); // ★ v3.34.0: HID 锚点服务(0x1812) —— 策略A 被动锚点，仅建库不接管 GAP

    GGS_SetParameter(GGS_DEVICE_NAME_ATT, strlen((char*)attDeviceName), attDeviceName);

    {
        uint8_t zero1[SIMPLEPROFILE_CHAR1_LEN] = {0};
        uint8_t zero2[SIMPLEPROFILE_CHAR2_LEN] = {0};
        uint8_t zero3[SIMPLEPROFILE_CHAR3_LEN] = {0};
        SimpleProfile_SetParameter(SIMPLEPROFILE_CHAR1, SIMPLEPROFILE_CHAR1_LEN, zero1);
        SimpleProfile_SetParameter(SIMPLEPROFILE_CHAR2, SIMPLEPROFILE_CHAR2_LEN, zero2);
        SimpleProfile_SetParameter(SIMPLEPROFILE_CHAR3, SIMPLEPROFILE_CHAR3_LEN, zero3);
    }

    // FF04 序列号
    {
        char serial[13] = {0};
        snprintf(serial, sizeof(serial), "%02X%02X%02X%02X%02X%02X",
                 g_deviceMac[0], g_deviceMac[1], g_deviceMac[2],
                 g_deviceMac[3], g_deviceMac[4], g_deviceMac[5]);
        SimpleProfile_SetParameter(SIMPLEPROFILE_CHAR4, 12, (void*)serial);
        PRINT("[SERIAL] Device Serial: %s\n", serial);
    }

    // ── 硬件 & 外设 ──
    KeyGo_GPIO_Init();
    KeyGo_ResetState();
    /* ★ 2026-07-11: 启用 DataFlash I/O 接口（CH58x 必需，且只需调用一次）。
     *   任何 EEPROM_READ/WRITE/ERASE 之前都必须先 FLASH_ROM_START_IO()，
     *   否则所有 DataFlash 操作返回失败 —— 表现为：
     *     - [CONFIG] EEPROM_READ failed（配置无法恢复）
     *     - BIND 时 Bonding_Save 失败（信任列表不落盘）
     *     - 重启后 Bonding_Load 读不到 → 设备显示「未绑定」
     *   这是此前「重启即丢失绑定 / 配置」的根因。BLE 栈的 SNV 内部也会用同一机制。 */
    /* ★ 2026-07-12: DataFlash I/O 使能 + 诊断。
     *   FLASH_ROM_START_IO() 返回 0=SUCCESS(ISP583.h:78)。若返回非0,
     *   说明 FlashROM I/O 未能就绪 —— 这是「EEPROM_READ failed / 重启丢绑定」的最可能根因。
     *   实测若首调失败, 先 FLASH_ROM_SW_RESET() 软复位 FlashROM 再 START_IO 常可恢复。 */
    int ioRc = FLASH_ROM_START_IO();
    if (ioRc != 0) {
        PRINT("[FLASH] START_IO first try failed rc=%d, retry after SW_RESET\n", ioRc);
        FLASH_ROM_SW_RESET();
        ioRc = FLASH_ROM_START_IO();
    }
    PRINT("[FLASH] DataFlash I/O ready (START_IO rc=%d)\n", ioRc);
    KeyGo_LoadConfig();   // ★ v3.5.1: 从 DataFlash 恢复上次保存的阈值
    KeyGo_LoadMode();     // ★ Phase 2: 从 DataFlash 恢复设备模式(car/ebike)
    KeyGo_LoadEncrypt();  // ★ 方案1: 从 DataFlash 恢复 无 App 模式(OS 配对)标志
    KeyGo_LoadPasscode(); // ★ 方案1 扩展: 从 DataFlash 恢复系统配对码(OS passkey)
    Bonding_Init();        // ★ KeyGo 绑定: 载入信任列表 + 配置 Bond Manager（链路加密层，内部据 g_encRequired 设配对模式）
    SimpleProfile_RegisterAppCBs(&Peripheral_SimpleProfileCBs);
    GAPRole_BroadcasterSetCB(&Broadcaster_BroadcasterCBs);

    // 启动
    tmos_set_event(Peripheral_TaskID, SBP_START_DEVICE_EVT);

    PRINT("==== KEYGO %s (CH582M) ====\n", KEYGO_FW_VERSION);
#ifdef DEBUG
    PRINT("[UART] debug cmds: 'scan' toggle / 'scan on' / 'scan off' / 'help'\n");
#endif
}

/*********************************************************************
 * ★ 2026-07-16 串口 DEBUG 命令轮询（v3.35.0 调试增强，非协议变更）
 *
 * [为什么用轮询而非中断？]
 *   UART1_DefInit() 仅使能 RB_IER_TXD_EN（发送），未开接收中断；但 UART 接收是
 *   硬件自动写入 FIFO 的，只要主循环每圈调用 UART1_RecvString()（非阻塞读 R8_UART1_RFC）
 *   及时取走即可。人工输入远慢于主循环，FIFO 深度 8 不会溢出。中断方式需改 IER +
 *   实现 UART1_IRQHandler，侵入更大，故选轮询。
 *
 * [调用时机] Main_Circulation() 的 while(1) 每圈调用（见 peripheral_main.c）。
 *
 * [命令表]（不区分大小写、忽略前后空格、首个 token 决定命令）：
 *   scan          切换 "Scan req from" 日志开关
 *   scan on       打开该日志
 *   scan off      关闭该日志
 *   help          打印帮助
 *
 * [非 DEBUG 构建] 函数体为空，避免在无 UART1 的工程里链接 UART1_RecvString。
 *********************************************************************/
#ifdef DEBUG
#define UART_CMD_LINE_MAX   32
static char   s_uartCmdLine[UART_CMD_LINE_MAX];
static uint8_t s_uartCmdIdx = 0;

// 小写化后比较 token（标准 strcmp，大小写不敏感由调用前转换保证）
static void KeyGo_UartCmdExec(char *line)
{
    char *p = line;
    while (*p == ' ' || *p == '\t') p++;          // 跳过前导空白
    if (*p == '\0') return;
    char *tok = p;
    while (*p && *p != ' ' && *p != '\t') p++;     // 取首个 token
    char saved = *p;
    *p = '\0';
    for (char *q = tok; *q; q++) {                 // token 转小写
        if (*q >= 'A' && *q <= 'Z') *q += 0x20;
    }
    char *arg = p;                                 // 提取参数（若有）
    if (saved) {
        arg++;
        while (*arg == ' ' || *arg == '\t') arg++;
    }

    if (strcmp(tok, "scan") == 0) {
        if (*arg == '\0') {
            g_scanLogEnabled = g_scanLogEnabled ? 0 : 1;   // 无参数 → 切换
        } else if (strcmp(arg, "off") == 0) {
            g_scanLogEnabled = 0;
        } else if (strcmp(arg, "on") == 0) {
            g_scanLogEnabled = 1;
        } else {
            PRINT("[UART] bad arg '%s' (use: scan | scan on | scan off)\n", arg);
            return;
        }
        PRINT("[UART] scan log %s\n", g_scanLogEnabled ? "ON" : "OFF");
    } else if (strcmp(tok, "help") == 0) {
        PRINT("[UART] cmds: scan | scan on | scan off | help\n");
    } else {
        PRINT("[UART] unknown: %s (type 'help')\n", tok);
    }
}

void KeyGo_UartCmdPoll(void)
{
    uint8_t buf[16];
    uint16_t n = UART1_RecvString(buf);            // 非阻塞读 FIFO 当前所有字节
    for (uint16_t i = 0; i < n; i++) {
        char c = (char)buf[i];
        if (c == '\r' || c == '\n') {              // 行结束符
            if (s_uartCmdIdx > 0) {
                s_uartCmdLine[s_uartCmdIdx] = '\0';
                KeyGo_UartCmdExec(s_uartCmdLine);
                s_uartCmdIdx = 0;
            }
        } else if (s_uartCmdIdx < UART_CMD_LINE_MAX - 1) {
            s_uartCmdLine[s_uartCmdIdx++] = c;     // 累积到行缓冲
        }
    }
}
#else
void KeyGo_UartCmdPoll(void) {}                    // 非 DEBUG：空实现，保证链接
#endif

/*********************************************************************
 * ────────────────────── 事件处理 ─────────────────────────────────
 *********************************************************************/

uint16_t Peripheral_ProcessEvent(uint8_t task_id, uint16_t events)
{
    if (events & SYS_EVENT_MSG) {
        uint8_t *pMsg;
        if ((pMsg = tmos_msg_receive(Peripheral_TaskID)) != NULL) {
            Peripheral_ProcessTMOSMsg((tmos_event_hdr_t *)pMsg);
            tmos_msg_deallocate(pMsg);
        }
        return (events ^ SYS_EVENT_MSG);
    }

    if (events & SBP_START_DEVICE_EVT) {
        GAPRole_PeripheralStartDevice(Peripheral_TaskID, &Bonding_BondCBs,
                                       &Peripheral_PeripheralCBs);
        /* ★ v3.14: 电池检测上电即运行（不依赖连接） ；若注释此行，则，电池检测移到连接建立后再启动，不再开机即跑*/
        tmos_start_task(Peripheral_TaskID, SBP_BATTERY_CHECK_EVT, SBP_BATTERY_CHECK_PERIOD);
        return (events ^ SBP_START_DEVICE_EVT);
    }

    if (events & SBP_PERIODIC_EVT) {
        if (SBP_PERIODIC_EVT_PERIOD) {
            tmos_start_task(Peripheral_TaskID, SBP_PERIODIC_EVT, SBP_PERIODIC_EVT_PERIOD);
        }
        if (g_deviceConnected) {
            KeyGo_NotifyStatus();
        }
        return (events ^ SBP_PERIODIC_EVT);
    }

    /* ★ 2026-07-10: 延迟状态上报——绑定层短报文(BIND:OK/AUTH:OK 等)后立即发 status 会与
     *   短报文抢同一通知队列，浅队列下短报文(BIND:OK)可能被丢弃 → App 收不到回包。
     *   改为延迟 ~20ms(32 tick)再发 status，给 BLE 栈时间先把 BIND:OK 发出去。 */
    if (events & SBP_DEFERRED_STATUS_EVT) {
        if (g_deviceConnected) {
            KeyGo_NotifyStatus();
        }
        return (events ^ SBP_DEFERRED_STATUS_EVT);
    }

    if (events & SBP_DEFERRED_RAW_EVT) {
        // ★ 2026-07-11: 写回调之外消费绑定层短报文队列（BIND:/NONCE:/AUTH:/DENY:），
        //   避免在 FF03 写回调内同步发通知导致 ATT 缓冲区占用/Flash 写关中断而丢包。
        KeyGo_FlushRawNotify();
        return (events ^ SBP_DEFERRED_RAW_EVT);
    }


    if (events & SBP_PARAM_UPDATE_EVT) {
        GAPRole_PeripheralConnParamUpdateReq(peripheralConnList.connHandle,
                DEFAULT_DESIRED_MIN_CONN_INTERVAL, DEFAULT_DESIRED_MAX_CONN_INTERVAL,
                DEFAULT_DESIRED_SLAVE_LATENCY, DEFAULT_DESIRED_CONN_TIMEOUT,
                Peripheral_TaskID);
        return (events ^ SBP_PARAM_UPDATE_EVT);
    }

    if (events & SBP_READ_RSSI_EVT) {
        GAPRole_ReadRssiCmd(peripheralConnList.connHandle);
        tmos_start_task(Peripheral_TaskID, SBP_READ_RSSI_EVT, KeyGo_GetRssiPeriodTicks());
        return (events ^ SBP_READ_RSSI_EVT);
    }

    if (events & SBP_BATTERY_CHECK_EVT) {
        tmos_start_task(Peripheral_TaskID, SBP_BATTERY_CHECK_EVT, SBP_BATTERY_CHECK_PERIOD);
        {
            uint8_t oldLevel = Battery_GetLevel();
            Battery_UpdateLevel();
            /* ★ v3.14: 电量变化 → 重建广播包 + 实时更新 advertising data
             *   GAP_UpdateAdvertisingData 可在广播中实时更新，无需重启 advertising */
            if (Battery_GetLevel() != oldLevel) {
                Peripheral_BuildAdvertData();
                GAP_UpdateAdvertisingData(Peripheral_TaskID, GAP_ADTYPE_ADV_IND,
                                          advertLen, advertData);
            }
        }
        return (events ^ SBP_BATTERY_CHECK_EVT);
    }

    if (events & SBP_STATE_MACHINE_EVT) {
        if (g_deviceConnected) {
            /* ★ 方案A（2026-07-12）：未鉴权连接超时强断（防 DoS 占槽）
             *   连接后 30s 内既不 AUTH 也不 BIND → 下发提示并断开，把唯一连接槽让回车主。
             *   正常车主：AUTH(~250ms)/BIND(一次往返) 远小于 30s，计时早已被取消，永不触发。
             *   ★ 2026-07-12 修正（用户实测无提示根因）：BLE 通知即使"发送成功"也只是排进
             *   链路层缓冲，要等【下一个连接事件】才空口发出；连接间隔可能达 30~48ms，加上
             *   raw 队列首发 ~5ms/退避 ~20ms，原先仅延迟 ~40ms 就 TerminateLink，通知常常
             *   还没空口发出链路就断了 → App 收不到、既不提示也不抑制重连。
             *   改：延迟拉长到 ~400ms（640 ticks），稳跨多个连接事件确保通知真正送达 App，
             *   再强断。对占槽 DoS 影响可忽略（每次占用只多 0.4s）。 */
            /* ★ v3.36-fix: 无APP模式(g_encRequired=1)下，OS 加密连接(已配对手机自动重连)
             *   即视为已授权「手机在场」态，不应再触发 30s 未鉴权强断——
             *   否则会与「无APP即解锁」特性自相矛盾，造成「解锁→30s强断→OS重连→再解锁」
             *   的连接风暴（实测日志）。仅当「既非 OS 加密(无APP模式) 也非 App 会话鉴权」
             *   的陌生连接才施加 30s 超时（防 DoS 占槽）。 */
            uint8_t osEncNoApp = g_encRequired
                    ? (linkDB_State(peripheralConnList.connHandle, LINK_ENCRYPTED) ? 1 : 0)
                    : 0;
            if (g_unauthConnStartMs != 0 && !osEncNoApp &&
                Peripheral_GetSystemMs() - g_unauthConnStartMs >= UNBOUND_CONN_TIMEOUT_MS) {
                PRINT("[SEC] unauth conn timeout %lums, schedule force disconnect\n",
                      (unsigned long)(Peripheral_GetSystemMs() - g_unauthConnStartMs));
                KeyGo_SendRawNotify("BIND:TIMEOUT:30S");   // App 提示：长时间连接未绑定
                g_unauthConnStartMs = 0;   // 标记已触发，避免重复；状态机继续轮询不受影响
                tmos_start_task(Peripheral_TaskID, SBP_UNBOUND_TIMEOUT_EVT, 640);  // ~400ms 后强断，确保通知先空口送达
            }
            KeyGo_ProcessStateMachine();
            tmos_start_task(Peripheral_TaskID, SBP_STATE_MACHINE_EVT, SBP_STATE_MACHINE_PERIOD);
        }
        return (events ^ SBP_STATE_MACHINE_EVT);
    }

    /* ★ 方案A（2026-07-12）：未鉴权连接超时后的延迟强断。
     *   由 SBP_STATE_MACHINE_EVT 触发（先发 BIND:TIMEOUT 通知），此处真正断开链路，
     *   把唯一连接槽让回车主。已发通知故 App 能提示并抑制自动重连。 */
    if (events & SBP_UNBOUND_TIMEOUT_EVT) {
        if (g_deviceConnected) {
            PRINT("[SEC] unauth timeout: terminating link\n");
            GAPRole_TerminateLink(peripheralConnList.connHandle);
        }
        return (events ^ SBP_UNBOUND_TIMEOUT_EVT);
    }

    if (events & SBP_GPIO_PULSE_END_EVT) {
        KeyGo_GPIO_PulseEnd();
        return (events ^ SBP_GPIO_PULSE_END_EVT);
    }

    /* [LED_BEGIN] 后备箱 LED 闪烁回调 (500ms 周期翻转 PB4) [LED_END] */
    if (events & SBP_LED_TRUNK_BLINK_EVT) {
        KeyGo_LedTrunkBlinkHandler();
        return (events ^ SBP_LED_TRUNK_BLINK_EVT);
    }

    /* [LED_BEGIN] 骑行 LED 闪烁回调 (参照后备箱, 2 次亮灭) [LED_END] */
    if (events & SBP_LED_RIDE_BLINK_EVT) {
        KeyGo_LedRideBlinkHandler();
        return (events ^ SBP_LED_RIDE_BLINK_EVT);
    }

    if (events & SBP_GPIO_RIDE_EVT) {     // ★ Phase 2: ebike RIDE 双脉冲序列
        KeyGo_RidePulseHandler();
        return (events ^ SBP_GPIO_RIDE_EVT);
    }

    // ★ v3.13: advertising 重启兜底 — 延迟重试，避免 BLE Controller 偶发卡死
    if (events & SBP_ADV_RESTART_EVT) {
        uint8_t adv_state;
        GAPRole_GetParameter(GAPROLE_STATE, &adv_state);
        /* ★ v3.36-fix: 广告/连接健康判定。
         *   旧逻辑仅当 adv_state==GAPROLE_ADVERTISING(2) 才算「健康」，但外设连接期间
         *   协议栈常处于 GAPROLE_CONNECTED_ADV(5)（连接中仍广播，方便第二台手机扫描/配对）
         *   或 GAPROLE_CONNECTED(4)。这两种态下无线电完全正常，却被旧判定误判为
         *   「广播失败」→ 重试 3 次 → SYS_ResetExecute() 把健康设备硬复位，
         *   形成「解锁→30s强断→OS重连→CONNECTED_ADV→误判→复位」死循环（见实测日志）。
         *   修正：连接态(4/5)或正常广播(2)均视为健康，直接清重试计数并放弃复位；
         *   仅当「既未广播也未连接」的卡死态才重试，重试耗尽才复位。 */
        uint8_t advMasked = adv_state & GAPROLE_STATE_ADV_MASK;
        if (advMasked == GAPROLE_ADVERTISING ||
            advMasked == GAPROLE_CONNECTED_ADV ||
            advMasked == GAPROLE_CONNECTED) {
            // 广播/连接均健康（含连接中仍广播的 CONNECTED_ADV），无需复位或重试
            advRestartRetryCount = 0;
            PRINT("[GAP] adv/conn healthy (state=0x%02x), no reset\n", adv_state);
        } else if (advRestartRetryCount < SBP_ADV_RESTART_MAX_RETRIES) {
            // advertising 仍未恢复，再次触发
            uint8_t enable = TRUE;
            GAPRole_SetParameter(GAPROLE_ADVERT_ENABLED, sizeof(uint8_t), &enable);
            advRestartRetryCount++;
            PRINT("[GAP] advertising retry %d/%d (state=0x%02x)\n",
                  advRestartRetryCount, SBP_ADV_RESTART_MAX_RETRIES, adv_state);
            tmos_start_task(Peripheral_TaskID, SBP_ADV_RESTART_EVT, SBP_ADV_RESTART_DELAY);
        } else {
            /* ★ v3.15-#18: 重试耗尽 → 触发系统软件复位
             *   BLE Controller 持续卡死无法恢复 advertising 时，设备进入静默状态：
             *   不广播、不能连接、不干活。复位是唯一可靠的恢复手段。
             *   ─────────────────────────────────────────────────────────────
             *   触发路径：User → 走出范围断连 → BLE Controller 状态异常 →
             *             advertising 无法启动 → 重试 3 次(~800ms)仍失败 →
             *             SYS_ResetExecute() → 完整固件重新初始化
             *   ─────────────────────────────────────────────────────────────
             *   代价：设备短暂的 ~2s 不可用（复位 + 重新初始化），远优于永久死锁
             *   SYS_ResetExecute() 内部执行：PFIC 系统复位 → 等同于上电复位 */
            advRestartRetryCount = 0;
            PRINT("[GAP] advertising FAILED after %d retries, triggering system reset\n",
                  SBP_ADV_RESTART_MAX_RETRIES);

            /* ★ v3.16-P1: 复位前将所有控制 GPIO 拉低
             *   问题：SYS_ResetExecute() → PFIC 系统复位 → 所有 GPIO 回退到
             *         输入+内部上拉(弱高电平) → PA4~PA7 不确定、PB4 LED 短暂亮起
             *   修复：提前将控制引脚拉低为输出低电平，确保复位窗口内输出安全状态
             *   ─────────────────────────────────────────────────────────────
             *   引脚说明：
             *     PA4 = UNLOCK 控制线,  PA5 = LOCK 控制线
             *     PA6 = TRUNK 控制线,    PA7 = KEY_POWER 控制线
             *     PB4 = LED 指示灯 (高电平=亮, 低电平=灭)
             *   ─────────────────────────────────────────────────────────────
             *   GPIO_Pin_4/5/6/7 = (1<<4)~(1<<7) 在 PA 和 PB 端口上值是相同的，
             *   所以可以直接用 GPIO_Pin_4 操作 PA4 和 PB4 */
            GPIOA_ResetBits(GPIO_Pin_4 | GPIO_Pin_5 | GPIO_Pin_6 | GPIO_Pin_7);
            GPIOB_ResetBits(GPIO_Pin_4);

            SYS_ResetExecute();
        }
        return (events ^ SBP_ADV_RESTART_EVT);
    }

    /* ★ v3.15-#15: 断连锁车延时回调 — 定时器到期后检查是否仍断连，是则锁车 */
    if (events & SBP_DISCONNECT_LOCK_EVT) {
        /* 仅当设备仍处于断连状态且 KeyGo 仍标记为已解锁时才执行锁车
         *  如果期间重连成功，Peripheral_LinkEstablished 已调用
         *  tmos_stop_task 取消此事件，不会到达这里。
         *  双重校验（+g_deviceConnected）防止极端竞态：
         *  取消指令发出前 TMOS 已调度此事件 → 仍会触发 → 但 g_deviceConnected==1 跳过 */
        if (!g_deviceConnected && g_keyState == KSTATE_UNLOCKED) {
            PRINT("[SAFETY] disconnect lock timer expired, locking\n");
            KeyGo_Lock();
            g_keyState = KSTATE_LOCKED;
            /* ★ v3.16-#23: 断连状态下 NotifyStatus 无法发出（函数首行检查
             *   !g_deviceConnected → 立即 return），此处不调用避免死代码。
             *   锁车状态变更在下次重连后的首条周期性 Status Notify 中反映。 */
        } else {
            PRINT("[SAFETY] disconnect lock timer expired, but device reconnected — skip\n");
        }
        return (events ^ SBP_DISCONNECT_LOCK_EVT);
    }

    return 0;
}

/*********************************************************************
 * ────────────────────── 消息分发 ──────────────────────────────────
 *********************************************************************/

static void Peripheral_ProcessGAPMsg(gapRoleEvent_t *pEvent)
{
    switch (pEvent->gap.opcode) {
        case GAP_SCAN_REQUEST_EVENT:
            // ★ 2026-07-16: 受 g_scanLogEnabled 门控（串口命令可切换），默认开。
            if (g_scanLogEnabled) {
                PRINT("Scan req from %x:%x:%x:%x:%x:%x\n",
                      pEvent->scanReqEvt.scannerAddr[0], pEvent->scanReqEvt.scannerAddr[1],
                      pEvent->scanReqEvt.scannerAddr[2], pEvent->scanReqEvt.scannerAddr[3],
                      pEvent->scanReqEvt.scannerAddr[4], pEvent->scanReqEvt.scannerAddr[5]);
            }
            break;

        case GAP_PHY_UPDATE_EVENT:
            PRINT("PHY update Rx:%x Tx:%x\n",
                  pEvent->linkPhyUpdate.connRxPHYS, pEvent->linkPhyUpdate.connTxPHYS);
            break;

        default:
            break;
    }
}

static void Peripheral_ProcessTMOSMsg(tmos_event_hdr_t *pMsg)
{
    switch (pMsg->event) {
        case GAP_MSG_EVENT:
            Peripheral_ProcessGAPMsg((gapRoleEvent_t *)pMsg);
            break;

        case GATT_MSG_EVENT: {
            gattMsgEvent_t *e = (gattMsgEvent_t *)pMsg;
            if (e->method == ATT_MTU_UPDATED_EVENT) {
                peripheralMTU = e->msg.exchangeMTUReq.clientRxMTU;
                PRINT("MTU exchange: %d\n", e->msg.exchangeMTUReq.clientRxMTU);
            }
            break;
        }

        default:
            break;
    }
}

/*********************************************************************
 * ────────────────────── 连接建立 ──────────────────────────────────
 *********************************************************************/

static void Peripheral_LinkEstablished(gapRoleEvent_t *pEvent)
{
    gapEstLinkReqEvent_t *event = (gapEstLinkReqEvent_t *)pEvent;

    if (peripheralConnList.connHandle != GAP_CONNHANDLE_INIT) {
        GAPRole_TerminateLink(pEvent->linkCmpl.connectionHandle);
        PRINT("Connection max...\n");
    } else {
        peripheralConnList.connHandle       = event->connectionHandle;
        peripheralConnList.connInterval     = event->connInterval;
        peripheralConnList.connSlaveLatency = event->connLatency;
        peripheralConnList.connTimeout      = event->connTimeout;
        /* ★ 记录对端地址，供绑定/鉴权判断使用 */
        tmos_memcpy(peripheralConnList.peerAddr, event->devAddr, B_ADDR_LEN);
        peripheralConnList.peerAddrType    = event->devAddrType;
        peripheralMTU                       = ATT_MTU_SIZE;

        g_deviceConnected        = 1;

        KeyGo_ResetState();

        // ★ 方案A（2026-07-12）：启动未鉴权连接计时（防 DoS 占槽）。
        //   连上即开始算，AUTH/BIND 成功由 KeyGo_CancelUnauthTimer 清零；超时强断（见状态机事件）。
        g_unauthConnStartMs = Peripheral_GetSystemMs();

        /* ★ v3.15-#15: 重连成功后取消断连锁车定时器
         *   用户在 dlockMs 窗口内重连 → 取消自动锁车，状态保持不变 */
        tmos_stop_task(Peripheral_TaskID, SBP_DISCONNECT_LOCK_EVT);

        tmos_start_task(Peripheral_TaskID, SBP_PERIODIC_EVT,      SBP_PERIODIC_EVT_PERIOD);
        tmos_start_task(Peripheral_TaskID, SBP_PARAM_UPDATE_EVT,  SBP_PARAM_UPDATE_DELAY);
        tmos_start_task(Peripheral_TaskID, SBP_READ_RSSI_EVT,     KeyGo_GetRssiPeriodTicks());
        tmos_start_task(Peripheral_TaskID, SBP_STATE_MACHINE_EVT, SBP_STATE_MACHINE_PERIOD);
        tmos_start_task(Peripheral_TaskID, SBP_BATTERY_CHECK_EVT, SBP_BATTERY_CHECK_PERIOD);

        PRINT("Connected %x - Int %x\n", event->connectionHandle, event->connInterval);
        PRINT("[OBS] CONNECTED (noAppMode=%d)\n", g_encRequired);
        /* ★ 2026-07-17 埋点：打印本次连接的初始协商参数（手机发起连接时给的值）。
         *   interval 单位 1.25ms，timeout 单位 10ms。若 timeout 很小(如 100=1s)，
         *   锁屏/Doze 下极易触发监督超时断连——这是排查「APP 偶发断连」的第一手数据。 */
        PRINT("[DIAG] LinkEst int=%d(%dms) lat=%d timeout=%d(%dms)\n",
              event->connInterval, (event->connInterval * 5) / 4,
              event->connLatency, event->connTimeout, event->connTimeout * 10);
    }
}

/*********************************************************************
 * ────────────────────── 连接断开 ──────────────────────────────────
 *********************************************************************/

static void Peripheral_LinkTerminated(gapRoleEvent_t *pEvent)
{
    gapTerminateLinkEvent_t *event = (gapTerminateLinkEvent_t *)pEvent;

    if (event->connectionHandle == peripheralConnList.connHandle) {
        g_deviceConnected        = 0;

        peripheralConnList.connHandle       = GAP_CONNHANDLE_INIT;
        peripheralConnList.connInterval     = 0;
        peripheralConnList.connSlaveLatency = 0;
        peripheralConnList.connTimeout      = 0;
        tmos_memset(peripheralConnList.peerAddr, 0, B_ADDR_LEN);
        peripheralConnList.peerAddrType    = 0;
        /* ★ 断连：清空绑定会话态（下次连接需重新 AUTH/BIND） */
        Bonding_ConnTerminated();

        // ★ 方案A（2026-07-12）：断连即清未鉴权计时；重连时重新计（见 LinkEstablished）。
        g_unauthConnStartMs = 0;

        tmos_stop_task(Peripheral_TaskID, SBP_PERIODIC_EVT);
        tmos_stop_task(Peripheral_TaskID, SBP_READ_RSSI_EVT);
        tmos_stop_task(Peripheral_TaskID, SBP_STATE_MACHINE_EVT);
        /* ★ v3.14: 电池检测持续运行（断开后不停），确保广播包电量实时更新 */
        tmos_stop_task(Peripheral_TaskID, SBP_GPIO_PULSE_END_EVT);
        tmos_stop_task(Peripheral_TaskID, SBP_ADV_RESTART_EVT);  // 取消之前的重试
        /* ★ v3.15-#15: 取消残留的断连锁车定时器（极速断连→重连→再断连） */
        tmos_stop_task(Peripheral_TaskID, SBP_DISCONNECT_LOCK_EVT);
        /* [LED_BEGIN] 取消残留的后备箱 LED 闪烁定时器 [LED_END] */
        tmos_stop_task(Peripheral_TaskID, SBP_LED_TRUNK_BLINK_EVT);
        /* [LED_BEGIN] 取消残留的骑行 LED 闪烁定时器 [LED_END] */
        tmos_stop_task(Peripheral_TaskID, SBP_LED_RIDE_BLINK_EVT);
        /* ★ 方案A（2026-07-12）：取消可能挂起的超时强断（已自然断连无需再踢） */
        tmos_stop_task(Peripheral_TaskID, SBP_UNBOUND_TIMEOUT_EVT);
        advRestartRetryCount = 0;

        KeyGo_ResetState();

        /* ★ v3.15-#15: 断连锁车支持可配置延时
         *   传统行为（dlockMs==0）：立即锁车，向后兼容
         *   延时模式（dlockMs>0）：启动定时器延迟锁车，允许断连后快速重连恢复
         *   重连成功后由 Peripheral_LinkEstablished 取消此定时器
         *   定时器到期时若仍断连则执行锁车 */
        if (g_keyState == KSTATE_UNLOCKED) {
            // ★ v3.32.2-fix: 手动模式(autolock=0)完全不自动锁车，连断连场景也不锁
            //   此前仅 RSSI 状态机受 autolock 闸门保护，断连自动锁未受控，导致手动模式
            //   下设备解锁后断连仍会在 dlock 后自动上锁，与「完全手动：也不自动锁车」矛盾。
            if (g_cfgAutoLockEnable) {
                uint16_t dlockTicks = KeyGo_GetDisconnectLockTicks();
                if (dlockTicks > 0) {
                    PRINT("[SAFETY] disconnected unlocked, scheduling auto lock in %lums\n",
                          (unsigned long)g_cfgDisconnectLockMs);
                    tmos_start_task(Peripheral_TaskID, SBP_DISCONNECT_LOCK_EVT, dlockTicks);
                } else {
                    // ★ v3.32.2-fix: dlock==0 表示「不自动锁车」（与配置页 UI 文案一致），
                    //   不再立即锁车（旧行为会误锁）。重连成功由 LinkEstablished 取消定时器。
                    PRINT("[SAFETY] dlock==0, skip auto lock on disconnect\n");
                }
            } else {
                PRINT("[SAFETY] manual mode (autolock=0), skip disconnect auto lock\n");
            }
        }

        // ★ v3.13: 立即启动 advertising（BLE Controller 正常情况）
        {
            uint8_t advertising_enable = TRUE;
            GAPRole_SetParameter(GAPROLE_ADVERT_ENABLED, sizeof(uint8_t), &advertising_enable);
        }
        // ★ v3.13: 200ms 后检查 advertising 状态，未恢复则触发重试机制
        tmos_start_task(Peripheral_TaskID, SBP_ADV_RESTART_EVT, SBP_ADV_RESTART_DELAY);

        PRINT("Disconnected.. Reason:%x\n", pEvent->linkTerminate.reason);
        PRINT("[OBS] DISCONNECTED reason=%x\n", pEvent->linkTerminate.reason);
    }
}

/*********************************************************************
 * ────────────────────── GAP 状态回调 ──────────────────────────────
 *********************************************************************/

static void peripheralRssiCB(uint16_t connHandle, int8_t rssi)
{
    KeyGo_RssiProcess(rssi);
}

static void peripheralParamUpdateCB(uint16_t connHandle, uint16_t connInterval,
                                    uint16_t connSlaveLatency, uint16_t connTimeout)
{
    if (connHandle == peripheralConnList.connHandle) {
        peripheralConnList.connInterval     = connInterval;
        peripheralConnList.connSlaveLatency = connSlaveLatency;
        peripheralConnList.connTimeout      = connTimeout;
        PRINT("Update %x - Int %x\n", connHandle, connInterval);
        /* ★ 2026-07-17 埋点：打印参数更新协商结果（约连上 4s 后固件请求 min6/max100/lat0/timeout=100）。
         *   若这里 timeout 仍是 100(1s)，说明手机接受了 1s 监督超时 → 断连风险高，
         *   可作为「把 DEFAULT_DESIRED_CONN_TIMEOUT 提到 400(4s)」验证的对照数据。 */
        PRINT("[DIAG] ParamUpd int=%d(%dms) lat=%d timeout=%d(%dms)\n",
              connInterval, (connInterval * 5) / 4,
              connSlaveLatency, connTimeout, connTimeout * 10);
    }
}

static void peripheralStateNotificationCB(gapRole_States_t newState, gapRoleEvent_t *pEvent)
{
    switch (newState & GAPROLE_STATE_ADV_MASK) {
        case GAPROLE_STARTED:
            PRINT("Initialized..\n");
            break;

        case GAPROLE_ADVERTISING:
            if (pEvent->gap.opcode == GAP_LINK_TERMINATED_EVENT) {
                Peripheral_LinkTerminated(pEvent);
                PRINT("Advertising..\n");
            } else if (pEvent->gap.opcode == GAP_MAKE_DISCOVERABLE_DONE_EVENT) {
                PRINT("Advertising..\n");
            }
            break;

        case GAPROLE_CONNECTED:
            if (pEvent->gap.opcode == GAP_LINK_ESTABLISHED_EVENT) {
                Peripheral_LinkEstablished(pEvent);
            }
            break;

        case GAPROLE_CONNECTED_ADV:
            PRINT("Connected Advertising..\n");
            break;

        case GAPROLE_WAITING:
            if (pEvent->gap.opcode == GAP_LINK_TERMINATED_EVENT) {
                Peripheral_LinkTerminated(pEvent);
            } else if (pEvent->gap.opcode == GAP_LINK_ESTABLISHED_EVENT) {
                if (pEvent->gap.hdr.status != SUCCESS) {
                    PRINT("Waiting..\n");
                }
            }
            break;

        case GAPROLE_ERROR:
            PRINT("Error..\n");
            break;

        default:
            break;
    }
}

/*********************************************************************
 * ────────────────────── FF03 命令路由（绑定/鉴权 + 门控）────────────
 *   BIND:xxx   → 首绑/改码
 *   NONCE      → 取挑战值
 *   AUTH:xxxx  → HMAC 会话鉴权
 *   UNBIND[:ALL] → 解绑
 *   其余（UNLOCK/LOCK/TRUNK/STATUS/NAME/配置）→ 须经会话鉴权才执行
 *********************************************************************/
/* ★ 2026-07-11: FF03 写累积解析（详见文件顶部 g_ff03Buf 注释）。
 *   现象：绑定返回 "BIND:FAIL:SHORT"，但 App 明确写了 "BIND:123456"(11 字节)。
 *   根因：固件侧收到的写 len < 11（写被拆分/截断，或 Android BLE 栈把一条写
 *   拆成多片下发），原逻辑按单次写判定 → payload 不足 6 → 误报 SHORT。
 *   修复：累积多次写进 g_ff03Buf，再按各命令固定长度逐条提取分发：
 *     - BIND:  前缀 5 + 码 6 = 11 字节
 *     - AUTH:  前缀 5 + HMAC(64hex) = 69 字节
 *     - NONCE  固定 5 字节
 *     - UNBIND 6 字节（或 UNBIND:ALL = 11）
 *   通用控制命令（UNLOCK/LOCK/config/NAME 等）为变长且本就单条发送，整段交给原门控逻辑。
 *   若以绑定前缀开头但长度不足，则 break 等待后续写补齐，绝不误吞残片。 */
/*********************************************************************
 * ────────────────────── FF03 命令派发 ─────────────────────────────
 *   GATT 层(gattprofile.c)已对 prepare-write 做完整重组（offset==0
 *   即重置累积），本函数收到的 pValue/len 即「一条完整命令」，
 *   直接按前缀解析派发即可。
 *   ★ 2026-07-11 重构：移除旧版的 App 层累加缓冲 g_ff03Buf。
 *     旧版在派发后若 Bonding_HandleBindCmd 未返回（如卡在 Flash 写），
 *     缓冲不会被清空，下一条命令会被拼到前一条后面
 *     (BIND:123456NONCE)，且因无 BIND:OK 回包导致绑定无响应。
 *     改为「每条 GATT 交付 = 一条完整命令」后，命令之间彻底隔离，
 *     任何单条命令的处理异常都不会污染后续命令。
 *********************************************************************/
static void Peripheral_HandleFF03(const uint8_t *pValue, uint16_t len)
{
    if (len == 0) return;

    /* 诊断：打印收到的完整命令（与 [INIT] 同窗口） */
    PRINT("[FF03] cmd len=%d :", len);
    uint16_t _d = (len > 24) ? 24 : len;
    for (uint16_t _i = 0; _i < _d; _i++) PRINT(" %02X", (uint8_t)pValue[_i]);
    PRINT("  str='%.*s'\n", (int)len, (const char *)pValue);

    uint16_t connHandle = peripheralConnList.connHandle;
    uint8_t *peerAddr   = peripheralConnList.peerAddr;
    uint8_t  peerType   = peripheralConnList.peerAddrType;

    /* 以绑定前缀开头但长度不足 → 直接报错，绝不误吞/误拼
     * ★ 2026-07-11 修复：tmos_memcmp 返回 TRUE(非零)=相等 / FALSE(零)=不相等（CH58xBLE_ROM.h），
     *   与标准 memcmp 相反。原代码误用 `== 0` 当作"前缀匹配"，导致所有命令前缀判断反相：
     *   BIND:123456 被当 AUTH → AUTH:FAIL:SHORT；NONCE 被当 BIND → BIND:FAIL:SHORT。
     *   现改为直接用返回值（真值=匹配），去掉错误的 `== 0`。 */
    if (len >= 5 && tmos_memcmp(pValue, "BIND:", 5) && len < 6) {
        KeyGo_SendRawNotify("BIND:FAIL:SHORT");
        PRINT("[BIND] too short\n");
        return;
    }
    if (len >= 5 && tmos_memcmp(pValue, "AUTH:", 5) && len < 69) {
        KeyGo_SendRawNotify("AUTH:FAIL:SHORT");
        PRINT("[AUTH] too short\n");
        return;
    }
    if (len >= 8 && tmos_memcmp(pValue, "SETCODE:", 8) && len < 9) {
        KeyGo_SendRawNotify("SETCODE:FAIL:SHORT");
        PRINT("[SETCODE] too short\n");
        return;
    }
    if (len >= 5 && tmos_memcmp(pValue, "NONCE", 5) && !(len == 5 || pValue[5] == ':')) {
        KeyGo_SendRawNotify("AUTH:FAIL:BAD_CMD");
        return;
    }

    if (len >= 6 && tmos_memcmp(pValue, "BIND:", 5)) {
        PRINT("[BIND] enter\n");
        /* ★ 支持自定义绑定码：码变长，整段 pValue+5 即码原文（len-5 字节） */
        uint8_t r = Bonding_HandleBindCmd(connHandle, peerAddr, peerType, pValue + 5, len - 5);
        PRINT("[BIND] exit r=%d\n", r);
        tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
    } else if (len >= 69 && tmos_memcmp(pValue, "AUTH:", 5)) {
        Bonding_HandleAuthResp(connHandle, peerAddr, pValue + 5, 64);
        tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
    } else if (len >= 5 && tmos_memcmp(pValue, "NONCE", 5) && (len == 5 || pValue[5] == ':')) {
        Bonding_HandleNonceReq(connHandle);
        tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
    } else if (len >= 6 && tmos_memcmp(pValue, "UNBIND", 6)) {
        uint8_t mode = (len > 7 && pValue[6] == ':' && pValue[7] == 'A') ? 1 : 0; /* UNBIND:ALL */
        Bonding_HandleUnbindCmd(connHandle, peerAddr, mode);
        tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
    } else if (len >= 8 && tmos_memcmp(pValue, "SETCODE:", 8)) {
        PRINT("[SETCODE] enter\n");
        uint8_t r = Bonding_HandleSetCodeCmd(connHandle, pValue + 8, len - 8);
        PRINT("[SETCODE] exit r=%d\n", r);
        tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
    } else if (len >= 9 && tmos_memcmp(pValue, "ENCRYPT:", 8)) {
        /* ★ 方案1: 无 App 模式(OS 系统配对)开关。
         *   ENCRYPT:1 → g_encRequired=1 → 配对模式切 INITIATE → 下次连接 OS 弹 passkey 配对；
         *   ENCRYPT:0 → 关闭，恢复明文最大兼容(仅 App 在场可解锁)。
         *   回包 ENCRYPT:OK / ENCRYPT:OFF 供 App 确认。 */
        uint8_t ev = (len > 8 && pValue[8] == '1') ? 1 : 0;
        g_encRequired = ev;
        KeyGo_SaveEncrypt(ev);
        Bonding_ApplyPairingMode();
        KeyGo_SendRawNotify(ev ? "ENCRYPT:OK" : "ENCRYPT:OFF");
        PRINT("[ENCRYPT] set encRequired=%d\n", ev);
        tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
    } else if (len >= 8 && tmos_memcmp(pValue, "SETPASS:", 8)) {
        /* ★ 方案1 扩展: 设置系统配对码(OS SMP passkey)，与绑定码完全独立，仅服务于无 App 模式。
         *   必须是 6 位数字(OS passkey 限制 0~999999)；非法 → SETPASS:FAIL。
         *   立即生效(存 DataFlash)，下次(重)连配对时由 Bonding_PasscodeCB 回传新码。 */
        uint8_t ok = 0;
        if (len == 14) {   // "SETPASS:"(8) + 6 位数字
            uint32_t v = 0;
            ok = 1;
            for (uint8_t i = 0; i < 6; i++) {
                char c = pValue[8 + i];
                if (c < '0' || c > '9') { ok = 0; break; }
                v = v * 10u + (uint32_t)(c - '0');
            }
            if (ok) {
                g_sysPasscode = v;
                KeyGo_SavePasscode(v);
                KeyGo_SendRawNotify("SETPASS:OK");
                PRINT("[PASS] set sysPasscode=%lu\n", (unsigned long)v);
            }
        }
        if (!ok) {
            KeyGo_SendRawNotify("SETPASS:FAIL");
            PRINT("[PASS] set sysPasscode FAILED (need 6 digits)\n");
        }
        tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
    } else {
        /* ── 通用控制命令（UNLOCK/LOCK/TRUNK/NAME 等）：须经 C1 签名 ── */
        if (Bonding_Count() == 0) {
            KeyGo_SendRawNotify("DENY:NOT_BOUND");
            PRINT("[CMD] rejected: device not bound\n");
            tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
        } else if (!Bonding_IsSessionAuthed(connHandle)) {
            char hex[33];
            Bonding_IssueNonce(hex);
            char msg[48];
            snprintf(msg, sizeof(msg), "DENY:AUTH_REQ:%s", hex);
            KeyGo_SendRawNotify(msg);
            PRINT("[CMD] rejected: auth required, nonce issued\n");
            tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
        } else if (len >= 3 && tmos_memcmp(pValue, "C1:", 3)) {
            /* ★ P0-2：带 C1 签名 → 校验后执行 */
            static char _body[64];
            uint16_t _bodyLen = 0;
            uint8_t r = Bonding_VerifySignedCmd((const char *)pValue + 3, len - 3, _body, &_bodyLen);
            if (r != 0) {
                char _err[40];
                snprintf(_err, sizeof(_err), "CMD:FAIL:SIG:%d", r);
                KeyGo_SendRawNotify(_err);
                PRINT("[CMD] signed verify fail r=%d\n", r);
            } else {
                KeyGo_HandleCommand(_body, _bodyLen);
                KeyGo_NotifyStatus();
            }
            tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
        } else {
            /* 未带 C1 签名的明文命令 → 一律拒绝（强制签名） */
            KeyGo_SendRawNotify("CMD:FAIL:NO_SIG");
            PRINT("[CMD] rejected: missing C1 signature\n");
            tmos_start_task(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT, 32);
        }
    }
}


/*********************************************************************
 * ────────────────────── GATT 写回调 ───────────────────────────────
 *   FF01 (RSSI)   → keygo_core
 *   FF03 (Command) → Peripheral_HandleFF03（绑定/鉴权 + 门控）
 *********************************************************************/

static void simpleProfileChangeCB(uint8_t paramID, uint8_t *pValue, uint16_t len)
{
    switch (paramID) {

        case SIMPLEPROFILE_CHAR1:  // FF01: RSSI + 配置下发
        {
            char buf[SIMPLEPROFILE_CHAR1_LEN + 1];
            uint16_t copyLen = (len > SIMPLEPROFILE_CHAR1_LEN) ? SIMPLEPROFILE_CHAR1_LEN : len;
            tmos_memcpy(buf, pValue, copyLen);
            buf[copyLen] = '\0';

            // ★ v3.5: 区分三种数据格式:
            //   ① 裸数字:          "-54"           → RSSI 注入
            //   ② rssi=-54: 首个 key 是 rssi      → RSSI 注入
            //   ③ 配置:   首个 key 是 unlock/lock/uc/lc... → 配置更新

            // 跳过前导空格
            uint16_t start = 0;
            while (start < copyLen && buf[start] == ' ') start++;

            // 判断是否为配置字符串: 看第一个 key 是否以 "rssi=" 开头
            int isConfig = 0;
            {
                // 查找第一个 '='
                uint16_t eqPos;
                int hasEq = 0;
                for (eqPos = start; eqPos < copyLen; eqPos++) {
                    if (buf[eqPos] == '=') { hasEq = 1; break; }
                    if (buf[eqPos] == ' ') break;  // 无 '=' 的裸数字
                }
                if (hasEq) {
                    // 有 '=' → 判断第一个 key 是不是 "rssi"
                    uint8_t firstKeyLen = (uint8_t)(eqPos - start);
                    if (!(firstKeyLen == 4 && buf[start] == 'r' && buf[start+1] == 's' &&
                          buf[start+2] == 's' && buf[start+3] == 'i')) {
                        // 第一个 key 不是 "rssi" → 配置字符串
                        isConfig = 1;
                    }
                }
            }

            if (isConfig) {
                // ── ③ 配置字符串: 解析并更新配置变量 ──
                uint8_t configChanged = KeyGo_ParseConfig(buf);
                if (configChanged) {
                    KeyGo_NotifyStatus();  // ★ 配置变更后通知 App 最新状态
                    // ★ v3.13: 重启 RSSI 读取任务以应用新周期
                    if (g_deviceConnected && peripheralConnList.connHandle != GAP_CONNHANDLE_INIT) {
                        tmos_stop_task(Peripheral_TaskID, SBP_READ_RSSI_EVT);
                        tmos_start_task(Peripheral_TaskID, SBP_READ_RSSI_EVT, KeyGo_GetRssiPeriodTicks());
                    }
                }
                // ★ 同时检查是否包含 rssi key (混合下发)
                {
                    uint16_t ri;
                    for (ri = 0; ri + 5 <= copyLen; ri++) {
                        if (buf[ri] == 'r' && buf[ri+1] == 's' && buf[ri+2] == 's' && buf[ri+3] == 'i' && buf[ri+4] == '=') {
                            int8_t rssiVal = (int8_t)atoi(&buf[ri + 5]);
                            if (rssiVal < 0) {
                                KeyGo_RssiProcess(rssiVal);
                            }
                            break;
                        }
                    }
                }
            } else {
                // ── ①② 纯 RSSI 值: 注入到 Kalman 滤波器 ──
                int8_t rssiVal = 0;
                if (buf[start] == '-' || (buf[start] >= '0' && buf[start] <= '9')) {
                    // 裸数字: -54
                    rssiVal = (int8_t)atoi(&buf[start]);
                } else {
                    // rssi=-54 格式 (兜底)
                    uint16_t i;
                    for (i = start; i < copyLen; i++) {
                        if (buf[i] == '=') {
                            rssiVal = (int8_t)atoi(&buf[i + 1]);
                            break;
                        }
                    }
                }
                KeyGo_RssiProcess(rssiVal);
            }
            break;
        }

        case SIMPLEPROFILE_CHAR3:  // FF03: Command（绑定/鉴权/门控统一入口）
        {
            /* ★ 2026-07-11 修复：命令已在 GATT 写到达时刻由 simpleProfile_WriteAttrCB
             *   快照进环形缓冲 SimpleProfile_PopCmd()，此处仅按 FIFO 弹出处理，
             *   不再读共享的 simpleProfileChar3（会被后续写/射频中断重入覆盖 → 错位）。
             *   HandleFF03 全程用弹出的私有副本，命令之间彻底隔离。 */
            uint8_t cmdBuf[SIMPLEPROFILE_CHAR3_LEN];
            uint16_t cmdLen = 0;
            if (SimpleProfile_PopCmd(cmdBuf, &cmdLen)) {
                Peripheral_HandleFF03(cmdBuf, cmdLen);
            }
            break;
        }

        default:
            break;
    }
}

/*********************************************************************
 *********************************************************************/
