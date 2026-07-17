# KeyGo 安全加固与加密规划 v1.0.0

> 状态：规划中（临时文档）
> 适用版本：App v3.24 / 固件 CH582M v3.13
> 目标：在修复现有功能性 bug 后，专项解决 BLE 锁具的未授权访问、重放、身份暴露等安全问题。
>
> 本文档为**后期专项工作**的临时规划，不阻塞当前 bug 修复。所有结论基于 2026-07-08 的代码审计。

---

## 0. 背景与优先级说明

当前 KeyGo 已实现完整的"舒适/手动/极速"三模式重连与后台扫描，功能闭环基本跑通。
但在安全审计中发现：**锁指令与配置通道完全裸奔，任意蓝牙设备可在免配对、免加密状态下远程物理开锁。**

安全加固分两个层次：
- **P0（上线前必做）**：阻断"陌生人直连直开"。
- **P1/P2（增强）**：防重放、防定向定位、强化本地凭据。

当前阶段（2026-07 上旬）先专注功能 bug 修复，**本规划留作专项启动时的任务清单**。

---

## 1. 现存漏洞清单（审计基线）

| 编号 | 严重度 | 问题 | 代码位置 | 现状 |
|------|--------|------|----------|------|
| V-01 | 🔴 致命 | 锁指令零鉴权，任意设备免配对直连直写 `UNLOCK` | `keygo_core.c:489-557` `KeyGo_HandleCommand` | 未处理 |
| V-02 | 🔴 致命 | "绑定密码"安全模型为文档剧场（`getBindKey` 从未调用，固件无 BIND 分支） | `stores/user.js:133` `getBindKey` / 固件 0 处校验 | 未落地 |
| V-03 | 🔴 致命 | 配置通道 FF01 同样无鉴权，可改写阈值/autolock/改名 | `keygo_core.c:600-714` `KeyGo_ParseConfig` | 未处理 |
| V-04 | 🟠 高危 | GATT 特征值免加密、免配对（`GATT_PERMIT_WRITE` 无加密要求） | `Profile/gattprofile.c:98,123,142,161` | 注释"到时候再加密" |
| V-05 | 🟠 高危 | 命令为静态字符串，无 nonce/会话，可重放 | `utils/ble.js:875` `sendCommand` | 未处理 |
| V-06 | 🟡 中 | 广播主动暴露 `KeyGo` 名+固定 serviceUUID+厂商 `KG+MAC`，便于定向定位 | `utils/ble.js:13-20,1197` | 未处理 |
| V-07 | 🟡 中 | 序列号 FF04 任意可读，设备唯一标识泄露 | `utils/ble.js:901` `readSerialNumber` | 无权限限制 |
| V-08 | 🟡 中 | 本地密码哈希极弱（DJB2 无盐快速哈希） | `stores/user.js:18-27` `hashPassword` | 可暴力还原 |
| V-09 | ⚪ 低 | 断连自动锁存在"已解锁窗口"（默认 5s） | `peripheral.c:543-553` | 安全特性，窗口可压缩 |

---

## 2. 修复路线图

### P0 — 阻断未授权访问（专项第一优先）

#### P0-1：启用 GATT 加密 + 设备绑定（bonding）
- **固件** `gattprofile.c`：命令(FF03)/配置(FF01)特征值权限由 `GATT_PERMIT_WRITE` 改为
  `GATT_PERMIT_WRITE | GATT_PERMIT_ENCRYPT`（状态可读可保持，必要时也加密）。
- 开启 GAPBondMgr：`LE Secure Connections`（带 MITM，不用 Legacy Just-Works 才能防中间人），
  配对模式 `GAPBOND_PAIRING_MODE_INITIATE`，`IO_CAP` 视硬件定（无屏无键 → 可走 Passkey 显示在 App）。
- App 侧 `utils/ble.js` 连接后需完成配对流程（处理 `onBLEConnectionStateChange` 中的加密/绑定回调）。

#### P0-2：落地真正的绑定鉴权（替代 V-02 的虚假模型）
- 实现 `BIND` 命令：首次配对后，App 将 `user.js.getBindKey()` 经加密通道写入固件 Flash 存为 `g_bindKey`。
- `UNLOCK`/`LOCK`/`TRUNK` 改为 **challenge-response**：
  1. 设备生成随机 `nonce`（每次不同），App 读 FF02 或专用指令获取；
  2. App 计算 `HMAC(nonce, g_bindKey)` 回传；
  3. 固件校验通过才执行 GPIO 动作。
- `stores/ble.js:_shouldAutoReconnect` 中预留的 `if (!this.isBound) return false`（:1221）正式启用，
  未绑定设备不参与自动重连。

### P1 — 防重放与防定向

- **P1-1 重放防护（V-05）**：challenge-response 的 nonce 即天然防重放；额外加滚动计数器（固件存 `lastCounter`，拒绝 ≤ 旧值）。
- **P1-2 广播隐匿（V-06）**：设备名不再明文 `KeyGo-XXXXXX`；改用需 bond 后由 GATT 解析的私有名，或随机化广播局部名，干扰人群定向定位。注意：需与现有"name 前缀/厂商指纹"识别逻辑（`utils/ble.js:501-546`）联动改造。
- **P1-3 序列号收敛（V-07）**：FF04 仅在已 bond 状态下可读，未授权连接返回空/错误。

### P2 — 凭据与本地安全

- **P2-1 本地哈希升级（V-08）**：`user.js.hashPassword` 改用盐 + 多轮迭代（uni-app 无 Web Crypto 时，手写 PBKDF2 风格：随机盐 + 例如 5000 轮 HMAC-SHA256 等价实现），存储 `{salt, iter, hash}` 而非单值。
- **P2-2 日志脱敏**：生产日志避免打印明文指令/绑定相关内容（当前 `utils/ble.js:760` 会 `console.log` 写入内容）。

---

## 3. 验收标准（专项完成时）

- [ ] 未配对手机连接 KeyGo 后，写 FF03 `UNLOCK` → 固件拒绝（加密/权限拦截）。
- [ ] 已配对非本机（未 BIND）手机 → challenge-response 失败，无法开锁。
- [ ] 本机 BIND 后 → 正常开锁；抓包重放旧指令 → 被 nonce/计数器拒绝。
- [ ] 蓝牙嗅探器无法从广播直接识别 `KeyGo` 设备身份。
- [ ] 本地存储密码无法被快速还原。

---

## 4. 风险与依赖

- **固件改动需重新烧录验证**：P0-1/P0-2 涉及 CH582M 固件 + App 两端，且破坏旧版兼容（旧 App 无加密将连不上新固件）→ 需约定固件版本协商（建议 FF02 加 `fwsec` 版本字段，App 按版本走新旧路径）。
- **多手机共享**：一辆车多把手机的场景，BIND 需支持多 key（固件存 key 列表），本版先单 key。
- **配对手感**：无屏设备 Passkey 需 App 显示并用户输入，流程需 UX 验证。

---

## 5. 待办（专项启动后转为 TODO）

- [ ] 固件 GAPBond + 加密特征值改造（P0-1）
- [ ] 固件 BIND + challenge-response 指令改造（P0-2）
- [ ] App 配对/加密连接流程接入（P0-1/2）
- [ ] 固件版本协商字段（FF02 `fwsec`）
- [ ] 重放 nonce/计数器（P1-1）
- [ ] 广播隐匿化（P1-2）
- [ ] FF04 权限收敛（P1-3）
- [ ] 本地哈希升级（P2-1）
- [ ] 日志脱敏（P2-2）
- [ ] 多手机 BIND 支持（后续）
