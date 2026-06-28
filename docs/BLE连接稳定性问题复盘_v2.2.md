# BLE 连接稳定性问题复盘（v2.2）

> 日期：2026-06-27  
> 项目：KeyGo BLE 车钥匙 UniApp 客户端  
> 涉及文件：`stores/ble.js`、`utils/ble.js`、`pages/index/index.vue`

---

## 一、问题总览

本次共修复 **5 个并发/时序竞态问题**，按发现顺序排列：

| # | 问题 | 症状 | 严重度 |
|---|------|------|--------|
| 1 | 断开后按钮卡在"扫描中..." | `disconnect()` 没重置 `scanning`，UI 卡死 | ⭐⭐ |
| 2 | 断开后立即扫描静默失败 | 蓝牙协议栈释放中启动扫描，无结果返回 | ⭐⭐⭐ |
| 3 | 多次重连后监听器堆积 | 同一个 Notify/连接回调被重复触发多次 | ⭐⭐⭐⭐ |
| 4 | 扫描出现两个同名设备 | RSSI 轮询的野定时器和残留监听器背刺新扫描 | ⭐⭐⭐ |
| 5 | 断开后设备列表"复活" | `_scanTimer` 到期后把旧设备覆盖回已清空的列表 | ⭐⭐⭐⭐ |

---

## 二、逐个详析

### Bug 1：断开后按钮卡在"扫描中..."

**症状**：用户点断开后，扫描按钮仍然显示"扫描中..."，无法再次扫描。

**根因**：`disconnect()` 只重置了 `connected`、`deviceId` 等字段，但忘了把 `scanning` 设为 `false`。如果断开时上一次扫描的 `finally` 还没执行，按钮就卡死。

**修复位置**：`stores/ble.js` → `disconnect()`

```javascript
// 新增一行
this.scanning = false   // ★ 强制复位扫描状态
```

---

### Bug 2：断开后立即扫描静默失败

**症状**：断开连接后立即点"扫描设备"，App 不报任何错，但设备列表就是空的。等几秒再扫就正常。

**根因**：蓝牙协议栈在收到 `closeBLEConnection` 后需要 ~500ms 释放连接资源。在这期间启动 `startBluetoothDevicesDiscovery` 会静默失败——API 不抛错，但也不发现设备。

**修复**：`disconnect()` 末尾设 500ms 冷却期，`startScanDevices()` 开头检查冷却状态并自动等待。

**修复位置**：`stores/ble.js` → `disconnect()` + `startScanDevices()`

```javascript
// disconnect() 末尾
this._coolingDown = true
setTimeout(() => { this._coolingDown = false }, 500)

// startScanDevices() 开头
if (this._coolingDown) {
    await new Promise(r => {
        const check = () => {
            if (!this._coolingDown) return r()
            setTimeout(check, 100)
        }
        check()
    })
}
```

---

### Bug 3：多次重连后监听器堆积（最隐蔽）

**症状**：第一次连接正常，第二次断开再连可能开始出现状态闪烁，第三条连接后设备状态反复跳变，Notify 数据被重复处理。

**根因**：`ble.js` 的 `onBLEConnectionStateChange()` 和 `onBLECharacteristicValueChange()` 每次调用只在 `uni` 上**累加**监听器，从不移除。`disconnect()` 也没做清理。

```
第 1 次 connect()：uni 上注册 1 个 connectStateChange 回调 + 1 个 valueChange 回调
第 2 次 connect()：uni 上注册 2 个 + 2 个（旧的还在）
第 3 次 connect()：uni 上注册 3 个 + 3 个 ← 现在有 6 个回调在监听同一个 deviceId
```

ESP32 每次 Notify 一段数据，3 个回调**全部命中**，`_handleStatusNotify` 被调用 3 次。

**修复**：`disconnect()` 开头用 `uni.off*()` 无参调用清空所有监听器（不传 callback = 清空全部）。

**修复位置**：`stores/ble.js` → `disconnect()` 开头

```javascript
try { uni.offBLEConnectionStateChange() } catch {}
try { uni.offBLECharacteristicValueChange() } catch {}
```

**关键点**：不带 callback 参数调用 `off*` 会清空**所有**注册的回调，是最彻底的清理方式。

---

### Bug 4：扫描出现两个同名设备

**症状**：偶尔设备列表中出现两个一模一样的 KeyGo 设备。用了 `Set` 去重仍出现。

**根因分析（两次深挖才定位）**：

#### 4a：`_stopRssiPolling()` 没 `offBluetoothDeviceFound`

```javascript
// 旧代码：只 stop 了扫描，没 off 监听器
uni.stopBluetoothDevicesDiscovery({ ... })
// ← 遗漏：uni.offBluetoothDeviceFound(this._rssiScanListener)
```

断开后，RSSI 轮询虽然被停了，但 `onBluetoothDeviceFound` 的监听器还挂在 `uni` 上。用户再点扫描时，旧的 RSSI 回调会和新扫描的回调**同时触发**，导致同一个设备被 `push` 进 `devices` 数组两次。

**修复**：先 `off` 再 `stop`。

```javascript
uni.offBluetoothDeviceFound(this._rssiScanListener)  // ★ 先移除监听
uni.stopBluetoothDevicesDiscovery({ ... })            // ♻ 再停扫描
```

#### 4b：`_doRssiScan()` 的 500ms 野定时器

```javascript
// _doRssiScan 内部
setTimeout(() => {
    uni.stopBluetoothDevicesDiscovery({ ... })  // ← 500ms 后停扫描
}, 500)
```

时序炸弹：
```
t=0ms:  用户点扫描 → startScanDevices() → 启动 discovery
t=300ms: _stopRssiPolling() 被调用（但野 setTimeout 没被清）
t=500ms: 野 setTimeout 触发 → stopBluetoothDevicesDiscovery → 新扫描被掐断
```

**修复**：把 `setTimeout` ID 存起来，`_stopRssiPolling` 里 `clearTimeout`。

```javascript
// 存引用
this._rssiScanTimeout = setTimeout(() => {
    this._rssiScanTimeout = null
    uni.stopBluetoothDevicesDiscovery({ ... })
}, 500)

// _stopRssiPolling 里清掉
if (this._rssiScanTimeout) {
    clearTimeout(this._rssiScanTimeout)
    this._rssiScanTimeout = null
}
```

同时为保险起见，`startScanDevices()` 开头加一道兜底：
```javascript
try { uni.offBluetoothDeviceFound() } catch {}  // 无参 = 清空全部
```

---

### Bug 5：断开后设备列表"复活"（最隐蔽的时序炸弹）

**症状**：用户断开连接后设备列表是空的，但过了几秒突然又凭空出现了设备。或者连接成功后设备列表被旧扫描结果覆盖。

**根因**：`ble.js` 的 `startScan()` 用 `_scanTimer` 管理 12 秒超时，到期后 `resolve(devices)`。`_scanTimer` 是模块级变量，Store 层无法控制，`disconnect()` 也清不掉它。

时序：
```
t=0s:  用户点扫描 → _scanTimer = setTimeout(12秒后 resolve)
t=3s:  扫到设备 → 点连接 → devices = []
t=5s:  操作完 → 点断开 → devices = []
t=12s: _scanTimer 到期 → resolve(devices) → this.devices = devices
        → 🔥 设备列表被"复活"了！
```

**修复**：不打断定时器（避免 Promise 悬挂），而是在扫描结果回来时加判断——如果已连接或已被中止，丢弃结果。

**修复位置**：`stores/ble.js`

```javascript
// 新增标记
_scanAborted: false

// disconnect() 第一行设标记
this._scanAborted = true

// startScanDevices() 中扫描结果回来后判废
const devices = await startScan(...)
if (this.connected || this._scanAborted) {
    this._scanAborted = false
    return devices          // ← 不执行 this.devices = devices
}
this.devices = devices      // ← 正常情况才覆盖
```

**设计思路**：让定时器自然走完，不制造悬挂 Promise，但在数据落盘前加安全检查。`connected` 为 true 时丢弃（覆盖场景 ②：连接中旧扫描完成），`_scanAborted` 为 true 时丢弃（覆盖场景 ①：断开后旧扫描完成）。

---

## 三、最终状态梳理

### `stores/ble.js` 新增的非响应式属性

| 属性 | 用途 | 初始值 |
|------|------|--------|
| `_coolingDown` | 断开后 500ms 冷却期标记 | `false` |
| `_rssiScanTimeout` | `_doRssiScan` 内部 500ms setTimeout 引用 | `null` |
| `_rssiScanListener` | RSSI 轮询的 deviceFound 回调引用 | `null` |
| `_scanAborted` | 标记进行中的扫描结果应被丢弃 | `false` |

### `disconnect()` 完整清理流程

```
1. _scanAborted = true            ← 宣告旧扫描作废
2. _stopRssiPolling()             ← 清 interval / setTimeout / off 监听器 / stop discovery
3. offBLEConnectionStateChange()  ← 清空连接状态回调
4. offBLECharacteristicValueChange() ← 清空 Notify 回调
5. closeBLEConnection(deviceId)   ← 断开物理连接
6. 重置所有状态字段               ← connected/deviceId/scanning/deviceState/rssi...
7. _coolingDown = true            ← 设 500ms 冷却期
```

### `startScanDevices()` 完整安全流程

```
1. 等待 _coolingDown 结束（轮询）  ← 防止蓝牙栈未就绪
2. offBluetoothDeviceFound()        ← 防御性清理残留监听
3. initBluetooth()                  ← 确保适配器就绪
4. scanning = true, devices = []
5. await startScan(...)
6. 检查 connected / _scanAborted   ← 判废，防止复活设备列表
7. finally: scanning = false
```

---

## 四、经验总结

1. **`uni.on*` 必须配 `uni.off*`**：微信小程序的 BLE API 是全局单例模式，不 off 就是永久泄漏。断开/页面销毁时必须清。
2. **带 `setTimeout` 的异步操作必须有取消机制**：野定时器是时序炸弹。存引用、clearTimeout。
3. **蓝牙断开后需要冷静期**：协议栈资源释放不是即时的，~500ms 是多人验证的经验值。
4. **长 Promise 的 resolve 要考虑上下文有效性**：扫描了 12 秒，resolve 时可能已经连接、已经断开、已经不在同一页了。在 resolve 下游加判废标记比打断 Promise 更安全（打断可能导致 Promise 悬挂、内存泄漏）。
5. **先 off 再 stop，顺序重要**：`offBluetoothDeviceFound` → `stopBluetoothDevicesDiscovery`，如果反过来，stop 到 off 之间可能还有回调插入。

---

## 五、涉及文件修改汇总

| 文件 | 改动点 | 行数 |
|------|--------|------|
| `stores/ble.js` | 5 个 Bug 的全部修复，新增 4 个非响应式属性 | ~30 行 |
| `utils/ble.js` | 无改动（工具层保持纯净，清理在 Store 层统一完成） | 0 |
| `pages/index/index.vue` | 无改动 | 0 |

所有修改集中在 Store 层的 `disconnect()`、`_stopRssiPolling()`、`_doRssiScan()`、`startScanDevices()` 四个方法中，逻辑清晰，不破坏现有架构。
