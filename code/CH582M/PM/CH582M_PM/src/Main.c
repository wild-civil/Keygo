/********************************** (C) COPYRIGHT *******************************
 * File Name          : Main_uart_diag.c
 * Author             : KeyGo PM Test V26 — 串口诊断版(观察睡没睡)
 * Version            : V26.0
 * Date               : 2026/08/02
 * Description        : 当 V25(Shutdown)电流仍 mA 级,用本版在【淘宝开发板】上接串口
 *   观察芯片到底睡没睡。核心思路:
 *     - 进睡前 UART1 打印 "ENTER SLEEP\r\n"
 *     - 唤醒后(从 LowPower_Sleep 返回)打印 "WAKEUP\r\n"
 *   判读:
 *     - 不碰 PB22 → 应只看到一次 ENTER SLEEP,之后静默(真睡了) ✓
 *     - 静默中反复出现 WAKEUP → 芯片在自唤醒,没真睡(时钟/中断问题) ✗
 *     - 一直滚 ENTER/WAKEUP → 睡眠被打断极频繁 ✗
 *   注意:本版用 Sleep(唤醒后继续跑),不用 Shutdown(复位重跑),便于连续观测。
 *   用法:把本文件改名为 Main.c 覆盖,或改工程源文件指向;UART1 接开发板 TX 看日志。
 *   波特率与主循环初始化见 InitUART()。
 *******************************************************************************/

#include "CH58x_common.h"
#include "HAL.h"
#include "RTC.h"

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

static void InitUART(void)
{
    /* 淘宝开发板板载 CH340 接 UART1: TX=PA9(bTXD1), RX=PA8(bRXD1)
       (参考 CH582M_BLE_Slave_proto-final_260728 的 #ifdef DEBUG 写法) */
    GPIOA_SetBits(GPIO_Pin_9);
    GPIOA_ModeCfg(GPIO_Pin_9, GPIO_ModeOut_PP_5mA);   /* PA9 = TX 推挽输出 */
    GPIOA_ModeCfg(GPIO_Pin_8, GPIO_ModeIN_PU);        /* PA8 = RX 上拉输入 */
    UART1_DefInit();
}

/* 逐字节发送字符串(库 UART1_SendString 需显式传长度,这里封装免依赖 strlen) */
static void uart_puts(const char *s)
{
    while (*s) {
        UART1_SendByte((uint8_t)(*s));
        s++;
    }
}

/* 打印无符号十进制(用于输出 GetSysClock 等诊断值) */
static void uart_putdec(uint32_t v)
{
    char buf[12];
    int i = 0;
    if (v == 0) {
        UART1_SendByte('0');
        return;
    }
    while (v && i < 11) {
        buf[i++] = (char)('0' + (v % 10));
        v /= 10;
    }
    while (i > 0) {
        UART1_SendByte((uint8_t)buf[--i]);
    }
}

int main(void)
{
    /* 照参考工程 peripheral_main.c:先开 DCDC,再设 PLL_60MHz。
       (DCDC 未开时 PLL 可能不稳,实测物理只跑 32M → UART 波特率错乱码) */
    PWR_DCDCCfg(ENABLE);
    SetSysClock(CLK_SOURCE_PLL_60MHz);
    Init32K_Clock();

    /* 全部 GPIO 上拉 */
    GPIOA_ModeCfg(GPIO_Pin_All, GPIO_ModeIN_PU);
    GPIOB_ModeCfg(GPIO_Pin_All, GPIO_ModeIN_PU);

    /* 关外设睡眠时钟 */
    R8_SLP_CLK_OFF0 = RB_SLP_CLK_TMR0 | RB_SLP_CLK_TMR1 | RB_SLP_CLK_TMR2 |
                      RB_SLP_CLK_TMR3 | RB_SLP_CLK_UART0 | RB_SLP_CLK_UART1 |
                      RB_SLP_CLK_UART2 | RB_SLP_CLK_UART3;
    R8_SLP_CLK_OFF1 = RB_SLP_CLK_SPI0 | RB_SLP_CLK_SPI1 | RB_SLP_CLK_PWMX |
                      RB_SLP_CLK_I2C  | RB_SLP_CLK_USB   | RB_SLP_CLK_USB2 |
                      RB_SLP_CLK_BLE;

    /* PB0 锁 HIGH 关 KeyPower(开发板无妨) */
    GPIOB_ModeCfg(GPIO_Pin_0, GPIO_ModeOut_PP_5mA);
    GPIOB_SetBits(GPIO_Pin_0);

    /* 初始化串口(用于观测) */
    InitUART();

    /* 用 RTC 周期唤醒(参考工程 CH58X_LowPower 的写法)。
       Sleep 模式下 GPIO 中断不一定能唤醒,只有 RTC/特定唤醒脚可靠;
       为稳妥这里直接用 RTC 定时唤醒,每轮睡约 2 秒自动醒,不需手动操作。 */
    HAL_SleepInit();

    /* 版本确认:蓝灯闪 6 次 */
    GPIOB_ModeCfg(GPIO_Pin_14, GPIO_ModeOut_PP_5mA);
    for (int i = 0; i < 6; i++) {
        GPIOB_SetBits(GPIO_Pin_14);
        DelayMs(100);
        GPIOB_ResetBits(GPIO_Pin_14);
        DelayMs(100);
    }

    uart_puts("PM DIAG START clk=");
    uart_putdec(GetSysClock());
    uart_puts("\r\n");

    /* 睡眠诊断(_RTC 唤醒版_):
       每轮:打印 HELLO -> ENTER SLEEP -> 设 RTC 2 秒后触发 -> LowPower_Sleep
             -> (静默,电流掉) -> RTC 到点唤醒 -> WAKEUP -> 重设时钟 -> 下一轮
       判读:
         - 看到 HELLO -> ENTER SLEEP -> (静默约2s) -> WAKEUP -> HELLO ... 循环
           且静默期间电流掉到 ~µA 级 = 真睡了 ✓
         - 一直 HELLO 从不见 ENTER SLEEP -> Sleep 没真正生效(检查 HAL_SLEEP) ✗
         - ENTER 后立刻 WAKEUP(无静默) -> RTC 没真正让芯片睡(睡眠时间被门槛拦掉) ✗
       注意:LowPower_Sleep 会切到 HSI/5 并强制关 DCDC,唤醒后必须重设系统时钟,
       否则 UART 波特率因时钟变慢而乱码。 */
    uint32_t cnt = 0;
    while (1) {
        uart_puts("HELLO ");
        uart_putdec(cnt);
        uart_puts("\r\n");
        cnt++;
        DelayMs(300);

        uart_puts("ENTER SLEEP\r\n");
        /* 进睡前把全部 GPIO 改成浮空输入(高阻),
           彻底断开 LED/外设驱动,隔离"GPIO 驱动耗电" vs "内核耗电"。
           Sleep 保留 GPIO 状态,若不主动释放,输出脚会一直驱动 LED → 持续 mA 级。 */
        GPIOA_ModeCfg(GPIO_Pin_All, GPIO_ModeIN_Floating);
        GPIOB_ModeCfg(GPIO_Pin_All, GPIO_ModeIN_Floating);

        /* 设 RTC 在约 2 秒(32K 计数 65536)后触发唤醒 */
        RTC_SetTignTime(RTC_GetCycle32k() + 65536);
        LowPower_Sleep(RB_PWR_RAM2K | RB_PWR_RAM30K | RB_PWR_EXTEND);
        uart_puts("WAKEUP\r\n");
        /* 唤醒后重建 60M 时钟 + DCDC( Sleep 强制关了),否则串口乱码 */
        PWR_DCDCCfg(ENABLE);
        SetSysClock(CLK_SOURCE_PLL_60MHz);
        /* 唤醒后重建串口(PA9/PA8)与 PB0,下一轮 HELLO 才能打印 */
        InitUART();
        GPIOB_ModeCfg(GPIO_Pin_0, GPIO_ModeOut_PP_5mA);
        GPIOB_SetBits(GPIO_Pin_0);
    }
}

