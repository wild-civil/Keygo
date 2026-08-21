# 2026-08-08 GPIO 配置耦合分析：PA3 漏电 + DEBUG=0 误触发 10mA

> 背景：`CH582M_BLE_Slave` 工程在 V04 自焊板上，电流基线 ~400µA（仅 LDO+CH582M），加电池分压电路后 → 3.x mA；另发现"调成 DEBUG=0 后电流 400µA → 10mA，删除 DEBUG=0 又恢复"。
> 目的：代码侧排查 PA3/PA4 默认 GPIO 配置、`BOARD_HAS_EXT_BAT_ADC` 是否启用，以及 DEBUG 宏与引脚初始化的耦合 bug。**本文只分析，不改代码。**

---

## 一、V04 板 3mA 漏电：PA3 被误配成数字输入上拉

### 代码证据链

1. **`peripheral_main.c` 第 188-194 行（HAL_SLEEP 块）**：
   ```c
   #if(defined(HAL_SLEEP)) && (HAL_SLEEP == TRUE)
       GPIOA_ModeCfg(GPIO_Pin_All & ~(GPIO_Pin_10 | GPIO_Pin_11), GPIO_ModeIN_PU);
       GPIOB_ModeCfg(GPIO_Pin_All, GPIO_ModeIN_PU);
   #endif
   ```
   **`GPIO_Pin_All & ~(10|11)`** 把 PA0~PA15（**除 PA10/PA11 给外部 32K 晶振**）全部配成 `GPIO_ModeIN_PU`（数字输入上拉）。
   → **PA3（= bAIN6，V04 外部电池 ADC 输入）被配成数字输入上拉**。

2. **V04 电池分压电路**（用户电路图）：
   ```
   BAT+ → R14(100k) → [BAT_ADC_EN 闸门 PB3 控制 Q1/Q5]
                      → R27(10k) ─┬─→ PA3 (AIN6)
                                  └─→ R28(10k) → GND
   ```
   PA3 接 **R27/R28 = 20kΩ 分压支路**（4.2V 电池下恒定耗电 ≈ 210µA）。
   关键：**PA3 被配成 GPIO_ModeIN_PU（数字输入上拉）后，内部上拉电阻（约 30~50kΩ）并联在 R27/R28 网络上**，分压点被拉高；更严重的是 **PA3 数字输入缓冲器开启**，当分压点电压落在 VDD/2 附近时，CMOS 输入缓冲器持续翻转（亚阈值振荡）→ **典型 1~3mA 级漏电**。

3. **`BOARD_HAS_EXT_BAT_ADC` 默认未定义**（config.h 未 define，memory 确认"默认关"）：
   ```c
   // keygo_core.c 第 229-231 行
   #ifdef BOARD_HAS_EXT_BAT_ADC
       Battery_ADC_Init();   // 仅在宏定义时调用
   #endif
   ```
   → `Battery_ADC_Init()` 不执行 → `battery_service.c` 第 174 行 `GPIOA_ModeCfg(BAT_ADC_AIN_PIN, GPIO_ModeIN_Floating)`（正确高阻配置）**永远不会跑到**。
   → PA3 一直保持第 192 行的 `GPIO_ModeIN_PU` → 持续漏电。

### 结论

**V04 板 3mA 暴涨 = PA3 数字输入上拉 + 20kΩ 分压网络 → CMOS 输入缓冲器亚阈值振荡漏电。** 这是硬件电路与 GPIO 默认配置不匹配导致的，不是电路本身"错"，而是**固件没把 PA3 配成正确的模拟高阻态**。

> 注：400µA 基线也部分来自此（PA3 上拉漏电 + 板级其他），但 PA3 漏电是加电路后暴涨到 3mA 的主因。

### 修复方向（待定，未改代码）

- **方案 A（最小改动）**：在 `BOARD_HAS_EXT_BAT_ADC` 未定义时，也要把 PA3 配成 `GPIO_ModeIN_Floating`（避免数字输入上拉漏电）。即在 main 的 HAL_SLEEP 块之后，补一行：
  ```c
  #ifndef BOARD_HAS_EXT_BAT_ADC
      GPIOA_ModeCfg(bAIN6, GPIO_ModeIN_Floating);  // PA3 悬空高阻，避免分压网络漏电
  #endif
  ```
- **方案 B（推荐）**：既然 V04 板有外部电池 ADC 电路，直接 `#define BOARD_HAS_EXT_BAT_ADC` 启用 `Battery_ADC_Init()`，让它正确把 PA3 配成高阻 + 闸门默认关断。但需确认 `BAT_ADC_EN_PIN`/`BAT_ADC_AIN_PIN` 宏已正确定义为 PB3/PA3。
- **方案 C（电路侧）**：R27/R28 分压网络在闸门关断时本应无电流（Q1/Q5 断开），但 PA3 数字输入上拉把分压点拉活 → 改固件引脚配置（A/B）是根本解法。

---

## 二、DEBUG=0 反而 10mA：#ifdef 误用 + 引脚初始化耦合

### 代码证据链

1. **`config.h` 第 20 行**：
   ```c
   // #define DEBUG                         Debug_UART1   // ★ 临时诊断用，生产关闭
   ```
   **DEBUG 默认未定义（注释掉）** → 正常量产态 → `#ifdef DEBUG` 不执行 → PA9 保持 main 第 192 行配的 `GPIO_ModeIN_PU`（低功耗确定态）→ 400µA 正常。

2. **用户"调成 DEBUG=0"**：
   - 把第 20 行改成 `#define DEBUG 0`（或 `#define DEBUG`）。
   - **`#ifdef DEBUG` 只看"是否定义"，不看值** → `#define DEBUG 0` 仍为"已定义" → `#ifdef DEBUG` 为 TRUE → 执行 UART 初始化块：
     ```c
     #ifdef DEBUG
         GPIOA_SetBits(bTXD1);                          // PA9 输出高
         GPIOA_ModeCfg(bTXD1, GPIO_ModeOut_PP_5mA);     // PA9 → UART TX 推挽输出
         UART1_DefInit();                               // UART1 寄存器初始化
     #endif
     ```
   - PA9 从"输入上拉（低功耗）"变成"UART TX 输出推挽 5mA 驱动"。
   - `UART1_DefInit()`（CH58x_uart1.c 第 24-31 行）只配 UART1 寄存器（波特率、FIFO、IER=TX_EN），**不配 PA9 引脚复用**——PA9 的 GPIO 模式完全靠上面那行 `GPIO_ModeCfg(bTXD1, GPIO_ModeOut_PP_5mA)`。
   - **PA9（UART1 TX）在用户板子上若外部有上拉/负载**（如接 CH340 RXD 上拉 4.7k 到 3.3V、或调试器、或 PCB 走线残留），PA9 输出态与外部电路形成灌电流路径 → **10mA 级电流**。

3. **用户删除 DEBUG=0 后恢复**：
   - DEBUG 回到未定义 → `#ifdef DEBUG` 不执行 → PA9 回到 `GPIO_ModeIN_PU`（低功耗）→ 400µA 正常。
   - **这恰好证明：10mA 是 DEBUG 定义后 PA9 变 UART 驱动态触发的，不是 DEBUG 关闭导致浮空**。

### 结论

**`#ifdef DEBUG` 把"调试日志开关"和"PA9/UART 物理引脚初始化"错误耦合**。DEBUG 关闭时（未定义），PA9 依赖 main 第 192 行的 `GPIO_ModeIN_PU` 保持低功耗；DEBUG 一旦定义（哪怕 =0），PA9 被强制变成 UART 驱动态，与板子外部电路冲突 → 10mA。

**这是真 bug，不是用户操作问题**：`#define DEBUG 0` 本应表示"关闭调试"，但 `#ifdef` 会误判为"已启用"。

### 修复方向（待定，未改代码）

- **修复 1（关键）**：`#ifdef DEBUG` 改为值判断，确保 `#define DEBUG 0` 不触发 UART：
  ```c
  #if defined(DEBUG) && (DEBUG != 0)
      GPIOA_SetBits(bTXD1);
      GPIOA_ModeCfg(bTXD1, GPIO_ModeOut_PP_5mA);
      UART1_DefInit();
  #else
      // DEBUG 关闭：PA9 显式保持低功耗确定态（输入上拉或浮空），不初始化 UART
      GPIOA_ModeCfg(bTXD1, GPIO_ModeIN_PU);
  #endif
  ```
- **修复 2（解耦）**：UART/PA9 的引脚初始化不应依赖 DEBUG。若量产仍需 UART 命令（`KeyGo_UartCmdPoll`），应独立宏控制；DEBUG 只控制 PRINT 是否输出。

---

## 三、给用户的即时结论（不改代码）

1. **V04 板 3mA 漏电**：根因是 PA3 被 `GPIO_Pin_All` 的 HAL_SLEEP 初始化误配成数字输入上拉，与 20kΩ 分压网络冲突。临时规避：把 `BOARD_HAS_EXT_BAT_ADC` 定义上（让 `Battery_ADC_Init` 把 PA3 配成高阻），或代码侧补 PA3 高阻配置。

2. **DEBUG=0 反而 10mA**：**这是代码 bug（`#ifdef` 误用）**，不是你的操作问题。正确量产态是 **DEBUG 保持未定义（注释掉，即当前 400µA 状态）**，不要"调成 DEBUG=0"。`#define DEBUG 0` 会误触发 UART 初始化 → PA9 变驱动态 → 10mA。
   - **所以：当前 400µA（DEBUG 未定义）才是正确量产基线，不要改成 DEBUG=0**。

3. **两个 bug 都指向同一个设计缺陷**：main 里 `GPIO_Pin_All` 的"一刀切"GPIO 初始化 + `#ifdef DEBUG` 引脚耦合，没考虑 V04 外部 ADC 引脚（PA3）和 UART 引脚（PA9）的特殊性。

---

## 四、待办（需用户决策后再动代码）

- [ ] 确认 `BOARD_HAS_EXT_BAT_ADC` 是否启用 → 决定 PA3 修复走方案 A 还是 B
- [ ] 修复 `#ifdef DEBUG` → 值判断（避免 `#define DEBUG 0` 误触发 UART）
- [ ] 验证修复后：V04 板电流应回落到 ~400µA 基线（PA3 高阻）+ 量产 DEBUG 关闭态稳定
- [ ] 重新确认 400µA 基线中是否还有板级漏电（参考 XC6206/LDO 功耗专题）
