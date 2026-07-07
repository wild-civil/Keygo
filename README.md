# KeyGo · 钥启程 （BLE 智能车钥匙）

> 一个基于 BLE 的车钥匙替代方案：用手机 App 连接 BLE MCU/SOC 固件模块，通过 RSSI 距离判断实现「走近解锁、走远锁车」的舒适进入体验。

**两大部分**：
- **固件**：运行在 BLE MCU/SOC 上，接管原车钥匙的解锁 / 锁车 / 后备箱三个物理按钮
  - 早期用 **ESP32C3**（Arduino）完成原型验证
  - 当前主力平台 **WCH CH582M**（RISC-V BLE SoC, MounRiver Studio）
  - 后续计划移植到 **nRF528xx** 等其他 BLE MCU/SOC
- **App**：**uni-app（Vue 3 + Pinia）** Android 应用，负责 BLE 连接、RSSI 监测、智能重连策略

---

## 实际功能

| 功能 | 怎么做的 | 限制 |
|------|----------|------|
| **走近自动解锁** | App 持续连接设备，根据 RSSI 信号强度判断距离，超过阈值 + 连续确认次数后自动发解锁命令 | 仅当 App 与设备保持 BLE 连接时生效 |
| **离开自动锁车** | RSSI 低于锁车阈值 + 连续确认次数 → 自动发锁车命令；BLE 意外断连也触发锁车 | BLE 断连时可能已离开很远，属于兜底保护 |
| **手动控制** | App 上点击按钮，通过 BLE GATT Write 发送 UNLOCK / LOCK / TRUNK 命令 | 需要设备在蓝牙范围内 |
| **设备绑定** | 设备唯一序列号 + 物理按键确认配对，App 只连接已绑定的设备 | 防止陌生人连接你的车钥匙 |
| **参数可调** | RSSI 解锁/锁车阈值、确认次数、采样间隔、Kalman 滤波参数均可在 App 上修改并下发到设备 | 参数调不好可能导致误触发或延迟 |
| **电池监测** | 设备通过 BLE Notify 上报电压/电量，App 显示并低于 20% 提醒 | 仅支持 18650 锂电池（电压→电量映射基于放电曲线） |
| **Android 前台服务** | 通过原生 Android Foreground Service + 常驻通知 + 电池优化豁免引导，尽可能不被系统杀死 | 荣耀/小米等深度管控机型锁屏 2h+ 仍可能被杀 |

---

## 智能重连（三种模式）

这是本项目最核心的部分。断开连接后 App 如何重新找到设备？不同用户需求完全不同，所以提供三种模式：

| | 极速模式 | 舒适模式（默认） | 省电模式 |
|:--|:--|:--|:--|
| **怎么工作的** | 蓝牙断开时记录停车 GPS 位置 → 建围栏 → 进入围栏时触发 BLE 扫描；同时加速度计检测运动 → 条件触发扫描 | 断开后注册 `ACTION_SCREEN_ON` 广播 → 用户亮屏/解锁手机时触发 8s BLE 扫描并连接 | 断开后什么也不做，等用户打开 App 时（onShow）才扫描 |
| **什么时候能连上** | 走到车附近（进入 GPS 围栏）时自动连，理想情况到车边就已连好 | 亮屏后 2-8 秒内连上 | 打开 App 后几秒 |
| **需要什么权限** | 后台定位 + 加速度计 | 无额外权限 | 无额外权限 |
| **后台干了什么** | GPS 围栏（Google Geofence API）+ AlarmManager 心跳兜底（无 GMS 设备降级） | 无任何后台任务（纯事件驱动，亮屏才触发） | 无 |
| **适合谁** | 每日通勤、愿意授权定位换取无感体验 | 大多数用户 | 一周开一次车、不想 App 耗任何电 |
| **已知问题** | 无 GMS 设备（华为/部分荣耀）围栏不可用，自动降级到舒适模式 | 亮屏后不靠近车就不会连上（符合预期，因为本来就没后台扫描） | 必须手动打开 App |

### 舒适模式的设计动机

旧方案在断开后每 2 分钟定时扫描一次。在荣耀 MagicOS 等深度管控系统上，锁屏 2 小时后系统会将持续有后台行为的 App 标记为「高耗电应用」并杀死 —— 定时扫描反而加速了被杀。

**现在舒适模式不做任何后台轮询**，等待系统自然广播 `ACTION_SCREEN_ON` 才触发扫描。系统找不到标记你的理由，存活概率大幅提升。

```
断开连接 → registerScreenOnReceiver()
    ↓
用户亮屏/解锁 → ACTION_SCREEN_ON / ACTION_USER_PRESENT
    ↓
_onScreenOn() → 检查：已连接？蓝牙关？30s内刚扫过？
    ↓
startScan(8s, service UUID 过滤) → 发现目标设备
    ↓
connectDevice() → 成功后停扫描
    ↓
8s 内未连上 → 30s 后重试，最多 3 次
```

### 打开 App 自动连已知设备里信号最强者（方案B）

默认行为：**打开 App（onShow）会先直连缓存设备（最快，无需扫描）；直连失败或缓存过期时，自动扫描并连接「已知设备集合」里 RSSI 最强的那台。**

- 「已知设备集合」当前 = 缓存的 `ble_device_id`（过渡期）。**非已知设备绝不会自动连接**，避免误连邻居家/陌生人的车钥匙（方案B 安全边界）。
- 多台已知设备同时在线时，按信号强度自动选最强的那台。
- 首次使用（无 `ble_device_id` 缓存）不自动连任何设备，需手动在扫描列表里挑一次；之后该设备进入已知集合。
- 预留「设备绑定」接入点：后续把已知集合换成受信任序列号列表即可，内部逻辑不变（见 `stores/ble.js` 中 `autoConnectBest` 的 `knownSet` / `TODO ①`）。

> 实现要点：`utils/ble.js` 的 `startScan` **不再传 `services` 硬件过滤**（Android 12+ 上带过滤的发现常返回空，导致扫不到设备），设备识别改由扫描回调内的「名字前缀 / 广播 UUID」二次过滤完成，发现更可靠。

### 断连状态机（reconnectMode）

所有自动重连/不重连的决策都看这个状态，避免「刚断连又秒重连」「用户主动断开后又自动连上」等竞态：

| 状态 | 含义 | 何时进入 / 谁负责 |
|------|------|------------------|
| `idle` | 空闲，允许自动重连 | 连接成功、或重连彻底放弃后 |
| `active` | 正在重连循环（指数退避） | 异常断连 `_handleDisconnect` → `_startReconnect` |
| `paused` | 临时挂起（退避等待 / 蓝牙关闭） | 退避等待期、蓝牙关闭时 |
| `dormant` | **用户主动断开**，禁止一切自动重连 | `disconnect()` |

统一闸门 `_shouldAutoReconnect()`：`connected` / `dormant` / `btState=off` 任一成立 → 返回 `false`，`tryAutoConnect`、`autoConnectBest`、`_onScreenOn` 均先过此闸门。

> ⚠️ **已知限制（待优化）**：`dormant` 是内存态，App 进程被杀后随 `reconnectMode` 重置回 `idle`；而 `ble_device_id` 缓存持久化在本地存储。因此**当前手动断开仅在「同一 App 会话内」有效**——重新打开 App 会按已知设备缓存再次自动连接。若希望「手动断开 = 跨重启都不自动连」，需把「用户主动断开」意图持久化（新增 `ble_manual_disconnect` 标记，受 `_shouldAutoReconnect` 与 `connect()` 共同管控），见下方「断连逻辑修复」讨论。

---

## BLE 通信协议

设备名格式：`KeyGo-{MAC后6位}`，例如 `KeyGo-A1B2C3`

| UUID | 类型 | 方向 | 用途 | 数据格式 |
|------|------|------|------|----------|
| `0000FF00-...` | Service | — | KeyGo 主服务 | — |
| `0000FF01-...` | Write | App→设备 | 配置下发 | `unlock=-45 lock=-65 uc=5 lc=10 interval=500 kf_r=15.0` |
| `0000FF02-...` | Read, Notify | 设备→App | 状态上报 | JSON: `{"c":"LOCKED","r":-52,"f":-52,"b":85,"d2":0}` |
| `0000FF03-...` | Write | App→设备 | 控制命令 | `UNLOCK` / `LOCK` / `TRUNK` / `UNBIND` / `STATUS` |
| `0000FF04-...` | Read | 设备→App | 设备序列号（永久唯一） | ASCII 字符串，配对绑定用 |

- 广播间隔：50ms，任意 ≥1s 扫描窗口能捕获
- 安全机制：MAC 白名单（NVS 持久化）+ 物理按键配对 + 长按恢复出厂设置

### FF02 状态字段说明

| 键 | 含义 | 示例值 |
|----|------|--------|
| `c` | 当前状态 | `LOCKED` / `UNLOCKED` / `ACTION` |
| `r` | 实时 RSSI (dBm) | `-52` |
| `f` | Kalman 滤波后 RSSI | `-52` |
| `b` | 电池电量百分比 | `85` (0-100) |
| `d2` | 断连倒计时 | `0` (设备内部用) |

---

## 目录结构

```
KeyGo/
├── app/BLE_Key_Go_App/            # uni-app 手机端工程（HBuilderX）
│   ├── pages/
│   │   ├── index/                 # 设备扫描 & 连接
│   │   ├── control/               # 手动解锁/锁车/后备箱
│   │   └── config/                # RSSI阈值/确认次数/Kalman参数
│   ├── stores/
│   │   └── ble.js                 # ★ 核心状态机（~2500行，连接/重连/三种模式）
│   ├── utils/
│   │   ├── ble.js                 # uni BLE API 封装
│   │   ├── foreground-service.js  # Android 前台服务 + 亮屏广播
│   │   ├── geofence.js            # 极速模式 GPS 围栏
│   │   └── power-saver.js         # 省电模式逻辑
│   └── nativeplugins/             # 原生插件（前台服务保活）
│
├── code/
│   ├── ESP32C3/                    # 早期原型（Arduino .ino，v1 ~ v3.13）
│   │   ├── BLE_Key_Go/            #   v1 初版
│   │   ├── BLE_Key_Go_v2/ ... v3_13/  # v2 ~ v3.13 演进
│   │   └── ...
│   └── CH582M/CH582M_BLE_Slave/   # 当前主力固件（MounRiver Studio，v3.13+）
│       ├── APP/
│       │   ├── peripheral.c       # GAP/GATT 服务、广播、连接管理
│       │   ├── keygo_core.c       # 业务核心（RSSI判断/命令执行/绑定/看门狗喂狗）
│       │   └── peripheral_main.c  # main() + WWDG 软看门狗
│       ├── HAL/                   # LED、按键等硬件抽象
│       └── Profile/               # Battery / DeviceInfo / GATT 服务实现
│
└── docs/                          # 设计文档 & 复盘
    ├── KeyGo_v3.23_智能重连模式设计v1.0.1.md   # ★ 最新智能重连设计
    ├── KeyGo_v3.22_电池优化豁免机制详解.md
    ├── BLE连接稳定性问题复盘_v2.2.md
    ├── KeyGo_v3.16_看门狗方案分析.md
    └── ...（共16篇）
```

---

## 开发 & 运行

### 固件

**当前平台：CH582M**

1. 安装 **MounRiver Studio**（WCH 官方 IDE）
2. 打开 `code/CH582M/CH582M_BLE_Slave/CH582M_BLE_Slave.wvproj`
3. 编译 → 通过 WCH-Link 烧录到 CH582M 开发板
4. 上电后开始 BLE 广播，设备名 `KeyGo-XXXXXX`

关键硬件：CH582M（RISC-V 60MHz, BLE 5.0），18650 锂电池供电，继电器模块接管原车钥匙按键。

**早期平台：ESP32C3（已归档）**

- 目录：`code/ESP32C3/`，Arduino `.ino` 工程，v1 ~ v3.13 的完整演进保留了 12 个版本快照
- 用 Arduino IDE 打开 `.ino` 文件即可编译烧录
- ESP32C3 完成了全部核心功能的原型验证，v3.13 后主线迁移到 CH582M

**计划移植**：nRF528xx（Nordic nRF5 SDK / Zephyr）等其他 BLE MCU/SOC，欢迎贡献。

### App

1. 用 **HBuilderX** 打开 `app/BLE_Key_Go_App`
2. 运行到 Android 真机（需开启开发者模式 + USB 调试）
3. 授予蓝牙、定位、通知权限
4. 打开 App → 扫描 KeyGo 设备 → 连接 → 控制 / 配置

AndroidManifest 已声明权限：蓝牙、定位（含后台定位，仅极速模式需要）、前台服务、通知、电池优化豁免请求。

### 快速自检

1. 固件上电，手机蓝牙扫描应能看到 `KeyGo-XXXXXX`
2. App 连接成功后，`FF02` 应持续推送 RSSI 状态 JSON
3. 靠近/远离设备，RSSI 应相应变化（越近数值越大，如 -30 > -60）

---

## 版本演进

```
v1    初版：单 BLE 栈 + 简单 RSSI 阈值判断（ESP32C3 / Arduino，连接不稳定）
v2    双栈重构：NimBLE / Bluedroid 双栈 + 断连锁车兜底（ESP32C3）
v2.1  合并版：Kalman 滤波 + RSSI 尖峰丢弃 + 滞后状态机（ESP32C3）
v2.2  MAC 白名单 + 设备唯一序列号 + 物理按键配对（ESP32C3）
v3.13 迁移到 CH582M 平台，18650 电池电压检测上线 ← 平台切换点
v3.14 电池监测完善（GATT Read 电量 + BLE Notify 电压）
v3.16 软看门狗（WWDG 2.5s 超时复位，防固件卡死）
v3.22 电池优化豁免引导（对抗 Android 系统后台查杀）
v3.23 智能重连三种模式框架（极速/舒适/省电）
  └─ v1.0.1 舒适模式重构：定时轮询 → 亮屏触发，零后台 polling
```

---

## 已知限制

- **仅支持 Android**：uni-app 可编译 iOS 版本，但前台服务、亮屏广播等原生插件仅 Android 实现
- **BLE 范围约 10-15m**：实际受环境、手机蓝牙芯片影响，RSSI 波动大（墙壁/人体遮挡）
- **深度管控机型**：荣耀 MagicOS、小米 MIUI 锁屏 2h+ 后即使有前台服务也可能被系统杀死
- **RSSI 不是精确距离**：同一距离不同角度 RSSI 可差 10-15dBm，依赖 Kalman 滤波 + 连续确认次数来降低误判
- **GPS 围栏依赖 GMS**：华为/部分荣耀设备 Google Geofence 不可用，极速模式自动降级
- **仅作学习研究**：未经车厂安全认证，请勿用于实际车辆

---

## 相关文档

`docs/` 目录包含完整的设计演进与问题复盘：

- **智能重连**：`KeyGo_v3.23_智能重连模式设计v1.0.1.md` (最新) / `v1.0.0.md` (旧版备份)
- **后台保活**：`KeyGo_v3.22_电池优化豁免机制详解.md`
- **BLE 稳定性**：`BLE连接稳定性问题复盘_v2.2.md` / `BLE扫描_设备发现机制复盘_v2.2.md`
- **硬件**：`BLE车钥匙_舒适进入_硬件方案设计.md`
- **电池**：`KeyGo_Battery_Service_实施方案.md` / `KeyGo_v3.14_18650电池电压检测方案.md`
- **看门狗**：`KeyGo_v3.16_看门狗方案分析.md`
- **项目规划**：`BLE车钥匙_舒适进入_项目立项书.md` / `BLE_Key_Go_项目规划.md`

---

## 许可证

本项目仅供学习与研究使用。商业用途请联系作者。
