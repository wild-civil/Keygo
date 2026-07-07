# KeyGo v3.23 智能重连模式 —— 技术设计文档

> 版本：v1.0.1
> 日期：2026-07-07
> 基于 v1.0.0，重新设计舒适模式（亮屏触发）和极速模式（加速度计+GPS围栏+心跳兜底）
> 
> 改动背景：原定时扫描方案在荣耀等深度管控机型上，锁屏 2h+ 后因"高耗电应用"判定导致进程被杀，
> 重连彻底失效。新方案以"零后台额外功耗"为核心目标，让系统找不到杀你的理由。
> 
> 备份：v1.0.0 保留为原始版本，不做修改。

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
│  ● 极速模式（运动感知 + GPS 围栏）           │
│    加速度计感知运动，GPS 唤醒确认位置         │
│    走到车边就已连好，完全无感                 │
│    额外耗电 ≈ 0.2%/天                       │
│    需要后台定位权限                          │
│                                             │
│  ○ 舒适模式（亮屏触发）★ 推荐                 │
│    解锁手机即可自动连接                      │
│    零后台额外功耗，零额外权限                │
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
| **恢复延迟** | 走到车边已就绪 | 亮屏后 2-8 秒 | 需要打开 App |
| **额外功耗** | ≈ 0.2%/天 | ≈ 0.01%/天 | 0 |
| **额外权限** | 后台定位 | 无 | 无 |
| **检测原理** | 加速度计→缓存GPS→条件扫描 + GPS围栏 + 心跳兜底 | 亮屏→延迟2s→扫描8s→连接 | onShow 扫描 |
| **后台轮询** | 无（加速度计 SoC 级，~0.5mA） | 无（完全事件驱动） | 无 |
| **续航影响** | 极小（传感器常开 + 条件扫描） | 几乎为零（仅亮屏时触发） | 零 |
| **实现复杂度** | 高 | 低 | 低（已有基础） |
| **适合人群** | 每日通勤，追求无感体验 | 大部分用户 ★默认 | 低频/电量焦虑 |

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

## 四、舒适模式（亮屏触发）★ 默认

### 4.1 设计理念

**核心思路：不做任何后台轮询，完全事件驱动。**

v1.0.0 的"2分钟定时扫描"方案有两个致命问题：
- `setInterval` 在 Doze 深度阶段被冻结
- 即使靠 AlarmManager 兜底（如现有代码），荣耀系统管家也会在 60 分钟后标记"高耗电应用"
- 进程一旦被杀，所有动态注册的 BroadcastReceiver 失效，重连永久哑火

**亮屏触发方案**：只在用户**亮屏/解锁**的瞬间执行一次 BLE 扫描。
- 零后台额外功耗 → 系统管家没有理由标记"高耗电"
- 进程存活概率最大化 → 亮屏时动态 Receiver 必然存活
- 覆盖最高频用车场景：用户掏手机 → 亮屏 → 自动连接

### 4.2 触发时序

```
用户从口袋掏出手机
  → 抬手亮屏 / 按电源键 / 指纹/面部解锁
  → BroadcastReceiver: Intent.ACTION_SCREEN_ON (或 ACTION_USER_PRESENT)
  → JS 回调：_onScreenOn()
  → wait 2000ms（等待解锁动画、系统 UI 渲染完成）
  → 前置检查：
     ├── BLE 已连接？ → 跳过（已连上了）
     ├── BLE 适配器未初始化？ → 跳过
     ├── 最近 30s 内扫描过？ → 跳过（防止频繁亮屏重复扫描）
     └── 需要扫描？ → _doScreenOnScan()
  → 8 秒 BLE 扫描（lowPower, serviceUUID 过滤）
  → 发现目标设备 → 连接 → 连接成功才停扫描
  → 8s 内未发现 → 静默结束（不重试，等下次亮屏）
```

### 4.3 扫描+连接闭环（确保真正连上）

**关键原则：扫描到设备 ≠ 连接成功，必须等待连接确认后才停扫描。**

```
_doScreenOnScan():
  startScan(8s, lowPower, serviceUUID)
  
  onDeviceFound(foundDeviceId):
    if (foundDeviceId === targetDeviceId):
      // 不立即停止扫描！先尝试连接
      connectDevice(foundDeviceId)
      
      onConnected:
        → stopScan()                    ✅ 真正连上了
        → 标记 scanId = null
      
      onConnectFail / timeout(10s):
        → 连接失败，继续扫描（还在 8s 窗口内）
        → 如果再次发现设备 → 再次尝试连接
        → 最多重试 2 次连接
  
  8s 扫描窗口到期:
    → stopScan()
    → if 连接未成功 → 30s 后再试一次（二阶段重试）
```

**为什么这么做**：
- BLE 扫描窗口内，设备广播是持续的 → 即使第一次连接失败，设备仍在广播
- 连接失败常见原因：设备正忙（正在被其他 App 连接尝试）、信号瞬间抖动
- 不提前停扫描 → 给了连接失败后的"原地复活"机会

### 4.4 亮屏检测实现

```javascript
// 在 App.vue 或 foreground-service 中注册
const Intent = plus.android.importClass('android.content.Intent')
const IntentFilter = plus.android.importClass('android.content.IntentFilter')

const screenOnFilter = new IntentFilter()
screenOnFilter.addAction(Intent.ACTION_SCREEN_ON)
screenOnFilter.addAction(Intent.ACTION_USER_PRESENT)

const screenReceiver = plus.android.implements('io.dcloud.feature.internal.reflect.BroadcastReceiver', {
  onReceive(context, intent) {
    const action = intent.getAction()
    if (action === Intent.ACTION_SCREEN_ON || action === Intent.ACTION_USER_PRESENT) {
      // 通知 JS 层
      uni.$emit('screen_on')
    }
  }
})

const main = plus.android.runtimeMainActivity()
main.registerReceiver(screenReceiver, screenOnFilter)
```

**注意**：`ACTION_USER_PRESENT` 仅在有锁屏密码时触发（用户真正解锁后），比 `SCREEN_ON` 更精准，但无锁屏用户只收到 `SCREEN_ON`。两者都注册，内部做去重（2s 内重复触发忽略）。

### 4.5 功耗分析

| 指标 | v1.0.0 定时扫描 | v1.0.1 亮屏触发 |
|:--|:--|:--|
| 后台持续功耗 | WakeLock + setInterval + AlarmManager | **零** |
| 一天扫描次数 | 720 次（每 2min） | 50-100 次（每次亮屏） |
| 一天扫描总时长 | 720 × 5s = 3600s | 100 × 8s = 800s |
| 额外日耗电 | ~25 mAh | ~3 mAh |
| 占比（4000mAh） | ≈ 0.6% | **≈ 0.08%** |
| 系统管家标记"高耗电"概率 | 高（WakeLock 持续持有） | **极低**（无可标记项） |

### 4.6 适用场景分析

| 场景 | 能否重连？ | 说明 |
|:--|:--|:--|
| 走到车边，掏手机亮屏 | ✅ 完美 | 最典型的用车场景 |
| 手机在支架上，到车附近亮屏导航 | ✅ 完美 | 亮屏时自动扫到设备 |
| 手机在口袋/包里走向车 | ❌ 不触发 | 屏幕没亮。如需覆盖 → 升级极速模式 |
| 在家/办公室频繁亮屏看手机 | 扫描但找不到 | 5s 扫描后静默结束，功耗可忽略 |
| 锁屏长时间后（2h+） | ✅ 可重连 | 只要进程活着，亮屏时的 Receiver 就能触发 |
| 进程被系统杀了 | ❌ 不行 | 下一版本考虑 WorkManager 15min 保底 |

### 4.7 改动范围

| 文件 | 改动 |
|:--|:--|
| `utils/foreground-service.js` | 新增 `registerScreenOnReceiver()` / `unregisterScreenOnReceiver()` |
| `stores/ble.js` | 新增 `_onScreenOn()`、`_doScreenOnScan()`；删除原 `_pollTimer`、`_startDormantPoll` 定时扫描逻辑 |
| `App.vue` | 初始化时注册 `uni.$on('screen_on', bleStore._onScreenOn)` |
| `pages/config/config.vue` | 更新舒适模式描述为"解锁手机即可自动连接，零后台功耗" |
| 设置持久化 | `uni.setStorageSync('auto_reconnect_mode', 'comfort')` |

---

## 五、极速模式（运动感知 + GPS 围栏 + 心跳兜底）★

### 5.1 设计理念

v1.0.0 的单层 GPS 围栏方案在深度后台有致命缺陷：Doze 导致 `watchPosition` 回调被抑制到 15 分钟一次，GPS 芯片冷启动超时 → 围栏检测失败 → 用户走到车边也连不上。

v1.0.1 采用**三层触发器"或"逻辑**，任意一层命中即启动 BLE 扫描：

```
┌─────────────────────────────────────────────────┐
│              极速模式 三层触发器                    │
│                                                   │
│  第一层：加速度计（运动感知）                       │
│    检测到走路/拿起手机 → 读缓存GPS                   │
│      → 在围栏附近（500m内）→ 获取GPS确认            │
│      → 在围栏内 → BLE 扫描 ✅                      │
│      → 不在围栏内 → 跳过（省电）                    │
│                                                   │
│  第二层：GPS 围栏（位置感知）                       │
│    watchPosition 持续监听                          │
│    → 进入停车围栏 100m 半径 → BLE 扫描 ✅           │
│                                                   │
│  第三层：心跳兜底（终极保底）                        │
│    AlarmManager 每 5 分钟触发                     │
│    → 读 GPS + 围栏判断 + BLE 扫描 -----------------│
│                                                   │
│  任意命中 → 启动 BLE 扫描 → 连接成功 → 停止一切     │
└─────────────────────────────────────────────────┘
```

### 5.2 第一层：加速度计（运动感知）

**原理**：加速度计是 SoC 自带传感器，功耗 ~0.5 mA（可忽略）。手机 SOC 里的 Sensor Hub 持续运行加速度计，不需要 CPU 唤醒。

```
加速度数据流（高频采样 ~20Hz）：
  
  原始数据 (x, y, z) 
    → 低通滤波（去重力分量，保留运动分量）
    → 特征提取：
        ├── 走路：周期性 1.5-2Hz 波动，幅度 0.3-0.6g
        ├── 拿起手机：大幅突变（>0.8g 阶跃变化）
        ├── 骑车/开车：小幅持续振动
        └── 静止：合加速度 ≈ 9.8 (±0.1)
  
  → 检测到运动特征 → _onMotionDetected()
```

**防抖策略（关键：降低误触发功耗）**：

```javascript
_onMotionDetected():
  
  // 1. 防重复：30s 内不重复触发
  if (Date.now() - lastMotionTrigger < 30000) return
  
  // 2. 读缓存 GPS（零功耗，上次定位结果）
  const cachedPos = getCachedPosition()
  
  // 3. 判断距离
  if (!cachedPos) {
    // 无缓存 → 获取一次 GPS（冷启动可能 2-5s）
    const pos = await getCurrentPositionCoarse()
    if (!pos) return  // GPS 获取失败，跳过
    updateCache(pos)
    cachedPos = pos
  }
  
  // 4. 计算距离最近围栏
  const nearestFence = getNearestFence(cachedPos)
  const distance = calculateDistance(cachedPos, nearestFence)
  
  // 5. 功耗阶梯策略
  if (distance > 500) {
    // 远离所有围栏 → 跳过，不获取 GPS ✅ 省电
    // 下次触发间隔扩大到 5 分钟（降低误触发频率）
    lastMotionTrigger = Date.now()  // 但不延长间隔
    return
  }
  
  if (distance > nearestFence.radius) {
    // 在围栏附近（500m 内）但不在围栏核心 → 需要确认 GPS
    const freshPos = await getCurrentPositionCoarse()
    if (!freshPos) return
    updateCache(freshPos)
    const freshDistance = calculateDistance(freshPos, nearestFence)
    if (freshDistance > nearestFence.radius) return  // 确认不在
  }
  
  // 6. 在围栏内！→ 启动 BLE 扫描
  lastMotionTrigger = Date.now()
  this._doDormantScan()  // 8s 扫描 + 连接
```

**功耗阶梯——核心优化：**

| 用户位置 | 加速度触发后行为 | 每次触发代价 |
|:--|:--|:--|
| 远离所有围栏（>500m） | 加速度计 → 读缓存 GPS → 跳过 | ~0（仅读内存） |
| 围栏附近（100-500m） | 加速度计 → 读缓存 GPS → 获取一次 GPS → 跳过 | ~GPS 获取 2s |
| 在围栏内（<100m） | 加速度计 → 读缓存 GPS → 获取 GPS 确认 → BLE 扫描 8s | ~GPS 2s + BLE 8s |

### 5.3 第二层：GPS 围栏（位置感知）

与 v1.0.0 原有的 Geofence 方案基本一致，但作为**第二层触发器**而不是唯一触发器。

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
                   │  启动 BLE 扫描（8s/30s 周期） │
                   │  发现设备 → 连接               │
                   │  连接成功 → 停 BLE 扫描        │
                   │  离开围栏 → 停 BLE 扫描        │
                   └──────────────────────────────┘
```

**注意**：在 Deep Doze 下 `watchPosition` 回调间隔被拉长到 15 分钟，GPS 围栏作为唯一触发器不可靠。但在浅后台（5 分钟内）或亮屏时，回调频率正常，所以围栏仍是有效的辅助触发器。

### 5.4 第三层：心跳兜底（终极保底）

AlarmManager 每 5 分钟触发一次，作为最终兜底：

```
AlarmManager(5min) → BroadcastReceiver → JS 回调 _onHeartbeatTick()
  → 读一次 GPS + 围栏判断
    → 在任一围栏内 → BLE 扫描 ✅
    → 不在 → 静默跳过
```

**为什么是 5 分钟而不是 60s**：
- 60s 心跳会持续唤醒 CPU → 系统管家判定"高耗电" → 杀进程
- 5 分钟间隔 → 每小时仅唤醒 12 次 → 不被系统管家关注
- 与加速度计的防抖间隔（不在围栏内时也是 5min）对齐

### 5.5 扫描+连接闭环（三层共用）

不论哪个触发器命中，最终调用同一个 `_doDormantScan()`，确保扫描+连接可靠性：

```
_doDormantScan():
  startScan(8s, lowPower, serviceUUID)
  
  onDeviceFound(foundDeviceId):
    if (foundDeviceId === targetDeviceId):
      connectDevice(foundDeviceId)
      
      onConnected:
        → stopScan()                    ✅ 真正连上了
      
      onConnectFail(10s超时):
        → 继续扫描（还在 8s 窗口）
        → 再次发现 → 再次连接（最多 2 次）
  
  8s 窗口到期:
    → stopScan()
    → if 未连接成功:
        → 30s 后重试（最多 3 次）
        → 3 次都失败 → 等下一次触发器命中
```

### 5.6 功耗估算

| 组件 | 功耗 | 说明 |
|:--|:--|:--|
| 加速度计常驻 | ~0.5 mA | SoC 自带 Sensor Hub，CPU 不唤醒 |
| GPS 围栏监听 (watchPosition) | ~15 mAh/天 | 网络定位（低精度模式） |
| 加速度计误触发（远离围栏时读缓存） | 可忽略 | 仅读内存，不启动 GPS/BLE |
| 加速度计命中触发（围栏附近 GPS 获取） | ~2 mAh/天 | 仅进入 500m 范围后才获取 |
| BLE 扫描（仅围栏内 + 触发命中时） | ~1 mAh/天 | 每天约 30-60 分钟在围栏内 |
| AlarmManager 心跳 (5min 保底) | 可忽略 | ~1ms CPU 唤醒 × 288 次/天 |
| **总计** | **≈ 18 mAh/天** | **约 0.45% 电池/天** |

对比 v1.0.0 的方案（~17 mAh/天），功耗几乎不变，但可靠性大幅提升（三层"或"逻辑）。

### 5.7 多设备支持

```
场景：一天内使用多辆 KeyGo 车辆

08:00  开 Car A 到公司 → 断开 → 创建围栏 #1 (公司停车场)
12:00  开朋友的 Car B 去吃饭 → 断开 → 创建围栏 #2 (餐厅)
14:00  回到公司 → 加速度计感知走路 → 读缓存 GPS → 距离围栏#1 50m → GPS确认 → BLE扫描
       → 发现 Car A (RSSI=-45) + Car B (RSSI=-78)
       → 优先连上次断开的 deviceId (Car A)
       → 如果 Car A 不在，连 RSSI 最强的 ✅

围栏去重策略：
  - 同一位置 (GPS 间距 < 50m) → 合并为 1 个，扩大半径
  - LRU 淘汰，最多保留 8 个围栏
```

### 5.8 Geofence 生命周期

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

### 5.9 技术方案：Google Geofence API（与 v1.0.0 一致）

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

### 5.10 与现有代码的集成方式

**不侵入现有 BLE Store 状态机**，通过 `geofence-trigger.js` + `motion-trigger.js` 作为桥梁：

```
motion-trigger.js (加速度计层)
  │
  ├── 监听加速度计运动事件
  │     → 读缓存 GPS → 距离判断
  │     → 在围栏内 → bleStore._doDormantScan()
  │
geofence-trigger.js (GPS 围栏层)
  │
  ├── 监听 Geofence 进入事件
  │     → bleStore._startDormantPoll(30s)  // 围栏内高频扫描
  │
  ├── 监听 Geofence 离开事件
  │     → bleStore._stopDormantPoll()
  │
  ├── 监听 BLE 断连事件
  │     → addGeofence(currentLocation)
  │
  └── 监听 BLE 连接事件
        → removeGeofence(currentLocation)
```

### 5.11 需要的权限

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

### 5.12 Google Play Services 依赖

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

### 5.13 改动范围

| 文件 | 改动 |
|:--|:--|
| `manifest.json` | 新增 `ACCESS_BACKGROUND_LOCATION` 权限声明 |
| `utils/motion-trigger.js` | **新文件**：加速度计采样 + 运动特征检测 + 缓存GPS判距 + BLE Store 桥接 |
| `utils/geofence-trigger.js` | **新文件**：Geofence 注册/移除/事件监听 + BLE Store 桥接 |
| `utils/location.js` | **新文件**：定位获取（单次精确定位，用于创建围栏 + 加速度运动确认） |
| `utils/geofence-receiver.java` 或等价的 plus.android 实现 | **新文件**：BroadcastReceiver 接收 Geofence 事件 |
| `stores/ble.js` | 暴露 `_doDormantScan()`、`_startDormantPoll(interval)`、`_stopDormantPoll()` |
| `stores/ble.js` | `_handleDisconnect()` 中通知 geofence-trigger 创建围栏 |
| `utils/foreground-service.js` | 新增 AlarmManager 5min 心跳（终极兜底） |
| `App.vue` | 初始化时检查模式，极速模式下启动 motion-trigger + geofence-trigger |
| 设置页 UI | 模式选择器 + 权限请求引导 |

---

## 六、数据持久化设计

### 6.1 存储 Key

```javascript
// 用户偏好
uni.setStorageSync('auto_reconnect_mode', 'comfort')  // 'extreme' | 'comfort' | 'power_save'
uni.setStorageSync('geo_permission_granted', true)     // 后台定位是否已授权
uni.setStorageSync('geo_fences', JSON.stringify([...])) // 围栏列表（极速模式专用）
uni.setStorageSync('last_known_position', JSON.stringify({ lat, lng, ts })) // 缓存GPS（加速度计判距用）
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
│    运动感知 + 位置围栏，走到车边已连接 │
│    需授权「后台定位」权限              │
│                                      │
│  ● 舒适模式（推荐）                   │
│    解锁手机即可自动连接               │
│    零后台功耗，零额外权限             │
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
    ├── 已授权 → 启动加速度计 + Geofence 服务 → 显示 "极速模式已启用"
    └── 未授权 → 弹出权限请求弹窗
                  ├── 同意 → 同「已授权」流程
                  └── 拒绝 → 回退到舒适模式 + Toast "需要后台定位权限才能使用极速模式"

用户切换到舒适/省电模式：
  → 停止加速度计监听（如果正在运行）
  → 停止 Geofence 服务（如果正在运行）
  → 停止 AlarmManager 心跳（如果正在运行）
  → 即时生效
```

---

## 八、实现计划

### Phase 1：基础架构（舒适模式亮屏触发 + UI）

| 任务 | 预估 | 文件 |
|:--|:--|:--|
| 前台服务注册 SCREEN_ON BroadcastReceiver + uni.$emit 桥接 | 1.5h | `utils/foreground-service.js` |
| BLE Store 新增 `_onScreenOn()`、`_doScreenOnScan()`（8s 扫描+连接闭环） | 2h | `stores/ble.js` |
| 防重复逻辑：30s 内不重复扫描、已连接跳过 | 0.5h | `stores/ble.js` |
| App.vue 监听 `uni.$on('screen_on')` + 根据模式分流 | 0.5h | `App.vue` |
| `_scanAndReconnect()`：onShow 扫描后连接（省电模式用） | 1h | `stores/ble.js` |
| 设置页 UI（单选组）+ 持久化 | 1h | `pages/config/config.vue` |
| 真机测试 + 日志（亮屏触发验证） | 1h | - |
| **Phase 1 小计** | **7.5h** | |

### Phase 2：极速模式（加速度计 + GPS 围栏 + 心跳兜底）

| 任务 | 预估 | 文件 |
|:--|:--|:--|
| `manifest.json` 增加后台定位权限 | 0.5h | `manifest.json` |
| `utils/location.js`：单次精确定位 + 缓存GPS 读写 | 1.5h | `utils/location.js` |
| `utils/motion-trigger.js`：加速度计采样 + 运动特征检测 + 缓存放判距 + BLE 桥接 | 3h | `utils/motion-trigger.js` |
| `utils/geofence-trigger.js`：Geofence 注册/移除/事件监听 + BLE Store 桥接 | 3h | `utils/geofence-trigger.js` |
| `utils/geofence-receiver.java`：BroadcastReceiver | 1.5h | native |
| 前台服务 AlarmManager 5min 心跳兜底 | 1h | `utils/foreground-service.js` |
| 设置页：极速模式 UI + 权限请求流程 | 1h | 设置页 vue |
| 华为/荣耀 GMS 检测 + 降级逻辑 | 1h | `utils/geofence-trigger.js` |
| 多围栏管理（去重/LRU/7天过期） | 1h | `utils/geofence-trigger.js` |
| 真机测试（含加速度计触发/围栏出入/多设备/权限拒绝/后台长时验证） | 2h | - |
| **Phase 2 小计** | **15.5h** | |

### 总计：约 23 小时

---

## 九、风险与兜底

### 9.1 风险矩阵

| 风险 | 概率 | 影响 | 兜底策略 |
|:--|:--|:--|:--|
| 亮屏 BroadcastReceiver 在进程被杀后失效 | 中 | 舒适模式失效 | 降低功耗 → 进程存活概率最大化；用户 onShow 时兜底扫描 |
| 加速度计在 Doze 后台被抑制 | 中 | 第一层触发器失效 | GPS围栏 + 5min 心跳仍可触发 |
| watchPosition 在 Deep Doze 下回调延长到 15min | 高 | GPS 围栏响应变慢 | 加速度计第一层弥补 + 5min 心跳兜底 |
| 华为无 GMS，极速模式不可用 | 中 | 功能缺失 | 自动降级到舒适模式 + 提示 |
| 用户拒绝后台定位权限 | 中 | 极速模式不可用 | 回退到舒适模式 |
| 走路时加速度计高频触发（不在围栏附近） | 中 | 误触发过多 | 缓存放判距 + 远离围栏时触发间隔扩大到 5min |
| 手机在口袋静止，走向车时加速度计不触发 | 低 | 第一层失效 | GPS围栏 + 5min 心跳仍可触发 |
| 同一停车场多辆 KeyGo | 低 | 连到别人车 | RSSI 优先连最近的 + deviceId 匹配 |
| 连接失败（设备忙/信号差） | 中 | 扫描到但连不上 | 8s 窗口内重连 2 次 + 30s 后二阶段重试 3 次 |

### 9.2 最坏情况分析

```
最坏情况：用户在车附近盲区（GPS 信号差），手机一直在口袋（加速度无触发），
         锁屏超过 2 小时（进程可能已被系统管家杀）

层级分析：
  加速度计 → ❌ 手机没动，不触发
  GPS 围栏 → ❌ GPS 信号差 + Deep Doze 抑制
  心跳兜底 → ❌ 进程已杀，动态 Receiver 已注销

唯一出路 → 用户掏手机亮屏 → onShow + 亮屏触发 → 双重保险 ✅
```

**结论**：只要进程还活着，至少有一个触发器能在 5 分钟内命中。如果进程被杀，唯一恢复方式是用户主动打开 App（省电模式逻辑作为兜底）。

---

## 十二、深度分析：后台扫描+连接可靠性

> **用户核心关切：能不能确保 APP 在后台真正扫描到设备并真正连接上？**

### 12.1 分阶段可靠性分析

| 锁屏时间 | 进程存活 | BLE扫描可行性 | 连接可行性 | 成功率 |
|:--|:--|:--|:--|:--|
| 0-5 分钟 | ✅ 存活 | ✅ 100% 可行 | ✅ 100% 可行 | **>95%** |
| 5-30 分钟 | ✅ 存活 | ✅ 大概率可行（Light Doze 维护窗口） | ⚠️ 连接窗口受限 | **~85%** |
| 30-120 分钟 | ⚠️ 可能受限 | ⚠️ Deep Doze，唤醒窗口缩短 | ⚠️ BLE 硬件预热延迟 | **~60%** |
| 2 小时+ | ⚠️ 系统管家压力 | ⚠️ 取决于进程是否存活 | ⚠️ BLE 栈可能深度休眠 | **不可预测** |

### 12.2 扫描可靠性的关键因素

**① 扫描前不依赖 GPS 芯片预热**

这是舒适模式亮屏触发的核心优势：
- 亮屏时系统解除 Doze → BLE 栈处于活跃状态 → 扫描 API 调用立即可用
- 极速模式需要在 GPS 后启动扫描，GPS 冷启动可能 3-5 秒 → 延长了扫描前的等待

**② serviceUUID 硬件级过滤**

```javascript
uni.startBluetoothDevicesDiscovery({
  services: ['0000FF00-0000-1000-8000-00805F9B34FB'],
  // 硬件级过滤 → BLE 控制器只上报指定 UUID 的广播包
  // 不受 Android BLE 栈扫描队列长度限制
})
```

**③ 8 秒扫描窗口（而非 5 秒）**

CH582M 广播间隔 50ms → 每秒 20 次广播。8 秒窗口内约 160 次广播机会，只要设备在范围内且正常广播，必能扫到。

### 12.3 连接可靠性的关键措施

**措施 A：扫描到 ≠ 连接成功，先连接再停扫描**

```
标准做法（有风险）：
  onDeviceFound → stopScan() → connectDevice() → 连接失败 → 已停止扫描，无重试机会 ❌

正确做法（v1.0.1）：
  onDeviceFound → connectDevice() → onConnected → stopScan() ✅
                     ↓ 连接失败
                 → 继续扫描 → 再次发现 → 再次连接 → onConnected → stopScan() ✅
```

**措施 B：连接失败后的二阶段重试**

```
第一次尝试（扫描窗口内）：
  8s 扫描窗口 → 发现设备 → connect → 失败 → 继续扫描 → 再发现 → connect
  → 8s 内最多重试 2 次

第二次尝试（扫描窗口外）：
  8s 窗口结束，仍未连上 → 30s 后重启扫描 → 8s 扫描 → connect
  → 最多重复 3 次 → 3 次都失败 → 放弃本次触发
```

**措施 C：连接超时处理**

```javascript
const connectPromise = createBLEConnection(deviceId)

// 10s 超时
const timeoutPromise = new Promise((_, reject) => 
  setTimeout(() => reject(new Error('Connect timeout')), 10000)
)

try {
  await Promise.race([connectPromise, timeoutPromise])
  // 连接成功
} catch (e) {
  // 超时或失败 → 继续扫描（如果还在扫描窗口内）或进入二阶段重试
}
```

### 12.4 为什么"不提前停扫描"至关重要

BLE 硬件有一个已知行为：**连接尝试期间，同一设备的扫描发现可能暂时停止**。这是因为：
- Android BLE 栈在连接初始化时，会将 BLE 控制器状态从"扫描"切换到"连接初始化"
- 如果此时立即 `stopScan()`，一旦连接失败，控制器回到"空闲"状态——无法再次发现设备
- 但如果先不 `stopScan()`，连接失败后控制器自动恢复到扫描状态 → 设备仍在扫描窗口内

### 12.5 进程存活 = 一切的前提

所有触发机制（SCREEN_ON BroadcastReceiver、加速度计回调、GPS 围栏 PendingIntent、AlarmManager）都是**动态注册的**。进程被杀后，它们全部失效。

**唯一的系统性解法**：
- 降低功耗 → 降低系统管家关注度 → 提高进程存活概率
- 这也是为什么 v1.0.1 将舒适模式从"定时扫描"改为"亮屏触发"——功耗降低 90%+

| 方案 | 后台额外功耗 | 系统管家标记"高耗电"概率 |
|:--|:--|:--|
| v1.0.0 舒适模式（2min 定时扫描） | ~25 mAh/天 + WakeLock | **高** |
| v1.0.1 舒适模式（亮屏触发） | ~3 mAh/天，无 WakeLock | **极低** |
| v1.0.0 极速模式（GPS 围栏） | ~17 mAh/天 | 中 |
| v1.0.1 极速模式（三触发） | ~18 mAh/天 | 中 |

### 12.6 验证方案

实施后，建议按以下时序做真机验证：

| 测试场景 | 等待时长 | 预期结果 | 验证方法 |
|:--|:--|:--|:--|
| 亮屏后立即靠近设备 | - | 2-8s 内连接 | 观察日志 + 实际连接 |
| 锁屏 10 分钟后靠近设备并亮屏 | 10min | 2-8s 内连接 | 日志时间戳对比 |
| 锁屏 60 分钟后靠近设备并亮屏 | 60min | 2-8s 内连接（进程存活前提下） | 日志确认心跳/触发器状态 |
| 极速模式：走路到围栏内 | 即时 | 加速度计触发 → BLE 扫描 → 连接 | 日志顺序验证 |
| 极速模式：GPS 进入围栏 | 即时 | Geofence Event → BLE 扫描 → 连接 | Geofence 日志 |
| 极速模式：长时间锁屏后进入围栏 | 2h+ | 5min 心跳兜底 → BLE 扫描（进程存活前提） | 心跳日志 + 扫描日志 |

---

## 十三、附录：CH582M 广播参数参考

```
固件广播间隔: 80 × 0.625ms = 50ms
每秒广播次数: 20 次
广播包长度: ≈ 25 bytes（含 Flags + Appearance + UUID + 电量）
扫描响应包: 动态构建，含设备名（KeyGo-XXXXXX）

结论：50ms 的广播频率足够快，任何 ≥ 1s 的扫描窗口
     都能在 ~100ms 内捕获广播包。
```

---

## 十四、附录：关键代码位置速查

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

---

## 十五、当前状态（2026-07-07）

> ★ 状态（2026-07-07 更新）：冷启动 banner 已修复；后台重连**已实现原生最小闭环（代码完成，待真机验证）**。

### 15.1 已完成 / 已修复
- **冷启动蓝牙状态误判（红/绿 banner 卡死）已修复**，commit `520855b`
  `fix(Bluetooth): 修复冷启动蓝牙状态误判导致的红/绿 banner 卡死`。
  - `utils/ble.js` 新增 `openBluetoothAdapterOnly()`（只打开适配器、不申请权限）。
  - `stores/ble.js` 新增 `_adapterReady` / `_reconcileBtState()` / `ensureAdapterReady()`；
    `enableBluetooth` / `prepareForAutoConnect` / `tryAutoConnect` 成功后校正 btState。
  - `index.vue` / `main.vue` 的 `onShow` 顶部先 `ensureAdapterReady()`。
  - 行为：BT 已开冷启动无红/绿 banner 且不弹框；BT 真关正确显示红 banner 且只触碰一次适配器。

### 15.2 后台重连：原生最小闭环已实现（待真机验证）
- **根因（已定位）**：原"前台服务"是纯 JS（通知+WakeLock），无真实 Android Service；
  所有触发器动态注册在 Activity 上，进程冻结/回收即失效；且 Android 8+ 后台 BLE 扫描
  需 `foregroundServiceType=connectedDevice` 的前台服务，否则限流/无回调。纯 JS 方案架构上不成立。
- **方案（已落地代码）**：新增原生 Android 前台服务插件 `Keygo-Foreground`
  （`nativeplugins/Keygo-Foreground/`）：
  - `KeygoBleScanService`：原生前台服务（type=connectedDevice）+ 原生 `BluetoothLeScanner`
    后台扫描 + AlarmManager 60s Doze 心跳 + `START_STICKY` + onDestroy 15s 复活。
  - `KeygoForegroundModule` + `BleScanEventBus`：JS API（`startScan`/`stopScan`）+ 扫描结果
    经 `UniJSCallback.invokeAndKeepAlive` 推回 JS。
  - `stores/ble.js`：`_ensureForegroundService()` 优先启动原生扫描，扫到已知设备 MAC 即
    `_onNativeDeviceFound()` → 节流(8s) → `tryAutoConnect()` 复用成熟连接逻辑。
  - `manifest.json` 已声明 `nativePlugins.Keygo-Foreground`。
- **前提（必须）**：本地原生插件在标准基座不生效，需自定义调试基座 / 云端打包 / 离线工程；
  后台扫描需授予"始终允许"位置权限 + 电池优化豁免。
- **未验证项（真机待确认）**：① 自定义基座下原生服务是否真常驻 ② 锁屏后原生扫描是否真发现设备
  ③ 厂商强杀对抗效果 ④ 极速模式 GPS 围栏在原生层的落地。

### 15.3 关键提醒
- 所有 JS 层触发器（SCREEN_ON、加速度计、GPS 围栏 PendingIntent、AlarmManager）均**动态注册**，
  进程被杀即全部失效；但**原生 `KeygoBleScanService` 不受此限**，是后台重连的真正支点。
  进程存活（前台服务保活）仍是前提，只是现在由原生层承担，而非脆弱的 JS 上下文。
