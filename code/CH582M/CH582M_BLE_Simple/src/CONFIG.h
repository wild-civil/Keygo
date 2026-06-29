/********************************** (C) COPYRIGHT *******************************
 * File Name          : CONFIG.h
 * Author             : WCH
 * Version            : V1.0
 * Date               : 2024/01/01
 * Description        : 配置文件
 *******************************************************************************/

#ifndef CONFIG_H
#define CONFIG_H

#include "CH58xBLE_LIB.h"

/* 设备名称：手机蓝牙扫描时显示的名字 */
#define DEVICE_NAME         "BLE-Key-Go"

/* 广播间隔：单位 0.625ms，160 = 100ms */
#define ADV_INTERVAL        160

/* 连接间隔：单位 1.25ms，6 = 7.5ms（最小），12 = 15ms（最大） */
#define CONN_INTERVAL_MIN   6
#define CONN_INTERVAL_MAX   12

/* 从机延迟：0 = 无延迟 */
#define CONN_SLAVE_LATENCY  0

/* 超时时间：单位 10ms，500 = 5秒 */
#define CONN_TIMEOUT        500

/* 服务 UUID：0xFF00（我们自定义的） */
#define SIMPLEPROFILE_SERV_UUID   0xFF00

/* 特征值 UUID */
#define SIMPLEPROFILE_CHAR1_UUID  0xFF01
#define SIMPLEPROFILE_CHAR2_UUID  0xFF02
#define SIMPLEPROFILE_CHAR3_UUID  0xFF03
#define SIMPLEPROFILE_CHAR4_UUID  0xFF04

/* 广播使能 */
#define DEFAULT_ADVERTISING_ENABLE    TRUE

/* 发现模式 */
#define DEFAULT_DISCOVERABLE_MODE     GAP_ADTYPE_FLAGS_GENERAL

/* 任务 ID */
extern uint8_t Peripheral_TaskID;

/* 函数声明 */
void Peripheral_Init(void);

#endif
