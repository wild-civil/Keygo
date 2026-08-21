# 复盘：BLE 断连后设备名变 N/A（scanRsp 丢失）根因与修复

> 日期：2026-08-21
> 固件：CH582M_BLE_Slave（peripheral.c）
> 关联：功耗讨论、降频实验（30MHz 验证）

---

## 一、现象（用户实测）

1. **App 连接一次 → 断开 → 设备名变 N/A**，App 按名过滤扫不到，需"忘记设备 / 复位"才恢复。
2. **NoApp 模式连接正常**，名字不丢。
3. **nRF Connect 关键对照实验**：
   上电 → 不连 App、仅用 nRF Connect 连一次 → 断开 → nRF Connect 也变 N/A。
   → 排除 App 端问题，排除特定 GATT 写，确认"任意中心设备连一次即触发"。
4. **该现象与 CPU 主频无关**：60MHz 与 30MHz（降频实验版）均复现。
5. 同期功耗观察：断连态 ~360–500µA（底板 + 广播波动），连接态 ~800–1200µA（连接事件固有开销），属 BLE 物理常态，与本案无直接因果。

---

## 二、根因（已坐实）

> **CH582M 协议栈在"被连接"期间，会改写 `GAPROLE_SCAN_RSP_DATA` 参数所指向的 `scanRspData` 缓冲。**
> 断连恢复广播时，固件**复用已被破坏的缓冲** → 广播出的 scanRsp 中不再包含设备名字段
> → 中心设备扫到的广播包无 Complete Local Name → 显示为 `N/A`、按名过滤失败。

判别证据链：
- 复位 / 清绑（重新走 `Peripheral_Init` 重建 `scanRspData`）→ 名字恢复 → 说明缓冲内容本身被破坏、非参数未设置。
- NoApp 正常，是因为 WCH HID 库（`hidDev`）在断连时会**主动重装载 scanRsp**（配对前后切换可发现性的钩子）；而普通 GATT 连接断连路径 `Peripheral_LinkTerminated` **只 `enable=TRUE`、不重载** → 顾名丢失。
- nRF Connect 单连即重现 → 与 App / GATT 写无关，纯属"被连接"这一生命周期行为。

---

## 三、为什么之前没暴露

- 旧测试多为"连上 → 操作 → 断连 → 结束"，很少在断连后**再次用中心设备扫描确认名字**。
- 早期 `scanRsp` 可能未放设备名（仅放间隔范围 / 功率），破坏后无感；当前固件把 `KeyGo-XXXXXX` 放进 scanRsp，`Peripheral_BuildBroadcastName` 依赖 `g_deviceMac`，破坏后直接 N/A。
- 复位 / 重新 Init 恰好重建缓冲，掩盖了"断连不恢复"的缺陷。

---

## 四、修复方案（已实施）

文件：`code/CH582M/CH582M_BLE_Slave/APP/peripheral.c`
函数：`Peripheral_LinkTerminated`（断连恢复广播处）

**改动要点**：在 `GAPROLE_ADVERT_ENABLED=TRUE` 之前，先重建并重新装载 `advertData` + `scanRspData`。

```c
// ★ 2026-08-21 [scanRsp 丢失根因修复]
//   根因: CH582M 协议栈在【被连接期间】改写 scanRspData 缓冲,
//         断连恢复广播复用被破坏缓冲 → scanRsp 无设备名 → N/A。
//   NoApp 正常是因为 hidDev 库自带断连 scanRsp 重装载; 普通 GATT
//   断连路径只 enable 不重载。与 CPU 主频无关。
//   修复: 断连恢复广播前重建并重装载 advertData + scanRspData,
//         再 enable=TRUE(绝不先 FALSE)。仅断连时执行一次, 不影响稳态功耗。
Peripheral_BuildAdvertData();
Peripheral_BuildScanRspData();
GAPRole_SetParameter(GAPROLE_ADVERT_DATA, advertLen, advertData);
GAPRole_SetParameter(GAPROLE_SCAN_RSP_DATA, scanRspLen, scanRspData);

uint8_t advertising_enable = TRUE;
GAPRole_SetParameter(GAPROLE_ADVERT_ENABLED, sizeof(uint8_t), &advertising_enable);
```

**遵循的约束（铁律）**：
- 切换广播间隔 / 恢复广播**绝不先 `FALSE` 再 `TRUE`**（避免广播闪烁、被中心设备漏扫）。
- 本次仅**重装载数据**，不开关广播状态，与铁律无冲突。
- 仅在断连时执行一次，无额外周期性开销，稳态功耗不变。

---

## 五、验证清单（烧录后请逐项确认）

- [ ] 上电 → nRF Connect 扫描：名字 `KeyGo-XXXXXX` 正常显示。
- [ ] nRF Connect 连一次 → 断开 → 再次扫描：名字**仍为 `KeyGo-XXXXXX`**（不再 N/A）。
- [ ] App 连一次 → 断开 → App 重新扫描：能按名搜到、可重连。
- [ ] NoApp 模式连接/断连：名字表现与 GATT 一致（修复后二者路径补齐）。
- [ ] 断连态电流仍 ~360–500µA（修复不增加稳态功耗）。
- [ ] 长时间反复"连接↔断连"循环 10 次，名字始终正常（验证缓冲未被累积破坏）。

---

## 六、经验沉淀（可复用）

1. **CH582M scanRsp 缓冲会被连接期改写**——凡依赖"断连后继续广播且名字正确"的设计，
   断连恢复路径必须显式重装载 `advertData`/`scanRspData`，不能假设缓冲一直有效。
2. **对照实验的价值**：用 nRF Connect（非业务 App）做最小中心设备复现，可快速剥离
   "App 逻辑 / GATT 写 / 业务协议"干扰，定位到底层协议栈行为。
3. **NoApp 正常 ≠ 全路径正常**：HID 库自带恢复钩子会掩盖 GATT 路径的同类缺陷；
   跨路径（NoApp / App / 裸中心设备）都要测断连恢复。
4. **功耗与功能 bug 解耦**：本案 N/A 与 30MHz/60MHz 无关，降频实验和 bug 修复应分别验证、
   分别提交，避免互相掩盖。
5. **"忘记设备才恢复"是重要线索**：说明状态需重建才能恢复，指向"运行时缓冲被破坏 + 无恢复动作"，
   而非"参数从未设置"。
