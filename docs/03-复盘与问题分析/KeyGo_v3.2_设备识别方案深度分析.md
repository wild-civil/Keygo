# KeyGo v3.2 设备识别方案深度分析

> 当前版本：v3.2 (BLE Bonding)  
> 核心问题：除了依赖设备名称，还有哪些识别方案？每种方案的优缺点与落地成本如何？

---

## 目录

1. [v3.2 当前的设备识别链路](#1-v32-当前的设备识别链路)
2. [为什么"只凭名字"不够？](#2-为什么只凭名字不够)
3. [方案全景图：五层识别体系](#3-方案全景图五层识别体系)
4. [第一层：广播识别（无连接阶段）](#4-第一层广播识别无连接阶段)
5. [第二层：连接识别（连接建立阶段）](#5-第二层连接识别连接建立阶段)
6. [第三层：绑定识别（持久信任阶段）](#6-第三层绑定识别持久信任阶段)
7. [第四层：应用层识别（已连接阶段）](#7-第四层应用层识别已连接阶段)
8. [第五层：出厂身份（固件烧录阶段）](#8-第五层出厂身份固件烧录阶段)
9. [全方案对比矩阵](#9-全方案对比矩阵)
10. [当前广播包结构分析 & 空间预算](#10-当前广播包结构分析--空间预算)
11. [推荐组合方案（按场景）](#11-推荐组合方案按场景)
12. [v3.3 落地路线图](#12-v33-落地路线图)
13. [附录：微信小程序 BLE API 能力边界](#13-附录微信小程序-ble-api-能力边界)

---

## 1. v3.2 当前的设备识别链路

### 完整流程

```
用户打开 App
  │
  ├─[1] 扫描阶段
  │     ├── Services 硬件过滤: 只扫 0000FF00-0000-1000-8000-00805F9B34FB 的设备
  │     ├── 名字前缀匹配: deviceName.startsWith("KeyGo")
  │     ├── 截断名兜底: "Ke" 开头也认（NimBLE 名字被截断的场景）
  │     ├── UUID 兜底: advertisServiceUUIDs 匹配也算
  │     └── 显示名重建: deviceId 后 6 位 → "KeyGo-71C65A"
  │
  ├─[2] 连接阶段
  │     ├── 通过 deviceId 建立 BLE 连接
  │     └── 等待 BLE 协议栈自动加密（SC Bonding）
  │
  ├─[3] 持久化
  │     ├── App 侧: uni.setStorageSync("ble_device_id", deviceId)  // 用于下次自动重连
  │     └── ESP32 侧: NVS 存储 bond key（链路层密钥）
  │
  └─[4] 重新识别
        ├── 自动重连: 直接用存储的 deviceId 调用 createBLEConnection
        ├── 扫描重连: 重新走扫描流程，用 deviceId 去重
        └── 已配对重连: BLE 栈自动加密，无需用户交互
```

### 当前实际使用的识别因子

| 因子 | 阶段 | 代码位置 | 效果 |
|------|------|----------|------|
| **Service UUID** | 扫描过滤 | `ble.js:128` `services: [BLE_CONFIG.serviceUUID]` | ⭐⭐⭐ 系统级过滤，只看到自家的设备 |
| **设备名前缀** | 扫描匹配 | `ble.js:95` `rawName.startsWith("KeyGo")` | ⭐⭐ 人能看懂，但有截断风险 |
| **deviceId (系统API)** | 连接/重连 | `ble.js:99` `foundSet.has(device.deviceId)` | ⭐⭐ 平台相关，iOS 不稳定 |
| **BLE Bonding 密钥** | 连接后加密 | 固件 `ESP_LE_AUTH_REQ_SC_BOND` | ⭐⭐⭐⭐ 链路层加密，行业标准 |
| **NVS 偏好存储** | 持久化 | 固件 `preferences.putString("ble_device_id")` | ⭐⭐⭐ 本地持久化，断电不丢 |

### ⚠️ 关键发现

**ESP32 固件已经在广播包中塞入了 Manufacturer Specific Data**（`0xFFFF` + `"KG"`），但 **App 端完全没有解析使用它**！

```cpp
// 固件 startAdvertising() — v3.2 第 809-814 行
String mfrData;
mfrData += (char)(MANUFACTURER_ID & 0xFF);      // 0xFF
mfrData += (char)((MANUFACTURER_ID >> 8) & 0xFF); // 0xFF
mfrData += MANUFACTURER_DATA;                    // "KG"
BLEAdvertisementData adData;
adData.setManufacturerData(mfrData);
advertising->setScanResponseData(adData);        // ← 放到 Scan Response 里了
```

这意味着：**广播识别这个能力，硬件侧已经完成了一半，只差 App 侧解析了。**

---

## 2. 为什么"只凭名字"不够？

### 2.1 名字碰撞

```
场景: 两个用户的车停在同一停车场，各自装了 KeyGo
      ESP32-A → "KeyGo-71C65A"
      ESP32-B → "KeyGo-3F8A2B"
```

这种情况下名字不同，没问题。但如果有用户**手动改名**：

```
ESP32-A → "我的宝马"  (via NAME: 命令)
ESP32-B → "我的宝马"  ← 名字碰上了！
```

App 端 `customDeviceName` 字段随 Notify 上报，但 **扫描阶段只靠名字前缀**，自定义名不参与过滤。

### 2.2 NimBLE 截断

```
问题: NimBLE 栈时 128-bit Service UUID 占 16 字节，挤占广播包
      完整名称 "KeyGo-71C65A" (12 字节) 被迫落入 Scan Response
      微信 API 的 localName 只能拿到广播包里的截断名 "Ke"
```

v3.2 已有三级兜底（parsedName → localName → devName）缓解了这个问题，但本质上是"猜"。

### 2.3 名字不可验证

设备名只是一个字符串，任何人都可以宣称自己是 `KeyGo-XXXXXX`。在扫描阶段，App 无法区分：
- 真正的 KeyGo ESP32
- 另一个故意取同名 `KeyGo-XXXXXX` 的蓝牙设备

这是**没有密码学保证**的识别方式。

### 2.4 deviceId 不稳定

| 平台 | deviceId 本质 | 什么情况下会变 |
|------|--------------|---------------|
| iOS | 系统随机 UUID | 卸载重装 / 系统重置 / 隐私设置重置 |
| Android 6.0+ | BLE 随机地址 | 蓝牙开关 / 系统升级 / 清除数据 |
| Android 5.x | 真实 MAC | 基本不变（但占比几乎为 0） |

也就是说 `uni.setStorageSync('ble_device_id', ...)` 存储的设备 ID，在用户**清缓存、重装 App、换手机**后就失效了。App 会认为这是一个"没见过的新设备"。

---

## 3. 方案全景图：五层识别体系

把设备识别拆成五个层次，每层对应不同的技术手段和时机：

```
┌─────────────────────────────────────────────────────┐
│            第五层：出厂身份                           │
│    烧录时写入的唯一序列号（不可篡改、断电不丢）         │
│    efuse / OTP / 工厂烧录脚本                        │
├─────────────────────────────────────────────────────┤
│            第四层：应用层识别                         │
│    连接后通过 GATT 特征值主动查询设备身份              │
│    序列号特征值 / 挑战-应答 / 数字签名                │
├─────────────────────────────────────────────────────┤
│            第三层：绑定识别                           │
│    配对后的持久信任关系（双方设备都记住对方）          │
│    BLE Bonding / OOB 配对 / 云端同步绑定列表         │
├─────────────────────────────────────────────────────┤
│            第二层：连接识别                           │
│    建立连接时的身份确认（系统层 API）                  │
│    BLE MAC / BLE Address Type / 连接参数协商          │
├─────────────────────────────────────────────────────┤
│            第一层：广播识别                           │
│    扫描时通过广播包内容筛选和识别设备                  │
│    名字 / Service UUID / 厂商数据 / Beacon 格式       │
└─────────────────────────────────────────────────────┘
```

**原则：下层做筛选，上层做确认。越往上越可靠，越往下越快速。**

---

## 4. 第一层：广播识别（无连接阶段）

这是**最早、最快、最轻量**的识别层。不需要建立连接，扫描回调中即可完成。

### 方案 1A：设备名称前缀 / 完整名 —— 当前方案

**原理：** 扫描到的设备名称以 `KeyGo` 开头即为目标设备。

| 维度 | 评价 |
|------|------|
| 实现难度 | ⭐ 极低（已实现） |
| 唯一性 | ⭐⭐ 依赖 MAC 后 6 位，理论碰撞概率 ~1/16M |
| 防伪造 | ❌ 无，名字可以随便改 |
| NimBLE 兼容 | ⚠️ 需要三级兜底（已实现） |
| 人类可读 | ✅ 非常好 |

**当前状态：** 已实现并工作良好（v2.2 引入三级探测）

---

### 方案 1B：自定义 128-bit Service UUID —— 推荐首先实施

**原理：** 注册一个 KeyGo 专属的 128-bit Service UUID 放到广播包中，扫描时只在这个 UUID 的设备。

```
当前 UUID: 0000FF00-0000-1000-8000-00805F9B34FB  ← 标准 16-bit base，谁都能用
建议 UUID: 4B65-7947-6F00-0000-000000000000  ← 你的专属 (KeyGo 的 hex: 4B 65 79 47 6F)
完整形式:  0000-4B65-7947-6F00-0000-00000000 ← 或自定完整 128-bit
```

**实现：**

```cpp
// ESP32 固件修改
#define SERVICE_UUID "4B657947-6F00-0000-0000-000000000000"  // 自定义 128-bit

// App 无需修改（已经在用这个 UUID 过滤）
// ble.js:128 → services: [BLE_CONFIG.serviceUUID]
```

| 维度 | 评价 |
|------|------|
| 实现难度 | ⭐ 极低（改一行 UUID 定义） |
| 唯一性 | ⭐⭐⭐⭐ UUID 空间 2^128，不可能碰撞 |
| 防仿冒 | ⭐⭐ 别人可以复制你的 UUID，但没有理由这么做 |
| 噪音过滤 | ⭐⭐⭐⭐⭐ 硬件级过滤，非 KeyGo 设备根本不会出现在扫描结果 |
| 用户无感 | ✅ 完全透明 |
| **风险** | ⚠️ 改了 UUID 后旧版 App 扫不到新版固件（需同步升级） |

**⚠️ 重要权衡：** 目前用标准 16-bit UUID `0000FF00-...`，技术上任何蓝牙设备都可能注册这个 UUID，但因为你的扫描还加了 Services 过滤 + 名字过滤，现实中基本不会有干扰。换成自定义 128-bit UUID 的**实际收益是"理论上更干净"**，但会带来**UUID 变更兼容性问题**。

**建议：** 如果现在还没大量分发设备，立即换；如果已有设备在外，可以用 **方案 1C** 代替。

---

### 方案 1C：Manufacturer Specific Data —— ⭐ 强烈推荐

**原理：** BLE 广播包中有一个标准 AD Type `0xFF`（Manufacturer Specific Data），可以塞入自定义数据。KeyGo v3.2 的固件**已经在发**，但 App 没用！

**当前广播数据：**
```
AD Type 0xFF: [0xFF, 0xFF, 'K', 'G']
                  ↑      ↑      ↑
             Company ID   Payload (目前只有 2 字节标识)
             (0xFFFF = 测试/实验用)
```

**改进后可以编码更多信息：**

```
方案: 扩展 Manufacturer Data 携带设备指纹
┌──────────────────────────────────────────┐
│ Byte 0-1: Company ID    = 0xFFFF          │
│ Byte 2:   Protocol Ver  = 0x01 (v1)      │
│ Byte 3:   Device Type   = 0x01 (KeyGo)   │
│ Byte 4-6: Device ID     = 后3字节MAC      │
│ Byte 7:   Flags         = 0x00 (预留)     │
└──────────────────────────────────────────┘
总计 8 字节（Scan Response 最多可放 ~27 字节）
```

**ESP32 固件修改：**

```cpp
void startAdvertising() {
    BLEAdvertising* advertising = BLEDevice::getAdvertising();
    advertising->addServiceUUID(SERVICE_UUID);

    // ★ v3.3: 扩展 Manufacturer Data
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_BT);
    
    String mfrData;
    mfrData += (char)0xFF;           // Company ID LSB
    mfrData += (char)0xFF;           // Company ID MSB
    mfrData += (char)0x01;           // Protocol Version
    mfrData += (char)0x01;           // Device Type (1=KeyGo)
    mfrData += (char)mac[3];         // Device ID [0]
    mfrData += (char)mac[4];         // Device ID [1]
    mfrData += (char)mac[5];         // Device ID [2]
    mfrData += (char)0x00;           // Flags

    BLEAdvertisementData adData;
    adData.setManufacturerData(mfrData);
    advertising->setScanResponseData(adData);
    advertising->setScanResponse(true);
    // ...
}
```

**App 端解析（ble.js 新增）：**

```javascript
/**
 * 从广播数据中提取 Manufacturer Specific Data
 * @param {ArrayBuffer} advBuffer 
 * @returns {{ companyId: number, deviceType: number, deviceId: string } | null}
 */
function parseManufacturerData(advBuffer) {
  if (!advBuffer || advBuffer.byteLength === 0) return null
  const data = new Uint8Array(advBuffer)
  let i = 0
  while (i < data.length - 1) {
    const length = data[i]
    const type = data[i + 1]
    if (length === 0) break
    const valueEnd = i + 2 + (length - 1)
    if (valueEnd > data.length) break

    if (type === 0xFF) { // Manufacturer Specific Data
      const value = data.slice(i + 2, valueEnd)
      if (value.length >= 6) {
        const companyId = value[0] | (value[1] << 8)
        if (companyId === 0xFFFF) { // KeyGo
          const protocolVer = value[2]
          const deviceType  = value[3]
          const deviceIdHex = value[4].toString(16).padStart(2,'0').toUpperCase()
                            + value[5].toString(16).padStart(2,'0').toUpperCase()
                            + value[6].toString(16).padStart(2,'0').toUpperCase()
          return { companyId, protocolVer, deviceType, deviceId: deviceIdHex }
        }
      }
    }
    i = valueEnd
  }
  return null
}
```

**扫描回调中整合：**

```javascript
// ble.js startScan 内部
const mfrInfo = parseManufacturerData(device.advertisData)
if (mfrInfo && mfrInfo.deviceType === 1) {
  // 这是 KeyGo 设备！deviceId = "71C65A"
  // 用它来重建显示名，或作为唯一标识
}
```

| 维度 | 评价 |
|------|------|
| 实现难度 | ⭐⭐ App 侧新增 ~30 行解析代码 |
| 唯一性 | ⭐⭐⭐⭐ 基于 ESP32 物理 MAC |
| 防伪造 | ⭐⭐ 广播数据可被复制，但随机的攻击者不会知道你的格式 |
| 无需连接 | ✅ 扫描阶段即可拿到 |
| 兼容性 | ✅ 不改变现有 UUID/名字，渐进增强 |
| 空间占用 | 8 字节，富裕 |
| **当前状态** | ⚡ **固件已发数据，App 没用！最快落地方案！** |

---

### 方案 1D：iBeacon 格式广播

**原理：** 用苹果 iBeacon 标准格式广播，包含 UUID + Major + Minor 字段。

```
iBeacon 数据包:
  UUID:  自定义 128-bit (产品线)
  Major: 设备批次号
  Minor: 设备编号
  
优点: iOS 可在后台唤醒 App（CLBeaconRegion monitoring）
缺点: Android 支持一般，数据字段有限，主要用于测距而非控制
```

| 维度 | 评价 |
|------|------|
| 实现难度 | ⭐⭐ 标准格式，固件 ~20 行 |
| iOS 后台 | ✅ 可以后台唤醒 App |
| 控制场景 | ❌ 不适合，iBeacon 是单向广播 |
| KeyGo 适用性 | ⭐⭐ 可作为辅助醒 App 的手段 |

**结论：** 对你的场景（主动控制而非被动探测），iBeacon 不是最优选择。但如果你未来想要"走近自动弹窗"，值得考虑。

---

### 方案 1E：Eddystone 格式

Google 的 Beacon 标准，类似 iBeacon 但更开放。对 KeyGo 适用性同样有限。

**结论：** 跳过。对你的场景不增加价值。

---

### 第一层小结

| 方案 | 目前状态 | 推荐度 | 优先级 |
|------|----------|--------|--------|
| 1A 设备名 | ✅ 已实现 | ⭐⭐⭐ | — |
| 1B 专属 UUID | ❌ 未实施 | ⭐⭐⭐ | P2（可选） |
| **1C 厂商数据** | ⚡ **固件已发，App 未解析** | ⭐⭐⭐⭐⭐ | **P0（立即）** |
| 1D iBeacon | ❌ 未实施 | ⭐⭐ | P3（远期） |
| 1E Eddystone | ❌ 未实施 | ⭐ | 不推荐 |

---

## 5. 第二层：连接识别（连接建立阶段）

这一层发生在 `uni.createBLEConnection()` 调用时。

### 方案 2A：deviceId（系统 API）—— 当前方案

**原理：** 微信小程序提供 `device.deviceId`，底层是操作系统的蓝牙地址抽象。

**当前使用方式：**
```javascript
// 重连
const savedId = uni.getStorageSync('ble_device_id')
uni.createBLEConnection({ deviceId: savedId })

// 去重
foundSet.has(device.deviceId)
```

| 维度 | 评价 |
|------|------|
| iOS 稳定性 | ❌ 卸载/重置后 deviceId 变化 |
| Android 稳定性 | ⚠️ 蓝牙开关可能导致变化 |
| 跨平台一致性 | ❌ 同一设备在 iPhone 和 Android 上 deviceId 不同 |

**核心问题：** 这是系统 API 决定的，App 无法改变。**只能接受它不稳定的事实。**

---

### 方案 2B：BLE MAC 地址 —— 不可用于 App 端

ESP32 可以用 `esp_read_mac(mac, ESP_MAC_BT)` 拿到自己的蓝牙 MAC 地址。但**微信小程序/uni-app 拿不到对端设备的真实 MAC**（隐私限制）。

> 结论：此方案仅 ESP32 侧可用，App 侧不可用。可用于"自己知道自己是谁"，不能用于"App 知道你是谁"。

---

### 方案 2C：连接后读设备名

`uni.getConnectedBluetoothDevices()` 可以拿到已连接设备的名称。但也是名字，聊胜于无。

---

### 第二层小结

第二层（系统层）基本被平台 API 限制锁死了，**能做的有限**。重点应放在第一层（广播识别）和第四层（应用层识别）。

---

## 6. 第三层：绑定识别（持久信任阶段）

### 方案 3A：BLE Bonding —— 当前方案 v3.2 ⭐

**原理：** 第一次配对时，双方交换并持久化加密密钥（NVS 存储）。后续连接自动加密，无需用户交互。

```
┌──────────┐          ┌──────────┐
│   App    │          │  ESP32   │
│ (手机)   │          │ (KeyGo)  │
└────┬─────┘          └────┬─────┘
     │ ① 连接              │
     │────────────────────→│
     │ ② 配对请求          │
     │←────────────────────│
     │ ③ 输入 PIN: 123456  │
     │────────────────────→│
     │ ④ SC 密钥交换       │
     │←───────────────────→│
     │ ⑤ 双方存储 LTK      │
     │    (长期密钥)        │
     │                     │
     │ 下次连接：自动用 LTK │
     │←──── 加密 ─────────→│
```

| 维度 | 评价 |
|------|------|
| 安全等级 | ⭐⭐⭐⭐ LE Secure Connections (ECDH, 类比 TLS) |
| 用户体验 | ⭐⭐⭐⭐⭐ 首次配对后无感自动连接 |
| 标准合规 | ✅ 与 Apple CarKey 同级别的链路层方案 |
| 防重放 | ✅ 每次连接使用不同的随机数 |
| 局限 | ⚠️ Bond 存储在 NVS，清除 NVS 后丢失 |

**当前状态：** ✅ 已完美实现。

---

### 方案 3B：Out-of-Band (OOB) 配对

**原理：** 通过 NFC 触碰来交换配对信息，不需要输入 PIN。

```
App 碰一下 ESP32 的 NFC 标签
  → 读到蓝牙地址 + 配对密钥
  → 直接建立加密连接
```

| 维度 | 评价 |
|------|------|
| 安全性 | ⭐⭐⭐⭐⭐ 物理触碰，最高安全 |
| 用户体验 | ⭐⭐⭐⭐ 碰一下就连，极简 |
| 硬件成本 | ⚠️ ESP32 需外接 NFC 模块（+¥5-8） |
| KeyGo 适用性 | ⭐⭐ 对车钥匙场景增加成本太高 |

**结论：** 对 DIY 车钥匙项目来说，NFC 更适合做**备用开锁**（手机没电时用 NFC 卡片/标签开锁），而非主要配对方式。

---

### 方案 3C：Just Works 配对

无 PIN，无交互，直接配对。适合没有显示器的设备。

| 维度 | 评价 |
|------|------|
| 安全 | ❌ 无 MITM 防护 |
| KeyGo 适用性 | ❌ 车钥匙场景不可接受 |

---

### 第三层小结

**v3.2 的 BLE Bonding + 静态 PIN 已经是最优方案**。链路层加密 + 持久化绑定，提供业界标准级别的安全性和用户体验。这一层不需要改动。

---

## 7. 第四层：应用层识别（已连接阶段）

连接建立后，可以通过 GATT 特征值读取/写入来进一步确认设备身份。

### 方案 4A：只读序列号特征值 —— ⭐ 强烈推荐

**原理：** 在 ESP32 上注册一个新的只读特征值，返回设备唯一序列号。App 连接后读取这个特征值来确认"确实是那台设备"。

**ESP32 新增：**

```cpp
// 新增 UUID
#define SERIAL_CHAR_UUID "0000FF04-0000-1000-8000-00805F9B34FB"

// 在 setup() 中注册
BLECharacteristic* serialChar = service->createCharacteristic(
    SERIAL_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ
);

// 序列号：MAC 后 6 字节 + 固件版本
char serialStr[32];
uint8_t mac[6];
esp_read_mac(mac, ESP_MAC_BT);
snprintf(serialStr, sizeof(serialStr), "KG-%02X%02X%02X%02X%02X%02X-v3.2",
         mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
serialChar->setValue(serialStr);
```

**App 读取：**

```javascript
// 连接后
const value = await readBLECharacteristicValue(
  deviceId, 
  BLE_CONFIG.serviceUUID, 
  '0000FF04-0000-1000-8000-00805F9B34FB'
)
const serial = arrayBufferToString(value) // "KG-60F95571C65A-v3.2"
```

| 维度 | 评价 |
|------|------|
| 唯一性 | ⭐⭐⭐⭐⭐ MAC 全 6 字节，全球唯一 |
| 防伪造 | ⭐⭐⭐ 只读特征值，需要连接 + 加密才能读 |
| 跨平台 | ✅ MAC 是 ESP32 物理地址，永不改变 |
| 实现成本 | ⭐⭐ 固件 + App 各 ~30 行 |
| 持久化 | ✅ MAC 存 efuse，重刷固件不丢 |

**核心价值：** 提供了一个**不依赖 deviceId、不依赖名字、不受平台限制**的稳定唯一标识。

---

### 方案 4B：设备信息特征值（增强版）

**原理：** 不只返回序列号，返回一个结构化的设备信息 JSON。

```json
{
  "sn": "KG-60F95571C65A",
  "fw": "3.2.0",
  "hw": "ESP32-C3",
  "bt_mac": "60:F9:55:71:C6:5A",
  "build": "2026-06-28"
}
```

| 维度 | 评价 |
|------|------|
| 信息丰富度 | ⭐⭐⭐⭐⭐ OTA 升级、调试都需要 |
| 实现 | 在 4A 基础上多写一个 JSON |
| 推荐 | 是 4A 的自然扩展 |

---

### 方案 4C：挑战-应答认证

**原理：** App 发送一个随机数（nonce），ESP32 用预共享密钥（PSK）加密后返回，App 验证。

```
App → ESP32:  "CHALLENGE:0xA3F7B201"
ESP32 → App:  "RESPONSE:0x8C2D..."  // AES(PSK, nonce)
```

| 维度 | 评价 |
|------|------|
| 安全等级 | ⭐⭐⭐⭐⭐ 防重放、防伪造 |
| 实现复杂度 | ⭐⭐⭐⭐ AES 加密 + 密钥管理 |
| KeyGo 适用性 | ⭐⭐ 对 DIY 车钥匙过度设计 |

**结论：** 已有 BLE Bonding 链路层加密，挑战-应答是**额外的安全层**。如果将来要防止"已配对的恶意 App 伪装控制"，才有必要。现阶段不需要。

---

### 方案 4D：数字签名（公私钥）

ESP32 存储私钥，App 存储公钥。ESP32 对认证请求签名，App 验签。

> 比挑战-应答更复杂，需要固件集成 ECDSA 库。**对 KeyGo 过度设计。** 跳过。

---

### 第四层小结

| 方案 | 推荐度 | 优先级 |
|------|--------|--------|
| **4A 序列号特征值** | ⭐⭐⭐⭐⭐ | **P0（与 1C 一起做）** |
| 4B 设备信息特征值 | ⭐⭐⭐⭐ | P1（OTA 升级前必须） |
| 4C 挑战-应答 | ⭐⭐ | P3（需要时再加） |
| 4D 数字签名 | ⭐ | 不推荐 |

---

## 8. 第五层：出厂身份（固件烧录阶段）

### 方案 5A：MAC 后 6 位（当前方案）

`esp_read_mac(mac, ESP_MAC_BT)` → 取 `mac[3:5]` 拼进 `KeyGo-XXXXXX`

**问题：** 后 3 字节有 2^24 = 16M 种可能，对个人项目来说碰撞概率极低，但如果要做产品化就太少了。

---

### 方案 5B：全 MAC 作为序列号

取全部 6 字节 `mac[0:5]`，2^48 空间，全球唯一。

```cpp
snprintf(deviceId, sizeof(deviceId), "%02X%02X%02X%02X%02X%02X",
         mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
// → "60F95571C65A"
```

---

### 方案 5C：烧录时写入自定义序列号

在固件烧录脚本中，每次烧录分配一个递增序号，写入 NVS：

```
ESP32 #001 → serial: "KG-24060001"
ESP32 #002 → serial: "KG-24060002"
ESP32 #003 → serial: "KG-24060003"
```

| 维度 | 评价 |
|------|------|
| 唯一性 | ⭐⭐⭐⭐⭐ 全局可控 |
| 可追溯 | ✅ 按序号追溯生产日期/批次 |
| 代价 | ⚠️ 需要烧录脚本管理序号 |

**对 KeyGo 当前阶段：** 过度设计。用 MAC 足够了。等到你真的要批量生产 100 台以上再说。

---

### 方案 5D：ESP32 efuse

ESP32 有一个不可修改的 efuse 区域，出厂就烧了 MAC 地址。可以读取但无法修改。

```cpp
uint8_t efuseMac[6];
esp_efuse_mac_get_default(efuseMac); // 读不可篡改的出厂 MAC
```

可以用来做"终极信任锚点"，但对 KeyGo 没必要。

---

## 9. 全方案对比矩阵

| # | 方案 | 层 | 识别时机 | 唯一性 | 防伪造 | 实现成本 | 平台兼容 | 推荐度 | 优先级 |
|---|------|----|---------|--------|--------|---------|---------|--------|--------|
| 1A | 设备名前缀 | 广播 | 扫描 | ⭐⭐ | ❌ | ✅ 已实现 | ⚠️ NimBLE截断 | ⭐⭐⭐ | — |
| 1B | 自定义128-bit UUID | 广播 | 扫描 | ⭐⭐⭐⭐ | ⭐⭐ | ⭐ 改1行 | ✅ | ⭐⭐⭐ | P2 |
| **1C** | **厂商数据扩展** | **广播** | **扫描** | **⭐⭐⭐⭐** | **⭐⭐** | **⭐⭐ 30行** | **✅** | **⭐⭐⭐⭐⭐** | **P0** |
| 1D | iBeacon | 广播 | 扫描 | ⭐⭐ | ⭐⭐ | ⭐⭐ | ✅ iOS优 | ⭐⭐ | P3 |
| 2A | deviceId | 系统 | 连接 | ⭐⭐ | ❌ | ✅ 已实现 | ❌ 不稳定 | ⭐⭐ | — |
| 2B | BLE MAC | 系统 | 连接 | ⭐⭐⭐⭐⭐ | N/A | ❌ App不可读 | ❌ App不可读 | — | — |
| 3A | BLE Bonding | 绑定 | 配后 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ✅ 已实现 | ✅ | ⭐⭐⭐⭐⭐ | — |
| 3B | OOB/NFC配对 | 绑定 | 触碰 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ 硬件 | ⚠️ 需NFC | ⭐⭐ | P3 |
| **4A** | **序列号特征值** | **应用** | **连后** | **⭐⭐⭐⭐⭐** | **⭐⭐⭐** | **⭐⭐ 30行** | **✅** | **⭐⭐⭐⭐⭐** | **P0** |
| 4B | 设备信息特征值 | 应用 | 连后 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ 50行 | ✅ | ⭐⭐⭐⭐ | P1 |
| 4C | 挑战-应答 | 应用 | 连后 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ✅ | ⭐⭐ | P3 |
| 5A | MAC后3字节 | 出厂 | 烧录 | ⭐⭐ | — | ✅ 已实现 | ✅ | ⭐⭐ | — |
| 5B | MAC全6字节 | 出厂 | 烧录 | ⭐⭐⭐⭐⭐ | — | ⭐ 改1行 | ✅ | ⭐⭐⭐⭐ | P1 |

---

## 10. 当前广播包结构分析 & 空间预算

### 10.1 BLE 广播包容量限制

| 包类型 | 最大有效载荷 | 说明 |
|--------|-------------|------|
| Advertising Packet (ADV_IND) | 31 字节 | 主广播包，所有设备都必须发 |
| Scan Response (SCAN_RSP) | 31 字节 | 响应扫描请求，被动/主动扫描都会拉取 |

**KeyGo 总共可用：31 + 31 = 62 字节**

### 10.2 v3.2 当前各字段占用

#### 主广播包 (ADV_IND)

```
┌─────────────────────────────────────────┐
│ Flags                     3 bytes       │
│   AD Len=2, Type=0x01, Data=0x06       │
├─────────────────────────────────────────┤
│ 128-bit Service UUID     18 bytes       │
│   AD Len=17, Type=0x07,                │
│   UUID=0000FF00-0000-1000-8000-...     │
├─────────────────────────────────────────┤
│ TX Power Level            3 bytes       │
│   AD Len=2, Type=0x0A, Data=0x00       │
├─────────────────────────────────────────┤
│ 剩余                       7 bytes       │
│   ↑ NimBLE模式可用, Bluedroid可能被占用  │
└─────────────────────────────────────────┘
总计: 18 + 3 + 3 = 24 bytes（已用），剩余 7 bytes
```

#### Scan Response (SCAN_RSP)

```
┌─────────────────────────────────────────┐
│ Complete Local Name      14 bytes       │
│   AD Len=13, Type=0x09,               │
│   Data="KeyGo-71C65A"                  │
├─────────────────────────────────────────┤
│ Manufacturer Data        6 bytes        │
│   AD Len=5, Type=0xFF,                │
│   Data=[0xFF,0xFF,'K','G']             │
├─────────────────────────────────────────┤
│ 剩余                      11 bytes       │
└─────────────────────────────────────────┘
总计: 14 + 6 = 20 bytes（已用），剩余 11 bytes
```

### 10.3 方案 1C 的空间需求

扩展后的 Manufacturer Data：
```
AD Len=9, Type=0xFF
Data=[0xFF,0xFF, 0x01, 0x01, mac3,mac4,mac5, 0x00]
      └─2B──┘ └1B─┘ └1B─┘ └───3B────┘ └1B─┘
      CID      Prot  Type  DeviceID    Flags
```
**需要：** 2 (Len+Type) + 8 (Data) = 10 bytes → 原来 6 bytes，**净增 4 字节**。Scan Response 剩余 11 字节，**绰绰有余**。

### 10.4 NimBLE 的名字截断问题

在 NimBLE 栈下，128-bit Service UUID（18 字节）占满主广播包，导致名字被挤到 Scan Response。微信 API 的 `localName` 只能取到广播包里的截断部分。

**改进思路：** 把名字也放到 Scan Response 里（已经在做了），然后通过 Manufacturer Data 中的 Device ID 来重建显示名。这正是方案 1C 的价值所在——**不依赖名字来识别设备**。

---

## 11. 推荐组合方案（按场景）

### 场景 A：单用户，一台车，一部手机

```
扫描: Service UUID 过滤 + 名字前缀 + 厂商数据确认
连接: deviceId（虽然不稳定，但有 bond 兜底）
认证: BLE Bonding（已实现）
持久: 序列号特征值（App 存 sn → 下次扫描时核对广播中的 Device ID）
```

**推荐改动：** 1C（厂商数据）+ 4A（序列号特征值）

---

### 场景 B：多用户，一车多手机（家庭共享）

```
扫描: Service UUID + 厂商数据
连接: 任一手机 deviceId
认证: BLE Bonding（每个手机独立配对）
管理: ESP32 维护已绑定手机列表（bond 数量管理）
识别: 序列号特征值用作"设备指纹"同步给所有手机
```

**推荐改动：** 1C + 4A + 多 bond 管理 UI

---

### 场景 C：多设备，一个用户多台车

```
扫描: Service UUID + 厂商数据中的 Device ID 精确匹配
连接: 按 Device ID 区分
管理: App 维护"我的设备"列表
      每台设备 = { deviceId, sn, customName, bondStatus }
```

**推荐改动：** 1C + 4A + App 设备列表 UI

---

### 场景 D：换手机 / 重装 App

```
旧手机: 存储的 deviceId 失效
新手机: 重新扫描 → 厂商数据识别到设备 → 提示"发现你的 KeyGo"
       → 需要重新配对（Bonding）→ 输入 PIN → 完成
```

**核心：** 扫描时靠**厂商数据**而不是名字来"认出老朋友"。重装 App 后不需要用户记住设备名。

---

## 12. v3.3 落地路线图

### P0 — 立即实施（核心识别增强）

```
┌──────────────────────────────────────────────────┐
│ 任务 1: 扩展 Manufacturer Data（固件）            │
│   - 在 startAdvertising() 中扩展 mfrData 到 8B   │
│   - 包含 Device ID（MAC 后 3B）+ 版本号           │
│   - 估计: 10 行改动，5 分钟                        │
├──────────────────────────────────────────────────┤
│ 任务 2: App 解析 Manufacturer Data（App）         │
│   - 新增 parseManufacturerData() 函数             │
│   - 扫描回调中使用 Device ID 做精确识别            │
│   - 估计: 40 行新增，15 分钟                       │
├──────────────────────────────────────────────────┤
│ 任务 3: 新增序列号特征值 FF04（固件 + App）        │
│   - 固件注册只读特征值，返回全 MAC 序列号          │
│   - App 连接后读取并存储，作为跨平台稳定 ID        │
│   - 估计: 固件 15 行 + App 20 行，20 分钟          │
└──────────────────────────────────────────────────┘
```

### P1 — 短期增强

```
┌──────────────────────────────────────────────────┐
│ 任务 4: App "我的设备"管理列表                     │
│   - 存储多台设备信息（sn, name, rssi阈值, bond状态）│
│   - 扫描时自动识别已配对 vs 新设备                  │
│   - 换手机后通过厂商数据找回旧设备                  │
├──────────────────────────────────────────────────┤
│ 任务 5: 全 MAC 序列号（取代后 3 字节）             │
│   - deviceName 仍用 KeyGo-XXXXXX（短名）           │
│   - FF04 返回完整 MAC 序列号供内部使用              │
└──────────────────────────────────────────────────┘
```

### P2 — 中期（可选）

```
┌──────────────────────────────────────────────────┐
│ 任务 6: 自定义 128-bit Service UUID                │
│   - 仅在设备大量分发后 UUID 冲突成为实际问题时      │
│   - 需同步升级全部固件 + App                        │
├──────────────────────────────────────────────────┤
│ 任务 7: 设备信息特征值（OTA 升级支持）              │
│   - fw 版本、hw 型号、build 日期                   │
│   - 为 OTA 固件升级做数据准备                       │
└──────────────────────────────────────────────────┘
```

### P3 — 远期（有需求时）

```
┌──────────────────────────────────────────────────┐
│ 任务 8: iBeacon 辅助（走近唤醒 App）               │
│ 任务 9: NFC 卡片备用开锁                           │
│ 任务 10: 挑战-应答认证层                           │
└──────────────────────────────────────────────────┘
```

---

## 13. 附录：微信小程序 BLE API 能力边界

### 扫描阶段能拿到的数据

| 字段 | 来源 | 稳定性 | 说明 |
|------|------|--------|------|
| `deviceId` | 系统蓝牙栈 | ⚠️ 不稳定 | iOS 随机 UUID，可随重置变化 |
| `name` | 广播包/系统缓存 | ⚠️ 可能截断 | NimBLE 时只有 "Ke" |
| `localName` | 广播包 AD 0x08/0x09 | ⚠️ 可能截断 | 同 name |
| `RSSI` | 物理层 | ✅ 实时 | 信号强度 |
| `advertisData` | 原始广播包 | ✅ 完整 | **这是关键！可以手动解析** |
| `advertisServiceUUIDs` | 广播包 AD 0x02-0x07 | ✅ 准确 | 你在用的过滤字段 |

### 连接后能拿到的数据

| 接口 | 能拿到什么 |
|------|-----------|
| `getBLEDeviceServices()` | 设备的所有 GATT Service |
| `getBLEDeviceCharacteristics()` | 每个 Service 的 Characteristic |
| `readBLECharacteristicValue()` | 读取特征值（**可以用这里读序列号**） |
| `writeBLECharacteristicValue()` | 写入特征值 |
| `notifyBLECharacteristicValueChange()` | 订阅 Notify |
| `onBLEConnectionStateChange()` | 连接/断开事件 |

### ⚠️ 拿不到的

| 想要的数据 | 原因 |
|-----------|------|
| 对端设备真实 MAC 地址 | 操作系统隐私保护，不提供给应用层 |
| 对端设备 BLE Address Type | 同上 |
| 扫描时直接读 GATT 特征值 | 必须先连接 |
| Bonding 密钥 | 系统安全区，应用层不可访问 |

### 策略含义

```
扫描阶段能依赖的:  名字 + advertisData(原始帧) + advertisServiceUUIDs + RSSI
连接阶段能依赖的:  deviceId（不稳定） + GATT特征值读取（可靠）
持久化能依赖的:    BLE Bonding（可靠） + 自定义序列号（可靠）

→ 结论: 扫描靠 advertisData，连接靠特征值，持久靠序列号
```

---

## 总结

**v3.2 已经在最关键的安全层（BLE Bonding）做对了。** 当前需要补的是**扫描层的识别精度**和**跨平台的稳定 ID**。

**最小代价最大收益的三件事（P0）：**

1. **扩展 Manufacturer Data**（固件 10 行）→ 扫描时不再只靠名字
2. **App 解析 Manufacturer Data**（App 40 行）→ 扫描时精确识别
3. **新增序列号特征值 FF04**（固件 15 行 + App 20 行）→ 连接后获取永不改变的设备指纹

这三件事加起来约 **100 行改动**，但能在根本上解决"设备识别只靠名字"的问题。
