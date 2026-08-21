# 2026-08-08 DCDC_ENABLE=TRUE 导致「无蓝牙」调试迷案（折磨数日，终破）

> 一句话结论：**不是代码逻辑 bug，是 `DCDC_ENABLE=TRUE` 在 DCDC 外围不匹配的板子上导致内核供电不稳、BLE 射频起不来 → 烧 Slave 无蓝牙、烧 Spike（DCDC 关）有 KeyGo-HID。** 关键转折：用户烧官方例程（Spike）有蓝牙，才反推出 DCDC 是元凶。

---

## 一、现象（用户实测，极迷惑）

| 芯片/板 | 烧 `CH582M_BLE_Slave`（DCDC_ENABLE=TRUE） | 烧 `CH582M_BLE_Spike`（DCDC_ENABLE=FALSE） |
|---|---|---|
| **新芯片**（一直没调试过的那块） | ❌ **无蓝牙信号** | ✅ 有 KeyGo-HID 蓝牙 |
| **旧芯片**（一直在烧写调试的） | ✅ 有蓝牙 | — |

早期还叠加了一个干扰现象：旧芯片上电串口**完全无输出**（连 `main()` 首句 `PRINT(VER_LIB)` 都没有），让排查一度怀疑代码/烧录。

---

## 二、排查历程（走过的弯路，留作教训）

1. **第一轮怀疑：代码广播逻辑坏了**
   - 把 `main() → Peripheral_Init → KeyGo_AdvEnterFastWindow → GAPROLE_ADVERT_ENABLED=TRUE → SBP_START_DEVICE_EVT → GAPRole_PeripheralStartDevice → GAPROLE_ADVERTISING` 整条链路与 fix27(`6b202da`，确认有广播的基准) 逐行对比 → **完全一致、无逻辑错误**。
   - `CH58X_BLEInit` 内所有 `while(1)` 死循环都带 `PRINT`（"head file error"/"SNV config error"/"LIB init error"）→ 若死在那儿应能看到对应打印。

2. **第二轮怀疑：WCHISPStudio「清除」破坏 Flash**
   - 用户用 WCHISPStudio「清除」后再重烧，串口零输出。
   - 假设：code flash 没真正写进 / InfoFlash MAC(0x7F018) 被清 → `BLE_LibInit` 内部异常。
   - **被推翻**：同代码 fix27 能打印，且 Spike（同样走该启动流程）能出蓝牙 → 启动代码没问题。

3. **第三轮（决定性）：烧官方例程做 A/B 对照**
   - 用户把**官方例程 `CH582M_BLE_Spike`** 烧进新芯片 → **立刻有 KeyGo-HID 蓝牙**。
   - 对比两个工程的 `config.h`：`Spike` 是 `DCDC_ENABLE=FALSE`，`Slave` 是 `DCDC_ENABLE=TRUE`。
   - 立刻锁定：**DCDC 使能与否是唯一变量**。

4. **验证**：把 `Slave/config.h` 的 `DCDC_ENABLE` 改为 `FALSE` 重烧新芯片 → **新芯片立刻有蓝牙** ✅ 100% 坐实。

---

## 二之二、用户追问："我明明焊了 22µH 电感 + 2.2µF + 100nF 电容，为什么还不行？"

**答：因为板子是 DCDC「旁路接法」，焊的电感/电容根本没构成 DCDC 续流回路。**

用户 2026-07-30 已澄清：板子 **VSW 直接短接到 VDCID(=VDD)**，这是 WCH 官方 DCDC **旁路 / bypass 接法**，不是「VSW→电感→VDD」标准 DCDC 接法。

- 标准 DCDC 接法：VSW → 10µH 电感 → VDD（构成续流回路），`DCDC_ENABLE=TRUE`。
- 旁路接法（用户板）：VSW = VDD 直连。`DCDC_ENABLE=TRUE` 时芯片把 VSW(开关节点)当开关驱动，但 VSW 已被短接到 VDD → **续流回路缺失 → 内核供电彻底乱掉 → 无蓝牙**（甚至伤芯片）。

用户后续补焊的 22µH 电感 / 2.2µF / 100nF，因 VSW 与 VDCID 短接，实际**全部挂在 VDD 电源轨上**，并未形成「VSW→电感→VDD」回路 → 开了 DCDC 依然无效。这与文档 `2026-07-30_LED跟随脉冲与低功耗优化.md` §5/§6 的结论完全一致：**旁路接法下 DCDC_ENABLE 必须恒为 FALSE**。

> 教训：看到"焊了电感还不行"别急着调电容参数，**先确认 VSW 是悬空/电感接法还是直连 VDD 旁路**——这是决定 DCDC 能不能开的硬前提。

---

## 三、根因（为什么 DCDC 一开就没蓝牙）

`DCDC_ENABLE=TRUE` 使 `main()` 调用 `PWR_DCDCCfg(ENABLE)`，把内核供电从 LDO 切到**片内 DCDC 降压**。DCDC 是开关电源，必须满足 datasheet 外围要求才能稳定工作：

| 项 | Datasheet 要求 | 作用 | 不满足的后果 |
|---|---|---|---|
| VSW–VDCID 电感 | 建议 10µH（范围 3.3~33µH） | 储能/续流 | 电感错 → 环路不稳 |
| **VDCID / VDCIA 退耦电容** | **建议 2.2µF（0.47~4.7µF）** | DCDC 稳压环路补偿 | **缺失/错配 → 内核电压纹波大/跌落 → BLE 射频起不来** |
| VDD33/VIO33 退耦 | 启用时 ≥2.2µF/1µF，须紧靠引脚 | 输出侧滤波 | 不足 → IO 噪声/复位 |
| VSW 对地电容 | **严禁** | — | 挂电容 → DCDC 波形被压死 |

**关键认知**：DCDC 是「外围全对才工作、差一样就罢工」的电路。用户自述「焊了 22µH 电感」只满足了 4 个条件里的 1 个——**漏了 VDCID/VDCIA 退耦电容（或退耦不对/VSW 误挂电容）**，所以即使有电感，DCDC 一开内核就抖，BLE 射频直接起不来。数字逻辑/UART 可能勉强跑，所以表现为「有串口/能启动但无蓝牙」。

> 旧芯片的板子 DCDC 外围齐全（已串电感+退耦），所以旧芯片烧 Slave 正常；新芯片板 DCDC 外围不全，才暴露问题。

---

## 四、修复（二选一）

**A. 关闭 DCDC（最稳，推荐跨板通用）**
```c
// code/CH582M/CH582M_BLE_Slave/HAL/include/config.h
#ifndef DCDC_ENABLE
#define DCDC_ENABLE  FALSE   // ← 改这里；LDO 直供，任何板子都稳
#endif
```
- 代价：活跃/连接态电流升回 DCDC 前的 ~1.6× 水平（约多 40% 活跃电流），但**功能全正常、跨板无坑**。
- `config.h` 原注释（fix17 写入）已预警：*"回退：真机若出现偶发复位、BLE 灵敏度下降、串口乱码，先把本宏改回 FALSE 复测，以区分是电源纹波问题还是固件逻辑问题。旁路接法下 FALSE 亦安全（电感等效导线，仅无收益）。"*

**B. 补齐全 DCDC 外围（保留省电收益）**
- VSW 串 **10µH 电感**（22µH 偏大但合法，建议换 10µH）；
- **VDCID、VDCIA 各接 2.2µF 退耦到地**（紧靠芯片引脚，别用 ESL 大的电解）；
- 确认 **VSW 不挂任何对地电容**；
- VDD33/VIO33 退耦 ≥1µF 且紧靠。
- 补完后保持 `DCDC_ENABLE=TRUE`，既省电又稳。

---

## 五、给后来者的排查铁律（避免再绕数日）

1. **「无蓝牙」先 A/B 对照官方例程**：烧 WCH 官方 `CH582M_BLE_Spike`（或任何确认能广播的例程）到同一块板。
   - 例程有蓝牙、自己的工程没有 → 100% 是**自己工程特有的配置/硬件假设**（如 DCDC、GPIO、时钟），而非芯片/板子坏了。
   - 例程也没有 → 才是板子/供电/晶振硬件问题。
2. **串口零输出 ≠ 代码逻辑错**：先确认烧录是否真写进 code flash（WCHISPStudio 下载日志 + 「读取芯片信息」看 MAC/配置字是否正常）。UART 在 `SetSysClock` 之后才初始化，死在 `main()` 早期（DCDC/时钟）会表现为零输出，而这往往和「清除/烧录操作」或「DCDC 供电」有关，不是广播逻辑。
3. **DCDC 是头号嫌疑**：跨板/跨芯片烧写出现「能启动但 BLE 不广播 / 偶发无蓝牙」，**第一反应就查 `DCDC_ENABLE` 和外围电感+退耦电容**，比翻广播代码快十倍。
4. **`config.h` 的 DCDC 注释块就是回退说明书**，遇到电源类怪现象先读它。

---

## 六、剩余待确认（非阻塞）

- 新芯片板是否真的漏了 VDCID/VDCIA 退耦？若是，补电容后可恢复 `DCDC_ENABLE=TRUE` 拿回省电收益（需重测连接态电流与 BLE 灵敏度）。
- 旧芯片「串口零输出」那次：大概率是当时 WCHISPStudio「清除」后下载未正确写入 code flash（与本次 DCDC 无关，属另一独立小坑），已通过直接「下载」规避。
