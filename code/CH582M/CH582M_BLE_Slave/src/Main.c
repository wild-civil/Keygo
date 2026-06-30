/********************************** (C) COPYRIGHT *******************************
 * File Name          : Main.c
 * Author             : WCH
 * Version            : V1.0
 * Date               : 2020/08/06
 * Description        : CH582M 最简 LED 闪烁程序
 *******************************************************************************/

#include "CH58x_common.h"

/* LED 引脚定义：PA12 */
#define LED_PIN     GPIO_Pin_12
#define LED_PORT    GPIOA

/*********************************************************************
 * @fn      main
 *
 * @brief   主函数：让 LED 每秒闪一次
 *
 * @return  none
 */
int main()
{
    /* 1. 设置系统时钟：60MHz */
    SetSysClock(CLK_SOURCE_PLL_60MHz);

    /* 2. 配置 PA12 为推挽输出模式 */
    GPIOA_ModeCfg(LED_PIN, GPIO_ModeOut_PP_5mA);

    /* 3. 主循环：闪烁 LED */
    while(1)
    {
        /* LED 翻转 */
        GPIOA_InvertBits(LED_PIN);

        /* 延时 500ms */
        DelayMs(500);
    }
}
