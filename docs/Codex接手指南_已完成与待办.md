# KeyGo 项目交接说明（Codex 接手 · 完善 App）

> 用途：让接手的 AI（Codex）快速理解项目、在**已验证可用**的基线上继续完善 App。
> 语言：中文叙述 + 英文代码/路径。涉及代码行号以 `文件:行` 标注。
> 分支状态：本说明撰写时 `codex` 已快进到 `main` 最新提交 `c57cf3c`（2026-07-13）。

---

## 0. 一句话背景

KeyGo = **CH582M BLE 从机固件**（MRS IDE + RISC-V + tmos RTOS + WCH BLE 库）+ **uni-app(Android) App** 的蓝牙摩托/车锁。
核心理念：**物理手机即钥匙**——走近（RSSI 近场）自动解锁、离开自动锁车；绑定基于共享密钥（非 MAC，因随机私有地址）。

---

## 1. 仓库 / 分支 / 协作约定（先读，避免踩坑）

- 多 AI agent 各自一条分支协作：`codebuddy`（CodeBuddy）、`codex`（你）、`workbuddy`、`trae/*`。`main` 是集成分支。
- 你当前在 **`codex`** 分支，已与 `main` 同步到 `c57cf3c`。
- **不要** `git push` 到远端，除非用户明确要求。
- **不要** 删除 `.codebuddy/` 目录（存放跨会话记忆与自动化，非临时缓存）。
- 跨会话记忆目录 `d:/WorkSpace/Code/Ai/CodeBuddy/Keygo/.codebuddy/memory/` 下有 `MEMORY.md` 与每日日志，**开始前务必读 `MEMORY.md`**（含大量已落地的根因修复与"铁律"）。

---

## 2. 架构与关键文件

### 2.1 固件（CH582M，需 MRS IDE 烧录）
| 文件 | 作用 |
|---|---|
| `code/CH582M/CH582M_BLE_Slave/APP/keygo_core.c` | 主状态机、RSSI 解锁闸门、配置下发 |
| `code/CH582M/CH582M_BLE_Slave/APP/bonding.c` | 绑定/KDF/挑战应答/AUTH/C1 签名、配对配置 |
| `code/CH582M/CH582M_BLE_Slave/APP/peripheral.c` | GATT/连接/未绑定超时强断/BondState 回调 |
| `code/CH582M/CH582M_BLE_Slave/APP/crypto_sha256.c` | 自研 SHA256/HMAC（**WCH 无硬件 SHA/RNG**） |

### 2.2 App（uni-app + Pinia + 原生插件）
| 文件 | 作用 |
|---|---|
| `app/BLE_Key_Go_App/stores/ble.js` | **核心**：连接/扫描/重连/自动 AUTH/RSSI 显示/绑定流程编排 |
| `app/BLE_Key_Go_App/utils/crypto.js` | 与固件同源的 KDF `deriveBindKey`、HMAC、nonce 处理 |
| `app/BLE_Key_Go_App/components/BindModal.vue` | 绑定/改码弹窗（用 `<input>` 直输） |
| `app/BLE_Key_Go_App/pages/index/index.vue` | 主界面（连接卡/进度卡/RSSI 大数字） |
| `app/BLE_Key_Go_App/pages/config/config.vue` | 配置页（阈值/模式/进度开关） |
| `app/BLE_Key_Go_App/nativeplugins/Keygo-Foreground/...` | 原生前台服务插件（后台扫描/重连/屏幕事件） |

> 关键约束：原生插件 `.java` 改法见 §6。改固件需**重烧**，且验收靠串口日志（见 §7）。

---

## 3. 已完成（已真机验证"可用"的基线）

按时间，关键里程碑（commit 哈希可在 `git log` 查到）：

1. **真实密码学绑定（v3.29, `a039598`）**：KDF `bindKey=SHA256(code‖serial)[0:16]`、BIND/AUTH 挑战应答、C1 签名指令、常量时间比较、fail-closed。两端同源。
2. **DataFlash 地址基准修复（决定性）**：WCH EEPROM 的 StartAddr 是相对 DataFlash 基址 0x70000 的**偏移**，旧代码误用物理地址导致重启丢绑定/配置。现为：`CFG 0x7000 / BOND 0x7100 / BINDCODE 0x7200`（物理 0x77000/0x77100/0x77200）。
3. **SHA256 位长 UB + 短报文延迟发送（`d8c47da`，真机 AUTH:OK 通过）**：`crypto_sha256.c` 位长高 32 位移位 ≥32 属未定义行为已修；绑定回包改延迟队列发送避免被丢。
4. **未绑定连接 30s 超时强断 + App 抑制自动重连（`31f3f59`，真机 PASS）**：防单连接槽被占的 DoS；断连后 App 不再自动重连未绑定设备。
5. **方案 A 双闸门 RSSI 解锁（`a895d0c`，可用）**：`keygo_core.c:442-443` 闸门 `!LINK_ENCRYPTED && !IsSessionAuthed → return`。保留"App 被杀+已配对+OS 重连加密仍能解锁"。
6. **RSSI 解锁进度可见（v3.31, `5e696ad`/`206a30b`）**：解锁/锁车进度条、配置回显、中间区间诊断。
7. **RSSI 显示修正（`c57cf3c`，最新）**：大数字 `displayRssi` 直接取固件 Kalman 滤波值 `f`（与区间判定同源），去掉 EMA 二次平滑导致的显示滞后。

> 这些版本组合 = 当前"可用"基线。继续开发请在此之上，**不要回退这些已验证行为**。

---

## 4. 待办清单（让 Codex 完善 App）

按优先级排列。每项给了文件落点、验收要点。**P0 被技术前提阻塞**，建议先做 §5 的"前提验证"再动手。

### P0 — 安全收口
- **[P0] 加密绑定优化：认证配对 Passkey = 绑定码**（详见 §5）。关闭"Just Works 配对即可解锁"缺口。
  - 落点：固件 `bonding.c:124-136`（配对配置）+ 原生 `KeygoForegroundModule.java`（`createBond`/`BondStateReceiver`）+ App `ble.js`/`BindModal.vue`。
  - **阻塞前提**：CH582/WCH BLE 栈是否真支持 `DISPLAY_ONLY + 固定 passcode` 的 Passkey Entry 且 `mitm=1` 不回退 Just Works。**第一步请先验证**（查仓库内 WCH BLE 库源码或 WCH 文档/实测），这是方案能否落地的硬前提。

### P1 — 安全加固 / 多设备
- **[P1] 受信任序列号列表（autoConnectBest 的 `TODO ①`，`ble.js:2614`）**：当前自动连接只认缓存 `deviceId`，应扩展为"绑定信任序列号列表"，仅列表内设备才自动连接、多台按 RSSI 取最强。避免误连/被冒名设备。
- **[P1] 多设备 / 多车主（方案 A 多手机管理员）**：当前单 owner 模型。需设计"车主 + 受控管理员/副机"的绑定/授权流程（参考 `docs/绑定安全设计与码长方案.md` §14）。

### P2 — 体验 / 配置
- **[P2] 首绑拒绝弱码 + 强码/机身二维码标签**：`bonding.c` 首绑分支加长度/强度校验（≥8 位且与默认 `123456` 不同）；远期可出厂烧每设备唯一码 + 二维码标签。
- **[P2] RSSI 阈值调参体验**：配置页已可设 `-50~-40` 等阈值（`config.vue`）。去掉 EMA 后若后台噪值回放感复现，可改对 `f` 用高响应轻 EMA(0.5/0.5) 或下调固件 `kalmanR`。需真机判断。
- **[P2] 极速模式 GPS 围栏真后台打磨**：`utils/geofence.js` + 原生 AlarmManager 心跳已搭框架，需真机验证锁屏/Doze 下围栏唤醒与功耗，打磨体验。

### P3 — 已知瑕疵 / 打磨
- **[P3] 通知左侧小图标显示 `H`**：部分国产 ROM 仍回退到 HBuilder 默认图标。可靠解法是原生 `KeygoBleScanService.getNotificationSmallIcon()` 用 **Base64 内嵌 PNG → BitmapFactory.decodeByteArray → Icon.createWithBitmap**（见 `.codebuddy/memory/` 相关记录）；请勿用 `getAssets().open()` 或 `getIdentifier()`（DCloud 基座打包不会合并 aar assets、两包名均返回 0）。
- **[P3] CH582M 极偶发扫描不到**：可能固件停广播（看门狗复位/低功耗卡死）、Android BLE 扫描栈静默失败、或 `_coolingDown` 永久持有。下次复现需收集完整日志，重点看扫描启动日志与 `_coolingDown` 状态。
- **[P3] DEV 面板「屏幕事件」偶发 `--`**：已定位多为"新 aar 未真正上手机"或原生 `getAppContext()` 返回 null（服务没起）→ 总线监听空。用 DEV 自带日志（`addDebugLog`）定位比 adb 更可靠。
- **[P3] iOS 支持评估**：当前原生插件仅 Android，uni-app 跨端未落地 iOS 钥匙能力。可作为远期评估项。
- **[P3] 自动化测试 / CI 缺失**：无单测/集成测试。crypto 有自测（`[CRYPTO] sha256 self-test`），可扩展为 Node 脚本；App 端可用小程序 mock 做回归。

---

## 5. 最高优先级：加密绑定优化（详设已就绪，待你落地）

完整设计见 **`docs/加密绑定优化方案设计.md`**（已含缺口分析、主方案、替代方案对比、实施清单、验证用例）。要点：

**缺口**：`keygo_core.c:442-443` 闸门接受 `LINK_ENCRYPTED`；而配对是 `mitm=0` 的 Just Works（`bonding.c:124-136`）。设备已 BIND 后，任意手机**无码配对 → OS 自动加密重连 → 闸门放行 → 走近解锁**，无需绑定码。

**主方案（推荐）**：认证配对，`Passkey = 绑定码`
- 固件 `Bonding_Init`：`ioCap=DISPLAY_ONLY` + `mitm=1` + `GAPBOND_PERI_PASSCODE = Bonding_CodeToPasskey(g_curBindCode)`（新增该函数，ASCII 码→uint32，不足 6 位前补 0）。
- `Bonding_HandleSetCodeCmd` 改码后刷新 passkey。
- 因 `mitm=1` 不回退 Just Works → `LINK_ENCRYPTED` 仅来自"知道绑定码"的配对 → **闸门逻辑零改动**（保留 App 被杀仍可解锁）。
- 应用层 KDF/BIND/AUTH/C1 **全部保留** → 双因子（配对防蹭链 + AUTH 防重放签指令）。
- App：`createBond(code)` 用 `BluetoothDevice.setPin` 反射静默预填 + `BondStateReceiver` 成功/失败分支；`_triggerBond` 透传码；`BindModal` 提示"配对码=绑定码"。

**替代方案对比**（设计文档 §5）：A 认证配对(推荐) / B 仅 IsSessionAuthed(丢 App 被杀解锁) / C LESC 数字比对(无头不可行) / D OOB NFC/QR(超范围) / E=A。

### ⚠ 接手前必须确认的 4 个问题（设计文档 §8）
1. **CH582 SMP passkey 行为**是否如预期（支持 `DISPLAY_ONLY+固定 passcode` + `mitm=1` 不回退 Just Works）？→ 先查仓库内 WCH BLE 库源码 / WCH 文档 / 实测。不支持则回退 B 或 D。
2. 配对码与绑定码**强制一致**（推荐）还是允许独立两套？
3. 首绑是否强制改默认码 `123456`（推荐拒弱码）？
4. 是否一并做随机数熵增强（建议独立小 PR，不阻塞主方案）？

> 建议 Codex 第一步：**验证问题 1**（技术可行性），再决定方案 A 能否落地。仓库 `code/CH582M/` 内可能含有 WCH BLE 协议栈源码可查。

---

## 6. 给 Codex 的硬约束（必读，否则可能白干）

1. **改原生插件 `.java`（`nativeplugins/Keygo-Foreground/.../_build/source/*.java`）**：
   - ❌ 不要用普通文件写入工具改（会**静默失败**）。必须用 **Python `io.open` 直写**后跑 `build_aar.bat` 重编 `android/keygo-foreground.aar`。
   - 改完必须：① `manifest.json` 的 `versionCode +1`；② 在 HBuilderX **重新制作自定义调试基座**并重装手机；③ 标准基座**不支持**原生插件。
2. **改固件（`code/CH582M/...`）**：必须**重烧**才能验证。烧录后看串口日志验收：
   - `[BOND] init done, owners=1`（绑定持久化 OK）
   - `[CRYPTO] sha256 self-test: PASS`（哈希算法 OK）
   - 重启后绑定/配置不丢（DataFlash 偏移正确）
3. **App UI 输入框**：在自定义 Android 基座上 webview `<input>` 键盘**可用**，绑定码/名称输入框统一用 `<input type="text">`（不要退回 `uni.showModal({editable})` 除非真弹不出键盘）。绑定码明文不遮罩（取舍：好用优先）。
4. **DataFlash 地址是相对偏移**（非物理地址），新增持久化区务必用偏移宏（基准 0x70000）。
5. **`tmos_memcmp` 语义相反**：返回 TRUE(非零)=相同 / FALSE(零)=不同（与标准 memcmp 相反），`bonding.c` 比较按 `==0`=不同→FAIL 正确，别改反。
6. **不要动 `.codebuddy/`**；改动尽量小、可验证、可回退。
7. 提交信息用中文 + 简洁主题行 + 要点（参考历史 `git log` 风格，含"此版可用"标注可用版本）。

---

## 7. 如何验证你的改动

- **App 改动**：HBuilderX 制作/重做自定义调试基座 → 运行到手机 → 看 HBuilderX 控制台（console.log 实时可见）。关键日志前缀：`[Store]`、`KeygoBleScanSvc`、`KeygoFgModule`。
- **原生插件改动**：见 §6.1（Python 直写 + build_aar.bat + versionCode+1 + 重做基座）。
- **固件改动**：MRS 烧录 → 串口监视器看 §6.2 验收关键字。
- **安全回归**：改完跑 `docs/加密绑定优化方案设计.md` §7 的 4 个验证用例（陌生人无码配对应失败、车主正确码配对应成功、改码后须用新码、BIND/AUTH/C1/30s 超时仍正常）。

---

## 8. 快捷索引（定位用）

- RSSI 解锁闸门：`code/CH582M/CH582M_BLE_Slave/APP/keygo_core.c:431,442-443`
- 配对配置（Just Works）：`bonding.c:124-136`
- KDF 同源：`bonding.c` `Bonding_DeriveKey` ↔ `app/.../utils/crypto.js` `deriveBindKey`
- 自动连接受信集合待扩展：`stores/ble.js:2614`（`TODO ①`）
- 后台扫描原生入口：`stores/ble.js:817` `startNativeBackgroundScan`
- 绑定流程编排：`stores/ble.js` `_triggerBond` / `_handleBindingNotify`
- 设计文档：`docs/加密绑定优化方案设计.md`、`docs/绑定安全设计与码长方案.md`
- 原生调试踩坑复盘：`docs/自己看/离线打包实战踩坑复盘_2026-07-10.md`、`docs/Android离线打包与插件集成checklist.md`
- 跨会话记忆：`d:/WorkSpace/Code/Ai/CodeBuddy/Keygo/.codebuddy/memory/MEMORY.md`

---

## 9. 建议的接手顺序

1. 读 `.codebuddy/memory/MEMORY.md` + 本文件 + `docs/加密绑定优化方案设计.md`。
2. **先验证加密绑定方案的可行性前提**（§5 问题 1：CH582 SMP passkey 行为）——这是 P0 能否落地的关键。
3. 按 §4 优先级推进：P0（加密绑定）→ P1（受信序列号列表 / 多车主）→ P2/P3。
4. 每步小改动、真机验证、保持"可用"基线不被回退。
