/********************************** (C) COPYRIGHT *******************************
 * File Name          : keygo_hid.c
 * Author             : KeyGo Spike (HID 锚点探针)
 * Version            : Spike-0.1
 * Date               : 2026/07/16
 * Description        : HID 锚点探针应用层
 *   验证目标：Android 在【无 App】时能否自动重连已配对的 BLE HID 设备。
 *   设计：
 *     - 设备作为 BLE HID(Consumer) 外设 → OS 像管键鼠一样自动重连（无需 App）
 *     - 叠加自定义 GATT 服务 SimpleProfile(0xFF00) → 验证「HID + 自定义 GATT 多服务共存」
 *     - 串口 [OBS] 日志 + PB4 LED 提示，用于肉眼观察「无 App 自动重连」是否发生
 *   注意：本文件不实现车锁动作逻辑，仅为架构探针。
 ********************************************************************************/

#include "CONFIG.h"
#include "HAL.h"
#include "hiddev.h"
#include "hidconsumerservice.h"
#include "battservice.h"
#include "gattprofile.h"
#include "keygo_hid.h"

/*********************************************************************
 * MACROS
 */
#define START_MONITOR_EVT   0x0001   // 周期性监测加密链路(自动重连标志)
#define BLINK_EVT           0x0002   // LED 闪烁驱动

// HID 配对参数（探针分阶段验证）
// 阶段1(默认·当前)：JUST_WORKS 无码配对 —— 最快验证"无App自动重连"核心假设，
//   绕开 passkey / Secure Connection 协商复杂度（CH582M BLE lib V2.13 对 SC+Passkey 支持有限）。
//   此模式已绑定后 OS 仍会加密重连(LTK 持久化)，"连上了=已授权"成立；仅配对瞬间无 MITM 保护（探针可接受）。
// 阶段2(启用密码模型)：把下面两行改回即可走 Passkey Entry（设备显示固定码123456，手机输入）
//   #define DEFAULT_IO_CAPABILITIES        GAPBOND_IO_CAP_DISPLAY_ONLY
//   #define DEFAULT_MITM_MODE              TRUE
//   ★ 切勿用 GAPBOND_IO_CAP_KEYBOARD_DISPLAY：会协商成 Numeric Comparison 且无确认回调→"密钥错误/配置错误"。
#define DEFAULT_PASSCODE               123456
#define DEFAULT_PAIRING_MODE           GAPBOND_PAIRING_MODE_WAIT_FOR_REQ
#define DEFAULT_MITM_MODE              FALSE
#define DEFAULT_BONDING_MODE           TRUE
#define DEFAULT_IO_CAPABILITIES        GAPBOND_IO_CAP_NO_INPUT_NO_OUTPUT

// 监测周期（TMOS tick，≈1s；精度不影响结论）
#define MONITOR_PERIOD_TICKS           800
// LED 闪烁半周期（TMOS tick，≈100ms；精度不影响结论）
#define BLINK_HALF_TICKS               80

/*********************************************************************
 * GLOBAL VARIABLES
 */
static uint8_t keygoHidTaskId = INVALID_TASK_ID;
static uint16_t gapConnHandle = GAP_CONNHANDLE_INIT;

// 观测性全局
static uint8_t  g_deviceConnected   = 0;
static uint8_t  g_obsLinkEncrypted  = 0;   // 上一拍 LINK_ENCRYPTED，用于上升沿检测
static uint8_t  g_obsBlinkLeft      = 0;   // 剩余半周期数
static uint8_t  g_obsBlinkOn        = 0;

/*********************************************************************
 * LOCAL FUNCTIONS
 */
static void keygoHidStateCB(gapRole_States_t newState, gapRoleEvent_t *pEvent);
static uint8_t keygoHidRptCB(uint8_t id, uint8_t type, uint16_t uuid,
                              uint8_t oper, uint16_t *pLen, uint8_t *pData);
static void keygoHidEvtCB(uint8_t evt);
static void KeyGoHid_BlinkTrigger(uint8_t blinks, uint16_t halfMs);

/*********************************************************************
 * PROFILE CALLBACKS
 */
static hidDevCB_t keygoHidCBs = {
    keygoHidRptCB,    // reportCB
    keygoHidEvtCB,    // evtCB
    NULL,             // passcodeCB（用 GAPBOND_PERI_DEFAULT_PASSCODE=123456）
    keygoHidStateCB   // pfnStateChange（HID 内部处理后转发到这里）
};

/*********************************************************************
 * 广播 / 扫描响应数据
 */
// 扫描响应：连接间隔 + 服务 UUID 列表(HID + Battery + 自定义GATT) + 发射功率
static uint8_t scanRspData[] = {
    0x05, // length
    GAP_ADTYPE_SLAVE_CONN_INTERVAL_RANGE,
    LO_UINT16(8), HI_UINT16(8),
    LO_UINT16(16), HI_UINT16(16),

    // service UUIDs (16-bit)
    0x07, // length = 3 UUIDs * 2 + 1
    GAP_ADTYPE_16BIT_MORE,
    LO_UINT16(HID_SERV_UUID),  HI_UINT16(HID_SERV_UUID),
    LO_UINT16(BATT_SERV_UUID), HI_UINT16(BATT_SERV_UUID),
    LO_UINT16(SIMPLEPROFILE_SERV_UUID), HI_UINT16(SIMPLEPROFILE_SERV_UUID),

    0x02, // length
    GAP_ADTYPE_POWER_LEVEL,
    0 // 0dBm
};

// 广播数据：flags + HID appearance + 设备名
static uint8_t advertData[] = {
    0x02, // length
    GAP_ADTYPE_FLAGS,
    GAP_ADTYPE_FLAGS_GENERAL | GAP_ADTYPE_FLAGS_BREDR_NOT_SUPPORTED,

    0x03, // length
    GAP_ADTYPE_APPEARANCE,
    LO_UINT16(GAP_APPEARE_GENERIC_HID),
    HI_UINT16(GAP_APPEARE_GENERIC_HID),

    0x0A, // length
    GAP_ADTYPE_LOCAL_NAME_COMPLETE,
    'K', 'e', 'y', 'G', 'o', '-', 'H', 'I', 'D'
};

static CONST uint8_t attDeviceName[GAP_DEVICE_NAME_LEN] = "KeyGo-HID";

// HID Dev 配置
static hidDevCfg_t keygoHidCfg = {
    60000,                 // Idle timeout
    HID_FEATURE_FLAGS      // HID feature flags
};

/*********************************************************************
 * @fn      KeyGoHid_Init
 */
void KeyGoHid_Init(void)
{
    keygoHidTaskId = TMOS_ProcessEventRegister(KeyGoHid_ProcessEvent);

    // LED (PB4) 初始化 —— 提示用
    GPIOB_ModeCfg(GPIO_Pin_4, GPIO_ModeOut_PP_5mA);
    GPIOB_ResetBits(GPIO_Pin_4);

    // 广播数据
    GAPRole_SetParameter(GAPROLE_ADVERT_DATA, sizeof(advertData), advertData);
    GAPRole_SetParameter(GAPROLE_SCAN_RSP_DATA, sizeof(scanRspData), scanRspData);
    GGS_SetParameter(GGS_DEVICE_NAME_ATT, sizeof(attDeviceName), (void *)attDeviceName);

    // 配对/绑定参数（镜像 KeyGo：INITIATE 触发系统输码 + 绑定）
    {
        uint32_t passkey = DEFAULT_PASSCODE;
        uint8_t  pairMode = DEFAULT_PAIRING_MODE;
        uint8_t  mitm = DEFAULT_MITM_MODE;
        uint8_t  ioCap = DEFAULT_IO_CAPABILITIES;
        uint8_t  bonding = DEFAULT_BONDING_MODE;
        uint8_t  syncWL = FALSE;  // ★ 覆盖 hiddev.c 默认 TRUE：关白名单，避免手机 RPA 轮换后断连重连被拒
        GAPBondMgr_SetParameter(GAPBOND_PERI_DEFAULT_PASSCODE, sizeof(uint32_t), &passkey);
        GAPBondMgr_SetParameter(GAPBOND_PERI_PAIRING_MODE, sizeof(uint8_t), &pairMode);
        GAPBondMgr_SetParameter(GAPBOND_PERI_MITM_PROTECTION, sizeof(uint8_t), &mitm);
        GAPBondMgr_SetParameter(GAPBOND_PERI_IO_CAPABILITIES, sizeof(uint8_t), &ioCap);
        GAPBondMgr_SetParameter(GAPBOND_PERI_BONDING_ENABLED, sizeof(uint8_t), &bonding);
        GAPBondMgr_SetParameter(GAPBOND_AUTO_SYNC_WL, sizeof(uint8_t), &syncWL);
    }

    // 注册服务：
    //   - HID 服务（连接锚点，OS 据此自动重连）
    //   - 自定义 GATT 服务 SimpleProfile(0xFF00)（验证 HID + 自定义 GATT 多服务共存）
    // 注意：GGS/GATTServApp/DevInfo/Batt/ScanParam 由 HidDev_Init() 注册，勿重复。
    Hid_AddService();
    SimpleProfile_AddService(GATT_ALL_SERVICES);

    // 注册 HID 回调（pfnStateChange = keygoHidStateCB）
    HidDev_Register(&keygoHidCfg, &keygoHidCBs);

    // 启动广播（高占空比 20ms，加快首次配对发现）
    // 默认 TGAP_DISC_ADV_INT=160 → 100ms 偏慢；压到 20ms(32×0.625) 让手机扫描窗口一开即发现。
    GAP_SetParamValue(TGAP_DISC_ADV_INT_MIN, 32);   // 20ms
    GAP_SetParamValue(TGAP_DISC_ADV_INT_MAX, 48);   // 30ms
    {
        uint8_t adv_enable = TRUE;
        GAPRole_SetParameter(GAPROLE_ADVERT_ENABLED, sizeof(uint8_t), &adv_enable);
    }

    PRINT("[SPIKE] KeyGo-HID probe init done (HID anchor + custom GATT 0xFF00)\n");
}

/*********************************************************************
 * @fn      KeyGoHid_ProcessEvent
 */
uint16_t KeyGoHid_ProcessEvent(uint8_t task_id, uint16_t events)
{
    if(events & SYS_EVENT_MSG)
    {
        uint8_t *pMsg;
        if((pMsg = tmos_msg_receive(keygoHidTaskId)) != NULL)
        {
            tmos_msg_deallocate(pMsg);
        }
        return (events ^ SYS_EVENT_MSG);
    }

    if(events & START_MONITOR_EVT)
    {
        // 监测加密链路（OS 已配对自动重连的标志）
        if(g_deviceConnected && gapConnHandle != GAP_CONNHANDLE_INIT)
        {
            uint8_t encNow = linkDB_State(gapConnHandle, LINK_ENCRYPTED) ? 1 : 0;
            if(encNow && !g_obsLinkEncrypted)
            {
                PRINT("[OBS] LINK_ENCRYPTED (OS bonded reconnect — phone near & paired)\n");
                KeyGoHid_BlinkTrigger(3, BLINK_HALF_TICKS);   // 3 短闪提示自动重连成功
            }
            else if(!encNow && g_obsLinkEncrypted)
            {
                PRINT("[OBS] LINK_PLAIN (encryption dropped)\n");
            }
            g_obsLinkEncrypted = encNow;
        }
        else
        {
            g_obsLinkEncrypted = 0;
        }
        tmos_start_task(keygoHidTaskId, START_MONITOR_EVT, MONITOR_PERIOD_TICKS);
        return (events ^ START_MONITOR_EVT);
    }

    if(events & BLINK_EVT)
    {
        // LED 闪烁驱动（纯 tmos 延时，不依赖时钟函数）
        if(g_obsBlinkLeft > 0)
        {
            if(g_obsBlinkOn) GPIOB_SetBits(GPIO_Pin_4);
            else             GPIOB_ResetBits(GPIO_Pin_4);
            g_obsBlinkOn = g_obsBlinkOn ? 0 : 1;
            g_obsBlinkLeft--;
            if(g_obsBlinkLeft > 0)
                tmos_start_task(keygoHidTaskId, BLINK_EVT, BLINK_HALF_TICKS);
        }
        return (events ^ BLINK_EVT);
    }

    return 0;
}

/*********************************************************************
 * @fn      keygoHidStateCB
 * @brief   GAP 状态回调（由 HID 框架在内部处理后转发调用）
 */
static void keygoHidStateCB(gapRole_States_t newState, gapRoleEvent_t *pEvent)
{
    switch(newState & GAPROLE_STATE_ADV_MASK)
    {
        case GAPROLE_STARTED:
        {
            uint8_t ownAddr[6];
            GAPRole_GetParameter(GAPROLE_BD_ADDR, ownAddr);
            GAP_ConfigDeviceAddr(ADDRTYPE_STATIC, ownAddr);
            PRINT("[SPIKE] Initialized..\n");
        }
        break;

        case GAPROLE_ADVERTISING:
            if(pEvent->gap.opcode == GAP_MAKE_DISCOVERABLE_DONE_EVENT)
                PRINT("[OBS] ADVERTISING\n");
            break;

        case GAPROLE_CONNECTED:
            if(pEvent->gap.opcode == GAP_LINK_ESTABLISHED_EVENT)
            {
                gapEstLinkReqEvent_t *event = (gapEstLinkReqEvent_t *)pEvent;
                gapConnHandle = event->connectionHandle;
                g_deviceConnected = 1;
                PRINT("[OBS] CONNECTED (HID link up)\n");
                // 启动加密链路监测（自动重连标志）
                tmos_start_task(keygoHidTaskId, START_MONITOR_EVT, MONITOR_PERIOD_TICKS);
            }
            break;

        case GAPROLE_WAITING:
            if(pEvent->gap.opcode == GAP_LINK_TERMINATED_EVENT)
            {
                PRINT("[OBS] DISCONNECTED reason=%x\n", pEvent->linkTerminate.reason);
                g_deviceConnected = 0;
                g_obsLinkEncrypted = 0;
                gapConnHandle = GAP_CONNHANDLE_INIT;
                GPIOB_ResetBits(GPIO_Pin_4);   // LED 灭
                // ★ 断连后必须显式重启广播：HID 框架(hiddev.c)不自动重启 advertising，
                //   若不处理，固件断连后停止广播→手机蓝牙重启/走远再走近时搜不到/连不上
                //   (必须重启设备才恢复)。重启广播后 OS 按 HID auto-connect 自动重连(荣耀手环同理)。
                // ★ 重连加速：用高占空比广播(20ms)替代默认 100ms。重连延迟两大来源——
                //   (1)固件广播间隔(此项可控,压到最短);(2)手机 OS 后台 HID 重连是低频扫描调度
                //   (此项固件不可控,须靠"定向广播"绕过,见下)。两者叠加才决定最终速度。
                //   注:持续 20ms 广播较耗电,主固件量产时应加"高占空比若干秒后转低占空比"降速定时器。
                GAP_SetParamValue(TGAP_DISC_ADV_INT_MIN, 32);   // 20ms
                GAP_SetParamValue(TGAP_DISC_ADV_INT_MAX, 48);   // 30ms
                uint8_t adv_enable = TRUE;
                GAPRole_SetParameter(GAPROLE_ADVERT_ENABLED, sizeof(uint8_t), &adv_enable);
            }
            break;

        case GAPROLE_ERROR:
            PRINT("[SPIKE] GAPROLE_ERROR %x\n", pEvent->gap.opcode);
            break;

        default:
            break;
    }
}

/*********************************************************************
 * @fn      keygoHidRptCB
 * @brief   HID 报告回调（探针不处理具体报告，仅返回成功）
 */
static uint8_t keygoHidRptCB(uint8_t id, uint8_t type, uint16_t uuid,
                              uint8_t oper, uint16_t *pLen, uint8_t *pData)
{
    return SUCCESS;
}

/*********************************************************************
 * @fn      keygoHidEvtCB
 */
static void keygoHidEvtCB(uint8_t evt)
{
    return;
}

/*********************************************************************
 * @fn      KeyGoHid_BlinkTrigger
 * @brief   触发 LED 闪烁（blinks 次，halfTicks 为半周期 tick 数）
 */
static void KeyGoHid_BlinkTrigger(uint8_t blinks, uint16_t halfTicks)
{
    if(blinks == 0) return;
    g_obsBlinkLeft   = blinks * 2;
    g_obsBlinkOn     = 1;
    tmos_start_task(keygoHidTaskId, BLINK_EVT, halfTicks);
}
