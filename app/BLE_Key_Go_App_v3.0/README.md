# BLE车钥匙 App

基于 **uni-app (Vue 3)** 开发，用于配合 ESP32-C3 的 `BLE_Key_Go_v2` 固件。

## 功能

| 功能 | 说明 |
|------|------|
| 🔍 **BLE 扫描连接** | 搜索附近 `BLE-Key-Go-v2` 设备并连接 |
| 📶 **RSSI 实时显示** | 通过 Notify 接收设备上报的 RSSI 信号强度 |
| 🔓 **手动解锁** | 通过 BLE 发送解锁命令到 ESP32 |
| 🔒 **手动锁车** | 通过 BLE 发送锁车命令到 ESP32 |
| 🚗 **后备箱控制** | 通过 BLE 发送后备箱命令到 ESP32 |
| ⚙️ **参数配置** | 设置 RSSI 阈值、确认次数、采样间隔等 |

## BLE 通信协议

与 `BLE_Key_Go_v2.ino` 固件对应：

| UUID | 方向 | 说明 |
|------|------|------|
| `FF00` | Service | 主服务 |
| `FF01` | Write | 配置下发（格式: `unlock=-45 lock=-65 uc=5 lc=10 interval=500`） |
| `FF02` | Read/Notify | 状态上报（JSON 格式） |
| `FF03` | Write | 手动命令（`UNLOCK` / `LOCK` / `TRUNK` / `STATUS`） |

## 开发

1. 用 **HbuilderX** 打开本项目目录
2. 选择运行到手机（Android/iOS）或微信小程序
3. 确保手机蓝牙已开启

### 目录结构

```
BLE_Key_Go_App/
├── pages/
│   ├── index/       # 连接页面（扫描/连接/断开）
│   ├── control/     # 控制面板（解锁/锁车/后备箱）
│   └── config/      # 配置页面（阈值/参数设置）
├── stores/
│   └── ble.js       # Pinia 状态管理（BLE 连接/状态/操作）
├── utils/
│   └── ble.js       # BLE 蓝牙工具类（封装 uni-app 蓝牙 API）
├── static/          # 静态资源（tab 图标等）
├── App.vue
├── main.js
├── pages.json
├── manifest.json
├── package.json
└── vite.config.js
```

## 使用流程

1. ESP32-C3 上电，固件开始 BLE 广播
2. 打开 App → 自动扫描 `BLE-Key-Go-v2`
3. 点击设备连接 → 连接成功后显示 RSSI 信号
4. 在「控制」页手动解锁/锁车/后备箱
5. 在「配置」页调整 RSSI 阈值等参数并下发到设备

## Tab 图标

需要在 `static/` 目录下放置以下图标（PNG，建议 81x81）：

- `tab_ble.png` / `tab_ble_active.png` - 连接页图标
- `tab_control.png` / `tab_control_active.png` - 控制页图标
- `tab_config.png` / `tab_config_active.png` - 配置页图标

可用 uni-app 自带的图标或自定义图标替代。
