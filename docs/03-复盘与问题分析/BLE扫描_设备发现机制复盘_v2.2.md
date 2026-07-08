# BLE KeyGo v2.2 — 设备发现机制完整复盘

> 🎯 目标：App 扫描时只显示自家的 KeyGo 设备，设备名完整显示为 `KeyGo-71C65A`

---

## 一、踩坑路线图

```
初版：services 系统级过滤
  ↓ Android 微信小程序扫不到 NimBLE 设备
移除 services，全量扫描
  ↓ 列表里涌入一堆"未知设备"，KeyGo 也被淹没
名字 + UUID 双重软件过滤
  ↓ 设备名只显示 "Ke"（截断）
尝试解析原始 advertisData（TLV）
  ↓ 解析不到完整名 — 因为完整名在 Scan Response 里
截断前缀检测 + deviceId 重建
  ↓ 冒号没处理，显示 "KeyGo-:C6:5A"
去冒号 + 正确的名字传递链路
  ↓ 🎉 "KeyGo-71C65A" 完美显示
```

---

## 二、核心问题：为什么"services 过滤"不工作？

### 代码长这样（初版）

```js
uni.startBluetoothDevicesDiscovery({
  services: ['0000FF00-0000-1000-8000-00805F9B34FB'],  // ← 问题所在
  allowDuplicatesKey: true,
  interval: 0,
})
```

### 原理

| 过滤方式 | 在哪里完成 | 优/缺点 |
|----------|-----------|---------|
| `services` 参数 | 操作系统蓝牙栈底层 | ✅ 省电省资源 / ❌ 平台兼容性差 |
| 软件代码过滤 | App 层收到回调后判断 | ✅ 100% 可控 / ❌ 需要处理所有广播 |

### 为什么失效

```
NimBLE (ESP32) 广播 128-bit UUID → Android 蓝牙栈 → 微信小程序 API
                                                 ↑
                                          services 过滤器在这里，
                                          但 NimBLE 的 128-bit UUID 广播格式
                                          与微信的 services 过滤器的格式期望不一致，
                                          Android 系统直接把设备丢弃了
```

**结论**：跨平台 BLE 应用中，**不要依赖 `services` 参数做过滤**，用软件层名字 + UUID 双重匹配更可靠。

---

## 三、双重过滤机制

```js
// 匹配条件：满足任一即通过
const fullMatch    = rawName.startsWith('KeyGo')       // 设备名以 KeyGo 开头
const partialMatch = 'KeyGo'.startsWith(rawName)       // "Ke" 是 "KeyGo" 的前缀（截断兜底）
const uuidMatch    = /* advertisServiceUUIDs 包含 FF00 */  // UUID 兜底
```

```
           广播包到达
               │
      ┌────────┼────────┐
      ▼        ▼        ▼
  名字完整匹配  截断匹配  UUID匹配
  "KeyGo-XXX"  "Ke"      FF00服务存在
      │        │        │
      └────────┼────────┘
               ▼
          加入设备列表
```

### 关于 nrfconnect 模拟

如果你用 nrfconnect 模拟一个设备，广播名设为 `KeyGo-123`：

| 判断项 | 能否通过 | 原因 |
|--------|---------|------|
| 名字完整匹配 | ✅ | `"KeyGo-123".startsWith("KeyGo")` = true |
| UUID 匹配 | ❓ | 需要手动在 nrfconnect 中添加 `0000FF00-...` 服务 |

**会被扫到！** 只要名字以 `KeyGo` 开头，就会被列入设备列表。

但这不构成安全问题，因为：
- 连接后需要进行绑定序列（BIND 命令 + MAC 白名单写入）
- 模拟设备没有真实的 IO 控制硬件，后续操作会失败

---

## 四、最深坑：设备名截断

### 现象

```
ESP32 串口输出：  Device: KeyGo-71C65A   ← 12 字节
App 列表显示：    Ke                     ← 只拿到 2 字节
```

### BLE 广播包大小限制

```
┌────────────────────────────────────────┐
│      BLE 主广播包 (Adv Data)            │
│      最大 31 字节                        │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ Flag (3B) + 128-bit UUID (18B)   │  │
│  │ + Shortened Name "Ke" (4B)       │  │
│  │ = 25 字节，6 字节剩余              │  │
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│      Scan Response (被动扫描响应)       │
│      最大 31 字节                        │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ Complete Name "KeyGo-71C65A"(14B)│  │
│  │ + Manufacturer Data "KG" (5B)    │  │
│  └──────────────────────────────────┘  │
│                                        │
│  ⚠️ 微信小程序 API 不暴露 Scan Response │
│     只给主广播包的 advertisData          │
└────────────────────────────────────────┘
```

### 为什么 `parseAdvertisName` 也失败了

```js
// 从 advertisData 的 TLV 格式中找 0x09(完整名) 和 0x08(短名)
function parseAdvertisName(advBuffer) {
  // 遍历 TLV：
  //   0x03, 0x01, 0x06          ← Flag (3B)
  //   0x13, 0x07, 0xFF, 0x00...  ← 128-bit UUID (18B)
  //   0x03, 0x08, 'K', 'e'       ← Shortened Name "Ke" (4B) ← 找到了！
  //                         ↑ 没有 0x09 Complete Name
  //                            因为完整名在 Scan Response 里
}
```

**完整名在 Scan Response 里，微信 API 不给 → 彻底解析不到。**

---

## 五、最终方案：截断前缀检测 + deviceId 重建

```js
// 关键判断：即使只拿到 "Ke"，也能识别为我们的设备
const partialMatch = BLE_CONFIG.deviceNamePrefix.startsWith(rawName) && rawName.length >= 2
//                            "KeyGo".startsWith("Ke")  = true ✅
//                            rawName.length(2) >= 2     = true ✅

// 完整名重建：从 deviceId 中提取 MAC 后缀
const macClean  = device.deviceId.replace(/:/g, '')   // "60:55:F9:71:C6:5A" → "6055F971C65A"
const macSuffix = macClean.slice(-6).toUpperCase()     // "71C65A"
const displayName = 'KeyGo-' + macSuffix               // "KeyGo-71C65A"
```

### 设备名三级来源

```
                    advertisData 解析 (0x09/0x08)
                           │
                    device.localName (API)
                           │
                    device.name (API)
                           │
                    ▼ 三级取最长 ▼
                    rawName = "Ke"
                           │
              ┌────────────┤
              ▼            ▼
    startsWith("KeyGo")?  "KeyGo".startsWith("Ke")?
          false           true → partialMatch ✅
              │                 │
              └───────┬─────────┘
                      ▼
              deviceId 去冒号 → 取后6位 → "KeyGo-71C65A"
```

---

## 六、完整改动文件对比

### ble.js — 设备发现回调

```diff
- // 直接用 services 系统级过滤 → 平台兼容性差
- uni.startBluetoothDevicesDiscovery({
-   services: [BLE_CONFIG.serviceUUID],
-   ...
- })

+ // 不指定 services，全量扫描后软件过滤
+ uni.startBluetoothDevicesDiscovery({
+   allowDuplicatesKey: true,
+   interval: 0,
+   ...
+ })
```

```diff
- // 匹配逻辑：只检查名字前缀
- const isKeyGo = devName.length === 0 || devName.startsWith('KeyGo')

+ // 三重匹配：完整前缀 | 截断前缀 | UUID
+ const fullMatch    = rawName.startsWith('KeyGo')
+ const partialMatch = 'KeyGo'.startsWith(rawName) && rawName.length >= 2
+ const uuidMatch    = advUUIDs.some(uuid => uuid.toUpperCase() === FF00_UUID)
```

```diff
- // 显示名：直接用 localName
- const displayName = device.localName || '未知设备'

+ // 显示名：完整前缀用原名，否则用 deviceId 重建
+ const macClean  = device.deviceId.replace(/:/g, '')
+ const macSuffix = macClean.slice(-6).toUpperCase()
+ const displayName = rawName.startsWith('KeyGo') ? rawName : ('KeyGo-' + macSuffix)
```

### index.vue — 模板 & 连接

```diff
- <text class="device-name">{{ device.localName || device.name }}</text>
+ <text class="device-name">{{ device.name }}</text>
```

```diff
- await bleStore.connect(device.deviceId, device.localName || device.name)
+ await bleStore.connect(device.deviceId, device.name)
```

---

## 七、关于 nrfconnect 模拟 KeyGo-123

在 nrfconnect 中创建 Advertiser，设置：
- **Device Name**: `KeyGo-123`
- **Service UUID**: 不设置（或添加 `0000FF00-...`）

**会被扫描出来吗？会。**

| 条件 | 结果 |
|------|------|
| 只设名字 `KeyGo-123` | ✅ 通过名字完整匹配 |
| 只设 UUID `FF00` | ✅ 通过 UUID 匹配 |
| 名字和 UUID 都不设 | ❌ 不会显示 |
| 设备名设为 `Key` (3字节) | ✅ 通过截断前缀匹配 |

**但这不影响安全**，因为：
1. 你需要真的建立 BLE 连接
2. 连接后要进行 BIND 序列（写入 FF03 特征值）
3. ESP32 固件会校验并写入 MAC 白名单
4. 模拟设备无法完成实际的解锁/锁车 IO 操作

---

## 八、经验总结

| # | 教训 | 一句话 |
|---|------|--------|
| 1 | `services` 过滤器不可靠 | 软件过滤永远是最后兜底 |
| 2 | BLE 广播包只有 31 字节 | 128-bit UUID + 长名字会挤爆，长名进 Scan Response |
| 3 | 微信 API 不给 Scan Response 数据 | 解析 `advertisData` 拿不到完整名 |
| 4 | MAC 地址带冒号 | `slice(-6)` 之前必须 `.replace(/:/g, '')` |
| 5 | `==` 是逐字符比较，`startsWith` 也是 | 截断检测 = 反着用 `startsWith`：`prefix.startsWith(short)` |
| 6 | 数据流链路要对齐 | ble.js 算好 → 模板直接用 → connect 也直接用，不要各算各的 |

---

> 📅 最后更新：2026-06-27
> 🔗 相关文件：`app/BLE_Key_Go_App/utils/ble.js`、`app/BLE_Key_Go_App/pages/index/index.vue`
