# KeyGo Battery Service 实施方案

> 状态：规划中 | 日期：2026-07-03

---

## 1. 概述

BLE Battery Service (BAS) 是蓝牙 SIG 定义的标准服务，用于让中心设备（手机）读取外设的电池电量。实现后，手机系统蓝牙设置中可以显示 KeyGo 设备的电量百分比。

**核心参数：**

| 项目 | 值 |
|------|-----|
| Service UUID | `0x180F` |
| Battery Level Characteristic UUID | `0x2A19` |
| 属性 | Read + Notify |
| 数据格式 | 1 字节 uint8，0~100 表示百分比 |
| 标准名称 | "Battery Service" (BAS v1.0) |

---

## 2. 硬件前提

CH582M 需要能读取电池电压。**CH582M 内置 ADC**，可以直接采样：

```
18650 电池 (3.0V ~ 4.2V)
      │
      ▼ (通过电阻分压，例如 1:1 或 2:1)
ADC 输入引脚 (如 PA1)
      │
      ▼
CH582M 内置 12-bit ADC
      │
      ▼
电池电压 → 百分比换算 → 写入 Battery Level (0x2A19)
```

### 分压电路

```
电池+ ── R1=100kΩ ──┬── R2=100kΩ ── GND
                     │
                     └── ADC输入 (PA1)
                     
满电 4.2V × (100/(100+100)) = 2.1V → ADC 在安全范围
亏电 3.0V × (100/(100+100)) = 1.5V
```

CH582M ADC 参考电压为内部 1.05V 或 VDD，需要根据实际电路选择。如果使用 VDD=3.3V 作为参考，分压后 2.1V 对应 ADC 读数约 2.1/3.3 × 4096 = 2608。

---

## 3. 代码实现步骤

### Step 1: 在 gattprofile.c 中注册 Battery Service

在 `gattAttribute_t` 属性表中新增加一节：

```c
// ═══ Battery Service (0x180F) ═══

// Battery Service Declaration
{
    { ATT_BT_UUID_SIZE, primaryServiceUUID },
    GATT_PERMIT_READ,
    0,
    (uint8_t *)&battServiceUUID    // 0x180F
},

// Battery Level Characteristic Declaration
{
    { ATT_BT_UUID_SIZE, characterUUID },
    GATT_PERMIT_READ,
    0,
    &battLevelCharProps            // Read | Notify
},

// Battery Level Value
{
    { ATT_BT_UUID_SIZE, battLevelUUID },
    GATT_PERMIT_READ,
    0,
    &batteryLevel                  // uint8_t, 当前电量
},

// Battery Level CCCD (Client Characteristic Configuration)
{
    { ATT_BT_UUID_SIZE, clientCharCfgUUID },
    GATT_PERMIT_READ | GATT_PERMIT_WRITE,
    0,
    (uint8_t *)&battLevelClientCharCfg
},
```

需要定义的变量：

```c
// UUID
static const uint8_t battServiceUUID[ATT_BT_UUID_SIZE] = 
    { LO_UINT16(0x180F), HI_UINT16(0x180F) };
static const uint8_t battLevelUUID[ATT_BT_UUID_SIZE]   = 
    { LO_UINT16(0x2A19), HI_UINT16(0x2A19) };

// Characteristic Properties: Read | Notify
static uint8_t battLevelCharProps = GATT_PROP_READ | GATT_PROP_NOTIFY;

// 当前电量值 (0~100)
static uint8_t batteryLevel = 100;

// CCCD
static gattCharCfg_t battLevelClientCharCfg[1] = { {0, 0} };
```

### Step 2: 添加读写回调

在 `gattprofile.c` 的 GATT 写回调中增加对 Battery Level 的处理：

```c
// 当手机启用 Notify 时，写入 CCCD
if (pValue 指向 Battery Level CCCD) {
    // 启用 Notify → 立即发送一次当前电量
    if (value == GATT_CLIENT_CFG_NOTIFY) {
        attHandleValueNoti(battLevelHandle, &batteryLevel, 1);
    }
}
```

读回调中返回 `batteryLevel`：

```c
if (paramID == BATTERY_LEVEL_CHAR) {
    *pValue = &batteryLevel;
    *pLen   = 1;
}
```

### Step 3: ADC 采样 + 百分比换算

在 `keygo_core.c` 或新建 `battery.c` 中：

```c
#include "CH58x_adc.h"

#define BATTERY_ADC_CHANNEL    ADC_Channel_0  // PA1
#define ADC_VREF               3300           // mV (VDD=3.3V)
#define ADC_RES                4096           // 12-bit
#define VOLTAGE_DIVIDER_RATIO  2              // 分压比 (R1+R2)/R2

static void Battery_UpdateLevel(void)
{
    uint16_t adcVal;
    uint16_t voltage_mV;
    uint8_t  level;

    // 1. 读 ADC
    ADC_ChannelCfg(0);                          // 选择通道
    adcVal = ADC_ExcutSingleConver();           // 单次转换

    // 2. 换算电压
    voltage_mV = (uint32_t)adcVal * ADC_VREF * VOLTAGE_DIVIDER_RATIO / ADC_RES;

    // 3. 电压 → 百分比
    //    锂电池放电曲线近似线性:
    //    4.2V → 100%, 3.0V → 0%
    if (voltage_mV >= 4200) level = 100;
    else if (voltage_mV <= 3000) level = 0;
    else level = (uint8_t)((voltage_mV - 3000) * 100 / 1200);

    // 4. 仅在变化时更新 + Notify
    if (level != batteryLevel) {
        batteryLevel = level;
        // 如果 CCCD 已启用，发送 Notify
        BattLevel_Notify();
    }
}
```

### Step 4: 周期性调度

在 TMOS 事件循环中加入电池检查：

```c
// 每 60 秒检查一次电池（不需要太频繁）
#define BATTERY_CHECK_PERIOD  60000  // ms

// 在 Peripheral_ProcessEvent 中增加:
if (events & SBP_BATTERY_CHECK_EVT) {
    Battery_UpdateLevel();
    tmos_start_task(Peripheral_TaskID, SBP_BATTERY_CHECK_EVT, 
                    BATTERY_CHECK_PERIOD / TMOS_TICK_MS);
    return (events ^ SBP_BATTERY_CHECK_EVT);
}
```

---

## 4. 手机上会怎么显示？

### Android

系统蓝牙设置 → 已连接设备详情 → **显示电量百分比**

```
┌─────────────────────────────┐
│  KeyGo-A3F29C               │
│  📱 已连接                   │
│  🔋 87%                     │  ← Battery Service 提供
└─────────────────────────────┘
```

### iOS

设置 → 蓝牙 → 设备列表 → 设备名下方显示电量

### KeyGo App

可以直接在 App 连接页加一个电量条，通过读取设备信息服务的标准方式。

---

## 5. 与你现有的 DevInfo Service 的对比

你已经有了 Device Information Service (0x180A)，这是一个**信息类服务**（只读，不变化）。Battery Service 是**状态类服务**（可读 + 可通知变化）。

| | DevInfo Service (0x180A) | Battery Service (0x180F) |
|---|---|---|
| 用途 | 告诉手机"我是谁" | 告诉手机"我剩多少电" |
| 数据 | 静态（固件版本等） | 动态（随时间变化） |
| Notify | 不需要 | ✅ 需要（电量变化时推送） |
| 手机显示 | 通常不显示 | ✅ 蓝牙设置页直接显示 |

---

## 6. 注意事项

1. **ADC 通道冲突**：确认 PA1 没有被其他功能占用
2. **功耗**：ADC 采样本身功耗极低，60s 采样一次几乎不影响续航
3. **锂电池非线性**：简单线性换算精度 ±5%，但够用。追求精度可以查表（4.1V→90%, 3.8V→50%, 3.6V→10%）
4. **太阳能充电中的电压虚高**：充电时电池端电压偏高，可以检测 TP4056 的 CHG/STDBY 脚来判断是否在充电
5. **CH582M GPIO 引脚分配**：当前 PA4~PA7 已用，需要确认 PA1 可用（config.h 中检查）

---

## 7. 额外优化：广播电量

BAS v1.1 支持通过广播包直接发电池状态（`Battery Level Status`），这样手机甚至不需要连接就能看到电量。但需要增加 `Service Data` AD Structure，会对本就不宽松的 31 字节广播包造成压力。**第一版建议只做 GATT Notify 方案**。
