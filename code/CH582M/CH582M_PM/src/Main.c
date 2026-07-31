/********************************** (C) COPYRIGHT *******************************
 * File Name          : Main.c
 * Author             : KeyGo PM Test V18 — 博客纯净版(闪3下) + 下拉防漏电
 * Version            : V18.0
 * Date               : 2026/07/31
 * Description        : V17 确认新固件生效(闪17下)后掉到 3mA。V18 简化：
 *   1) 内部 32K RC 初始化
 *   2) 全部 GPIO 下拉输入（博客另一种推荐，避免上拉到外电路漏电）
 *   3) PB22 下降沿 GPIO 唤醒
 *   4) 蓝灯闪 3 下确认（简洁）
 *   5) 关 LED(PB14/15=LOW)、关 KeyPower(PB0=HIGH)
 *   6) 纯 Sleep 循环
 *   对比 V17(上拉)的 3mA：若下拉更低→说明上拉到外电路漏电；若仍 3mA→芯片/供电域问题
 *******************************************************************************/

#include "CH58x_common.h"

__INTERRUPT
__HIGH_CODE
void GPIOB_IRQHandler(void)
{
    GPIOB_ClearITFlagBit(GPIO_Pin_22);
}

static void Init32K_Clock(void)
{
#if(CLK_OSC32K)
    sys_safe_access_enable();
    R8_CK32K_CONFIG &= ~(RB_CLK_OSC32K_XT | RB_CLK_XT32K_PON);
    sys_safe_access_disable();

    sys_safe_access_enable();
    R8_CK32K_CONFIG |= RB_CLK_INT32K_PON;
    sys_safe_access_disable();

    LSECFG_Current(LSE_RCur_100);
    Lib_Calibration_LSI();
#else
    sys_safe_access_enable();
    R8_CK32K_CONFIG |= RB_CLK_OSC32K_XT | RB_CLK_INT32K_PON | RB_CLK_XT32K_PON;
    sys_safe_access_disable();
#endif
}

int main(void)
{
    SetSysClock(CLK_SOURCE_PLL_60MHz);

    /* 1) 内部 32K RC，关外部晶振 */
    Init32K_Clock();

    /* 2) 全部 GPIO 下拉输入（避免上拉到外电路漏电）*/
    GPIOA_ModeCfg(GPIO_Pin_All, GPIO_ModeIN_PD);
    GPIOB_ModeCfg(GPIO_Pin_All, GPIO_ModeIN_PD);

    /* 3) PB22(BOOT键) 下降沿 GPIO 唤醒 */
    GPIOB_ITModeCfg(GPIO_Pin_22, GPIO_ITMode_FallEdge);
    PFIC_EnableIRQ(GPIO_B_IRQn);
    PWR_PeriphWakeUpCfg(ENABLE, RB_SLP_GPIO_WAKE, Long_Delay);

    /* 4) 版本确认：蓝灯闪 3 次 */
    GPIOB_ModeCfg(GPIO_Pin_14, GPIO_ModeOut_PP_5mA);
    for (int i = 0; i < 3; i++) {
        GPIOB_SetBits(GPIO_Pin_14);
        DelayMs(100);
        GPIOB_ResetBits(GPIO_Pin_14);
        DelayMs(100);
    }

    /* 5) 关 LED、关 KeyPower */
    GPIOB_ModeCfg(GPIO_Pin_0  | GPIO_Pin_14 | GPIO_Pin_15, GPIO_ModeOut_PP_5mA);
    GPIOB_ResetBits(GPIO_Pin_14 | GPIO_Pin_15);
    GPIOB_SetBits(GPIO_Pin_0);

    DelayMs(2);

    /* 6) 纯睡眠循环 */
    while (1) {
        LowPower_Sleep(RB_PWR_RAM30K | RB_PWR_RAM2K);
        HSECFG_Current(HSE_RCur_100);
    }
}
