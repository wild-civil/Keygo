# KeyGo · 钥启程 (BLE Smart Car Key)

> 中文版: [README.md](README.md)
>
> A BLE-based car-key replacement: a phone App connects to a BLE MCU/SOC firmware module and uses **RSSI distance** to deliver "unlock when you approach, lock when you leave" passive-keyless-entry; it also supports **real device binding/auth** (binding code + HMAC challenge-response) instead of "connect-and-open with no protection".

**Two main parts**:
- **Firmware**: runs on a BLE MCU/SOC, taking over the original car key's three physical buttons — Unlock / Lock / Third key (trunk or ride).
  - Early prototype used **ESP32C3** (Arduino) for validation.
  - Current main platform: **WCH CH582M** (RISC-V BLE SoC, MounRiver Studio).
  - Future port planned to **nRF528xx** and other BLE MCU/SOC.
- **App**: a **uni-app (Vue 3 + Pinia)** Android app responsible for BLE connection, RSSI monitoring, smart reconnect, binding auth, and dual-mode switching.

---

## Current Mainline

- **Main branch (mainline)**: `main` — the stable trunk that consolidates `codex` (security hardening / Codex takeover) and `workbuddy` (this round of optimization / UI polish / dual-mode).
- **Development branches**:
  - `workbuddy` (current branch): based on `main`, carries this round's "optimize logic + polish UI" increments (auto re-verify binding after manual-mode restart / disable disconnect-auto-lock UI / binding-page firmware-version copy / main-button disabled-state polish / move dual-mode switch entry to the control page).
  - `codex`: based on `main`, carries v3.32.x security hardening (pair-then-BIND, HMAC challenge-response recovery) and Codex-takeover exploration.
- Firmware `KEYGO_FW_VERSION`: `3.32.2` (same as the App version; no re-flash needed).
- App version label: `v3.32.2` (matches firmware; see the `APP_VERSION` constant in `stores/ble.js`).
- This release status: **[usable — logic optimized, UI polished]**
- Next-stage optimization: **Phase 3: connection reliability enhancement; Phase 4: GATT encryption gating (redo)**

---

## Actual Features

| Feature | How it works | Limits / Status |
|---------|--------------|-----------------|
| **Walk-up auto unlock** | App stays connected, judges distance by RSSI; after crossing the threshold + consecutive confirmations, sends unlock | Only works while App keeps a BLE connection to the device |
| **Walk-away auto lock** | RSSI below lock threshold + consecutive confirmations → auto send lock; BLE drop also triggers lock | On disconnect you may already be far away — it's a fallback safety |
| **Manual control** | Tap buttons in App to send `UNLOCK` / `LOCK` / third key via BLE GATT Write | Device must be within Bluetooth range |
| **Device binding (real auth)** | Binding code → `SHA256(code‖serial)` derives a 16B key written to device DataFlash; later each connection the device sends `NONCE` → App replies `AUTH:HMAC-SHA256(nonce, key)` for session auth | Landed (v3.32.0); default binding code `123456`, **recommend forcing a change after first bind `[TODO]`** |
| **Tunable params** | RSSI unlock/lock thresholds, confirmation count, sample interval, Kalman filter params — all editable in App and pushed to device | Bad tuning can cause false triggers or delay |
| **Battery monitoring** | Device reports voltage/level via BLE Notify; App shows it and warns below 20% | 18650 Li-ion only (voltage→level map based on discharge curve) |
| **Android foreground service** | Native Android Foreground Service + sticky notification + battery-optimization-exemption guidance, to survive being killed | Deeply-managed phones (Honor/Xiaomi) may still be killed after 2h+ screen-off |
| **Device dual mode (car/ebike)** | Mode stored in device DataFlash (not a physical switch); first two keys identical (unlock/lock), third key differs: car=trunk, `ebike`=ride (double pulse) | Phase 2 code landed, pending re-flash integration test |
| **Unauthorized-connect 30s timeout** | A connection that binds/auths neither gets force-dropped after 30s, preventing the single connection slot from being occupied (DoS protection) | Landed (commit 31f3f59) |
| **RSSI auto-unlock security gate** | Before unlock, requires either "link encrypted (paired)" or "session authed (AUTH)" — blocks strangers from riding RSSI open | Landed (2026-07-12) |

---

## Device Dual Mode (Phase 2: Car / Ebike)

One device, two uses — only the third key differs:

| Mode | First two keys | Third key | Firmware behavior |
|------|----------------|-----------|-------------------|
| **Car `car` (default)** | Unlock / Lock | 🚗 Trunk (`TRUNK`) | Single pulse triggers trunk |
| **Ebike `ebike`** | Unlock / Lock | 🛵 Ride (`RIDE`) | Fast double pulse (2×100ms@150ms); LED blinks in sync to mimic "pressed the switch twice" |

- **Mode storage**: DataFlash new `MODE_ADDR` (offset `0x7300` / physical `0x77300`); switched from App on first bind or at the bottom of the control page (not a physical switch).
- **Switch entry**: "Device Mode" card at the bottom of the control page (`control.vue`), which is a control concern.
- **State sync**: FF02 status JSON adds `"m":0|1`; the big card icon at the top of the control page switches with mode (🚗/🛵); the third quick key on the connect page is also mode-driven.
- **Interface**: config command `MODE:car`/`MODE:ebike` (via FF03, gated by encryption + bind protection); control command `RIDE` (ebike double pulse / car replies `DENY:NOT_SUPPORTED`).
- `[TODO]` admin-locked mode column (prevent mis-switch); multiple admins.

---

## Smart Reconnect (Three Modes)

This is the core of the project. After a drop, how does the App find the device again? Different users want different things, so three modes are provided:

| | Fast mode | Comfort mode (default) | Manual mode (formerly "power-save") |
|:--|:--|:--|:--|
| **How it works** | On BT drop, record parked GPS → build a geofence → entering the fence triggers BLE scan; also accelerometer detects motion → conditionally triggers scan | After drop, register `ACTION_SCREEN_ON` broadcast → on screen-on/unlock, trigger an 8s BLE scan and connect | Fully manual: no auto connect, no auto lock. After connecting, push `autolock=0` to firmware to disable RSSI auto-lock; only respond to manual UNLOCK/LOCK/third key |
| **When it connects** | Auto-connects when you walk near the car (enter GPS fence); ideally already connected at the curb | Connects within 2–8s after screen-on | When the user manually taps connect / unlock |
| **Permissions needed** | Background location + accelerometer | No extra permission | No extra permission |
| **What runs in background** | GPS geofence (Google Geofence API) + AlarmManager heartbeat fallback (degrades on no-GMS devices) | No background task at all (pure event-driven, only on screen-on) | None (no keep-alive / background scan; stops foreground service on switch) |
| **For whom** | Daily commute, willing to grant location for a seamless feel | Most users | Close-contact scenarios like camping: RSSI jitter would cause repeated auto connect/lock |
| **Known issues** | No-GMS devices (Huawei/some Honor) have no geofence → auto-degrade to Comfort mode | If you don't approach the car after screen-on it won't connect (expected — no background scan) | Must operate manually every time; no auto reconnect at all |

### Why Comfort mode is designed this way

The old approach scanned on a fixed 2-min timer after a drop. On deeply-managed systems like Honor MagicOS, after 2h screen-off the OS marks an App with ongoing background activity as "high battery drain" and kills it — the timer scan actually accelerated being killed.

**Now Comfort mode does zero background polling**, waiting for the OS's natural `ACTION_SCREEN_ON` broadcast to trigger a scan. The OS finds no reason to flag you, greatly improving survival odds.

```
Disconnect → registerScreenOnReceiver()
    ↓
User screen-on/unlock → ACTION_SCREEN_ON / ACTION_USER_PRESENT
    ↓
_onScreenOn() → checks: connected? BT off? scanned within 30s?
    ↓
startScan(8s, service UUID filter) → discover target device
    ↓
connectDevice() → stop scan on success
    ↓
Not connected within 8s → retry after 30s, up to 3 times
```

### Auto-connect the strongest known device on App open (Plan B)

Default behavior: **opening the App (onShow) first directly connects the cached device (fastest, no scan); on direct-connect failure or stale cache, it auto-scans and connects the strongest-RSSI device among the "known device set."**

- The "known device set" is currently the cached `ble_device_id` (transition period). **Non-known devices are never auto-connected**, avoiding mis-connecting a neighbor's/stranger's key (Plan B safety boundary).
- When multiple known devices are online, it auto-picks the strongest by signal.
- First use (no `ble_device_id` cache) connects nothing automatically; you pick once from the scan list; after that the device enters the known set.
- Reserved "device binding" hook: later swap the known set for a trusted-serial list — internal logic unchanged (see `knownSet` / `TODO ①` in `autoConnectBest` in `stores/ble.js`).

> Implementation note: `utils/ble.js`'s `startScan` **no longer passes a hardware `services` filter** (filtered discovery on Android 12+ often returns empty, causing devices not to be found). Device identification is now done by a secondary filter on "name prefix / advertised UUID" inside the scan callback — more reliable discovery.

### Disconnect state machine (reconnectMode)

All auto-reconnect / no-reconnect decisions go through this state, avoiding races like "just dropped then instantly reconnected" or "user actively disconnected then auto-reconnected":

| State | Meaning | When entered / who owns it |
|-------|---------|----------------------------|
| `idle` | Idle, auto reconnect allowed | Connection success, or after reconnect fully gave up |
| `active` | In reconnect loop (exponential backoff) | Unexpected drop `_handleDisconnect` → `_startReconnect` |
| `paused` | Temporarily suspended (backoff wait / BT off) | Backoff wait, BT off |
| `dormant` | **User actively disconnected / unauthorized connect kicked**, all auto reconnect forbidden | `disconnect()` / receiving `BIND:TIMEOUT` |

Unified gate `_shouldAutoReconnect()`: if any of `connected` / `dormant` / `btState=off` is true → return `false`. `tryAutoConnect`, `autoConnectBest`, `_onScreenOn` all pass this gate first.

> ⚠️ **Known limitation (to optimize)**: `dormant` is in-memory; after the App process is killed it resets to `idle` along with `reconnectMode`, while the `ble_device_id` cache persists in local storage. So **a manual disconnect currently only lasts "within the same App session"** — reopening the App auto-connects again via the known-device cache. To make "manual disconnect = never auto-connect across restarts," persist the "user actively disconnected" intent (add a `ble_manual_disconnect` flag), see the "disconnect logic fix" discussion below. `[TODO / Phase 3]`

---

## Device Binding & Security Model

### Trust model
- Trust list capacity 8, stored in DataFlash (offset `KEYGO_BOND_ADDR = 0x7100` relative / physical `0x77100`); LTK is auto-persisted by the stack via SNV (offset `0x07E00`).
- **KDF**: `bindKey[16] = SHA256(utf8(bindingCode) ‖ utf8(serial))[0:16]`, serial = FF04 MAC hex (12 uppercase). Firmware `Bonding_DeriveKey` and App `utils/crypto.js.deriveBindKey` are同源 (same source).
- **Challenge-response**: device sends `NONCE(16B)` → phone replies `AUTH:<HMAC-SHA256(nonce, bindKey) hex>`; `NONCE` is one-time.
- Manual control gate: on device side `Bonding_Count()==0` → `DENY:NOT_BOUND`; otherwise `!sessionAuthed` → `DENY:AUTH_REQ` and issue `NONCE`.
- Default binding code `123456` (placeholder, **recommend forcing a change after first bind `[TODO]`**). Trust is based on the shared key (not MAC, because of random private addresses).

### Security hardening timeline
- **RSSI auto-unlock gap (landed 2026-07-12)**: `KeyGo_ProcessStateMachine()` gate changed to "link encrypted (paired)" OR "session authed (AUTH)" before allowing RSSI unlock, blocking strangers from riding RSSI open.
- **DoS protection: unauthorized-connect 30s timeout (2026-07-12, commit 31f3f59)**: connect-without-bind occupies the slot → on timeout first send `BIND:TIMEOUT:30S` notice, then force-drop after a delay; App stops reconnect on receipt.
- **v3.32.0 (2026-07-13, commit 77c6806)**: ① pair-then-`BIND` (Just Works pairing → link encrypted → send `BIND:code`, closing plaintext sniffing); ② after BIND success, add `NONCE → AUTH(HMAC)` fallback auth; ③ pre-validate with `_authWithKey` before changing code.
- **v3.32.1 (GATT encryption gating, reverted)**: once raised FF01/FF02-CCCD/FF03 permissions to `GATT_PERMIT_AUTHEN_WRITE/READ` so unpaired connections couldn't read. Later `git revert`ed on the `codex` branch due to a post-pair FF02 re-subscribe timing issue, **pending Phase 4 redo `[TODO]`**.

### Key security insights (measured corrections)
- Ordinary phone Bluetooth settings **can't find** KeyGo (needs nRF Connect etc. to actively connect), so "passerby opens it casually" doesn't hold.
- Real residual risk (narrowed): an attacker phone that was previously paired (bonded), OS auto-reconnects → `LINK_ENCRYPTED` → satisfies RSSI gate → walks up and unlocks. Pairing and binding code are independent; the 30s timeout only prevents slot occupation, not blocking paired parties.
- **RSSI unlock measured NOT working after App killed**: unlock needs an active connection, which relies on the foreground service; App dead → no connection → no unlock. So this vuln's bar = "running KeyGo App + a deliberate actor who once paired with a tool", not a passerby.
- Control commands `UNLOCK/LOCK`'s **C1 signature (per-command HMAC + session salt + incrementing counter) replay protection is always on** — it's not "HMAC commented out".

### `[TODO]` security enhancements
- **Authenticated pairing Passkey = binding code** (closes the "paired party can also RSSI unlock" gap): must first verify CH582 SMP supports "headless device + fixed passcode + mitm=1 without falling back to Just Works".
- **AUTH failure rate-limit**, **force binding-code change**, **multiple admins**.
- **Phase 4: GATT encryption gating redo** (fix the v3.32.1 subscribe-timing issue).

---

## BLE Communication Protocol

Device name format: `KeyGo-{last 6 of MAC}`, e.g. `KeyGo-A1B2C3`

| UUID | Type | Direction | Purpose | Data format |
|------|------|-----------|---------|-------------|
| `0000FF00-...` | Service | — | KeyGo main service | — |
| `0000FF01-...` | Write | App→Device | Config push | `unlock=-45 lock=-65 uc=3 lc=5 interval=500 kf_r=15.0 autolock=1 mode=car` (`autolock=0` disables firmware RSSI auto-lock; `mode=car|ebike` switches dual mode) |
| `0000FF02-...` | Read, Notify | Device→App | Status report | JSON: `{"c":1,"st":"LOCKED","r":-52,"f":-52,"b":85,"d2":"","cd":8000,"kr":15,"al":1,"bn":1,"v":"...","m":0,"uc":3,"lc":5,"ucnt":1,"lcnt":0,"th":1}` |
| `0000FF03-...` | Write | App→Device | Control / binding commands | `UNLOCK` / `LOCK` / `TRUNK` / `RIDE` / `BIND:code` / `SETCODE:new` / `UNBIND` / `STATUS` / `MODE:car|ebike` |
| `0000FF04-...` | Read | Device→App | Device serial (permanently unique) | ASCII string, used for pairing/binding |

- Advertise interval: 50ms, catchable by any ≥1s scan window
- FF01 / FF02-CCCD / FF03 current permissions: `GATT_PERMIT_READ` + `GATT_PERMIT_WRITE` (**no encryption gating**, see Phase 4 `[TODO]`); FF04 stays readable.

### FF02 status fields (Device→App, periodic report)

> ⚠️ This is the **status report** window; it does NOT participate in unlock/lock decisions (decisions are in the firmware state machine).

| Key | Meaning | Example |
|-----|---------|---------|
| `c` | Connection flag (always 1) | `1` |
| `st` | Current lock state | `LOCKED` / `UNLOCKED` / `ACTION` |
| `r` | Real-time RSSI (dBm) | `-52` |
| `f` | Kalman-filtered RSSI | `-52` |
| `d2` | Device custom name | `""` |
| `cd` | Manual command cooldown (ms) | `8000` |
| `kr` | Kalman R param (filter strength) | `15` |
| `al` | Auto-lock enable state | `1`=on (Comfort/Fast) / `0`=off (Manual) |
| `bn` | Bound flag | `1`=bound / `0`=unbound |
| `v` | Firmware version | `3.32.2` |
| `m` | Device mode | `0`=car / `1`=ebike |
| `uc` | Device's current unlock-confirm-count config (echo to verify push landed) | `3` |
| `lc` | Device's current lock-confirm-count config | `5` |
| `ucnt` | Current unlock progress count | `1` |
| `lcnt` | Current lock progress count | `0` |
| `th` | Current zone: `0` neutral / `1` unlock zone / `2` lock zone | `1` |

### Confirmation-progress report (Plan B, landed)
FF02 added `uc/lc/ucnt/lcnt/th` fields; the state machine reports immediately on counter change + a 1s heartbeat keep-alive, decoupling traffic from sample interval. The App main UI shows an "🔓 unlock progress ucnt/uc" bar, and warns "config may not have been pushed" when `uc` disagrees with App settings.

> ⚠️ **Known deviation (to fix `[TODO]`)**: config items `uc/lc/threshold` are only persisted when `cooldown` changes (`KeyGo_SaveConfig` only triggers on `cooldown_changed`); changing only `uc` isn't persisted → reverts to defaults on reboot; App reconnect also **doesn't auto push config back**. Fix direction: ① `if(cooldown_changed)` → `if(changed)`; ② align defaults (firmware `uc` default → 3); ③ add App reconnect auto-push-back. Recorded in `docs/KeyGo_v3.33_实现状态与待办核对.md`.

---

## Directory Structure (current real files)

```
KeyGo/
├── README.md                         # This project (Chinese)
├── README_EN.md                      # English version of this README
├── app/BLE_Key_Go_App/               # uni-app phone project (HBuilderX + Vite)
│   ├── pages/
│   │   ├── index/                    # Device scan & connect (third quick key mode-driven)
│   │   ├── control/                  # Manual unlock/lock/third key + bottom dual-mode switch + top big-card icon
│   │   ├── config/                   # RSSI threshold/confirm count/Kalman params/disconnect-auto-lock sliders
│   │   ├── help/                     # Help page (3-step onboarding + binding security model + mode guide, moved from login.vue)
│   │   ├── login/                    # Legacy help page (migrated to help.vue, pending cleanup [TODO])
│   │   └── main/                     # TabBar container
│   ├── stores/
│   │   ├── ble.js                    # ★ Core state machine (~4100 lines: connect/reconnect/3 modes/session auth)
│   │   ├── ble-binding.js            # Binding-layer module-level state (B namespace: _bindKey/_sessionSalt/waiter etc.)
│   │   ├── theme.js                  # Theme (dark/light)
│   │   └── user.js                   # User preferences (e.g. progress-bar toggle)
│   ├── utils/
│   │   ├── ble.js                    # uni BLE API wrapper (startScan secondary-filter discovery)
│   │   ├── ble-native.js             # Native BLE call wrapper
│   │   ├── command-queue.js          # GATT write queue enqueueWrite + isGattConflict (prevent GATT_BUSY channel contention)
│   │   ├── crypto.js                 # deriveBindKey (SHA256 KDF, same source as firmware)
│   │   ├── firmware.js               # Firmware version compare isFirmwareAtLeast (≥3.30.2 supports deferred reply)
│   │   ├── foreground-service.js     # Android foreground service + screen-on broadcast
│   │   ├── geofence.js               # Fast-mode GPS geofence (GEOFENCE_RADIUS etc.)
│   │   ├── power-saver.js            # Manual-mode logic (formerly "power-save mode")
│   │   ├── readable-errors.js        # Error code → user-readable text (ERROR_MSGS / cmdErrorMsg / throwError)
│   │   ├── debug-panel.js            # DEV debug panel logic
│   │   ├── swipe.js                  # Tab swipe management
│   │   └── toast.js                  # Unified toast (success/error)
│   ├── components/
│   │   ├── BindModal.vue             # ★ Binding modal (first bind/takeover/re-verify/change code/unbind/factory reset + diagnostics + firmware version badge)
│   │   ├── CustomTabBar.vue          # Custom bottom Tab (Ⓠ help)
│   │   └── DebugFloatPanel.vue       # Floating debug panel
│   ├── nativeplugins/
│   │   └── Keygo-Foreground/         # Native Android plugin (foreground scan/reconnect/auto AUTH)
│   │       ├── android/keygo-foreground.aar  # Build artifact (changing _build/source/*.java needs Python direct-write + build_aar.bat)
│   │       ├── _build/source/        # Java sources (KeygoBleScanService / KeygoForegroundModule)
│   │       └── package.json          # Plugin manifest
│   ├── manifest.json                 # App permissions/native-plugin declarations (versionCode must +1 after changing .java)
│   ├── pages.json / main.js / App.vue / index.html / vite.config.js
│   └── static/                       # Image assets
│
├── code/
│   ├── ESP32C3/                      # Early prototype (Arduino .ino, v1 ~ v3.13, archived)
│   └── CH582M/CH582M_BLE_Slave/      # Current main firmware (MounRiver Studio, v3.13+)
│       ├── APP/
│       │   ├── peripheral.c          # GAP/GATT service, advertising, connection mgmt, disconnect-auto-lock gate, unauthorized 30s timeout
│       │   ├── keygo_core.c          # Business core (RSSI state machine/Kalman/command exec/binding/dual-mode/RIDE double pulse/config persistence)
│       │   ├── bonding.c             # Binding/pairing (Just Works; GAPBOND_PERI_BONDING_ENABLED)
│       │   ├── crypto_sha256.c       # Self-made SHA256 (WCH lib has no SHA/HMAC/HWRNG)
│       │   ├── peripheral_main.c     # main() + WWDG soft watchdog
│       │   └── include/
│       │       ├── appearance.h      # Advertising/appearance
│       │       ├── bonding.h
│       │       ├── crypto_sha256.h
│       │       ├── keygo_core.h      # Business constants/offsets (MODE_ADDR etc.)/extern decls
│       │       └── peripheral.h      # TMOS event-bit allocation (★ new event bits must be checked for no conflict)
│       ├── HAL/                       # LED, keys and other hardware abstraction
│       └── Profile/                   # Battery / DeviceInfo / GATT service impl
│
└── docs/                             # Design docs & retrospectives (see docs/README.md index)
    ├── 01-项目规划与立项/            # Project planning, proposal, hardware plan, market comparison
    ├── 02-技术方案与专项设计/        # Battery Service, security hardening plan, smart-reconnect mode design
    ├── 03-复盘与问题分析/            # Version summaries, topical analysis, BLE connect/scan retrospectives
    ├── 自己看/                       # Personal notes
    ├── Phase2_UI打磨与双模式兼容设计.md
    ├── KeyGo_v3.32.2_实现状态与待办核对.md   # ✅ landed / 🔲 not implemented (T1~T11) / ⚠️ known deviations ledger
    ├── KeyGo_v3.33_实现状态与待办核对.md
    ├── 加密绑定优化方案设计.md
    ├── 已验证事实_安全模型实测与纠偏.md
    ├── Codex接手指南_已完成与待办.md
    ├── Android离线打包与插件集成checklist.md
    ├── Android屏幕检测方案参考.md
    └── 绑定安全设计与码长方案.md
```

---

## Develop & Run

### Firmware

**Current platform: CH582M**

1. Install **MounRiver Studio** (WCH official IDE)
2. Open `code/CH582M/CH582M_BLE_Slave/CH582M_BLE_Slave.wvproj`
3. Build → flash to CH582M dev board via WCH-Link
4. After power-on it starts BLE advertising, device name `KeyGo-XXXXXX`

Key hardware: CH582M (RISC-V 60MHz, BLE 5.0), 18650 Li-ion power, relay module taking over the original car-key buttons.

**Early platform: ESP32C3 (archived)**

- Directory: `code/ESP32C3/`, Arduino `.ino` project, full v1 ~ v3.13 evolution preserved as 12 version snapshots
- Open the `.ino` file in Arduino IDE to build and flash
- ESP32C3 validated all core features; mainline moved to CH582M after v3.13

**Planned port**: nRF528xx (Nordic nRF5 SDK / Zephyr) and other BLE MCU/SOC `[TODO]`, contributions welcome.

### App

1. Open `app/BLE_Key_Go_App` with **HBuilderX**
2. Run to an Android device (enable developer mode + USB debugging)
3. The native plugin (foreground service) **must be built with "custom debug base" or "offline packaging"** — the standard base won't work
4. Grant Bluetooth, location, and notification permissions
5. Open App → scan for KeyGo device → connect → control / config / bind

> ⚠️ **Native-plugin change iron rule**: after changing `_build/source/*.java` and rebuilding `android/keygo-foreground.aar`, you MUST ① bump `versionCode` in `manifest.json` by +1; ② rebuild the custom debug base and reinstall; ③ the standard base does not support native plugins. Otherwise HBuilderX caches the old base and the new aar never reaches the phone.

### Quick self-check

1. Firmware powered on — phone Bluetooth scan should see `KeyGo-XXXXXX`
2. After App connects, `FF02` should keep pushing RSSI status JSON
3. Approaching/leaving the device, RSSI should change accordingly (closer = larger number, e.g. -30 > -60)
4. After bind + disconnect + reconnect, AUTH should auto-complete "within protection" (diagnostics shows "AUTH passed")

---

## Version Evolution

```
v1    Initial: single BLE stack + simple RSSI threshold (ESP32C3 / Arduino, unstable connection)
v2    Dual-stack rebuild: NimBLE / Bluedroid dual stack + disconnect-lock fallback (ESP32C3)
v2.1 Merge: Kalman filter + RSSI spike drop + hysteresis state machine (ESP32C3)
v2.2 MAC whitelist + device unique serial + physical-key pairing (ESP32C3)
v3.13 Migration to CH582M platform, 18650 battery voltage detection online ← platform switch point
v3.14 Battery monitoring improved (GATT Read level + BLE Notify voltage)
v3.16 Soft watchdog (WWDG 2.5s timeout reset, prevent firmware hang)
v3.22 Battery-optimization exemption guide (fight Android background killing)
v3.23 Smart-reconnect three-mode framework (Fast/Comfort/Power-save)
  └─ v1.0.1 Comfort mode rebuild: timed polling → screen-on trigger, zero background polling
v3.24 Three reconnect modes renamed (Power-save → Manual) + firmware auto-lock switch (autolock)
v3.31 App: RSSI display-layer throttle linkage + keep old value on return to foreground + confirm-count→time conversion; FF02 reports confirm progress (Plan B)
v3.32.0 Security: pair-then-BIND + HMAC challenge-response recovery (commit 77c6806)
v3.32.1 GATT encryption gating (reverted, pending Phase 4 redo)
v3.32.2-fix Manual-mode disconnect no-auto-lock + help page rebuild (login→help, merge onboarding) (commit 6a61787)
  └─ workbuddy branch increments: ① auto re-verify binding after manual-mode restart ② manual-mode disable disconnect-auto-lock (UI) ③ binding-page firmware-version copy fix + main-button disabled-state polish
```

---

## Next Phase Planning

> This release (workbuddy branch, mainline `main`) goal achieved: **[usable — logic optimized, UI polished]**. Next stage focuses on connection reliability and encryption.

### Phase 3: Connection reliability enhancement `[TODO]`
- `command-queue.js` GATT write queue already landed (prevents `_cmdBusy`/`_configWriteBusy` channel contention → GATT_BUSY); keep enhancing:
  - Fix `uc/lc/threshold` persistence (only persists on cooldown change)
  - App auto-push config back after reconnect (claimed in comments but not actually called)
  - Persist `dormant` across restart (manual disconnect = never auto-connect across restart)
  - Rare: CH582M unconnected but App can't scan it (suspected firmware stopped advertising / domestic-ROM scan stack silent failure / `_coolingDown` held permanently)

### Phase 4: GATT encryption gating (redo) `[TODO]`
- Redo the v3.32.1 reverted FF01/FF02-CCCD/FF03 encryption gating, fixing the "post-pair FF02 re-subscribe timing" issue
- Authenticated pairing Passkey = binding code (must first verify CH582 SMP supports "headless device + fixed passcode + mitm=1 without falling back to Just Works")
- Goal: unpaired connections can't even read, and close the "paired-party RSSI unlock" gap

### Other TODO `[TODO]`
- Force binding-code change, multiple admins, admin-locked device mode
- AUTH failure rate-limit
- iOS support (foreground service / screen-on broadcast native plugin is Android-only)
- nRF528xx port
- `login/` legacy page cleanup

---

## Known Limitations

- **Android only**: uni-app can compile an iOS build, but the foreground service, screen-on broadcast, and other native plugins are Android-only
- **BLE range ~10-15m**: actually affected by environment and phone Bluetooth chip; RSSI fluctuates a lot (walls/body blockage)
- **Deeply-managed phones**: Honor MagicOS, Xiaomi MIUI may kill even with foreground service after 2h+ screen-off
- **RSSI is not precise distance**: same distance different angles can differ 10-15dBm; relies on Kalman filter + consecutive confirmations to reduce misjudgment
- **GPS geofence depends on GMS**: Huawei/some Honor devices have no Google Geofence, Fast mode auto-degrades
- **Research/study only**: not certified by any car maker; do not use on a real vehicle

---

## Related Docs

Full docs are categorized by topic; see [`docs/README.md`](docs/README.md) master index. Highlights:

- **Implementation status ledger**: `docs/KeyGo_v3.32.2_实现状态与待办核对.md` / `docs/KeyGo_v3.33_实现状态与待办核对.md` (✅ landed / 🔲 not implemented / ⚠️ known deviations)
- **Smart reconnect**: `docs/02-技术方案与专项设计/KeyGo_v3.23_智能重连模式设计v1.0.1.md`
- **Security hardening plan**: `docs/02-技术方案与专项设计/KeyGo_安全加固与加密规划_v1.0.0.md`
- **Encrypted binding optimization**: `docs/加密绑定优化方案设计.md`
- **Verified facts**: `docs/已验证事实_安全模型实测与纠偏.md`
- **Codex takeover guide**: `docs/Codex接手指南_已完成与待办.md`
- **Dual-mode design**: `docs/Phase2_UI打磨与双模式兼容设计.md`
- **Background keep-alive**: `docs/03-复盘与问题分析/KeyGo_v3.22_电池优化豁免机制详解.md`
- **BLE stability**: `docs/03-复盘与问题分析/BLE连接稳定性问题复盘_v2.2.md` / `BLE扫描_设备发现机制复盘_v2.2.md`
- **Hardware**: `docs/01-项目规划与立项/BLE车钥匙_舒适进入_硬件方案设计.md`

---

## License

This project is for learning and research only. For commercial use, please contact the author.
