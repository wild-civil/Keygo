/********************************** (C) COPYRIGHT *******************************
 * File Name          : peripheral.c
 * Author             : WCH
 * Version            : V1.0
 * Date               : 2024/01/01
 * Description        : BLE 从机应用程序 - 最简版
 *******************************************************************************/

#include "CONFIG.h"
#include "att.h"
#include "gatt_profile.h"

/*********************************************************************
 * 全局变量
 ********************************************************************/
uint8_t Peripheral_TaskID = 0;          // 任务 ID
uint8_t PeripheralConnHandle = 0xFF;   // 连接句柄
static uint8_t notificationEnabled = FALSE;

/* 广播数据：告诉手机"我是什么" */
static uint8_t advertData[] =
{
    0x02,             // 长度 = 2 字节
    GAP_ADTYPE_FLAGS, // 类型 = 标志位
    DEFAULT_DISCOVERABLE_MODE | GAP_ADTYPE_FLAGS_BREDR_NOT_SUPPORTED, // BLE only

    0x03,             // 长度 = 3 字节
    GAP_ADTYPE_16BIT_MORE, // 类型 = 16位 UUID 列表
    LO_UINT16(SIMPLEPROFILE_SERV_UUID),
    HI_UINT16(SIMPLEPROFILE_SERV_UUID),
};

/* 扫描回复数据：告诉手机"我叫什么" */
static uint8_t scanRspData[] =
{
    // 设备名称（手机蓝牙界面显示的名字）
    0x0A,             // 长度 = 10 字节 (1字节类型 + 9字节名字)
    GAP_ADTYPE_LOCAL_NAME_COMPLETE,
    'B','L','E','-','K','e','y','-','G','o',

    // 发射功率
    0x02,             // 长度 = 2 字节
    GAP_ADTYPE_POWER_LEVEL,
    0,                // 0 dBm
};

/*********************************************************************
 * 函数声明
 ********************************************************************/
static void peripheralStateNotificationCB(gapRoleStates_t newState, uint8_t connHandle);
static void peripheralInit(void);
static uint8_t peripheralReadCfg(uint8_t funcID);

/* GAP 角色回调函数 */
static const gapRoleCBs_t peripheralParamsCBs =
{
    peripheralStateNotificationCB,  // 状态通知回调
    peripheralReadCfg              // 配置读取回调
};

/*********************************************************************
 * @fn      Peripheral_Init
 *
 * @brief   初始化应用程序
 *
 * @return  none
 */
void Peripheral_Init(void)
{
    /* 注册任务 */
    Peripheral_TaskID = TMOS_ProcessEventRegister(Peripheral_ProcessEvent);

    /* 初始化 GAP */
    GAPRole_PeripheralInit(Peripheral_TaskID);

    /* 设置设备参数 */
    uint8_t initial_advertising_enable = DEFAULT_ADVERTISING_ENABLE;
    GAPRole_SetParameter(GAPROLE_ADVERT_ENABLED, sizeof(uint8_t), &initial_advertising_enable);
    GAPRole_SetParameter(GAPROLE_SCAN_RSP_DATA, sizeof(scanRspData), scanRspData);
    GAPRole_SetParameter(GAPROLE_ADVERT_DATA, sizeof(advertData), advertData);

    /* 设置连接参数 */
    uint16_t desired_min_interval = DEFAULT_DESIRED_MIN_CONN_INTERVAL;
    uint16_t desired_max_interval = DEFAULT_DESIRED_MAX_CONN_INTERVAL;
    GAPRole_SetParameter(GAPROLE_MIN_CONN_INTERVAL, sizeof(uint16_t), &desired_min_interval);
    GAPRole_SetParameter(GAPROLE_MAX_CONN_INTERVAL, sizeof(uint16_t), &desired_max_interval);
    GAPRole_SetParameter(GAPROLE_SLAVE_LATENCY, sizeof(uint16_t), &desired_slave_latency);
    GAPRole_SetParameter(GAPROLE_TIMEOUT_MULTIPLIER, sizeof(uint16_t), &desired_conn_timeout);

    /* 注册 GAP 回调 */
    GAPRole_StartDevice(&peripheralParamsCBs);

    /* 初始化 GATT 服务 */
    peripheralInit();

#ifdef DEBUG
    PRINT("Peripheral started\n");
#endif
}

/*********************************************************************
 * @fn      peripheralStateNotificationCB
 *
 * @brief   连接状态变化回调
 *
 * @param   newState - 新状态
 * @param   connHandle - 连接句柄
 *
 * @return  none
 */
static void peripheralStateNotificationCB(gapRoleStates_t newState, uint8_t connHandle)
{
    switch(newState)
    {
        case GAPROLE_STARTED:
#ifdef DEBUG
            PRINT("Initialized\n");
#endif
            break;

        case GAPROLE_ADVERTISING:
#ifdef DEBUG
            PRINT("Advertising...\n");
#endif
            break;

        case GAPROLE_CONNECTED:
#ifdef DEBUG
            PRINT("Connected!\n");
#endif
            PeripheralConnHandle = connHandle;
            break;

        case GAPROLE_CONNECTED_ADV:
#ifdef DEBUG
            PRINT("Connected and advertising\n");
#endif
            break;

        case GAPROLE_WAITING:
#ifdef DEBUG
            PRINT("Disconnected\n");
#endif
            PeripheralConnHandle = 0xFF;
            break;

        default:
            break;
    }
}

/*********************************************************************
 * @fn      peripheralReadCfg
 *
 * @brief   读取配置参数
 *
 * @param   funcID - 功能 ID
 *
 * @return  配置值
 */
static uint8_t peripheralReadCfg(uint8_t funcID)
{
    if(funcID == RILEYCFG_PARAM_ADV_INT)
    {
        return (uint8_t)(DEFAULT_ADVERTISING_INTERVAL);
    }
    return 0;
}

/*********************************************************************
 * @fn      peripheralInit
 *
 * @brief   初始化 GATT 服务
 *
 * @return  none
 */
static void peripheralInit(void)
{
    /* 添加简单 GATT 服务 */
    uint8_t svcUuid[2] = {LO_UINT16(SIMPLEPROFILE_SERV_UUID), HI_UINT16(SIMPLEPROFILE_SERV_UUID)};
    GGS_AddService(GATT_ALL_SERVICES);

    /* 添加简单 profiles */
    SimpleProfile_AddService(GATT_ALL_SERVICES);
}

/*********************************************************************
 * @fn      Peripheral_ProcessEvent
 *
 * @brief   任务事件处理
 *
 * @param   task_id - 任务 ID
 * @param   events - 事件标志
 *
 * @return  未处理的事件
 */
uint16_t Peripheral_ProcessEvent(uint8_t task_id, uint16_t events)
{
    if(events & SBP_READ_RSSI_EVT)
    {
#ifdef DEBUG
        int8_t rssi = 0;
        GAPRole_GetParameter(GAPROLE_RSSI, &rssi);
        PRINT("RSSI: %d dBm\n", rssi);
#endif
        return (events ^ SBP_READ_RSSI_EVT);
    }

    if(events & SBP_PARAM_UPDATE_EVT)
    {
        GAPRole_PeripheralConnParamUpdateReq(PeripheralConnHandle,
                                              desired_min_interval,
                                              desired_max_interval,
                                              desired_slave_latency,
                                              desired_conn_timeout,
                                              Peripheral_TaskID);
        return (events ^ SBP_PARAM_UPDATE_EVT);
    }

    return 0;
}
