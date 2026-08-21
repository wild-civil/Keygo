# 「连接中 ~6s / 断开中 ~3s」耗时核查与优化点（2026-08-18）

> 背景：用户对 CodeBuddy 的分析存疑，要求基于最新代码（commit 2b8cd0e / 2e8368f）复核。
> 结论：**CodeBuddy 有 3 处错误/过时；真正的耗时大头是 `connect()` 的无条件预清理 + createBLEConnection 平台耗时 + 固定 1000ms 盲等**。

---

## 一、CodeBuddy 分析的对错裁定

| CodeBuddy 说法 | 裁定 | 依据（最新代码） |
|----------------|------|------------------|
| 3516 行固定 `await 1000ms` 在 loading 内 | ✅ **正确** | `stores/ble.js:3516` 确实存在且无条件执行，index.vue:634-636 `showLoading → await connect() → hideLoading` 包裹它 |
| 「连接中」≈ createBLEConnection + 固定 1000ms | ⚠️ **不完整** | 漏掉了 `connect()` 开头 3460 行**无条件 `await 700ms`** 预清理等待 |
| connectDevice「含 MTU + 服务发现」 | ❌ **错误** | `utils/ble.js:746-805`：MTU 是异步 fire-and-forget（`setBLEMTU` 不阻塞 resolve）；**服务发现根本不在 connectDevice 里**，在 `_finalizeConnection`（无 await、不阻塞 loading） |
| 根因是「固件连接参数慢」 | ❌ **过时** | 已被 commit 2e8368f（广播声明 30/60ms）+ 2b8cd0e（连接后 80ms 发 FAST 40/80ms）修复。AUTH 握手已实测 <1s（2e8368f commit message） |
| 断开 1500ms 可压到 800ms | ❌ **混淆** | `disconnect()` 3573 行是**最多等 1.5s、命中 `onBLEConnectionStateChange` 断连事件即 resolve**（上限非固定）。断开 3s 的主因是 `closeBLEConnection` 慢（complete 不回调吃满 3s 硬超时），不是这 1.5s |

---

## 二、「连接中 ~6s」的真实构成（最新代码）

```
handleConnect / handleReconnect → showLoading('连接中') → await connect()
─────────────────────────────────────────────────────────────
connect() 内串行：
① 无条件预清理（3448-3460）：
   - uni.closeBLEConnection（2s 硬超时兜底）—— 即使 connected=false 也执行
   - await 700ms（3460，无条件！）            ← 固定 0.7s
② _connectWithResetFallback → connectDevice：
   - stopScan（快）
   - createBLEConnection（平台 timeout 10s / 硬超时 18s）  ← ★ 大头，实测推算 ~4.3s
   - 成功即 resolve（MTU 异步不阻塞）
③ this.connected = true（3468）
④ await 1000ms（3516，无条件固定等待）         ← 固定 1.0s
⑤ _finalizeConnection（无 await，不阻塞 loading）
⑥ return → hideLoading
─────────────────────────────────────────────────────────────
总计 ≈ 0.7s（固定）+ createBLEConnection（~4.3s?）+ 1.0s（固定）
```

**关键点**：
- 固定开销 **1.7s**（700ms + 1000ms）—— 占 6s 的 28%，纯可省；
- `createBLEConnection` 约 **4.3s** —— 才是大头，但**原因未知，需日志确认**（见第四节）；
- 「连接中过后才显示 RSSI/设备名/绑定验证」是因为这些都在 `_finalizeConnection` 的**异步流程**里（读 SN / 订阅 FF02 / AUTH），loading 结束 ≠ 初始化完成。

---

## 三、可优化项（按收益排序，均基于最新代码事实）

### 1.【App·高收益】`connect()` 预清理条件化 —— 省 0.7~2.7s
`stores/ble.js:3448-3460`：**无条件**执行 closeBLEConnection（2s 上限）+ 700ms。
对比 `_doReconnect`（2526-2540）已做条件化：`if (this.connected)` 才拆链等待，else 跳过。
**改法**：与 `_doReconnect` 对齐——仅当 `this.connected === true`（旧链还活着）才 close + 700ms；断开状态下直连跳过。省 0.7s（close 未超时）~ 2.7s（close 吃满 2s 超时）。

### 2.【App·高收益】固定 1000ms 盲等 → 真实就绪信号 —— 省 ~0.5~1s
`stores/ble.js:3516` 盲等 1s 是历史遗留（v3.15-fix6）。`_finalizeConnection` 里的 `_enableStatusNotify`（FF02 订阅）才需要 GATT 就绪。
**改法**：把 `_enableStatusNotify` **提前到 connect 内直接调用**（已知 UUID 常量，无需服务发现），用「订阅成功 / 首次 FF02 到达」作为就绪信号，去掉固定 1000ms（或降为 300ms 保底）。已存在 `_armFf02ArrivalProbe` 机制可复用。

### 3.【App·中收益】`reconnectDisconnected` 的 closeBLEConnection 无超时兜底 —— 健壮性缺口
`stores/ble.js:3652-3656`：`new Promise((resolve) => { uni.closeBLEConnection({ deviceId, complete: () => resolve() }) })` —— **没有硬超时**！
若 complete 不回调（与项目其他处同类 Android 静默挂起问题），`reconnectDisconnected` 永久挂起 → `handleReconnect` 的 loading 永不消失。
**改法**：加 2s 硬超时兜底（与 connect/_doReconnect 一致）。

### 4.【App·低收益】断开 3s 的查证方向
`disconnect()`：`disconnectDevice`（closeBLEConnection，3s 硬超时）+ 最多等 1.5s 断连事件（命中即 resolve）。
**3s 的主因 = closeBLEConnection 慢**（complete 不回调吃满 3s 硬超时）或断连事件到达慢。**不建议压 1.5s 上限**（它已是"命中即返回"，且是等待系统确认的必要窗口）；应抓日志确认 closeBLEConnection 为何慢。

---

## 四、必须先确认的事实：createBLEConnection 为什么 ~4s？

这是 6s 里的大头，但**当前无日志证据**。两种可能：

| 假设 | 判断 | 验证方法 |
|------|------|----------|
| A. Android 建链本身慢（定向连接排队 / stale ACL 未清） | 平台行为，App 无解 | 日志看 `connect()` 开始 → `createBLEConnection success` 间隔 |
| B. success 回调延迟（连接已建立但状态事件晚到） | 可尝试更早 resolve（风险高） | 固件串口 `Connected xx - Int xx` 时刻 vs App success 时刻对比 |

**建议**：在 `connectDevice` 的 `createBLEConnection success` 前后加时间戳日志（`console.time` / Date.now 差），一次实测即可定位。**在确认前，不要为它写任何"优化"代码。**

---

## 五、结论

1. **CodeBuddy 3 处错误**：connectDevice 不含服务发现（❌）；"固件连接参数慢"已过时（❌，已被用户 2 个 commit 修复）；断开 1.5s 是上限非固定（❌）。
2. **可信优化只有 2 个**（纯 App，无固件改动）：
   - `connect()` 预清理条件化（省 0.7~2.7s）
   - 固定 1000ms 盲等 → 真实就绪信号（省 ~1s）
   - 附带 1 个健壮性缺口：`reconnectDisconnected` 的 closeBLEConnection 加 2s 超时
3. **大头（createBLEConnection ~4s）原因未知**，先加日志实测，再决定是否可优化。
4. 固件侧 AUTH fast 参数链路（用户已实施）经核查**实现正确**：事件位已从 0x0080 修正到 0x0004（避开状态机撞位），AUTH 后 200ms 切回 DEFAULT，无规范频率问题。
