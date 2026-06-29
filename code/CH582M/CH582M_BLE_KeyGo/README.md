# BLE-Key-Go v3.5 CH582M 移植说明

> 版本：v3.5 (与 ESP32 v3.5 协议完全兼容)
> 目标芯片：CH582M (沁恒 WCH, RISC-V, BLE 5.3)
> 开发环境：MounRiver Studio

---

## 一、工程结构

```
CH582M_BLE_KeyGo/
├── src/                           ← 应用层代码（已完成）
│   ├── config.h                   ← 总配置头文件（引脚、UUID、默认参数）
│   ├── Main.c                     ← 主程序 + BLE 协议栈适配接口
│   ├── config_storage.c/.h        ← Flash 持久化存储（替代 NVS）
│   ├── kalman_filter.c/.h         ← 1D Kalman 滤波器 + 尖峰丢弃
│   ├── state_machine.c/.h         ← 锁车/解锁状态机（滞后阈值）
│   ├── relay_ctrl.c/.h            ← 继电器控制（解锁/锁车/后备箱）
│   ├── led_ctrl.c/.h              ← LED 状态指示
│   ├── button_ctrl.c/.h           ← 物理按键（配对/恢复出厂）
│   ├── gatt_service.c/.h          ← GATT 服务应用层逻辑
│   └── ble_security.c/.h          ← BLE 安全/Bonding 应用层
│
├── StdPeriphDriver/               ← WCH 标准外设驱动（复用现有）
├── RVMSIS/                        ← RISC-V CMSIS（复用现有）
├── Startup/                       ← 启动文件（复用现有）
├── Ld/                            ← 链接脚本（复用现有）
│
└── [需要添加] CH58xBLE_LIB/       ← WCH BLE 协议栈库（从官网获取）
```

---

## 二、与 ESP32 v3.5 的协议兼容性

**目标：App 端无需任何修改，直接连接 CH582M 设备。**

### 2.1 BLE UUID 完全一致

| 项目 | ESP32 v3.5 | CH582M 移植版 |
|------|-----------|--------------|
| Service UUID | `0000FF00-...` | ✅ 完全一致 |
| FF01 (Config Write) | ✅ | ✅ 完全一致 |
| FF02 (Status Read/Notify) | ✅ | ✅ 完全一致 |
| FF03 (Command Write) | ✅ | ✅ 完全一致 |
| FF04 (Serial Read) | ✅ | ✅ 完全一致 |

### 2.2 Status JSON 字段完全一致

```json
{
  "c": 1,      // connected
  "enc": 1,    // encrypted
  "bdd": 1,    // has bonded devices
  "st": "LOCKED",
  "r": -52,    // raw RSSI
  "f": -50,    // filtered RSSI
  "ul": -45,   // unlock threshold
  "lk": -65,   // lock threshold
  "hy": 5,     // hysteresis
  "uc": 3,     // unlock count
  "lc": 5,     // lock count
  "mc": 0,     // manual cooldown
  "dn": "KeyGo-A3F29C",   // device name
  "d2": "我的车",          // custom name (仅加密时发送)
  "sn": "A3F29C",          // serial suffix
  "pm": 0,     // pairing mode
  "pd": 1,     // pin default
  "pce": 0     // pin change error
}
```

### 2.3 命令格式完全一致

| FF03 命令 | 说明 | 兼容性 |
|-----------|------|--------|
| `UNLOCK` | 手动解锁 | ✅ |
| `LOCK` | 手动锁车 | ✅ |
| `TRUNK` | 开启后备箱 | ✅ |
| `STATUS` | 触发状态上报 | ✅ |
| `NAME:xxx` | 设置自定义名称 | ✅ |
| `PIN:old:new` | 修改配对 PIN | ✅ |

### 2.4 FF01 配置格式完全一致

```
unlock=-45 lock=-65 hyst=5 spike=25 uc=3 lc=5 interval=500 dlock=5000 q=4 r=16
```

---

## 三、引脚分配

| 功能 | ESP32-C3 | CH582M | 端口 |
|------|----------|--------|------|
| 解锁继电器 | GPIO2 | PA2 | NMOS 高电平触发 |
| 锁车继电器 | GPIO3 | PA3 | NMOS 高电平触发 |
| 后备箱继电器 | GPIO4 | PA4 | NMOS 高电平触发 |
| 钥匙供电 PMOS | GPIO5 | PA5 | 低电平导通 |
| 状态 LED | GPIO8 | PA8 | 高电平点亮 |
| 配对按键 | GPIO9 | PA9 | 上拉输入，低电平有效 |
| 串口 TX | GPIO20 | PB9 (UART1_TX) | 115200 波特率 |
| 串口 RX | GPIO21 | PB8 (UART1_RX) | 115200 波特率 |

> **注意**：引脚可在 `config.h` 中修改。如果你的硬件设计不同，只需修改 `PIN_*` 和 `PIN_PORT_*` 宏定义。

---

## 四、WCH BLE 库集成步骤

### 4.1 获取 WCH BLE 库

从沁恒官网下载 CH58x BLE 协议栈库：
- 官网：http://www.wch.cn
- 搜索：CH582M / CH58x BLE SDK
- 下载：CH58xBLE_LIB 或类似名称

### 4.2 添加源文件到工程

将以下文件添加到 MounRiver 工程：

```
src/config.h
src/Main.c
src/config_storage.c
src/kalman_filter.c
src/state_machine.c
src/relay_ctrl.c
src/led_ctrl.c
src/button_ctrl.c
src/gatt_service.c
src/ble_security.c
```

### 4.3 实现 BLE 协议栈回调

在 `Main.c` 中标记为 `TODO` 的位置，根据 WCH BLE 库的 API 完成以下适配：

#### 1. GAP 事件回调注册

```c
// 在 BLE_Init() 中注册
GAP_RegisterCallbacks(BLE_OnConnect, BLE_OnDisconnect);
```

#### 2. GATT 服务和特征值添加

```c
// 添加 FF00 服务
GATT_AddService(serviceUUID);

// 添加 FF01 - 配置特征（写，加密）
GATT_AddCharacteristic(
    FF01_UUID,
    GATT_PROP_WRITE,
    GATT_PERM_WRITE_ENCRYPTED,
    BLE_OnConfigWrite
);

// 添加 FF02 - 状态特征（读+通知，加密）
GATT_AddCharacteristic(
    FF02_UUID,
    GATT_PROP_READ | GATT_PROP_NOTIFY,
    GATT_PERM_READ_ENCRYPTED,
    BLE_OnStatusRead
);

// 添加 FF03 - 命令特征（写，加密）
GATT_AddCharacteristic(
    FF03_UUID,
    GATT_PROP_WRITE,
    GATT_PERM_WRITE_ENCRYPTED,
    BLE_OnCommandWrite
);

// 添加 FF04 - 序列号特征（只读，加密）
GATT_AddCharacteristic(
    FF04_UUID,
    GATT_PROP_READ,
    GATT_PERM_READ_ENCRYPTED,
    BLE_OnSerialRead
);
```

#### 3. SM (Security Manager) 配置

```c
SM_SetIOCapability(SM_IO_CAP_DISPLAY_ONLY);  // 显示 PIN 码
SM_SetAuthReq(SM_AUTH_REQ_SC_BOND);           // LE Secure Connection + Bonding
SM_SetPassKeyCallback(BLE_OnPassKeyRequest);
SM_SetAuthCompleteCallback(BLE_OnAuthComplete);
```

#### 4. Notify 发送实现

在 `gattNotifyImpl()` 函数中实现：

```c
static void gattNotifyImpl(uint16_t connHandle, const uint8_t *data, uint16_t len) {
    // 调用 WCH BLE 库的 Notify 函数
    GATT_Notification(connHandle, statusCharHandle, data, len);
}
```

#### 5. RSSI 读取

在 `ReadConnectionRSSI()` 中实现：

```c
static void ReadConnectionRSSI(void) {
    GAP_ReadRSSI(g_st.connectionHandle);
    // 结果在 GAP 事件回调中返回，调用 BLE_OnRSSIRead()
}
```

#### 6. 广播数据设置

广播包（Advertisement）：
- 设备完整名称：`KeyGo-XXXXXX`

扫描响应（Scan Response）：
- Service UUID: `0000FF00-...`
- Manufacturer Data: `0xFFFF` + `"KG"` + MAC 后 3 字节

### 4.4 主循环中添加协议栈处理

```c
while (1) {
    // ... 应用层代码 ...

    // WCH BLE 协议栈事件处理
    TMOS_SystemProcess();  // 或类似函数

    Delay_Ms(10);
}
```

---

## 五、功能模块对应关系

| ESP32 Arduino 功能 | CH582M 实现模块 | 状态 |
|-------------------|----------------|------|
| `Preferences` (NVS) | `config_storage.c` | ✅ 已实现 |
| `BLEDevice/BLEServer` | WCH BLE 库 + `Main.c` 适配 | ⚠️ 需集成 |
| `BLESecurity` | WCH SM + `ble_security.c` | ⚠️ 需集成 |
| `Kalman filter` | `kalman_filter.c` | ✅ 已实现 |
| `状态机` | `state_machine.c` | ✅ 已实现 |
| `GPIO 控制` | `relay_ctrl.c` + `led_ctrl.c` | ✅ 已实现 |
| `按键` | `button_ctrl.c` | ✅ 已实现 |
| `millis()/delay()` | SysTick + `Delay_Ms()` | ✅ 已实现 |
| `String` | C 字符串 + `snprintf` | ✅ 已实现 |
| `Status JSON` | `gatt_service.c` | ✅ 已实现 |
| `命令解析` | `gatt_service.c` | ✅ 已实现 |
| `串口命令` | 可扩展（当前主要输出日志） | ⚠️ 可扩展 |

---

## 六、安全特性对照

| 安全特性 | ESP32 v3.5 | CH582M 移植版 |
|---------|-----------|--------------|
| MAC 白名单 | ✅ (已淘汰，用 Bonding 替代) | — |
| BLE Bonding (链路层加密) | ✅ | ✅ 应用层逻辑已实现 |
| GATT 特征值加密权限 | ✅ | ⚠️ 需在 BLE 库中设置 |
| 主动发起安全请求 | ✅ | ✅ 应用层逻辑已实现 |
| 静态 PIN | ✅ | ✅ 已实现 |
| PIN 修改 | ✅ | ✅ 已实现 |
| 旧 bond 失效检测 | ✅ | ✅ 已实现 (三路兜底) |
| 未加密不返回自定义名称 | ✅ | ✅ 已实现 |
| FF04 序列号（设备指纹） | ✅ | ✅ 已实现 |

---

## 七、编译和调试

### 7.1 编译前检查

1. ✅ 所有应用层 `.c` 文件已添加到工程
2. ⬜ WCH BLE 库已添加
3. ⬜ `Main.c` 中的 TODO 已全部实现
4. ⬜ 引脚定义与硬件一致（`config.h`）
5. ⬜ 串口波特率 115200

### 7.2 调试步骤

1. **第一阶段：基础功能验证**
   - LED 闪烁是否正常
   - 按键按下是否有串口输出
   - 继电器能否正常触发（可手动调用 `Relay_ExecuteUnlock()`）

2. **第二阶段：BLE 连接验证**
   - 手机能否扫描到 `KeyGo-XXXXXX`
   - 能否正常连接
   - 能否弹出配对 PIN 框

3. **第三阶段：功能验证**
   - 配对后能否看到 FF02 Notify
   - 手动命令（UNLOCK/LOCK/TRUNK）是否正常
   - 参数配置（FF01）能否下发和保存
   - RSSI 状态机是否正常工作

4. **第四阶段：App 验证**
   - 打开 BLE Key Go App
   - 扫描和连接是否正常
   - 所有功能是否与 ESP32 版本一致

---

## 八、常见问题

### Q1: Flash 存储地址是否正确？

默认使用 `0x0003F000`（256KB Flash 的最后 4KB）。
如果你的 Flash 大小不同，请修改 `config_storage.h` 中的 `STORAGE_ADDR`。

### Q2: 设备 MAC 地址从哪里读取？

CH582M 的蓝牙 MAC 地址存储在 Information Block 中，地址 `0x40640`。
如果你的芯片 MAC 地址存储位置不同，请修改 `GetDeviceMac()` 函数。

### Q3: SysTick 用的是哪个定时器？

使用 TMR0 实现 1ms SysTick。
如果你的项目需要使用 TMR0，可以修改为其他定时器（TMR1/TMR2/TMR3）。

### Q4: App 端需要修改吗？

**不需要。** 移植版保持了与 ESP32 v3.5 100% 的协议兼容性，App 可以直接使用。

---

## 九、文件清单

| 文件 | 行数 | 功能 |
|------|------|------|
| [config.h](file:///workspace/code/CH582M/CH582M_BLE_KeyGo/src/config.h) | 147 | 总配置 |
| [Main.c](file:///workspace/code/CH582M/CH582M_BLE_KeyGo/src/Main.c) | 540 | 主程序 + BLE 适配 |
| [config_storage.c](file:///workspace/code/CH582M/CH582M_BLE_KeyGo/src/config_storage.c) | 130 | Flash 存储 |
| [kalman_filter.c](file:///workspace/code/CH582M/CH582M_BLE_KeyGo/src/kalman_filter.c) | 70 | Kalman 滤波 |
| [state_machine.c](file:///workspace/code/CH582M/CH582M_BLE_KeyGo/src/state_machine.c) | 80 | 状态机 |
| [relay_ctrl.c](file:///workspace/code/CH582M/CH582M_BLE_KeyGo/src/relay_ctrl.c) | 65 | 继电器控制 |
| [led_ctrl.c](file:///workspace/code/CH582M/CH582M_BLE_KeyGo/src/led_ctrl.c) | 80 | LED 控制 |
| [button_ctrl.c](file:///workspace/code/CH582M/CH582M_BLE_KeyGo/src/button_ctrl.c) | 65 | 按键控制 |
| [gatt_service.c](file:///workspace/code/CH582M/CH582M_BLE_KeyGo/src/gatt_service.c) | 280 | GATT 应用层 |
| [ble_security.c](file:///workspace/code/CH582M/CH582M_BLE_KeyGo/src/ble_security.c) | 95 | 安全管理 |
| **合计** | **~1550** | **应用层完整实现** |

---

## 十、下一步

1. 获取 WCH CH58x BLE 协议栈库
2. 将 `src/` 目录下的文件添加到 MounRiver 工程
3. 按照本文第四章完成 BLE 库适配
4. 编译、烧录、调试
5. 用 App 验证所有功能

> 💡 **建议**：先不接原车钥匙，用 LED 或万用表验证 GPIO 输出正确后，再接入钥匙电路。
