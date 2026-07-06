# KeyGo v3.23 智能重连模式 —— 技术设计文档

> 日期：2026-07-06
> 目标：解决"长时间离开 BLE 范围后无法自动重连"问题，让用户可选择功耗/便捷性平衡

---

## 一、问题分析

### 1.1 当前死锁链

```
用户离开车辆（BLE 断连）
  → _handleDisconnect()
  → _startReconnect()
  → 指数退避重连: 0s, 2s, 4s, 8s, 16s, 30s × 6
  → 10 次后放弃 → reconnectMode = 'idle' 💀
  → 总窗口 ≈ 3 分钟
```

### 1.2 两个致命缺陷

| 缺陷 | 说明 | 影响 |
|:--|:--|:--|
| **重连窗口太短** | 10 次指数退避 ≈ 3 分钟，之后永久放弃 | 离开 5 分钟以上回来必定连不上 |
| **盲连无扫描** | `_doReconnect()` 直调 `createBLEConnection(deviceId)`，不先扫描 | Android BLE 缓存 30s 过期，缓存失效后连接直接失败 |

### 1.3 用户场景差异

不同用户对"自动重连"的需求完全不同：

| 用户类型 | 使用频率 | 诉求 |
|:--|:--|:--|
| 每日通勤 | 4-6 次/天 | 自动舒适进入是核心体验，能接受轻微功耗 |
| 低频用户 | 1 次/周 | 后台扫描纯属浪费，宁可用时自己打开 App |
| 电量焦虑 | - | 任何额外耗电都不想要 |

**→ 结论：提供三种模式让用户自选。**

---

## 二、三种模式总览

```
┌─────────────────────────────────────────────┐
│  自动重连模式                               │
│                                             │
│  ● 极速模式（Geofence 地理围栏）             │
│    走到车边就已连好，完全无感                 │
│    额外耗电 ≈ 0.5%/天                       │
│    需要后台定位权限                          │
│                                             │
│  ○ 舒适模式（定时扫描）                      │
│    回到车边 1-2 分钟内自动连上               │
│    额外耗电 ≈ 0.1%/天                       │
│    零额外权限                                │
│                                             │
│  ○ 省电模式（仅手动）                        │
│    打开 App 时才扫描连接                     │
│    零额外耗电                                │
│    零额外权限                                │
└─────────────────────────────────────────────┘
```

### 2.1 横向对比

| | 极速模式 | 舒适模式 | 省电模式 |
|:--|:--|:--|:--|
| **恢复延迟** | 走到车边已就绪 | 0-120 秒 | 需要打开 App |
| **额外功耗** | ≈ 0.5%/天 | ≈ 0.1%/天 | 0 |
| **额外权限** | 后台定位 | 无 | 无 |
| **检测原理** | Geofence + 短扫描 | 2 分钟/次短扫描 | onShow 扫描 |
| **实现复杂度** | 高 | 中 | 低（已有基础） |
| **适合人群** | 每日通勤 | 大部分用户 | 低频/电量焦虑 |

---

## 三、省电模式（改动最小）

### 3.1 行为

- 10 次重连失败 → `reconnectMode = 'idle'`（与现在一致）
- App 从后台切回前台（`onShow`）→ 调用 `_scanAndReconnect()` 而非 `tryAutoConnect()`

### 3.2 核心改动：扫描后重连

```javascript
// 替换原有的 tryAutoConnect → tryReconnect → _doReconnect 盲连
async _scanAndReconnect() {
  // 1. 先做一次短扫描（8 秒，带 service UUID 过滤）
  const devices = await startScan({
    services: [BLE_CONFIG.serviceUUID],
    timeout: 8,
    powerLevel: 'low',
  })

  // 2. 查找目标设备
  const target = devices.find(d => d.deviceId === this.deviceId)
  if (!target) {
    console.log('[Store] _scanAndReconnect: 设备不在范围内')
    return false
  }

  // 3. 用扫描到的 device 连（确保 BLE 缓存已刷新）
  await connectDevice(target.deviceId)
  // ... 后续与服务发现流程相同
}
```

### 3.3 改动范围

| 文件 | 改动 |
|:--|:--|
| `stores/ble.js` | 新增 `_scanAndReconnect()`，省电模式下用此替代 `tryReconnect()` |
| `pages/index/index.vue` | `onShow` 中根据模式选择走 `tryAutoConnect` 还是 `_scanAndReconnect` |
| 设置持久化 | `uni.setStorageSync('auto_reconnect_mode', 'power_save')` |

---

## 四、舒适模式（定时扫描）

### 4.1 状态机

```
连接断开
  → _startReconnect()  → 10 次指数退避（同现逻辑）
  → 全部失败
  → 检查模式：
     ├── 省电模式 → idle（结束）
     └── 舒适/极速模式 → 进入 dormant_poll

dormant_poll 状态：
  每 2 分钟 启动一次短扫描（5 秒, lowPower, serviceUUID 过滤）
    → 发现设备 → 连接
    → 未发现   → 下轮继续

连接成功 → 停止 dormant_poll → 清除定时器
用户主动断开 → 停止 dormant_poll → 回到 dormant（等待用户手动连接）
```

### 4.2 BLE 扫描参数

```javascript
// 低功耗扫描，适合周期性轮询
uni.startBluetoothDevicesDiscovery({
  services: ['0000FF00-0000-1000-8000-00805F9B34FB'], // 硬件级过滤
  allowDuplicatesKey: false,       // 只需首次发现
  interval: 2000,                  // 宽间隔扫描
  powerLevel: 'low',               // 低功耗模式
})
```

### 4.3 功耗估算

| 扫描参数 | 数值 |
|:--|:--|
| 扫描模式 | `lowPower`（约 25mA） |
| 每次扫描时长 | 5 秒 |
| 扫描间隔 | 120 秒（2 分钟） |
| 占空比 | 5 ÷ 120 = 4.2% |
| 平均额外电流 | 25mA × 4.2% ≈ 1.05 mA |
| 额外日耗电 | 1.05mA × 24h ≈ **25 mAh** |
| 占比（4000mAh 电池） | **≈ 0.6%** |

实际低于 0.6%：因扫描期间手机可能已在被 Doze 唤醒处理其他任务，BT 射频的边际功耗更小。

### 4.4 检测延迟分析

CH582M 广播间隔 = 50ms，5 秒扫描窗口内必然捕获：

```
最坏情况：用户刚好在扫描刚结束时进入范围
  → 等待 120 秒 → 下轮扫描 → 发现 → 连接
  → 延迟 = 0 ~ 120 秒

最好情况：用户进入范围时扫描正在进行
  → 1-2 秒内发现 → 连接
  → 延迟 = 1 ~ 2 秒

平均延迟 ≈ 60 秒
```

### 4.5 改动范围

| 文件 | 改动 |
|:--|:--|
| `stores/ble.js` | 新增 `_pollTimer`、`_startDormantPoll()`、`_stopDormantPoll()`、`_doPollScan()` |
| `stores/ble.js` | `_startReconnect()` 末尾：10 次失败后根据模式决定进 `idle` 还是 `dormant_poll` |
| `stores/ble.js` | `_onConnected()` / `_handleDisconnect()` 中管理 poll 生命周期 |
| `pages/index/index.vue` | 设置页 UI：模式选择器 |
| 设置持久化 | `uni.setStorageSync('auto_reconnect_mode', 'comfort')` |

---

## 五、极速模式（Geofence 地理围栏）★

### 5.1 原理

Tesla/蔚来/小鹏 的同款方案：不在手机持续做 BLE 扫描，而是用超低功耗的 GPS Geofence 做触发器。

```
                   ┌──────────────────────────────┐
                   │  手机日常（远离车辆）          │
                   │  Geofence 静默监听            │
                   │  BLE 无线电: 关闭              │
                   │  功耗: ~15 mAh/天 (仅 GPS)      │
                   └──────────────┬───────────────┘
                                  │
                    GPS 检测到进入停车围栏
                                  │
                                  ▼
                   ┌──────────────────────────────┐
                   │  进入围栏后                    │
                   │  启动 BLE 扫描（5s/30s 周期） │
                   │  发现设备 → 连接               │
                   │  连接成功 → 停 BLE 扫描        │
                   │  离开围栏 → 停 BLE 扫描        │
                   └──────────────────────────────┘
```

### 5.2 Geofence 生命周期

```
事件                        → 动作
─────────────────────────────────────────────────────
BLE 断连                    → 获取当前位置 → 创建围栏 → 加入列表
用户进入已注册围栏           → 启动 BLE 轮询扫描
用户离开所有围栏             → 停止 BLE 扫描，仅保留 Geofence 监听
BLE 连接成功                 → 删除该位置围栏（已上车，不需要了）
用户主动断开连接             → 不创建围栏（人为操作，非停车场景）
围栏超过 7 天未触发          → 自动清理
围栏总数 > 8 个              → LRU 淘汰最久未访问的
```

### 5.3 多设备支持

```
场景：一天内使用多辆 KeyGo 车辆

08:00  开 Car A 到公司 → 断开 → 创建围栏 #1 (公司停车场)
12:00  开朋友的 Car B 去吃饭 → 断开 → 创建围栏 #2 (餐厅)
14:00  回到公司 → 进入围栏 #1 → BLE 扫描
       → 发现 Car A (RSSI=-45) + Car B (RSSI=-78)
       → 优先连上次断开的 deviceId (Car A)
       → 如果 Car A 不在，连 RSSI 最强的 ✅

围栏去重策略：
  - 同一位置 (GPS 间距 < 50m) → 合并为 1 个，扩大半径
  - LRU 淘汰，最多保留 8 个围栏
```

### 5.4 技术方案：Google Geofence API

Android 层级依赖：

```
用户层 ──── Vue 设置页（模式选择 + 权限请求）
               │
uni-app 桥 ──── plus.android 调用原生 Geofence API
               │
原生层 ──── GeofencingClient (Google Play Services)
               │
系统层 ──── LocationManager + GPS/WiFi/基站 混合定位
```

**核心 API 调用链：**

```java
// 1. 创建 GeofencingClient
GeofencingClient client = LocationServices.getGeofencingClient(context);

// 2. 构建围栏
Geofence geofence = new Geofence.Builder()
    .setRequestId("parking_" + timestamp)
    .setCircularRegion(lat, lng, 100)  // 半径 100 米
    .setExpirationDuration(7 * 24 * 3600 * 1000)  // 7 天后过期
    .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER)
    .build();

// 3. 注册
GeofencingRequest request = new GeofencingRequest.Builder()
    .addGeofence(geofence)
    .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
    .build();

// 4. 用 PendingIntent 接收回调
Intent intent = new Intent(context, GeofenceReceiver.class);
PendingIntent pi = PendingIntent.getBroadcast(context, 0, intent, FLAG_UPDATE_CURRENT);
client.addGeofences(request, pi);

// 5. BroadcastReceiver 收到进入事件 → 启动 BLE 扫描
```

### 5.5 与现有代码的集成方式

**不侵入现有 BLE Store 状态机**，通过一个新模块 `geofence-trigger.js` 作为桥梁：

```
geofence-trigger.js
  │
  ├── 监听 Geofence 进入事件
  │     → 调用 bleStore._startDormantPoll()
  │     → 扫描间隔加速到 30s（围栏内才高频）
  │
  ├── 监听 Geofence 离开事件
  │     → 调用 bleStore._stopDormantPoll()
  │
  ├── 监听 BLE 断连事件
  │     → 调用 addGeofence(currentLocation)
  │
  └── 监听 BLE 连接事件
        → 调用 removeGeofence(currentLocation)
```

BLE Store 不需要知道 Geofence 的存在——它只提供 `_startDormantPoll(interval)` 和 `_stopDormantPoll()` 两个接口。Geofence 模块决定什么时候调用它们以及用什么频率。

### 5.6 功耗估算

| 组件 | 功耗 | 说明 |
|:--|:--|:--|
| Geofence API 常驻监听 | ~15 mAh/天 | GPS 间歇采样 + WiFi/基站辅助 |
| BLE 扫描（仅围栏内） | ~1.5 mAh/天 | 每天平均 30-60 分钟在围栏内 |
| Geofence BroadcastReceiver | 可忽略 | 事件驱动，无轮询 |
| **总计** | **≈ 17 mAh/天** | **约 0.4% 电池/天** |

### 5.7 需要的权限

manifest.json 新增：

```xml
<!-- 后台定位权限（Geofence 必须） -->
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION"/>
```

已有的权限（无需新增）：
```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>   <!-- ✅ 已有 -->
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/> <!-- ✅ 已有 -->
```

### 5.8 Google Play Services 依赖

Geofence API 依赖 Google Play Services。对于华为/荣耀等没有 GMS 的设备：

```
检测逻辑：
  if (GoogleApiAvailability.isGooglePlayServicesAvailable(context) == SUCCESS)
    → 使用 Google Geofence API
  else
    → 使用华为 HMS Location Kit（需集成 HMS SDK）
    → 或者降级为舒适模式（告知用户"当前设备不支持极速模式"）
```

**注意：华为 HMS 集成需要引入 HMS Core SDK，不在 v3.23 范围内。v3.23 仅实现 GMS 路径，HMS 设备降级到舒适模式。**

### 5.9 改动范围

| 文件 | 改动 |
|:--|:--|
| `manifest.json` | 新增 `ACCESS_BACKGROUND_LOCATION` 权限声明 |
| `utils/geofence-trigger.js` | **新文件**：Geofence 注册/移除/事件监听 + BLE Store 桥接 |
| `utils/location.js` | **新文件**：定位获取（单次精确定位，用于创建围栏） |
| `utils/geofence-receiver.java` 或等价的 plus.android 实现 | **新文件**：BroadcastReceiver 接收 Geofence 事件 |
| `stores/ble.js` | 暴露 `_startDormantPoll(interval)` / `_stopDormantPoll()`，支持可调间隔 |
| `stores/ble.js` | `_handleDisconnect()` 中通知 geofence-trigger 创建围栏 |
| `App.vue` | 初始化时检查模式，极速模式下启动 geofence-trigger |
| 设置页 UI | 模式选择器 + 权限请求引导 |

---

## 六、数据持久化设计

### 6.1 存储 Key

```javascript
// 用户偏好
uni.setStorageSync('auto_reconnect_mode', 'comfort')  // 'geofence' | 'comfort' | 'power_save'
uni.setStorageSync('geo_permission_granted', true)     // 后台定位是否已授权
uni.setStorageSync('geo_fences', JSON.stringify([...])) // 围栏列表（极速模式专用）
```

### 6.2 围栏数据结构

```javascript
{
  id: "fence_1712345678",       // 唯一标识
  lat: 22.5431,                  // 纬度
  lng: 113.9344,                 // 经度
  radius: 100,                   // 半径（米）
  name: "公司停车场",            // 可选：反地理编码
  deviceId: "60:55:F9:71:C6:5A",// 关联的 BLE 设备
  createdAt: 1712345678000,      // 创建时间戳
  lastTriggered: 1712345678000,  // 最后触发时间
}
```

### 6.3 默认值

首次安装默认使用**舒适模式**（零权限，体验尚可）。用户可在设置中切换。

---

## 七、UI 设计规范

### 7.1 设置页布局

```
┌──────────────────────────────────────┐
│  ← 设置                              │
│                                      │
│  ── 自动重连 ──                      │
│                                      │
│  ○ 极速模式                          │
│    靠近车辆自动连接，完全无感          │
│    需授权「后台定位」权限              │
│                                      │
│  ● 舒适模式（推荐）                   │
│    回到车边 1-2 分钟自动连接           │
│    零额外权限，极低功耗                │
│                                      │
│  ○ 省电模式                          │
│    仅打开 App 时连接                  │
│    零额外耗电，适合低频使用            │
│                                      │
│  ──────────────────────────────       │
│                                      │
│  [后台定位权限]   未授权 → 去授权      │
│  （仅极速模式需要）                    │
└──────────────────────────────────────┘
```

### 7.2 切换模式时的交互

```
用户切换到极速模式：
  → 检查后台定位权限
    ├── 已授权 → 启动 Geofence 服务 → 显示 "极速模式已启用"
    └── 未授权 → 弹出权限请求弹窗
                  ├── 同意 → 同「已授权」流程
                  └── 拒绝 → 回退到舒适模式 + Toast "需要后台定位权限才能使用极速模式"

用户切换到舒适/省电模式：
  → 停止 Geofence 服务（如果正在运行）
  → 停止 dormant_poll（省电模式）
  → 即时生效
```

---

## 八、实现计划

### Phase 1：基础架构（舒适模式 + UI）

| 任务 | 预估 | 文件 |
|:--|:--|:--|
| BLE Store 增加 `_startDormantPoll()` / `_stopDormantPoll()` | 2h | `stores/ble.js` |
| `_startReconnect()` 末尾分支：省电 → idle / 舒适 → dormant_poll | 0.5h | `stores/ble.js` |
| 设置页 UI（单选组） + 持久化 | 1.5h | 设置页 vue |
| `_scanAndReconnect()`：onShow 扫描后连接（省电模式用） | 1h | `stores/ble.js` |
| 真机测试 + 日志 | 1h | - |
| **Phase 1 小计** | **6h** | |

### Phase 2：极速模式

| 任务 | 预估 | 文件 |
|:--|:--|:--|
| `manifest.json` 增加后台定位权限 | 0.5h | `manifest.json` |
| `utils/location.js`：单次精确定位 | 1.5h | `utils/location.js` |
| `utils/geofence-trigger.js`：Geofence 注册/事件/桥接 | 3h | `utils/geofence-trigger.js` |
| `utils/geofence-receiver.java`：BroadcastReceiver | 1.5h | native |
| 设置页：极速模式 UI + 权限请求流程 | 1h | 设置页 vue |
| 华为/荣耀 GMS 检测 + 降级逻辑 | 1h | `utils/geofence-trigger.js` |
| 多围栏管理（去重/LRU/7天过期） | 1h | `utils/geofence-trigger.js` |
| 真机测试（含出入围栏/多设备/权限拒绝场景） | 2h | - |
| **Phase 2 小计** | **11.5h** | |

### 总计：约 17.5 小时

---

## 九、风险与兜底

| 风险 | 概率 | 影响 | 兜底策略 |
|:--|:--|:--|:--|
| Android Doze 延迟 dormant_poll 定时器 | 高 | 扫描间隔可能被拉长到 15 分钟 | 可接受，仍远好于永不重连 |
| 华为没 GMS，极速模式不可用 | 中 | 功能缺失 | 自动降级到舒适模式 + 提示 |
| 用户拒绝后台定位权限 | 中 | 极速模式不可用 | 回退到舒适模式 |
| BLE 扫描在 Doze 中被挂起 | 低 | 扫描超时失败 | 扫描前获取 WakeLock（已有） |
| 多围栏 Battery drain | 低 | GPS 采样增加 | LRU 限制 8 个，功耗可控 |
| 同一停车场多辆 KeyGo | 低 | 连到别人车 | RSSI 优先连最近的 + deviceId 匹配 |

---

## 十、附录：CH582M 广播参数参考

```
固件广播间隔: 80 × 0.625ms = 50ms
每秒广播次数: 20 次
广播包长度: ≈ 25 bytes（含 Flags + Appearance + UUID + 电量）
扫描响应包: 动态构建，含设备名（KeyGo-XXXXXX）

结论：50ms 的广播频率足够快，任何 ≥ 1s 的扫描窗口
     都能在 ~100ms 内捕获广播包。
```

---

## 十一、附录：关键代码位置速查

| 功能 | 文件 | 位置 |
|:--|:--|:--|
| 重连循环 | `stores/ble.js` | `_startReconnect()` (L768) |
| 单次重连 | `stores/ble.js` | `_doReconnect()` (L846) |
| 10 次放弃 | `stores/ble.js` | L824-831 |
| 连接回调 | `stores/ble.js` | `_onConnected()` (L930+) |
| 异常断连 | `stores/ble.js` | `_handleDisconnect()` (L680+) |
| 扫描入口 | `utils/ble.js` | `startScan()` (L460+) |
| 扫描参数 | `utils/ble.js` | L525-528 |
| 设备过滤 | `utils/ble.js` | `_deviceFoundCallback` (L470+) |
| 前台服务 | `utils/foreground-service.js` | `startForegroundService()` (L410) |
| 权限列表 | `manifest.json` | L23-35 |
| 广播间隔 | `peripheral.h` | `DEFAULT_ADVERTISING_INTERVAL = 80` |
