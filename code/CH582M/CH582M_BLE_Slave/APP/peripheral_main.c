/********************************** (C) COPYRIGHT *******************************
 * File Name          : main.c
 * Author             : KeyGo v3.35.0 (CH582M) — 基于 WCH V1.1 修改
 * Version            : V3.35.0
 * Date               : 2026/07/16
 * Description        : 外设从机应用主函数 — 含 WWDG 中断模式软看门狗 (2.5s)
 *********************************************************************************
 * Copyright (c) 2021 Nanjing Qinheng Microelectronics Co., Ltd.
 * Attention: This software (modified or not) and binary are used for 
 * microcontroller manufactured by Nanjing Qinheng Microelectronics.
 *******************************************************************************/

/******************************************************************************/
/* 头文件包含 */
#include "CONFIG.h"
#include "HAL.h"
#include "gattprofile.h"
#include "peripheral.h"
#include "keygo_core.h"  /* ★ 2026-07-16: KeyGo_UartCmdPoll 声明（串口 DEBUG 命令） */
#include "CH58x_sys.h"  /* WWDG API + SYS_ResetExecute — 软看门狗 2.5s */

/*********************************************************************
 * GLOBAL TYPEDEFS
 */
__attribute__((aligned(4))) uint32_t MEM_BUF[BLE_MEMHEAP_SIZE / 4];

#if(defined(BLE_MAC)) && (BLE_MAC == TRUE)
const uint8_t MacAddr[6] = {0x84, 0xC2, 0xE4, 0x03, 0x02, 0x02};
#endif

/*********************************************************************
 * ★ v3.16: 软看门狗 — 全局变量
 *
 * [为什么用 volatile？]
 *   这两个变量由主循环写入、由中断 ISR 读取/写入。
 *   不加 volatile，编译器可能会把 g_mainLoopAlive 优化成寄存器常量，
 *   导致 ISR 永远读到旧值 = 看门狗永远不工作。
 *
 * [g_mainLoopAlive — 主循环存活标志]
 *   - 初始值 0: 系统启动阶段主循环还没跑，ISR 统计启动耗时
 *   - 主循环每跑完一圈: 设为 1
 *   - ISR 每 500ms 读取: 是 1 → 主循环活着（清零标志）；是 0 → 可能死了
 *
 * [g_watchdogCount — 连续未报到计数器]
 *   - ISR 每 500ms 检查一次: g_mainLoopAlive==0 → 计数+1; ==1 → 清零
 *   - 连续 5 次未报到 (≈2.5s) → 判定死机 → 软件复位
 *
 * [为什么 5 次 = 2.5s？]
 *   WWDG 时钟 = 60MHz / 131072 ≈ 457.8Hz, 每拍 ≈ 2.1845ms
 *   SetCounter(26) → (255-26)=229 拍 → 229×2.18ms ≈ 500ms
 *   5 个周期 = 5×500ms = 2.5s
 *********************************************************************/
volatile uint8_t g_mainLoopAlive   = 0;  /* 主循环存活标志: 主循环写=1, ISR 读后清=0 */
volatile uint8_t g_watchdogCount   = 0;  /* 连续未报到计数: ISR 内累加, ≥5 触发复位  */

/*********************************************************************
 * @fn      WDOG_BAT_IRQHandler
 *
 * @brief   WWDG 看门狗溢出中断服务函数
 *
 * @说明
 *   【为什么会有这个函数？】
 *   CH582M 的 WWDG（窗口看门狗）有两条路：
 *     - RB_WDOG_RST_EN = 1 → 溢出后直接硬件复位（太猛，557ms 会误杀 BLE 连接）
 *     - RB_WDOG_INT_EN = 1 → 溢出后进入这个中断函数（先检查再决定）
 *   我们选择了后者。
 *
 *   【调用频率】约每 500ms 一次（WWDG_SetCounter(26) → 229 拍后溢出）
 *
 *   【执行时间】< 10μs（纯寄存器操作 + 可能触发一次软件复位）
 *
 *   【WWDG 不喂狗！】
 *   主循环只设置 g_mainLoopAlive=1，不再调用 WWDG_SetCounter()。
 *   WWDG 会持续溢出进入这个 ISR，ISR 末尾重新装填计数器，
 *   形成 ~500ms 周期的自律计时循环。
 *   如果主循环长期卡死，g_mainLoopAlive 保持为 0，
 *   g_watchdogCount 达到 5 后执行软件复位。
 *
 *   【等价的比喻】
 *   这就像一个老板每 30 分钟检查一次流水线：
 *     如果看得到工头在干活 → 倒一杯新茶，继续等
 *     如果看不到工头 → 记一次旷工
 *     连续 5 次旷工 → 开除（复位）
 *
 *   【启动文件兼容性】
 *   startup_CH583.S 中 WDOG_BAT_IRQHandler 为 __weak 定义（原地死循环），
 *   我们在此重写它，链接器会自动替换弱定义。
 *********************************************************************/
__INTERRUPT
__HIGH_CODE
void WDOG_BAT_IRQHandler(void)
{
    /* ── 步骤 1: 确认是 WWDG 溢出触发，不是其他共用中断源（BAT）── */
    if (WWDG_GetFlowFlag())
    {
        /* ── 步骤 2: 清除溢出标志 ──
         *   不清除的话，退出 ISR 后中断标志还在 → 立即再次触发 → 无限循环 */
        WWDG_ClearFlag();

        /* ── 步骤 3: 检查主循环是否在这个周期内报到过 ── */
        if (g_mainLoopAlive != 0)
        {
            /* 主循环活着！→ 清除标志，清零计数器，一切正常 */
            g_mainLoopAlive = 0;
            g_watchdogCount = 0;
        }
        else
        {
            /* 主循环没报到 → 可能卡死了 → 计数器 +1 */
            g_watchdogCount++;

            /* ── 步骤 4: 连续 5 次没报到 = ~2.5s → 确认死机 → 软件复位 ── */
            if (g_watchdogCount >= 5)
            {
                /* ★ 复位前安全措施：拉低所有 GPIO 控制引脚
                 *   防止复位过程中引脚电平抖动 → 车锁误动作
                 *   PA4/PA5/PA6/PA7 + PB4 是 KeyGo 的所有控制输出引脚 */
                GPIOA_ResetBits(GPIO_Pin_4 | GPIO_Pin_5 | GPIO_Pin_6 | GPIO_Pin_7);
                GPIOB_ResetBits(GPIO_Pin_4);

                /* 执行软件复位 — 芯片完全重启，等效于上电复位 */
                SYS_ResetExecute();
            }
        }

        /* ── 步骤 5: 重新装填 WWDG 计数器，启动下一个 ~500ms 周期 ──
         *   计数器 = 26 → 要跑 255-26=229 拍才溢出 → 229×2.18ms ≈ 500ms
         *   注意：调用 SetCounter 会自动清除溢出标志（硬件行为），
         *   但我们仍显式调用 ClearFlag 以保持代码清晰。                   */
        WWDG_SetCounter(26);
    }
}

/*********************************************************************
 * @fn      Main_Circulation
 *
 * @brief   主循环 — 运行 BLE 协议栈 + 应用事件 + 向软看门狗报到
 *
 * @说明
 *   【v3.16 变更】不再调用 WWDG_SetCounter() 喂狗。
 *   取而代之的是 g_mainLoopAlive = 1 — 向 WDOG_BAT_IRQHandler 举手报到。
 *   WWDG 会自行每 ~500ms 溢出进入 ISR，ISR 里检查这个标志。
 *
 *   【为什么这样改？】
 *   硬件复位模式 (WWDG_SetCounter 喂狗) 超时只有 557ms，
 *   BLE 连接事件（DataFlash 读）可能耗时 800ms → 误复位。
 *   中断模式 + 软件计数器 = 2.5s 容错，够用。
 *
 * @return  none
 */
__HIGH_CODE
__attribute__((noinline))
void Main_Circulation()
{
    while(1)
    {
        TMOS_SystemProcess();      /* BLE 协议栈事件处理 + TMOS 任务调度 */
        KeyGo_UartCmdPoll();       /* ★ 2026-07-16: 轮询 UART1 调试命令（非 DEBUG 为空实现） */
        g_mainLoopAlive = 1;       /* ← 举手报到！告诉 ISR"我还活着"    */
    }
}

/*********************************************************************
 * @fn      main
 *
 * @brief   主函数 — 系统初始化 + 软看门狗配置 + 启动主循环
 *
 * @说明
 *   【v3.16 WWDG 配置策略】
 *   1. WWDG_ResetCfg(DISABLE)  — 溢出后不硬件复位（557ms 太短，会误杀）
 *   2. WWDG_ITCfg(ENABLE)      — 溢出后触发 WDOG_BAT_IRQHandler 中断
 *   3. WWDG_SetCounter(26)     — 计数器初值 → ~500ms 后第一次溢出
 *
 *   此配置下，WWDG 变成一个"周期性中断源"，
 *   配合 g_mainLoopAlive + g_watchdogCount 实现 2.5s 软看门狗。
 *   详细原理见 docs/KeyGo_v3.16_看门狗方案分析.md
 *
 * @return  none
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
    GAPRole_PeripheralInit();
    Peripheral_Init();

    /* ★ v3.16-fix: WWDG 放到 init 完成后才启动
     *   ─────────────────────────────────────────────────────────
     *   bug: WWDG 在 main() 入口处启动后，漫长的初始化流程
     *        (CH58X_BLEInit + DataFlash SNV 读写 + GATT 服务注册
     *         + KeyGo_LoadConfig 的 EEPROM_READ) 可能耗时超过 2.5s，
     *        导致 ISR 连续读到 g_mainLoopAlive==0 → 触发复位。
     *
     *   symptom: 设备重启时 LED 闪三下（3 次复位循环），且最终
     *            PB4 因复位时序不确定，LED 可能停留在高电平亮起状态。
     *
     *   fix: 把 WWDG 启动推迟到所有初始化完成之后，确保进入主循环
     *        后 g_mainLoopAlive 能在第一个 500ms 周期内被设为 1，
     *        不会误触发复位。同时显式同步 LED 到当前锁状态。
     *   ───────────────────────────────────────────────────────── */
    WWDG_ResetCfg(DISABLE);
    WWDG_ITCfg(ENABLE);
    WWDG_SetCounter(26);

    /* LED 最终同步：确保 LED 反映实际锁状态 */
    if (g_keyState == KSTATE_UNLOCKED) {
        GPIOB_SetBits(GPIO_Pin_4);     /* 解锁 → LED 亮 (高电平) */
    } else {
        GPIOB_ResetBits(GPIO_Pin_4);   /* 锁车 → LED 灭 (低电平) */
    }

    Main_Circulation();
}

/******************************** endfile @ main ******************************/
