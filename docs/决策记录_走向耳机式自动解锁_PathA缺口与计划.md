# 决策记录：确认走向耳机式自动解锁（Path A）+ 缺口与计划

> 日期：2026-07-15
> 背景：实测恢复出厂后重连无 passkey 弹窗，经串口核实根因；用户确认选择 **Path A（要耳机式自动解锁体验）**。
> 本文是对 `docs/Phase4_耳机式自动解锁与凭证硬化_设计落地清单.md` 的**实测补充与决策固化**，非重复设计。

---

## 1. 实测澄清（与早期设想的关键偏差）

- 固件 Phase1+2（commit `3c693f5`）已烧入：串口 `[BOND] init done, owners=1, bonding=1, mitm=1`，证明 `mitm=1` 已生效。
- 但正常连接全程是 GATT AUTH（`NONCE → AUTH:OK`），**从未触发 `Bonding_PasscodeCB`、从未出现 `bond saved`** → 说明 App 正常连接**只做 GATT + 应用层挑战应答，从不调 `createBond()`**。
- 结论：**Phase2 的 passkey 保护当前处于"休眠"**——只有手机侧主动配对（系统蓝牙设置点"配对"，或 App 首绑调 `createBond()`）才会触发 passkey 弹窗。正常流程根本不走配对。
- 因此"耳机体验"尚未成立：缺的是 **App 首绑触发 `createBond`** 这一半（Phase2 的 App 半边）。

## 2. owners=1 异常已澄清（非 bug）

- 本次串口从头到尾**无 `RESET:*`**，重启前最后一条是 `C1:LOCK`（App 带签名锁车指令），约 2s 后直接重启 → 这是**掉电/手动复位，不是隐藏键 8s 工厂复位**。
- RAW 通道正常（`NONCE:`/`AUTH:OK` flush 成功）；复位提示也走 RAW 通道（`RESET:OK` 必现），它没出现 ⇒ 复位未触发。
- `owners=1` + `config magic mismatch` 是烧录后 DataFlash 里的**旧数据**（旧信任列表 + 新固件 magic 不符→默认、模式从未写→255），什么都没被擦。
- 真验证 Phase1 以串口 `RESET:OK` + 重启后 `owners=0` 为准。

## 3. 决策：Path A（要耳机式自动解锁）

用户明确选择"要耳机体验"。即保留：
- 解锁闸门中的 `LINK_ENCRYPTED` 分支（bond 后 OS 自动重连 + 静默加密 → RSSI 解锁，无需 App）。
- 保留 autoConnect 基建（前台服务/亮屏唤醒），否则激进 ROM 下失去后台重连 → 耳机体验失效。

### 关于 Trae "BLE 没有 OS 特权，做不了耳机体验"——部分纠正
- 耳机体验内核（靠近自动重连 + 静默重加密 + RSSI 解锁）是 **BLE 规范标准行为**，每个已配对 BLE 设备都有，与经典蓝牙 OS 特权无关 → Trae 这点说错。
- Trae 那点"特权"仅指：通用 BLE GATT 外设不像 A2DP 耳机被 OS 当系统音频设备后台主动连。但这是否"脱离 App"取决于**有没有 autoConnect 上下文**（前台服务/亮屏唤醒），我方已搭好、与 passkey 正交。passkey 只决定"谁能 bond"，不决定"能不能自动连"。

## 4. 已做（已提交 `3c693f5`）

- Phase1 修 SNV 清除 bug（`Bonding_ClearSnvBonds` 清协议栈 LTK）。
- Phase2 固件启用 passkey/MITM（`mitm=1`、`DISPLAY_ONLY`、`Bonding_PasscodeCB` 回送绑定码、一次性迁移标记 `KEYGO_SECEP_ADDR`）。

## 5. 还没做（待办，按依赖排序）

1. **Phase2 App 半边（关键缺口）**：首绑流程调 `device.createBond()`，触发系统 passkey 弹窗输绑定码，持久化 LTK。这是让 passkey 活起来 + 耳机体验成立的必需缺口。
2. **Phase4 修订：不能一刀切退役前台服务**：保留 autoConnect 基建（前台扫描/亮屏唤醒），否则激进 ROM 下失去后台重连 → 耳机体验失效。原 Phase4 §5 的"常驻前台服务日常退役"需收敛为"可选高可靠模式（默认开/常驻按需）"。
3. **Phase3 AUTO 调阈 + 真机验收**：阈值/卡尔曼/确认计数真机实测定。
4. **guest 临时码机制（限事件/次数/时间）**：App + 固件临时码表，与 passkey/owner 正交（见 §6）。
5. **多 owner/管理员体系（Phase5，`fwsec` 升 2）**：首绑=管理员可删后绑；与 Phase1 单删 SNV 难点相关（随机私有地址旋转）。
6. **版本号** `3.33.2` → 建议验证通过后升 `3.34.0`，标记 passkey/owner 体系变更。

## 6. 关键考量（纠偏 guest 论断）

> **"guest 临时码走 App 层 AUTH，它不产生加密链路，所以 guest 永远拿不到'脱离 App 自动 RSSI 解锁'"——确认成立。**

理由：
- guest 走 App/小程序层 `NONCE/AUTH` 挑战应答，**不产生加密链路**（无 bond、无 LTK）。
- 解锁闸门 `LINK_ENCRYPTED || sessionAuthed`：guest 的 `LINK_ENCRYPTED` 永远为假；`sessionAuthed` 仅在 App 主动连上并完成 AUTH 时为真，App 不连即失效。
- 因此 guest **必须有 App 在场**才能解锁，无法"脱离 App"。要"脱离 App 自动解锁"必须 `LINK_ENCRYPTED`，即必须 bond → 必须 passkey。
- 补充（重要，见 `已验证事实_安全模型实测与纠偏.md` §1-2）：**即便 owner，当前真机上"App 被杀走近解锁"也尚未生效**——裸系统不维持已配对 BLE 连接，重连靠 App 前台服务。所以"脱离 App"对所有人都难，Path A 正是要保留 autoConnect 基建把 owner 这一侧补上；guest 则结构性被排除。

其它考量：
- **passkey 是耳机体验的安全前提**：否则任何装 App 的陌生人 Just-Works `createBond` 即拿加密链路 → RSSI 自动解锁，等于"谁装 App 谁主人"。passkey 把"能 bond"锁成"知道绑定码才能 bond"。
- **已配对手机（家人/自己）即使被别人拿也能解锁**——与车钥匙/耳机同模型，设计内取舍，非漏洞。
- **guest 与 passkey 正交**：guest 解决"短期借出"，owner/bond 解决"长期共享 + 自动解锁"；两者都该做，互不替代。

## 7. 下一步

- 落地 Phase2 App 半边 `createBond` 触发 + 配套"系统蓝牙输码"引导；随后真机看 passkey 弹窗 + 之后耳机式自动解锁。
- 同步修订 Phase4 为"保留 autoConnect 基建（前台服务/亮屏唤醒）"。
