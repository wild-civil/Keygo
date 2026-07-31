/********************************** (C) COPYRIGHT *******************************
 * File Name          : SLEEP.c
 * Author             : WCH
 * Version            : V1.2
 * Date               : 2022/01/18
 * Description        : 睡眠配置及其初始化
 *********************************************************************************
 * Copyright (c) 2021 Nanjing Qinheng Microelectronics Co., Ltd.
 * Attention: This software (modified or not) and binary are used for 
 * microcontroller manufactured by Nanjing Qinheng Microelectronics.
 *******************************************************************************/

/******************************************************************************/
/* 头文件包含 */
#include "HAL.h"

/*******************************************************************************
 * @fn          CH58X_LowPower
 *
 * @brief       启动睡眠
 *
 * @param   time    - 唤醒的时间点（RTC绝对值）
 *
 * @return      state.
 */
uint32_t CH58X_LowPower(uint32_t time)
{
#if(defined(HAL_SLEEP)) && (HAL_SLEEP == TRUE)
    uint32_t time_sleep, time_curr;
    unsigned long irq_status;
    
    SYS_DisableAllIrq(&irq_status);
    time_curr = RTC_GetCycle32k();
#if (DEBUG == Debug_UART1)
    {
        static uint32_t _lpDbgCnt = 0;
        if((_lpDbgCnt++ & 0x1F) == 0) {  // 每 32 次打印一次，避免刷屏
            PRINT("[LP] tc=%lu t=%lu\r\n", (uint32_t)time_curr, (uint32_t)time);
        }
    }
#endif
    // 检测睡眠时间
    if (time < time_curr) {
        time_sleep = time + (RTC_TIMER_MAX_VALUE - time_curr);
    } else {
        time_sleep = time - time_curr;
    }
    
    // 若睡眠时间小于最小睡眠时间或大于最大睡眠时间，则不睡眠
    if ((time_sleep < SLEEP_RTC_MIN_TIME) || 
        (time_sleep > SLEEP_RTC_MAX_TIME)) {
#if (DEBUG == Debug_UART1)
        PRINT("[LP] ret=2 ts=%lu (MIN=%lu)\r\n", (uint32_t)time_sleep, (uint32_t)SLEEP_RTC_MIN_TIME);
#endif
        SYS_RecoverIrq(irq_status);
        return 2;
    }

    RTC_SetTignTime(time);
    SYS_RecoverIrq(irq_status);
  #if(DEBUG == Debug_UART1) // 使用其他串口输出打印信息需要修改这行代码
    while((R8_UART1_LSR & RB_LSR_TX_ALL_EMP) == 0)
    {
        __nop();
    }
  #endif
    // LOW POWER-sleep模式
    if(!RTCTigFlag)
    {
        LowPower_Sleep(RB_PWR_RAM2K | RB_PWR_RAM30K | RB_PWR_EXTEND);
        if(RTCTigFlag) // 注意如果使用了RTC以外的唤醒方式，需要注意此时32M晶振未稳定
        {
            time += WAKE_UP_RTC_MAX_TIME;
            if(time > 0xA8C00000)
            {
                time -= 0xA8C00000;
            }
            RTC_SetTignTime(time);
            LowPower_Idle();
        }
        HSECFG_Current(HSE_RCur_100); // 降为额定电流(低功耗函数中提升了HSE偏置电流)
    }
    else
    {
#if (DEBUG == Debug_UART1)
        PRINT("[LP] ret=3 (RTCTigFlag stuck)\r\n");
#endif
        return 3;
    }
#endif
    return 0;
}

/*******************************************************************************
 * @fn      HAL_SleepInit
 *
 * @brief   配置睡眠唤醒的方式   - RTC唤醒，触发模式
 *
 * @param   None.
 *
 * @return  None.
 */
void HAL_SleepInit(void)
{
#if(defined(HAL_SLEEP)) && (HAL_SLEEP == TRUE)
    sys_safe_access_enable();
    R8_SLP_WAKE_CTRL |= RB_SLP_RTC_WAKE; // RTC唤醒
    sys_safe_access_disable();              //
    sys_safe_access_enable();
    R8_RTC_MODE_CTRL |= RB_RTC_TRIG_EN;  // 触发模式
    sys_safe_access_disable();              //

    /* ★2026-07-31 低功耗：sleep 时关停未使用的外设时钟（USB/SPI/I2C/PWM/UART2/3/UART0）。
     *   临时整段注释，用于二分法对照：确认 CLK_OSC32K=1 仍 4.3mA 是否由它引起。
     *   保留：BLE(TMOS)/TMR0~3(节拍)/UART1(调试)。 */
#if 0
    sys_safe_access_enable();
    R8_SLP_CLK_OFF0 |= RB_SLP_CLK_UART0 | RB_SLP_CLK_UART2 | RB_SLP_CLK_UART3;
    R8_SLP_CLK_OFF1 |= RB_SLP_CLK_SPI0  | RB_SLP_CLK_SPI1  | RB_SLP_CLK_PWMX
                     | RB_SLP_CLK_I2C  | RB_SLP_CLK_USB   | RB_SLP_CLK_USB2;
    sys_safe_access_disable();
#endif

    PFIC_EnableIRQ(RTC_IRQn);
#endif
}
