/********************************** (C) COPYRIGHT *******************************
 * File Name          : keygo_hid.h
 * Author             : KeyGo Spike (HID 锚点探针)
 * Version            : Spike-0.1
 * Date               : 2026/07/16
 * Description        : HID 锚点探针应用层头文件
 *   目的：验证「Android 能否在【无 App】情况下，自动重连已配对的 BLE HID 设备」。
 *   做法：设备作为 BLE HID (Consumer) 外设 + 叠加自定义 GATT 服务(0xFF00)，
 *        由 OS 托管连接（像蓝牙键鼠），App 不参与日常重连。
 ********************************************************************************/
#ifndef KEYGO_HID_H
#define KEYGO_HID_H

#ifdef __cplusplus
extern "C" {
#endif

/*********************************************************************
 * @fn      KeyGoHid_Init
 *
 * @brief   探针应用初始化：设置 HID 广播/配对参数，注册 HID 服务 +
 *          自定义 GATT 服务(SimpleProfile, 0xFF00)，注册 HID 回调。
 *
 * @return  none
 */
void KeyGoHid_Init(void);

/*********************************************************************
 * @fn      KeyGoHid_ProcessEvent
 *
 * @brief   探针 TMOS 任务事件处理（加密链路监测 + LED 提示驱动）。
 *
 * @return  events not processed
 */
uint16_t KeyGoHid_ProcessEvent(uint8_t task_id, uint16_t events);

#ifdef __cplusplus
}
#endif

#endif /* KEYGO_HID_H */
