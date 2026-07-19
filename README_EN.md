# KeyGo · Bluetooth Smart Car Key (Phone as Car Key)

> A Bluetooth car-lock solution built on **CH582M (RISC-V) BLE slave firmware + a uni-app (Android) phone App**.
> The phone connects to the lock over BLE and delivers a "phone-as-key" experience via **RSSI passive entry + real binding authentication**.
> Supports **car / e-bike dual mode**, with **Comfort / Turbo / Manual** three-tier auto-reconnect strategies.

---

## 1. Project Overview

| Item | Detail |
| --- | --- |
| Name | KeyGo · Bluetooth Smart Car Key |
| Form | Phone App (uni-app, Android) + Lock firmware (CH582M) |
| Goal | Replace the physical car key with a phone: RSSI passive entry + real binding auth |
| Firmware version | **3.36.2** |
| Auth system | v1 (per-phone identity + RSSI threshold follow, `fwsec=2`) |
| Dual mode | Car (key/trunk) / E-bike (key/ride) |
| Reconnect | Comfort / Turbo / Manual three tiers |

## 2. Design Philosophy (Logic & Goals)

KeyGo is built around three principles:

1. **Security-first, not MAC-trust.** Unlocking is gated by *real authentication*: a per-phone key derived from the binding code + device serial, verified every session via a nonce + HMAC-SHA256 challenge-response. Device trust is based on a shared secret, **not** on the Bluetooth MAC.
2. **Passive entry + explicit control.** The phone auto-unlocks when it is physically close (RSSI threshold + session auth double gate). An optional **no-App mode** lets the lock itself act as a passive anchor (OS-encrypted reconnect + RSSI auto-unlock) without the App running.
3. **Reliability + power-awareness.** Three reconnect tiers + a native Android foreground-scan service keep background reconnection robust across Doze/manufacturer kill. Power-wise, the internal ADC sampling (temperature/battery) is negligible (nA-scale); the real levers are BLE RF, LED, and (once external) the divider MOS — see the power analysis doc.

## 3. Core Features

| Feature | Description | Status / Notes |
| --- | --- | --- |
| BLE connection | Phone ↔ lock BLE GATT read/write control | Landed |
| Passive entry | Phone auto-connects when near; screen-on / unlock auto-unlocks (RSSI threshold + system auth double gate) | Landed |
| Real binding | Binding code + device serial derive `bindKey`; challenge-response (`NONCE` + HMAC-SHA256) auth | Landed |
| Physical buttons | UNLOCK / LOCK / 3rd key; dual-pulse RIDE for e-bike; TRUNK for car | Landed |
| Remote / unattended | **No-App mode (v3.34.0)**: firmware-side HID passive anchor, OS-encrypted reconnect + RSSI auto-unlock, no App needed | Landed |
| Multi-phone | Trust list (capacity 8) + per-phone auth; primary phone can manage remotely | Landed (v3.36, fwsec=2) |
| Dual mode | Car (key/trunk) / E-bike (key/ride), mode stored on device | Landed |
| Low power | Comfort/Turbo/Manual tiers; BLE RF + native background scan service (with Doze heartbeat) | Landed |
| Battery monitoring | Real-time battery %; alert below 20%; 18650 Li-ion | Landed (dev board uses internal VBAT channel; reading is constant under LDO@3.3V, accurate only after moving to external divider+MOS on the real board) |
| Chip temperature | Real-time chip temperature (FF02 `t` field, CH582M TSENSE 5s throttled sampling); hidden on disconnect | Landed (CH582M internal sensor) |
| Security | Binding-code auth, challenge-response, RSSI anti-occupy, timeout force-disconnect, encryption gating | Landed (encryption gating reverted in v3.32.1, Phase 4 redo `[TODO]`) |

## 4. Working Logic

### 4.1 RSSI Passive Entry (Dual Gate)
- Auto-unlock requires **both**: OS-level encryption/link established **and** App session authenticated **and** RSSI inside the unlock threshold.
- RSSI threshold is **per-phone**: each phone writes its own unlock/lock threshold after AUTH (see FF02 `ou`/`ol`), solving the "global threshold doesn't fit every phone's TX power/antenna" problem.

### 4.2 Real Binding & per-phone Auth (v3.36, fwsec=2)
- KDF (firmware & App share the same source): `bindKey[16] = SHA256(utf8(bindCode) ‖ utf8(serial))[0:16]`, `serial` = FF04 MAC in hex (12 uppercase).
- **per-phone**: `phoneKey[16] = HMAC-SHA256(bindKey, phoneId)[0:16]`, `phoneId` = the phone's stable identifier. Each phone holds an **independent key**.
- Challenge-response: device sends `NONCE(16B)` → App replies `AUTH:<phoneIdHex16>:<HMAC-SHA256(nonce, phoneKey) hex>`; device locates the owner by `phoneId` and verifies `phoneKey`. `NONCE` is one-time.
- Default binding code `123456` (placeholder) — **recommend changing after first bind**.
- Anti-DoS: unauthorized connection idle > 30s → force disconnect (`BIND:TIMEOUT:30S`); App stops native scan on timeout.

### 4.3 Dual Mode
- First two keys (UNLOCK/LOCK) identical; 3rd key = TRUNK (car) / RIDE double-pulse (e-bike, PB4 LED sync). Mode stored in device flash.
- Switch entry: control page bottom "Device Mode" card (`control.vue`); config command `MODE:car`/`MODE:ebike` (FF03, encryption+bbing protected).

## 5. Protocol & GATT

| Service | Perm | Dir | Use | Notes |
| --- | --- | --- | --- | --- |
| `0000FF01-...` | Write | App→Dev | Config push | `unlock=-45 lock=-65 uc=3 lc=5 interval=500 kf_r=15.0 autolock=1 mode=car` (`autolock=0` disables firmware RSSI auto-lock; `mode=car\|ebike` switches dual mode) |
| `0000FF02-...` | Read, Notify | Dev→App | Status report | JSON: `{"c":1,"st":"LOCKED","r":-52,"f":-52,"b":85,"t":32.5,"d2":"","cd":8000,"kr":15,"al":1,"bn":1,"v":"3.36.2","m":0,"uc":3,"lc":5,"ucnt":1,"lcnt":0,"th":1,"ou":-45,"ol":-65,"fwsec":2}` |
| `0000FF03-...` | Write | App→Dev | Control / bind commands | `UNLOCK` / `LOCK` / `TRUNK` / `RIDE` / `BIND:code\0phoneIdHex` / `AUTH:phoneIdHex:hmac` / `SETCODE:new` / `UNBIND` / `RSSISET:unlock:lock` / `STATUS` / `MODE:car\|ebike` |
| `0000FF04-...` | Read | Dev→App | Device info | MAC / version / bind state |

- Advertising interval: 50ms; any ≥1s scan window captures it.
- FF01 / FF02-CCCD / FF03 current permissions: `GATT_PERMIT_READ` + `GATT_PERMIT_WRITE` (**no encryption gating**, see Phase 4 `[TODO]`); FF04 readable.

### FF02 status fields (Dev→App, periodic)

> ⚠️ This is the **status report** window; it does NOT participate in unlock/lock decisions (decisions are in the firmware state machine).

| Key | Meaning | Example |
|----|------|--------|
| `c` | Connection flag (always 1) | `1` |
| `st` | Lock state | `LOCKED` / `UNLOCKED` / `ACTION` |
| `r` | Real-time RSSI (dBm) | `-52` |
| `f` | Kalman-filtered RSSI | `-52` |
| `d2` | Device custom name | `""` |
| `cd` | Manual-command cooldown (ms) | `8000` |
| `kr` | Kalman R (filter strength) | `15` |
| `al` | Auto-lock enable state | `1`=on (Comfort/Turbo) / `0`=off (Manual) |
| `bn` | Bound flag | `1`=bound / `0`=unbound |
| `v` | Firmware version | `3.36.2` |
| `m` | Device mode | `0`=car / `1`=e-bike |
| `uc` | Device unlock-confirm count config (echo to verify push landed) | `3` |
| `lc` | Device lock-confirm count config | `5` |
| `ucnt` | Current unlock progress count | `1` |
| `lcnt` | Current lock progress count | `0` |
| `th` | Current zone: `0` neutral / `1` unlock zone / `2` lock zone | `1` |
| `ou` | **Effective unlock RSSI threshold** (owner-specific or global, v3.36) | `-45` |
| `ol` | **Effective lock RSSI threshold** (owner-specific or global, v3.36) | `-65` |
| `fwsec` | Protocol capability version (1=baseline, 2=auth v1) | `2` |
| `t` | Chip temperature (°C), CH582M internal TSENSE (5s throttle); `null`/absent on disconnect or when not sampled | `32.5` |

## 6. Architecture & Status

### 6.1 Firmware
- **CH582M** (RISC-V 60MHz, BLE 5.0): current main firmware, developed in MounRiver Studio (MRS) + TMOS RTOS. WCH BLE stack has no SHA/HMAC/HWRNG, so `crypto_sha256.c` is self-implemented.
- **ESP32C3** (Arduino .ino, v1~v3.13): early prototype, **archived**.
- **nRF52/54**: planned port target. Note: nRF52 already has an internal TEMP sensor; BLE 6.0 Channel Sounding (phase-based ranging) is a future upgrade path for centimeter-grade secure distance unlocking — see the power/future doc.

### 6.2 App
- **uni-app + Pinia** (`stores/ble.js` core state machine ~4100 lines: connect/reconnect/three modes/session auth).
- Native plugin **Keygo-Foreground**: Android foreground-scan/reconnect/auto-AUTH service (with Doze heartbeat + 15s self-respawn).
- Requires a **custom debug base** (standard base does not support native plugins); after changing `_build/source/*.java`, bump `manifest.json` `versionCode` +1 and rebuild the base.

## 7. Roadmap

- **Phase 4: GATT encryption gating redo** `[TODO]` — redo the v3.32.1 reverted FF01/FF02-CCCD/FF03 encryption gating, fixing the "post-pair FF02 re-subscribe timing" issue.
- **UNBIND linked SMP-pairing deletion** (landed on custom base): App unbinding triggers native `removeBond` + firmware `Bonding_ClearSnvBonds`, so a revoked phone cannot auto-unlock even in no-App mode.
- **Multi-admin / temporary authorization** — per-identity auth entries, phoneId KDF, multiple owners/admins.
- **Temperature / voltage ADC on-off switch** (discussion only, not implemented) — firmware `tempEn`/voltage flag (DataFlash) + App toggle; positioned as "telemetry on/off", not a power saver. See `docs/03-复盘与问题分析/3-安全模型实测/温度电压采集与功耗分析_未来方向_BLE6.md`.
- **Super power-save mode** — real levers: BLE RF params > LED > external divider MOS > CPU sleep > ADC sampling.
- **BLE 6.0** — Channel Sounding for secure distance-based unlocking (anti relay-attack).

## 8. Related Documentation

> Full design, decisions and retrospectives live in `docs/` (index: `docs/README.md`).

- **Auth system v1 (per-phone + RSSI follow)**: `docs/02-技术方案与专项设计/2-绑定与鉴权/授权体系v1_per-phone与RSSI阈值跟随.md`
- **No-App mode (HID retrofit)**: `docs/02-技术方案与专项设计/3-自动解锁与无App/KeyGo_无App模式_主固件HID改造分步计划.md`
- **Dual-mode / UI**: `docs/02-技术方案与专项设计/4-UI与双模式/Phase2_UI打磨与双模式兼容设计.md`
- **Three reconnect modes**: `docs/02-技术方案与专项设计/1-连接与重连/KeyGo_v3.23_智能重连模式设计v1.0.1.md`
- **Security hardening plan**: `docs/02-技术方案与专项设计/2-绑定与鉴权/KeyGo_安全加固与加密规划_v1.0.0.md`
- **Encryption binding optimization**: `docs/02-技术方案与专项设计/2-绑定与鉴权/加密绑定优化方案设计.md`
- **Verified facts (security model)**: `docs/03-复盘与问题分析/3-安全模型实测/已验证事实_安全模型实测与纠偏.md`
- **Implementation status ledger**: `docs/03-复盘与问题分析/1-版本总结/KeyGo_v3.32.2_实现状态与待办核对.md` (✅ landed / 🔲 not implemented / ⚠️ known deviations)
- **Smart reconnect**: `docs/02-技术方案与专项设计/KeyGo_v3.23_智能重连模式设计v1.0.1.md`
- **Temperature / voltage power analysis & future (incl. BLE 6.0)**: `docs/03-复盘与问题分析/3-安全模型实测/温度电压采集与功耗分析_未来方向_BLE6.md`
- **Hardware power & driver design**: `docs/01-项目规划与立项/3-硬件/KeyGo_硬件供电与驱动设计.md`
- **UI description cheatsheet (plain-language ↔ CSS)**: `docs/自己看/UI描述对照表.md`
- **BLE stability**: `docs/03-复盘与问题分析/2-连接与扫描复盘/BLE连接稳定性问题复盘_v2.2.md` / `docs/03-复盘与问题分析/2-连接与扫描复盘/BLE扫描_设备发现机制复盘_v2.2.md`
- **Codex takeover guide**: `docs/Codex接手指南_已完成与待办.md`
- **git collaboration**: `docs/git协作.md`
