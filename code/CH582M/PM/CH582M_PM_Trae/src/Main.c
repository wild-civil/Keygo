/********************************** (C) COPYRIGHT *******************************
 * File Name          : Main.c
 * Author             : Trae
 * Version            : V3.0
 * Description        : CH582M 四模式低功耗电流对比测试 (极简版)
 *                      模仿 eeworld 帖子方法: 删串口, 极简, 直接进模式测电流
 *
 * 测试模式 (TEST_MODE):
 *   0 = Idle      空闲模式  (标称 ~2mA)
 *   1 = Halt      暂停模式  (标称 ~0.4mA)
 *   2 = Sleep     睡眠模式  (标称 0.7~2.8uA)
 *   3 = Shutdown  下电模式  (标称 ~0.15uA)
 *
 * 测电流方法 (重要!):
 *   1. 烧录后拔掉 USB / CH340 / WCH-Link (调试器供电会致 mA 级电流)
 *   2. 拆电源指示灯 LED 及其限流电阻
 *   3. 拆 USB 接口旁的 5.1K 识别电阻 (D+ 上拉, 关键漏电源)
 *   4. 独立 3.3V 电源从 VDD 直接供电 (绕开板载 LDO)
 *   5. 万用表 uA 档串联在电源和 VDD 之间
 *   6. 上电后等 2s 再读数
 *********************************************************************************/

#include "CH58x_common.h"

/* ===================== 用户配置 ===================== */
#define TEST_MODE           0       /* 0=Idle / 1=Halt / 2=Sleep / 3=Shutdown */
#define USE_DCDC            1       /* 1=使能DCDC(需PCB达标) / 0=关闭(默认更稳) */
#define USE_LSE             1       /* 1=外部32.768K晶振 / 0=内部32K RC */
/* =================================================== */

/*********************************************************************
 * @fn      GpioLowPowerInit
 * @brief   GPIO 全部输入上拉, 避免 floating 致 CMOS 漏电
 *********************************************************************/
void GpioLowPowerInit(void)
{
    GPIOA_ModeCfg(GPIO_Pin_All, GPIO_ModeIN_PU);
    GPIOB_ModeCfg(GPIO_Pin_All, GPIO_ModeIN_PU);
}

/*********************************************************************
 * @fn      Clk32KInit
 *********************************************************************/
void Clk32KInit(void)
{
#if USE_LSE
    LClk32K_Select(Clk32K_LSE);
    PWR_UnitModCfg(ENABLE, UNIT_SYS_LSE);
    PWR_UnitModCfg(DISABLE, UNIT_SYS_LSI);
#else
    LClk32K_Select(Clk32K_LSI);
    PWR_UnitModCfg(ENABLE, UNIT_SYS_LSI);
    PWR_UnitModCfg(DISABLE, UNIT_SYS_LSE);
#endif
}

/*********************************************************************
 * @fn      WakeupSrcInit
 * @brief   GPIO PA5 下降沿唤醒 (Idle/Halt/Sleep 唤醒用; Shutdown 唤醒=复位)
 *********************************************************************/
void WakeupSrcInit(void)
{
    GPIOA_ModeCfg(GPIO_Pin_5, GPIO_ModeIN_PU);
    GPIOA_ITModeCfg(GPIO_Pin_5, GPIO_ITMode_FallEdge);
    PFIC_EnableIRQ(GPIO_A_IRQn);
    PWR_PeriphWakeUpCfg(ENABLE, RB_SLP_GPIO_WAKE, Long_Delay);
}

/*********************************************************************
 * @fn      LowPowerPrep
 * @brief   Sleep 前低功耗准备
 *********************************************************************/
void LowPowerPrep(void)
{
    /* 关所有外设时钟 (含 USB 时钟 BIT_SLP_CLK_USB, 唤醒后自动恢复) */
    PWR_PeriphClkCfg(DISABLE, BIT_SLP_CLK_ALL);

    /* 关电压监测 (省 1~2uA) */
    PowerMonitor(DISABLE, HALevel_1V9);

    /* HSE 偏置 75% / LSE 偏置 70% */
    HSECFG_Current(HSE_RCur_75);
    LSECFG_Current(LSE_RCur_70);

#if USE_DCDC
    PWR_DCDCCfg(ENABLE);
#else
    PWR_DCDCCfg(DISABLE);
#endif
}

/*********************************************************************
 * @fn      main
 * @brief   极简: 上电 -> 初始化 -> 直接进模式 (无串口, 无打印)
 *********************************************************************/
int main(void)
{
    SetSysClock(CLK_SOURCE_PLL_60MHz);

    /* GPIO 全部上拉 */
    GpioLowPowerInit();

    /* 32K 时钟 */
    Clk32KInit();

    /* 唤醒源 (PA5 下降沿) */
    WakeupSrcInit();

    /* 低功耗准备 */
    LowPowerPrep();

    /* 上电后延时 2s 让电源稳定, 然后进模式 */
    DelayMs(2000);

    while(1)
    {
#if (TEST_MODE == 0)
        /* Idle: 内核停, 时钟运行, 外设全开 */
        LowPower_Idle();

#elif (TEST_MODE == 1)
        /* Halt: 内核停, 时钟也停 */
        LowPower_Halt();

#elif (TEST_MODE == 2)
        /* Sleep: 主LDO关, ULP-LDO维持, 保留 30K+2K SRAM */
        LowPower_Sleep(RB_PWR_RAM30K | RB_PWR_RAM2K);

#elif (TEST_MODE == 3)
        /* Shutdown: 内核+外设全断, 唤醒=复位 */
        LowPower_Shutdown(0);

#endif
    }
}

/*********************************************************************
 * @fn      GPIOA_IRQHandler
 * @brief   PA5 唤醒中断 (空函数, 仅用于触发唤醒)
 *********************************************************************/
__INTERRUPT
__HIGH_CODE
void GPIOA_IRQHandler(void)
{
    GPIOA_ClearITFlagBit(GPIO_Pin_5);
}
