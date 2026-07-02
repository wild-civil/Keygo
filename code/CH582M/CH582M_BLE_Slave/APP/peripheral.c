/********************************** (C) COPYRIGHT *******************************
 * File Name          : peripheral.c
 * Author             : KeyGo v3.13 (CH582M)
 * Date               : 2026/07/02
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
#include "peripheral.h"
#include "keygo_core.h"
#include <stdlib.h>

#define ADVERT_MFG_DATA_LEN  4

/* ─────────────────────────────────────────────────────────────────
 * 广播数据
 * ───────────────────────────────────────────────────────────────── */

// 扫描响应
static uint8_t scanRspData[] = {
    // complete name: BLE-Key-Go
    0x0B, // length = 1 + 10 = 11 = 0x0B
    GAP_ADTYPE_LOCAL_NAME_COMPLETE,
    'B','L','E','-','K','e','y','-','G','o',

    0x05, // length of this data
    GAP_ADTYPE_SLAVE_CONN_INTERVAL_RANGE,
    LO_UINT16(DEFAULT_DESIRED_MIN_CONN_INTERVAL),
    HI_UINT16(DEFAULT_DESIRED_MIN_CONN_INTERVAL),
    LO_UINT16(DEFAULT_DESIRED_MAX_CONN_INTERVAL),
    HI_UINT16(DEFAULT_DESIRED_MAX_CONN_INTERVAL),

    // Tx power level
    0x02, // length of this data
    GAP_ADTYPE_POWER_LEVEL, 
    0 // 0dBm
};

// 广播包
static uint8_t advertData[] = {
    // Flags
    0x02, GAP_ADTYPE_FLAGS,
    GAP_ADTYPE_FLAGS_GENERAL | GAP_ADTYPE_FLAGS_BREDR_NOT_SUPPORTED,

    // Appearance: 通用手表 (0x00C1)
    0x03, GAP_ADTYPE_APPEARANCE, // 长度: 0x03  (AD Type 1字节 + Appearance值 2字节)； 类型: 0x19      (GAP_ADTYPE_APPEARANCE)
    LO_UINT16(0x00C1), HI_UINT16(0x00C1), // 值:   0xC1,0x00 (小端序 = 0x00C1 = 通用手表)

    // 16-bit UUID list (incomplete)
    0x03, GAP_ADTYPE_16BIT_MORE, 0x00, 0xFF,

    // Manufacturer Specific: WCH
    0x05, GAP_ADTYPE_MANUFACTURER_SPECIFIC,
    LO_UINT16(WCH_COMPANY_ID), HI_UINT16(WCH_COMPANY_ID),
    0x00, 0x00
};

static uint8_t attDeviceName[GAP_DEVICE_NAME_LEN] = "KeyGo";

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
 * ────────────────────── 初始化 ────────────────────────────────────
 *********************************************************************/

void Peripheral_Init(void)
{
    Peripheral_TaskID = TMOS_ProcessEventRegister(Peripheral_ProcessEvent);

    // ── GAP Role ──
    {
        uint8_t  adv_enable          = TRUE;
        uint16_t desired_min         = DEFAULT_DESIRED_MIN_CONN_INTERVAL;
        uint16_t desired_max         = DEFAULT_DESIRED_MAX_CONN_INTERVAL;

        GAPRole_SetParameter(GAPROLE_ADVERT_ENABLED, sizeof(uint8_t), &adv_enable);
        GAPRole_SetParameter(GAPROLE_SCAN_RSP_DATA, sizeof(scanRspData), scanRspData);

        GetMACAddress(g_deviceMac);
        advertData[11] = g_deviceMac[4]; // 这个好像是 MAC 写入索引
        advertData[12] = g_deviceMac[5];

        GAPRole_SetParameter(GAPROLE_ADVERT_DATA, sizeof(advertData), advertData);
        GAPRole_SetParameter(GAPROLE_MIN_CONN_INTERVAL, sizeof(uint16_t), &desired_min);
        GAPRole_SetParameter(GAPROLE_MAX_CONN_INTERVAL, sizeof(uint16_t), &desired_max);
    }

    {
        uint16_t advInt = DEFAULT_ADVERTISING_INTERVAL;
        GAP_SetParamValue(TGAP_DISC_ADV_INT_MIN, advInt);
        GAP_SetParamValue(TGAP_DISC_ADV_INT_MAX, advInt);
        GAP_SetParamValue(TGAP_ADV_SCAN_REQ_NOTIFY, ENABLE);
    }

    // ── GATT Services ──
    GGS_AddService(GATT_ALL_SERVICES);
    GATTServApp_AddService(GATT_ALL_SERVICES);
    DevInfo_AddService();
    SimpleProfile_AddService(GATT_ALL_SERVICES);

    GGS_SetParameter(GGS_DEVICE_NAME_ATT, sizeof(attDeviceName), attDeviceName);

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
    KeyGo_LoadConfig();   // ★ v3.5.1: 从 DataFlash 恢复上次保存的阈值
    SimpleProfile_RegisterAppCBs(&Peripheral_SimpleProfileCBs);
    GAPRole_BroadcasterSetCB(&Broadcaster_BroadcasterCBs);

    // 启动
    tmos_set_event(Peripheral_TaskID, SBP_START_DEVICE_EVT);

    PRINT("==== KEYGO v3.13 (CH582M) ====\n");
}

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
        GAPRole_PeripheralStartDevice(Peripheral_TaskID, NULL,
                                       &Peripheral_PeripheralCBs);
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

    if (events & SBP_STATE_MACHINE_EVT) {
        if (g_deviceConnected) {
            KeyGo_ProcessStateMachine();
        }
        if (g_deviceConnected) {
            tmos_start_task(Peripheral_TaskID, SBP_STATE_MACHINE_EVT, SBP_STATE_MACHINE_PERIOD);
        }
        return (events ^ SBP_STATE_MACHINE_EVT);
    }

    if (events & SBP_GPIO_PULSE_END_EVT) {
        KeyGo_GPIO_PulseEnd();
        return (events ^ SBP_GPIO_PULSE_END_EVT);
    }

    // ★ v3.13: advertising 重启兜底 — 延迟重试，避免 BLE Controller 偶发卡死
    if (events & SBP_ADV_RESTART_EVT) {
        uint8_t adv_state;
        GAPRole_GetParameter(GAPROLE_STATE, &adv_state);
        if ((adv_state & GAPROLE_STATE_ADV_MASK) == GAPROLE_ADVERTISING) {
            // advertising 已正常启动，清除重试计数
            advRestartRetryCount = 0;
            PRINT("[GAP] advertising restarted successfully (retry=%d)\n", advRestartRetryCount);
        } else if (advRestartRetryCount < SBP_ADV_RESTART_MAX_RETRIES) {
            // advertising 仍未恢复，再次触发
            uint8_t enable = TRUE;
            GAPRole_SetParameter(GAPROLE_ADVERT_ENABLED, sizeof(uint8_t), &enable);
            advRestartRetryCount++;
            PRINT("[GAP] advertising retry %d/%d (state=0x%02x)\n",
                  advRestartRetryCount, SBP_ADV_RESTART_MAX_RETRIES, adv_state);
            tmos_start_task(Peripheral_TaskID, SBP_ADV_RESTART_EVT, SBP_ADV_RESTART_DELAY);
        } else {
            // 重试耗尽，打印警告
            advRestartRetryCount = 0;
            PRINT("[GAP] advertising FAILED after %d retries, giving up\n", SBP_ADV_RESTART_MAX_RETRIES);
        }
        return (events ^ SBP_ADV_RESTART_EVT);
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
            PRINT("Scan req from %x:%x:%x:%x:%x:%x\n",
                  pEvent->scanReqEvt.scannerAddr[0], pEvent->scanReqEvt.scannerAddr[1],
                  pEvent->scanReqEvt.scannerAddr[2], pEvent->scanReqEvt.scannerAddr[3],
                  pEvent->scanReqEvt.scannerAddr[4], pEvent->scanReqEvt.scannerAddr[5]);
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
        peripheralMTU                       = ATT_MTU_SIZE;

        g_deviceConnected        = 1;

        KeyGo_ResetState();

        tmos_start_task(Peripheral_TaskID, SBP_PERIODIC_EVT,      SBP_PERIODIC_EVT_PERIOD);
        tmos_start_task(Peripheral_TaskID, SBP_PARAM_UPDATE_EVT,  SBP_PARAM_UPDATE_DELAY);
        tmos_start_task(Peripheral_TaskID, SBP_READ_RSSI_EVT,     KeyGo_GetRssiPeriodTicks());
        tmos_start_task(Peripheral_TaskID, SBP_STATE_MACHINE_EVT, SBP_STATE_MACHINE_PERIOD);

        PRINT("Connected %x - Int %x\n", event->connectionHandle, event->connInterval);
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

        tmos_stop_task(Peripheral_TaskID, SBP_PERIODIC_EVT);
        tmos_stop_task(Peripheral_TaskID, SBP_READ_RSSI_EVT);
        tmos_stop_task(Peripheral_TaskID, SBP_STATE_MACHINE_EVT);
        tmos_stop_task(Peripheral_TaskID, SBP_GPIO_PULSE_END_EVT);
        tmos_stop_task(Peripheral_TaskID, SBP_ADV_RESTART_EVT);  // 取消之前的重试
        advRestartRetryCount = 0;

        KeyGo_ResetState();

        if (g_keyState == KSTATE_UNLOCKED) {
            PRINT("[SAFETY] disconnected while unlocked, auto lock\n");
            KeyGo_Lock();
            g_keyState = KSTATE_LOCKED;
        }

        // ★ v3.13: 立即启动 advertising（BLE Controller 正常情况）
        {
            uint8_t advertising_enable = TRUE;
            GAPRole_SetParameter(GAPROLE_ADVERT_ENABLED, sizeof(uint8_t), &advertising_enable);
        }
        // ★ v3.13: 200ms 后检查 advertising 状态，未恢复则触发重试机制
        tmos_start_task(Peripheral_TaskID, SBP_ADV_RESTART_EVT, SBP_ADV_RESTART_DELAY);

        PRINT("Disconnected.. Reason:%x\n", pEvent->linkTerminate.reason);
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
 * ────────────────────── GATT 写回调 ───────────────────────────────
 *   FF01 (RSSI)   → keygo_core
 *   FF03 (Command) → keygo_core
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

        case SIMPLEPROFILE_CHAR3:  // FF03: Command
        {
            char cmd[SIMPLEPROFILE_CHAR3_LEN + 1];
            uint16_t copyLen = (len > SIMPLEPROFILE_CHAR3_LEN) ? SIMPLEPROFILE_CHAR3_LEN : len;
            tmos_memcpy(cmd, pValue, copyLen);
            cmd[copyLen] = '\0';

            KeyGo_HandleCommand(cmd, copyLen);
            KeyGo_NotifyStatus();
            break;
        }

        default:
            break;
    }
}

/*********************************************************************
 *********************************************************************/
