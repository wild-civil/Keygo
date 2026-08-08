# 2026-08-09 已知设备语义 + 电量显示 + 连接健壮性 复盘

> 本文记录 2026-08-09 当天对 KeyGo App / 固件做的一组修复：电量"不支持"图标优化、
> P0-② 连接健壮性、V03 误报 0% 固件修复、P1-① 已知设备语义（AUTH 通过才算已知）。
> 每条均对应独立 commit，现象/根因/修复分开写。

---

## 一、电量"不支持"图标：🚫 → 🔋（commit 0c1abeb）

### 现象
- V03（无电池 ADC 分压电路）固件经 Δ 法判定无分压后回报 `batteryLevel=255`，App 识别后
  显示 🚫 + "不支持"。用户实测已正确显示，但 🚫（禁止符号）语义模糊，易误读为
  "设备被禁用 / 操作被禁止"，无法明确表达"是不支持电量检测"。

### 修复
- `stores/ble.js` `batteryIcon` getter：`batteryLevel===255` 的图标 `'🚫'` → `'🔋'`。
  配合 `batteryText` "不支持" 文案 + 橙色 `.batt-unsupported` 样式，含义明确：
  **电池图标 + "不支持" = 该设备不支持电量检测（如 V03 未画分压电路）**。

### 影响
- 仅图标字符变更，不影响 255 识别逻辑、连接重置、跨板粘连修复。
- V04（有 ADC）电量显示不受影响（≥0 走正常电量图标）。

---

## 二、P0-② 连接健壮性：断开设备后必能重连（commit 50985ee）

### 现象
- 用户先点「断开连接」再点「重新连接」时存在两类隐患：
  1. `disconnect()` 中 `disconnectDevice` API 抛错时直接 `return false` 且**不执行后续状态清理**
     （`_destroyGlobalListeners` / `connected=false` / `deviceId=''` 等）→ 残留半连接态
     （`connected` 仍 true、监听器未销毁、deviceId 残留）→ UI 卡"连接中"，无法重连。
  2. 断开后 `reconnectMode='dormant'`，「重新连接」按钮直接调 `connect(id)` 未显式清 `dormant`
     → 连上后若再次异常掉线，因 `dormant` 残留不会自动重连。

### 根因
- `disconnect()` 把状态清理放在 `try{...}catch{return false}` 的 catch 之后，API 失败即跳过清理。
- 重新连接入口未显式清除"用户主动断开"抑制标记。

### 修复（stores/ble.js）
- `disconnect()` 加固：断开前先保留 `lastDeviceId`（重连锚点）；`disconnectDevice` API 失败仅告警、
  不 return，继续执行完整状态清理（保证断开后状态确定一致、必然可重连）。
- 新增统一重连入口 `reconnectDisconnected()`：清除 `dormant` + 递增 `_reconnectGuard`（使在途旧
  session 失效）+ 预清理残留系统连接句柄 + `connect(lastDeviceId)`；失败保留 `lastDeviceId`
  允许再次点击。
- `pages/control/control.vue` / `pages/index/index.vue` 的 `handleReconnect` 无 `targetMac`
  （重连已断开的当前设备）改调 `reconnectDisconnected()`；有 `targetMac`（多设备列表连其他设备）
  保持原 `connect(id)` 逻辑。

### 影响
- 仅增强断开/重连的健壮性，不影响正常连接、自动重连、电量显示等既有逻辑。
- `dormant` 语义保留：用户主动断开后后台仍不自动重连，仅「重新连接」按钮触发。

---

## 三、V03 误报 0% → 固件多次平均采样修复（commit 227b0bc）

### 现象
- V03（无 ADC 分压电路）重烧最新固件（含 `BOARD_HAS_EXT_BAT_ADC` + Δ 法判定）后，电量仍显示
  🔋0%，而非预期的"不支持"(255)。此前曾偶发显示"不支持"，行为**不稳定**。
- 绑定问题解决自动断开后（见第四节），电量显示问题暴露为独立固件 bug。

### 根因
- C 方案 Δ 法（开/关 PB3 闸门前后 ΔadcVal < 阈值 → 255）使用**单次采样**。
- V03 的 PA3 为**纯高阻浮空输入**（无分压、无 100nF 电容），浮空噪声大；开/关 PB3 两次采样
  间隔 200ms，浮空电位随机漂移可能 ≥200 counts → 误判"有分压" → 两点校准
  `batt_mV = adcVal×4242/1000 - 6590` 算出落在 3600mV 以下 → `level=0`（误报 0%）。
- 浮空噪声随机 → 偶发 Δ<200（显示不支持）、偶发 Δ≥200（显示 0%），与"不稳定"现象吻合。

### 物理判据（关键）
| 状态 | 闸门关闭 PA3 | 闸门开启 PA3 | 多次平均后 Δ |
|------|-------------|-------------|-------------|
| V03 无分压 | 浮空（纯高阻，无 100nF） | 仍浮空 | 趋近 0 |
| V04 有分压 | 浮空 | 被 100nF 低阻抗驱动到 Vbat/2（稳定） | 仍 >1200 |

→ **平均法对 V03 特别有效**：4 次平均把浮空随机噪声砍掉一半以上，平均后 Δ 趋近 0；
V04 有 100nF 低阻抗驱动，平均不改变 Δ（仍巨大）→ 可靠区分。

### 修复（Profile/battery_service.c）
- `Battery_Init` / `Battery_UpdateLevel`：采样由"单次"改为**闸门关 / 开各采样 4 次平均**。
- Δ 判定阈值 `200` → `300`（平均后浮空 Δ 远小于此，分压 Δ 仍巨大，留足余量）。
- 同步更新两处注释，说明多次平均的物理原理与阈值选取。

### 影响
- V03：稳定判定为无分压 → 报 255（App 显示 🔋 不支持），不再误报 0%。
- V04：有分压 → 平均后 Δ 仍巨大 → 正常两点校准，电量显示不受影响。
- 每次采样成本 +3 次转换（微秒级），对 1s 周期电量更新可忽略，功耗无显著影响。

### 经验固化
- **浮空引脚判定不可靠**：必须用"多次平均消除噪声"或"确定电平区间"，而非单次 Δ 阈值。
- **部署铁律回顾**：改固件后务必重烧最新 hex；V03/V04 烧同一份固件（`BOARD_HAS_EXT_BAT_ADC` 已开启）。

---

## 四、自动断开根因：本机未绑定 → 固件 30s 强断（App 诊断修复 commit e42b517）

### 现象（用户日志）
```
01:37:31  Notify 订阅成功
01:37:34  电池 0%（GATT Read）
01:37:57  系统级断连 connected=false   ← 固件 30s 超时强断
01:37:57  authed=false bound=false     ← 从未完成鉴权
01:38:00  Status Notify 超时 → 强制重建 GATT（此时已死，乱重建）
```
- 设备连上约 30s 自动断开；日志全程无 AUTH 握手记录。

### 根因
- **固件 30s 未收到合法 AUTH 即强断**（`authed=false`）。App 侧 `_maybeAutoAuth` 在
  `!B._bindKey`（本机无该设备绑定密钥）时**静默 return 无任何提示** → 用户只看到"连上被踢"，
  不知是"本机未绑定"。
- 用户确认：之前「忘了绑定」→ 重新绑定后自动断开消失（坐实根因：本机无密钥 → AUTH 永不通过 → 30s 强断）。
- 伴生 App bug：`_statusStaleTimer` 触发的 `_repairConnection` 在系统已真断后仍对已死连接强行走
  `closeBLEConnection` + 重建路径，制造混乱。

### 修复（stores/ble.js）
- `_maybeAutoAuth`：`!B._bindKey` 时不再静默 return，显式置 `_autoAuthState='need-bind'`
  + `bindHint='设备未绑定，请先绑定'`，并打印警告日志，让 UI 立即告知根因。
- `_repairConnection`：进入重建前用 `_verifyConnection(targetId, 1500)` 复核系统真实连接状态；
  若已真断，放弃 GATT 重建、直接 `_scheduleReconnect(0)`，避免对已死连接瞎重建打断在途 AUTH 握手。

### 影响
- 仅增强诊断与状态机健壮性；不改变正常 AUTH / 绑定 / 重连成功路径。
- 自动断开的根因（authed=false / 30s 强断）需结合"本机是否绑定"确认 —— 本提交让"未绑定"类根因
  暴露为明确 UI 提示，便于快速定位。

---

## 五、P1-① 已知设备语义：AUTH 通过才算已知（本次核心改动）

### 目标（用户 2026-08-09 讨论决策）
- **已知设备 = 本机通过 AUTH 鉴权 / BIND 绑定的设备（真 owner）**，而非"连过的设备"。
- 陌生 / 未绑定连接不应进入 `knownDevices` 集合，避免污染"重新连接"卡片。

### 旧实现问题
- `_touchKnownDevice(mac)` 在 `_finalizeConnection`（连接成功）时**无条件调用** → 任何连过的设备
  （含 AUTH 失败 / 未绑定）都进 `knownDevices` → 多设备列表 / 重新连接卡片被污染。

### 新实现（stores/ble.js）
1. **移除** `_finalizeConnection` 中的 `_touchKnownDevice(deviceId)` 调用。
2. **新增记录时机**：
   - `AUTH:OK` 分支：`this._touchKnownDevice(this.deviceId)` —— AUTH 通过 = 真 owner。
   - `BIND:OK` 分支：`this._touchKnownDevice(this.deviceId)` —— 首绑 / 接管成功 = 新 owner。
   - 陌生人 / 未绑定连接永远到不了 `AUTH:OK` / `BIND:OK`，故不会污染列表。
3. **反向清理**（语义对称）：
   - 新增 `_removeKnownDevice(mac)`。
   - `_forgetDeviceKey`（设备复位 / 密钥失效）→ 调 `_removeKnownDevice`（不再是有效 owner）。
   - `UNBIND:OK`（用户主动解绑）→ 调 `_removeKnownDevice`（不再是已知设备）。

### 影响
- "重新连接"卡片仅展示本机已绑定 / 鉴权过的设备，体验更干净。
- 不影响自动重连、系统连接复用（`_reuseSystemConnectedDevice` 命中时已 AUTH 通过，列表必有该设备）。
- 多设备排序（默认设备置顶 + 最近连接倒序）逻辑不变，仅集合准入门槛更严格。

---

## 六、commit 一览（2026-08-09）

| commit | 主题 |
|--------|------|
| `0c1abeb` | fix(app): 电量"不支持"改用 🔋 图标替代 🚫 |
| `50985ee` | fix(app): P0-② 连接健壮性——断开设备后必能重连 |
| `e42b517` | fix(app): 连接自动断开诊断——未绑定显式提示 + 防已死连接瞎重建 |
| `227b0bc` | fix(fw): V03 电量误报 0% → 改用多次平均采样消除浮空噪声 |
| (P1-①)  | fix(app): P1-① 已知设备语义——AUTH/BIND 通过才算已知 |

---

## 七、待办

- [ ] **P1-② 删除交互**：已知设备列表项支持左滑 / 长按菜单删除（清除持久化 knownDevices +
      customName + lastDeviceId），与 P1-① 的准入门槛配合形成完整"增删"闭环。
- [ ] 用户重烧 `227b0bc` 固件验证 V03 稳定显示"不支持"（已口头确认通过，但建议再烧一次最新 Δ 法确认）。
