# KeyGo v3.14 — 18650 电池电压检测方案

> 版本: v3.14  
> 日期: 2026-07-03  
> 状态: 方案设计（代码未实施）  
> 前置条件: 需画 PCB 时一并实施，当前 CH582M 开发板验证阶段仅通过内部 VBAT 通道监测芯片 VDD

---

## 一、问题背景

### 当前现状（v3.14）

- `Battery_UpdateLevel()` 使用 CH582M **内部 VBAT 通道**（CH_INTE_VBAT, 通道 14）
- 该通道内置 `VDD / 3` 固定分压 → 测到的是**芯片自身供电电压**，不是电池真实电压
- 开发板 USB 供电时，VDD 固定为 3.3V / 5V → 电量读数没有意义（永远是固定值）

### 目标

- 使用 **外部 ADC 通道 + 电阻分压电路** 测量 18650 锂电池真实电压
- 输出电压范围: 3.0V ~ 4.2V（18650 典型工作范围）
- 在广播包（Service Data / Manufacturer Specific）中实时上报电量

---

## 二、硬件设计

### 2.1 电阻分压电路

```
18650 BAT(+) ──┬── R1 (330kΩ) ──┬── ADC_PIN (PA1 / ADC通道1)
               │                 │
               │                 ├── C1 (0.1µF) ── GND  （可选：去耦滤波电容）
               │                 │
               └── R2 (100kΩ) ──┘
               
18650 BAT(-) ── GND
```

### 2.2 参数计算

**分压比：**

```
V_ADC = V_BAT × R2 / (R1 + R2) = V_BAT × 100 / (330 + 100) = V_BAT × 0.2326
```

**ADC 输入电压范围（0dB PGA，内部基准 1.05V）：**

| 电池电压 | 分压后 (ADC 引脚) | ADC 读数 | ADC 利用率 |
|---------|------------------|---------|-----------|
| 4.20V (满电) | 0.977V | ~3810 | 93% |
| 3.60V (标称) | 0.837V | ~3265 | 80% |
| 3.00V (截止) | 0.698V | ~2720 | 66% |

**有效量程利用率：** 3810 - 2720 = 1090 个 LSB，覆盖 1200mV 电池跨度  
**分辨率：** 1200mV / 1090 ≈ 1.1mV/LSB → 足够精确

**分压电路功耗：**

```
I_divider = V_BAT / (R1 + R2) = 4.2V / 430kΩ = 9.77µA
P_divider = 4.2V × 9.77µA = 41µW
```

对于 18650（容量通常 2000~3500mAh），9.77µA 持续消耗可忽略（自放电率通常远大于此）。

### 2.3 为何选 330k + 100k

| 方案 | R1 | R2 | 4.2V→ADC | 功耗(µA) | 评价 |
|------|----|----|---------|----------|------|
| A | 300k | 100k | 1.05V (极限) | 10.5 | ❌ 0% 余量，超一点点就饱和 |
| **B** | **330k** | **100k** | **0.977V** | **9.77** | ✅ **推荐：7% 安全余量，功耗更低** |
| C | 100k | 100k | 2.10V | 21 | ❌ ADC 引脚超 1.05V → 可能损坏 GPIO |
| D | 1M | 100k | 0.382V | 3.82 | ⚠️ 分辨率太低，高阻抗易受噪声干扰 |

---

## 三、引脚选择

### 当前 GPIO 占用情况（CH582M）

| 引脚 | 功能 | 方向 |
|------|------|------|
| PA4 | UNLOCK (解锁) | 输出 |
| PA5 | LOCK (上锁) | 输出 |
| PA6 | TRUNK (后备箱) | 输出 |
| PA7 | KEY_POWER (钥匙电源) | 输出 |
| PB15 | LED | 输出 |
| PB22 | KEY1 (BIND 按键) | 输入 |

### 推荐 ADC 引脚：**PA1 / ADC 通道 1**

- PA4/PA5 已被 KeyGo 输出占用，不可复用
- PA0 常被 UART1_TX 占用（调试串口），避免冲突
- **PA1** 通常空闲，且 ADC 通道 1（CH_EXTIN_1）可直接使用
- 备选方案: **PA2**（ADC 通道 2）、**PB10**（ADC 通道 8，如果 CH582M 封装支持）

> ⚠️ 注意：选择引脚前确认其是否被其他外设（UART、SPI、调试口）占用。画 PCB 时预留测试点。

---

## 四、电压计算公式

```
V_ADC(mV)  = (adcVal / 4096) × 1050          — ADC 引脚电压 (0dB PGA, 内部基准 1.05V)
V_BAT(mV)  = V_ADC(mV) × (R1 + R2) / R2     — 乘以分压比例还原真实电池电压
           = adcVal × 1050 / 4096 × 430 / 100
           = adcVal × 4515 / 4096
           ≈ adcVal × 1.102
```

**简化整数公式（推荐在代码中使用）：**

```c
vdd_mV = (uint32_t)adcVal * 4515 / 4096;
```

**百分比映射（3.0V → 0%, 4.2V → 100%）：**

```c
if (vdd_mV >= 4200)      level = 100;
else if (vdd_mV <= 3000) level = 0;
else                     level = (vdd_mV - 3000) * 100 / 1200;
```

### 校准建议

不同芯片 bandgap 基准有一定偏差（1.05V 典型值，实际可能 ±5%），建议：

1. 用万用表实测电池电压，记为 `V_real`
2. 读取 ADC 值，记为 `adcVal_real`
3. 计算校准系数: `CAL_K = V_real(mV) × 4096 / adcVal_real`
4. 代码中使用: `vdd_mV = (uint32_t)adcVal * CAL_K / 4096;`

---

## 五、软件改动清单

### 5.1 `battery_service.c` — 核心改动

**改动点 1：新增分压宏定义**

```c
// ★ v3.14: 18650 电池分压电路参数
//   ADC 基准 = 1.05V (内部 bandgap)
//   分压比 = R2/(R1+R2) = 100k/430k = 0.2326
//   公式: V_BAT(mV) = adcVal * 1050 * (R1+R2)/R2 / 4096
//                   = adcVal * 1050 * 430 / 100 / 4096
//                   = adcVal * 4515 / 4096
#define BAT_ADC_CHANNEL     CH_EXTIN_1  // PA1 → ADC 通道 1
#define BAT_ADC_PGA         ADC_PGA_0   // 0dB (外部已分压到 < 1.05V)
#define BAT_DIVIDER_K       4515        // 1050 * 430 / 100 = 4515
```

**改动点 2：修改 `Battery_UpdateLevel()` 的 ADC 读取逻辑**

```c
void Battery_UpdateLevel(void)
{
    uint16_t adcVal;
    uint16_t vdd_mV;
    uint8_t  newLevel;

    // 保存原有 ADC 配置
    uint8_t savedChannel = R8_ADC_CHANNEL;
    uint8_t savedCfg     = R8_ADC_CFG;

    // 配置外部 ADC 通道 (PA1, 0dB PGA)
    R8_ADC_CFG    = RB_ADC_POWER_ON | RB_ADC_BUF_EN | (BAT_ADC_PGA << 4) | (3 << 6);
    R8_ADC_CHANNEL = BAT_ADC_CHANNEL;

    // 执行转换
    R8_ADC_CONVERT = RB_ADC_START;
    while (R8_ADC_CONVERT & RB_ADC_START);
    adcVal = R16_ADC_DATA;

    // 恢复
    R8_ADC_CHANNEL = savedChannel;
    R8_ADC_CFG     = savedCfg;

    // 电压计算（含分压补偿）
    vdd_mV = (uint32_t)adcVal * BAT_DIVIDER_K / 4096;

    // 电压 → 百分比
    if (vdd_mV >= 4200)      newLevel = 100;
    else if (vdd_mV <= 3000) newLevel = 0;
    else                     newLevel = (uint8_t)((uint32_t)(vdd_mV - 3000) * 100 / 1200);

    if (newLevel != batteryLevel) {
        batteryLevel = newLevel;
        PRINT("[BATT] Level updated: %d%%  (VBAT=%d mV, ADC=%d)\n",
              batteryLevel, vdd_mV, adcVal);
        Battery_Notify();
    }
}
```

**改动点 3：配置 ADC 引脚的模拟输入模式**

在 `Battery_UpdateLevel()` 或 `Peripheral_Init()` 中，ADC 读取前确保 PA1 配置为模拟输入：

```c
// 关闭 PA1 的数字输入 (避免漏电，模拟模式下未连接的逻辑门会振荡)
R16_PIN_ANALOG_IE |= RB_PIN_ADC1_IE;
```

> ⚠️ CH582M 的 ADC 引脚默认是数字输入模式，需要写 `R16_PIN_ANALOG_IE` 寄存器关闭数字输入缓冲，防止高频开关噪声干扰 ADC 读数。

### 5.2 `peripheral.c` — 广播包无需改动

当前 `Peripheral_BuildAdvertData()` 已使用 `Battery_GetLevel()` 获取电量，两者通过 `batteryLevel` 全局变量解耦，无需改动。

### 5.3 `HAL/include/config.h` — 新增引脚宏

```c
// ★ v3.14: 18650 电池电压检测
#define PIN_BAT_ADC_GPIO        GPIO_Pin_1   // PA1 → ADC
#define PIN_BAT_ADC_PORT        GPIOA
#define PIN_BAT_ADC_CHANNEL     1            // ADC 通道 1 (CH_EXTIN_1)
```

---

## 六、PCB 布局注意事项

### 6.1 关键规则

1. **分压电阻靠近 ADC 引脚放置** — 缩短走线减少电磁干扰
2. **C1 去耦电容** (0.1µF) 紧贴 ADC 引脚放置 — 形成 RC 低通滤波器 (fc = 1/(2π×Rth×C) ≈ 4.8Hz)，抑制高频噪声
3. **模拟地 (AGND) 与数字地 (DGND) 单点连接** — 避免数字噪声耦合到 ADC 输入
4. **ADC 走线远离开关电源、RF 天线** — BLE 射频发射时功率放大器可能干扰 ADC
5. **如果需要超低功耗**，可在分压电路上端加 P-MOSFET 开关，ADC 测量前导通，测量后断开

### 6.2 低功耗优化电路（可选）

```
18650 BAT(+) ── P-MOSFET(S) ──┬── R1 ──┬── ADC_PIN
                             │         │
                  GPIO(BAT_EN)─ G       ├── R2 ── GND
                                        │
                                        └── C1 ── GND
```

- 通过 GPIO 控制 P-MOSFET 栅极
- 测量时拉低 GPIO 导通 → ADC 读取
- 读取完成后拉高 GPIO 关闭 → 分压电路完全断电，零功耗

> 对于深度睡眠场景（HAL_SLEEP 打开后），强烈建议加入此电路。18650 容量虽大，
> 但 10µA 持续漏电在极端休眠场景下可能成为主要消耗源。

### 6.3 分压电阻精度

- 推荐使用 **±1%** 精度电阻（比 ±5% 的碳膜电阻好很多）
- R1 和 R2 应从**同批次**选取，保证温度系数一致 → 分压比不随温度漂移
- 如果有条件，使用 **金属膜贴片电阻** (0805 封装即可)

---

## 七、验证步骤

### 7.1 硬件验证（焊接 PCB 后）

1. 不接电池，用可调电源输出 3.0V / 3.6V / 4.2V 分别接到 BAT+ 和 BAT-
2. 串口读取 `PRINT("[BATT] ...")` 日志，记录 `vdd_mV` 值
3. 对比万用表实测值和程序读值，计算偏差
4. 如果偏差 > ±50mV，调整 `BAT_DIVIDER_K` 校准系数

### 7.2 实测校准样本表

| 输入电压 (万用表) | 预期 ADC | 实际 ADC | 程序读数 | 偏差 |
|------------------|---------|---------|---------|------|
| 3.00V | 2727 | _____ | _____ | _____ |
| 3.60V | 3275 | _____ | _____ | _____ |
| 4.20V | 3822 | _____ | _____ | _____ |

校准系数: `K_new = V_actual(mV) × 4096 / adcVal_actual`

### 7.3 锂电池放电特性注意

18650 放电曲线不是线性的：
- 4.2V ~ 3.8V: 下降快（前 20% 容量）
- 3.8V ~ 3.5V: 平缓期（中间 60% 容量）
- 3.5V ~ 3.0V: 快速下降（最后 20% 容量）

**当前代码使用线性映射（3.0→0%, 4.2→100%），会导致电量显示不准。**  
后续改进方案：
- 实现**查表法**：预存 18650 放电曲线 LUT
- 或使用**库仑计**（如 DS2780、MAX17048）通过 I2C 读取更精确的电量

---

## 八、完整物料清单 (BOM)

| 位号 | 参数 | 封装 | 数量 | 备注 |
|------|------|------|------|------|
| R1 | 330kΩ ±1% 金属膜 | 0805 | 1 | 分压上电阻 |
| R2 | 100kΩ ±1% 金属膜 | 0805 | 1 | 分压下电阻 |
| C1 | 0.1µF / 50V MLCC | 0805 | 1 | 去耦电容 (可选) |
| Q1 | P-MOSFET (AO3401 或类似) | SOT-23 | 1 | 低功耗开关 (可选) |
| BAT | 18650 电池座 | 直插 | 1 | 含保护板的弹簧触点座 |

> 总成本约 ¥0.5~2（不含电池座）

---

## 九、总结

| 项目 | 当前 (v3.14 dev) | 目标 (v3.14 PCB) |
|------|-----------------|------------------|
| ADC 通道 | 内部 VBAT (通道14) | 外部 PA1 (通道1) |
| 测什么 | 芯片 VDD 供电 | 18650 真实电压 |
| 分压 | 内置 1/3 | 330k+100k 外部分压 |
| 读数变化 | 永远是固定值 | 随电池放电递减 |
| 功耗 | 无额外 | +9.77µA (分压器) |

有了外部 ADC + 分压电路后，`batteryLevel` 就能真实反映 18650 的剩余电量，APP 端在广播包和 GATT 连接中都能看到准确的电池百分比。
