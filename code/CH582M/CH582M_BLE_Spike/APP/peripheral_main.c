/********************************** (C) COPYRIGHT *******************************
 * File Name          : main.c
 * Author             : KeyGo Spike (HID 锚点探针) — 基于 WCH HID_Consumer 例程 + 原 slave 看门狗
 * Version            : Spike-0.1
 * Date               : 2026/07/16
 * Description        : HID 锚点探针主函数
 *   目的：把设备做成「BLE HID(Consumer) 外设 + 自定义 GATT(0xFF00)」，
 *        验证 Android 能否在【无 App】时自动重连已配对设备。
 *   连接由 OS 托管（像蓝牙键鼠），App 不参与日常重连。
 ********************************************************************************/

#include "CONFIG.h"
#include "HAL.h"
#include "hiddev.h"
#include "keygo_hid.h"
#include "CH58x_sys.h"  /* WWDG API + SYS_ResetExecute — 软看门狗 */

/*********************************************************************
 * GLOBAL TYPEDEFS
 */
__attribute__((aligned(4))) uint32_t MEM_BUF[BLE_MEMHEAP_SIZE / 4];

#if(defined(BLE_MAC)) && (BLE_MAC == TRUE)
const uint8_t MacAddr[6] = {0x84, 0xC2, 0xE4, 0x03, 0x02, 0x02};
#endif

/*********************************************************************
 * ★ 软看门狗 — 复制自主固件 v3.16（防止探针死机无输出）
 *   说明见主固件 peripheral_main.c；此处保持一致。
 *********************************************************************/
volatile uint8_t g_mainLoopAlive   = 0;
volatile uint8_t g_watchdogCount   = 0;

__INTERRUPT
__HIGH_CODE
void WDOG_BAT_IRQHandler(void)
{
    if (WWDG_GetFlowFlag())
    {
        WWDG_ClearFlag();
        if (g_mainLoopAlive != 0)
        {
            g_mainLoopAlive = 0;
            g_watchdogCount = 0;
        }
        else
        {
            g_watchdogCount++;
            if (g_watchdogCount >= 5)
            {
                GPIOB_ResetBits(GPIO_Pin_4);
                SYS_ResetExecute();
            }
        }
        WWDG_SetCounter(26);
    }
}

__HIGH_CODE
__attribute__((noinline))
void Main_Circulation()
{
    while(1)
    {
        TMOS_SystemProcess();
        g_mainLoopAlive = 1;
    }
}

/*********************************************************************
 * @fn      main
 */
int main(void)
{
#if(defined(DCDC_ENABLE)) && (DCDC_ENABLE == TRUE)
    PWR_DCDCCfg(ENABLE);
#endif
    SetSysClock(CLK_SOURCE_PLL_60MHz);

#if(defined(HAL_SLEEP)) && (HAL_SLEEP == TRUE)
    GPIOA_ModeCfg(GPIO_Pin_All, GPIO_ModeIN_PU);
    GPIOB_ModeCfg(GPIO_Pin_All, GPIO_ModeIN_PU);
#endif
#ifdef DEBUG
    GPIOA_SetBits(bTXD1);
    GPIOA_ModeCfg(bTXD1, GPIO_ModeOut_PP_5mA);
    UART1_DefInit();
#endif
    PRINT("%s\n", VER_LIB);
    CH58X_BLEInit();
    HAL_Init();
    GAPRole_PeripheralInit();   // 初始化 GAP 外设角色

    // HID 框架：注册 HID 任务 + 服务(GGS/GATT/DevInfo/Batt/ScanParam) + 启动设备
    HidDev_Init();
    // 探针应用层：HID 广播/配对 + HID 服务 + 自定义 GATT(0xFF00) + 观测性
    KeyGoHid_Init();

    // 软看门狗（init 完成后启动，避免初始化超时误复位）
    WWDG_ResetCfg(DISABLE);
    WWDG_ITCfg(ENABLE);
    WWDG_SetCounter(26);

    Main_Circulation();
}
