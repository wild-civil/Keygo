/********************************** (C) COPYRIGHT *******************************
 * File Name          : Main.c
 * Author             : WCH
 * Version            : V1.0
 * Date               : 2024/01/01
 * Description        : CH582M 最简 BLE 广播工程
 *********************************************************************************
 * 本工程目标：让 CH582M 发送 BLE 广播，手机能搜到设备
 * 特点：代码极简，适合小白入门
 *******************************************************************************/

#include "CH58x_common.h"
#include "CONFIG.h"

/*********************************************************************
 * @fn      main
 *
 * @brief   主函数
 *
 * @return  none
 */
int main()
{
    /* 1. 设置系统时钟：60MHz PLL */
    SetSysClock(CLK_SOURCE_PLL_60MHz);

    /* 2. 配置调试串口（可选，用于打印信息） */
#ifdef DEBUG
    GPIOA_SetBits(bTXD1);
    GPIOA_ModeCfg(bTXD1, GPIO_ModeOut_PP_5mA);
    GPIOA_ModeCfg(bRXD1, GPIO_ModeIN_PU);
    UART1_DefInit();
    PRINT("CH582M BLE Simple Advertising\n");
#endif

    /* 3. 初始化 BLE 协议栈 */
    CH58X_BLEInit();
    
    /* 4. 初始化 GAP 角色（作为从机/外设） */
    GAPRole_PeripheralInit();
    
    /* 5. 初始化应用程序 */
    Peripheral_Init();

    /* 6. 主循环 */
    while(1)
    {
        TMOS_SystemProcess();
    }
}
