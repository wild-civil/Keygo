# KeyGo HID 锚点探针（CH582M_BLE_Spike）开发 / 测试说明

> 目的：验证「Android 能否在【无 App】时自动重连已配对的 BLE HID 设备」——这是
> 「真·无 App 模式」成立的最危险假设。本工程是一个**架构探针**，不是产品固件。
> 产品固件仍是 `CH582M_BLE_Slave`。

---

## 1. 背景与结论（研究阶段已确认）

- **问题**：之前实测发现，Android 不会为「自定义 GATT」设备做系统级自动重连；重连必须由
  持 GATT 连接的 App（前台服务）发起。这导致"无 App 模式"若依赖自定义 GATT，就必须常驻
  App 进程（用户嫌麻烦、耗电、易被系统杀）。
- **出路**：在 LE 上，唯一能让 Android/iOS **无 App 自动重连**的标准 profile 是 **HID
  （HOGP，蓝牙键鼠）**。设备声明成 HID 后，OS 像管蓝牙鼠标/键盘一样自动重连、自动保活，
  **完全不需要 App 进程**。
- **多服务共存已证实**：WCH `CH583EVT/EVT/EXAM/BLE/HID_Consumer` 例程**同时挂载了
  HID + Battery + DeviceInfo + ScanParam 四个 GATT 服务**，且均通过
  `GATTServApp_RegisterService()` 注册（与我们自定义 `gattprofile.c` 同一机制）。
  → 因此「HID 服务(连接锚点) + 自定义 GATT 服务(配置/状态) 共存」在协议栈层面**成立**。
- **推荐架构（方案 A）**：单芯片 CH582M 同时跑
  - **HID 服务（Consumer usage，非键盘，避免输入法弹窗）** → OS 自动重连/保活（无 App）
  - **自定义 GATT 服务 `SimpleProfile` (0xFF00)** → App 配置/状态/指令（仅配置时打开 App）
  - 日常：OS 因 HID 自动重连 → 固件读 `LINK_ENCRYPTED`(=已授权) + RSSI → 近解远锁。
  - App 完全不用常驻，甚至日常不用打开。

---

## 2. 探针工程现状（CH582M_BLE_Spike）

本工程由你新建（原为 `CH582M_BLE_Slave` 的副本），现已改为 **HID_Consumer 例程的 CH582M 移植 + 自定义 GATT 叠加 + 观测日志**。

### 新增 / 覆盖的文件
- `Profile/hiddev.c`、`Profile/hidconsumerservice.c`、`Profile/battservice.c`、
  `Profile/scanparamservice.c`、`Profile/devinfoservice.c`（覆盖原 slave 版）
- `Profile/include/`：`hiddev.h`、`hidconsumerservice.h`、`battservice.h`、
  `scanparamservice.h`、`devinfoservice.h`、`hidconsumer.h`
- `APP/keygo_hid.c`（探针应用层：HID 广播/配对 + HID 服务 + 自定义 GATT + 观测性）
- `APP/include/keygo_hid.h`
- `APP/peripheral_main.c`（HID 版 `main`，保留原 slave 的 WWDG 软看门狗）

### 移除的文件（原 slave 副本，原件安全保留于 `CH582M_BLE_Slave`）
- `APP/peripheral.c`、`APP/keygo_core.c`、`APP/bonding.c`、`APP/crypto_sha256.c`
- `Profile/battery_service.c`（由 HID 的 `battservice.c` 取代）

### 保留的文件
- `Profile/gattprofile.c` + `Profile/include/gattprofile.h` —— **自定义 GATT 服务
  `SimpleProfile` (UUID 0xFF00)**，用于验证「HID + 自定义 GATT 多服务共存」（次级目标）。

> 注：`.wvproj` 无需手工改——MRS(WCH IDE) 会自动扫描工程目录下所有 `.c` 参与编译
> （见 `excludeResources` 仅排除 `HAL/Profile` 等无关目录）。新增的 `.c` 会被自动纳入。

---

## 3. 探针行为

- 设备身份：**BLE HID (Consumer Control)** 外设，广播含
  - `GAP_APPEARE_GENERIC_HID`（HID 外观，让 OS 当 HID 设备管理/自动重连）
  - 服务 UUID 列表：`HID(0x1812)` + `Battery(0x180F)` + `自定义(0xFF00)`
  - 设备名 `KeyGo-HID`
- 配对：镜像 KeyGo 策略 —— `GAPBOND_PERI_PAIRING_MODE_INITIATE` + 系统码 `123456`
  + `MITM=TRUE` + `IO_CAP=KEYBOARD_DISPLAY` + `BONDING=TRUE`。
  - 首次连接系统弹 passkey，输 `123456` 完成绑定（LTK 存入手机 OS）。
  - HID 框架开启 `GAPBOND_AUTO_SYNC_WL`：绑定后仅白名单(已配对)设备可连。
- 观测输出（串口，调试 UART）：
  - `[SPIKE] KeyGo-HID probe init done ...`
  - `[OBS] ADVERTISING`
  - `[OBS] CONNECTED (HID link up)`
  - `[OBS] LINK_ENCRYPTED (OS bonded reconnect — phone near & paired)` ← **自动重连成功标志**
  - `[OBS] DISCONNECTED reason=xx`
  - LED(PB4)：`LINK_ENCRYPTED` 上升沿时 **3 短闪**提示自动重连成功。
- **本探针未实现 RSSI 邻近判定与车锁动作**，仅验证「无 App 自动重连」这一最核心假设。
  （RSSI 逻辑已在主固件 3.33.5 验证，落地时直接接入。）

---

## 4. 构建步骤（MRS）

1. 用 **MRS (MounRiver Studio)** 打开 `CH582M_BLE_Spike/CH582M_BLE_Slave.wvproj`
   （工程名虽叫 Slave，实为本探针）。
2. 确认参与编译的源含：`peripheral_main.c`、`keygo_hid.c`、`hiddev.c`、
   `hidconsumerservice.c`、`battservice.c`、`scanparamservice.c`、`devinfoservice.c`、
   `gattprofile.c`，以及 `StdPeriphDriver / Startup / RVMSIS / HAL / LIB`。
3. 编译（首次可能需微调，见第 6 节风险）。
4. 下载到 CH582M 开发板（WCH-Link）。

> 本环境（AI 侧）**无 CH582 工具链，未能编译验证**。请在 MRS 首次编译后据报错微调。

---

## 5. 测试步骤（验证「无 App 自动重连」）

### 5.1 基础连通 + 多服务共存（次级目标）
1. 打开串口监视（调试 UART，与固件 `PRINT` 同路）。
2. 上电，应见 `[SPIKE] ... init done`、`[OBS] ADVERTISING`。
3. 手机蓝牙搜到 `KeyGo-HID` → 点击配对 → 系统弹 passkey → 输 `123456` → 配对成功。
4. 用 **nRF Connect** 连接，浏览 GATT 服务：
   - 应同时看到 **HID 服务 (0x1812)** 与 **自定义服务 (0xFF00)** →
     **次级目标达成（HID + 自定义 GATT 共存证明）**。

### 5.2 核心：无 App 自动重连（主要目标）
1. 保持上一步已配对状态。
2. **杀掉/不打开任何 KeyGo 相关 App**（甚至根本不装 KeyGo App）。
3. 带着手机**走远**，离开蓝牙范围 → 串口应打印 `[OBS] DISCONNECTED`。
4. 再**走近**设备 → 观察串口：
   - 若出现 `[OBS] CONNECTED` + `[OBS] LINK_ENCRYPTED`（且 LED 3 短闪），
     **且全程无任何 App 参与** → **主要目标达成：方案 A(HID 锚点) 可行**。
   - 若只有手动进系统蓝牙点一下"连接"才出现 `CONNECTED` → OS 未自动重连。

> 提示：不同 Android ROM（尤其国产）对 HID 自动重连的策略可能不同，建议多试几次、
> 不同距离/时长，并在「设置→蓝牙」里确认设备状态从"已配对"变为"已连接"。

---

## 6. 成功 / 失败判据与后续

| 结果 | 含义 | 下一步 |
|---|---|---|
| 无 App 自动重连成功（`LINK_ENCRYPTED` 自发出现） | 方案 A 成立 | 主固件 `CH582M_BLE_Slave` 改造：加 HID 服务 + 连接管理交 OS + 接入 3.33.5 RSSI 自解 |
| 仅手动点连才连 | 该 ROM 不对本 HID 设备自动重连 | 试 HID_Keyboard / 其他 usage；或退回"无感守护(前台服务)"折中；或仍用前台服务兜底 |

---

## 7. 风险 / 注意事项

- **未编译验证**：AI 侧无 CH582 工具链，代码按 WCH 例程 + 主固件模式对齐编写，首次 MRS
  编译可能需小修（如某常量/头文件）。重点检查：
  - `keygo_hid.c` 用到的 GAP/HID 常量是否都在 `CH58xBLE_LIB.h` 中存在。
  - `hiddev.c` 的 `hidDevGapStateCB` 会转发到 `keygoHidStateCB`（已通过
    `HidDev_Register` 的 `pfnStateChange` 注册，机制正确）。
- **AUTO_SYNC_WL**：绑定后设备只接受白名单设备。验证期间若要换手机，需先在手机
  "忘记此设备"清 bond，否则新手机连不上。
- **最简配对（可选）**：若想跳过 passkey 弹窗，把 `keygo_hid.c` 中
  `DEFAULT_MITM_MODE=FALSE`、`DEFAULT_IO_CAPABILITIES=GAPBOND_IO_CAP_NO_INPUT_NO_OUTPUT`、
  `DEFAULT_PASSCODE=0`（Just Works）。自动重连测试与配对方式无关，绑定本身才是关键。
- **RSSI 邻近判定未做**：本探针只验证"连不连得回来"，不做"近不近"。接近度解锁逻辑
  在主固件 3.33.5 已具备，方案 A 落地时把"连接/加密"事件喂给现有 RSSI 状态机即可。

---

## 8. 落地到主固件的设想（探针成功后）

主固件 `CH582M_BLE_Slave` 改造方向：
1. 保留 `gattprofile.c`（自定义 GATT 0xFF00）作为 App 配置通道。
2. 新增 HID(Consumer) 服务作为"连接锚点"（参考本探针 `keygo_hid.c`）。
3. **连接管理交 OS**：不再依赖 App 前台服务维持 GATT；OS 因 HID 自动重连。
4. 复用 3.33.5 的 `LINK_ENCRYPTED` 上升沿检测 + RSSI 状态机 → 近解远锁。
5. App 仅"配置时"打开（设系统码/阈值/开关），日常完全不打开。
