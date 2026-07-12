# KeyGo 绑定功能 · 分阶段方案与阶段 1（明文绑定）改动清单

> 文档状态：阶段 1 讨论稿（仅注释/保留原函数，便于阶段 3 一键恢复）
> 制定日期：2026-07-11
> 背景：此前在「传输管道尚未钉死」时就叠加了 AUTH 加密握手，导致绑定/改码/解锁的 bug 互相掩盖。经全链路走查，决定**先明文跑通地基，再叠加加密**。

---

## 0. 核心结论（为什么可以"明文先行"）

全链路走查确认：**固件 `BIND` 成功即把会话标记为已认证**，加密只是后来叠加的一层 AUTH 握手。

- 固件 `BIND:<code>` 成功后置位 `s_sessionAuthed = 1`（`code/CH582M/CH582M_BLE_Slave/APP/bonding.c:400`）。
- 命令门控（`peripheral.c:765`）：非绑定指令执行前查 `Bonding_Count() > 0` 且 `Bonding_IsSessionAuthed()`。
- `SETCODE` 前置（`bonding.c:430`）：要求 `s_sessionAuthed`。
- `BIND:` 本身走独立特殊分支（`peripheral.c:724`），**不受上面门控限制**，永远可发可成功。

⇒ 因此「明文绑定阶段」**固件零改动**，只要 App 不再强制走 NONCE/AUTH 握手，BIND 成功后的会话就已被固件视为已认证，下游命令全部放行。

---

## 1. 三阶段总览

| 阶段 | 目标 | 加密 | 固件改动 | App 改动 | 复杂度 |
|---|---|---|---|---|---|
| **1 明文绑定** | BIND 成功即放行，验证写串行/FF02 路由/改码解锁全链路 | 无 | 零 | 注释掉 `ensureSession`/`_authWithKey` 调用 | 低 |
| **2 自动重绑** | 重连后自动用本地明文码 BIND，免手动 | 无 | 零 | 连接回调自动发 `BIND:<code>` | 低–中 |
| **3 加密硬化** | 用 NONCE→AUTH:HMAC 取代明文重绑，码不在空中出现 | HMAC 挑战应答 | 零 | 恢复 `ensureSession`（取消注释） | 中 |

> 阶段 3 的 `ensureSession` / `_authWithKey` / `deriveBindKey` 在阶段 1 中**全部保留不删**，仅注释掉调用点，阶段 3 取消注释即可恢复。

---

## 2. 阶段 1 详细改动清单

涉及文件：`app/BLE_Key_Go_App/stores/ble.js`（App 端）。固件端无改动。

### A1. `sendCommand` 跳过 AUTH 握手，改判 `sessionAuthed`

- 位置：`stores/ble.js:2740-2753`
- 现状：`2744-2753` 判别非绑定指令后调用 `ensureSession()` 发起 NONCE/AUTH 加密握手，失败则抛错。
- 做法：把 `2744-2753` 整段**注释掉**，替换为：

  ```js
  // ★ 阶段1(明文): 控制指令仅要求本连接已完成 BIND（sessionAuthed 由 BIND:OK 置位），
  //   暂不走 NONCE/AUTH 加密握手。阶段3 恢复 ensureSession() 调用。
  if (!/^(BIND:|AUTH:|NONCE|UNBIND|SETCODE:)/.test(command)) {
    if (!this.sessionAuthed) {
      const e = new Error('设备未绑定，请先绑定'); e.code = 'NOT_BOUND'; throw e
    }
  }
  ```

- 理由：BIND 成功后固件已 `s_sessionAuthed=1`，下游命令本就放行。加密握手由 `ensureSession` 函数保留，阶段 3 恢复。

### A2. `bindDevice` 去掉 AUTH 兜底握手

- 位置：`stores/ble.js:2957-2965`
- 现状：`if (!bound)` 时调用 `this._authWithKey(key)` 走加密握手兜底确证绑定。
- 做法：把 `2957-2965` 整段**注释掉**。若 `BIND:OK` 未拿到则直接 `bound = false`，失败提示反映真实情况（不再偷偷走加密）。
- 理由：阶段 1 要隔离加密变量。`BIND:OK` 在白名单修复 + 固件延迟发送修复后应稳定送达，无需兜底。`_authWithKey` 函数保留。
- 备注：`2929` 的 `const key = deriveBindKey(code, sn)` 与 `2970` 的 `_bindKey = key` 可保留（无害，阶段 3 复用），也可一并注释；建议保留以便平滑过渡。

### A3. `changeBindCode` 去掉 `_authWithKey` 前置

- 位置：`stores/ble.js:3078-3090`
- 现状：`3078-3089` 先用旧 key 走 NONCE→AUTH 重建会话，再发 `SETCODE:`。
- 做法：把 `3078-3089` **注释掉**，直接信任本次会话 `sessionAuthed`（BIND 已置位）后发 `SETCODE:`（`3097`）。`3090` 的 `this.sessionAuthed = true` 保留。
- 理由：阶段 1 会话已因 BIND 为 authed，固件 `SETCODE` 前置 `s_sessionAuthed` 也满足，不需 AUTH。

### A4. 连接成功回调的自动 `ensureSession` 改为不强制加密

- 位置：`stores/ble.js:1684-1693`
- 现状：`1688` 连接后用本地 `_bindKey` 调 `ensureSession()` 做 AUTH 握手。
- 做法：把 `1687-1692` **注释掉**（阶段 1 不做加密自动重连，由用户手动 BIND）。
- 副作用：重连后 `sessionAuthed = false`，直到手动 BIND —— 符合"每连接手动重绑"设定。

### A5.（已做，保留）FF02 通知白名单加 `SETCODE:`

- 位置：`stores/ble.js:481`
- 内容：已将 `SETCODE:` 加入 `_SHORT_PREFIX` 白名单。
- 说明：这是**管道修复**（之前 `SETCODE:OK` 被当 JSON 静默丢弃），与加密无关，三阶段都要，保留不动。

---

## 3. 固件端（阶段 1 零改动 + 前置验证）

- **零改动**：BIND 已置位 `s_sessionAuthed`；命令门控、SETCODE 前置都基于 `s_sessionAuthed`，BIND 成功即满足。
- **前置验证（必做）**：确认手机里烧的固件含「延迟发送短报文」修复——即 `keygo_core.c` 的 `KeyGo_SendRawNotify` 走 `SBP_DEFERRED_RAW_EVT`（写回调外经 TMOS 任务发送），而非写回调内同步 `GATT_bm_alloc`+`simpleProfile_Notify`。否则 `BIND:OK` 仍会偶发被丢弃。
  - 判断依据：能在控制台看到 `AUTH:OK` / `NONCE:` 说明多半已含该修复；但首次阶段 1 验证前建议核对一次 `keygo_core.c`。

---

## 4. 验证步骤

1. HBuilderX 重编运行（仅 App，固件不动）。
2. **首绑**：输入默认码 `123456`（或机身码）→ 点绑定 → 预期 toast「绑定成功」，`sessionAuthed = true`。
3. **解锁**：点解锁 → 设备应解锁（不再报 `AUTH_FAIL` / 未绑定）。
4. **改码**：`当前码` + `新码` + `确认` → 预期「绑定码已修改」；用新码能解锁、旧码应失败。
5. **控制台核查**：`[BIND] notify:` 应只出现 `BIND:OK` / `SETCODE:OK`，**不再有 `NONCE:` / `AUTH:` 流量**。

---

## 5. 风险与回退

- **风险①（安全）**：明文绑定码在空中传输，可被 sniff / 猜中 `123456` 控制锁。**仅限开发阶段**，阶段 3 前不可发布。
- **风险②（重连体验）**：阶段 1 断连后需手动重绑 —— 属预期（阶段 2 解决）。
- **回退**：所有改动均为"注释一段"，`ensureSession` / `_authWithKey` / `deriveBindKey` 全部保留未删，阶段 3 取消注释即恢复加密路径。

---

## 6. 阶段 3 唯一易错点（提前预警）

阶段 3 恢复 `ensureSession` 时，`js` 端 `hmacSha256Hex` 与 `c` 端 `Bonding_HandleAuthResp` 的**字节序 / hex 编码必须对齐**，否则 `AUTH` 永远 FAIL。建议在阶段 3 用一组固定向量（已知 nonce + key → 预期 HMAC）两端单测对齐一次，再上真机。
