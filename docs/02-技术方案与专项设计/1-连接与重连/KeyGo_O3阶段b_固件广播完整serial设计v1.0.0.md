# O3 阶段 b：固件广播完整 serial 设计文档 v1.0

> 配套：O3 总目标（见记忆 / TODO①）是让 `autoConnectBest` 在**扫描阶段**就能按设备序列号（serial）认出已知设备，根治「Android `deviceId` 随机化」与「iOS 扫描期拿不到 serial」两个痛点。
> 阶段 a（JS 侧持久化 serial 作次要确认键）收益有限；**阶段 b（固件把完整 serial 塞进广播包）才是真正根治**，本文档只讲阶段 b。

---

## 0. 名词解释（给不熟悉 BLE 的读者）

### 0.1 广播包 advertData 与扫描响应 scanRspData
BLE 从机（我们的 CH582M）想被手机发现，会周期性发出**广播包（advertising data）**。
- **advertData**：主广播 payload，长度上限 **31 字节**（BLE 规范的 `ADVERT_MAX_LEN`）。
- **scanRspData**：扫描响应 payload。手机收到广播后，可回一个 SCAN_REQ，设备再发 **scanRspData**（同样上限 31 字节）。两者加起来才是手机「发现设备」时看到的全貌。
- 为什么是 31？这是 Bluetooth 4.0/4.1 的经典广播上限。超了 GAP 协议栈会**静默截断**，多出来的字段直接丢失——所以预算必须算准。

### 0.2 AD 结构（TLV）
advertData / scanRspData 内部是按「长度-类型-值」(TLV) 串起来的：
```
[Len][Type][Value ...][Len][Type][Value ...] ...
```
常见 Type：
- `0x01` Flags（设备可发现/可连接等）
- `0x03` 完整 16-bit 服务 UUID 列表
- `0x16` 服务数据（Service Data，带 UUID）
- `0x19` Appearance（设备外观类别）
- `0xFF` **厂商自定义数据（Manufacturer Specific Data）** ← 本文主角

### 0.3 Manufacturer Specific Data（0xFF）
格式：`[Len][0xFF][Company ID 低][Company ID 高][厂商私有数据...]`
- Company ID 由 Bluetooth SIG 分配；我们目前用 `0xFFFF`（测试/保留值）。
- 厂商私有数据我们自定义为：`"KG"`（协议标记 0x4B 0x47）+ MAC 地址片段。

### 0.4 serial 是什么
App 侧的 `serialNumber`（FF04 特征） = 芯片 MAC 地址的 **12 位大写十六进制**（例如 `84C2E4030202`）。
- Android 的 `deviceId`（蓝牙 MAC）= 同一个 MAC，所以 `serial == deviceId 去冒号大写`，二者同源。
- iOS 的 `deviceId` 是系统生成的随机 UUID，**不等于 MAC**，且 iOS 扫描期根本拿不到 serial。

### 0.5 parseManufacturerFingerprint（App 侧解析器）
位置：`app/BLE_Key_Go_App/utils/ble.js:1308`。
它遍历 advertData 的 TLV，找到 `Type==0xFF` 且 Company ID `==0xFFFF` 且前 2 字节是 `"KG"` 的记录，把后面跟的 MAC 片段转成 hex 字符串返回。
- v3.2 只发 `"KG"`（无后缀）→ 返回 null。
- v3.3 发 `"KG"+3字节MAC后缀` → 返回 6 位 hex（如 `71C65A`）。
- **现状坑**：固件 `peripheral.c:99-103` 那段「KG」制造商数据**被注释掉了** → 现在 App 解析实际一直返回 `null`，这个能力是「睡着」的。

---

## 1. 当前广播结构（实测）

来源：`code/CH582M/CH582M_BLE_Slave/APP/peripheral.c`
- `Peripheral_BuildAdvertData`（`:59`）
- `Peripheral_BuildScanRspData`（`:178`）

### advertData（20 / 31 字节已用）
| 内容 | TLV | 字节 |
|---|---|---|
| Flags | `02 01 06` | 3 |
| Appearance (HID) | `03 19 B0 04` | 4 |
| 16-bit UUID 列表 | `07 03 00FF 0F18 1218` | 8 |
| 电池服务数据 | `04 16 0F18 <batt>` | 5 |
| **合计** | | **20** |
| **剩余** | | **11** |

> 电池服务数据用的是 Battery Service UUID `0x180F`，放在 **advertData 里**。这就是你现在能在**手机系统蓝牙界面看到电量**的原因——系统解析到广播里的 `0x180F` 就显示了。

### scanRspData（21 / 31 字节已用）
| 内容 | 字节 |
|---|---|
| 设备名 `KeyGo-XXXXXX`（MAC 后缀 6 hex） | 11 |
| 从机连接间隔 | 7 |
| 发射功率 | 3 |
| **合计** | **21** |
| **剩余** | **10** |

---

## 2. 设计目标与核心决策

**目标**：让手机在**还没连上设备**的扫描阶段，就能从广播里拿到完整 12 位 serial，从而在 `autoConnectBest` 里按 serial 匹配已知设备。

**核心决策：完整 serial 放在 advertData 里，电池 ServiceData 保持原位不动。**

这么做直接化解你提的电池可见性担忧：
- advertData 剩 11 字节，而「KG + 6 字节原始 MAC」恰好占 **11 字节**（`0A FF FFFF 4B 47 m0..m5`），20 + 11 = **31 = 恰好填满**，电池仍在 advertData → 系统蓝牙电量显示**零影响**。
- 不需要把电池挪到 scanRspData（挪了反而有未知风险，见 §5 优劣对比）。

> 备注：31/31 是**满负荷、零余量**。按蓝牙规范合法，但今后任何新增广播字段都会顶爆，需在文档/代码注释里标注这个约束；若想要余量，可后续评估去掉 Appearance(4字节) 或把 MAC 改成哈希(§4 方案 B)。

---

## 3. 具体改动（方案 A：广播原始 MAC）

### 3.1 固件 `peripheral.c`
把 `:99-103` 被注释的制造商数据块恢复并扩展为 6 字节 MAC：
```c
// 恢复并扩展：KG + 完整 6 字节 MAC（= 12 位 serial 的二进制源）
0x0A, 0xFF, 0xFF, 0xFF, 0x4B, 0x47,
g_deviceMac[0], g_deviceMac[1], g_deviceMac[2],
g_deviceMac[3], g_deviceMac[4], g_deviceMac[5],
```
- `g_deviceMac` 已在 `peripheral.c` 初始化时通过 `GetMACAddress` 宏取得（见 `:64-66`）。
- 放 advertData 末尾，总字节 = 20 + 11 = 31。

### 3.2 App `utils/ble.js` `parseManufacturerFingerprint`（`:1308`）
当前只读 3 字节（`:1340-1347`）。改为：
- 若 `valEnd - valStart >= 10`（KG 后跟 6 字节）→ 返回 12 位 hex（完整 serial）。
- 若只有 3 字节（旧固件 v3.3）→ 仍返回 6 位后缀（向后兼容，仅用于展示/降级匹配）。

### 3.3 App `stores/ble.js` `autoConnectBest`（`:2656`）
扫描回调拿到 `advertisData` 后，用 `parseManufacturerFingerprint` 取 serial；匹配逻辑改为：
- 主键仍是 `deviceId`（Android 上 == serial，零成本）；
- **新增**：若 `deviceId` 匹配失败，再用 serial 在「已知设备信任表」里二次匹配。这样当某 ROM 把 `deviceId` 换成随机地址时，仍能用广播里的真实 MAC 认出设备；iOS 也能在扫描期按 serial 认设备。

---

## 4. 方案对比

### 4.1 方案 A：广播原始 6 字节 MAC（推荐）
把完整 MAC 直接塞进「KG」块。

| 优点 | 缺点 |
|---|---|
| 实现最简单（固件+App 各改一处） | 空中广播完整 MAC = 设备真实身份永远挂在广播里，可被第三方持续追踪（比现在只挂 3 字节后缀更暴露） |
| App 解析零歧义，直接得 12 位 serial | 31/31 满负荷、零余量 |
| 向后兼容旧固件（3 字节降级） | — |
| 彻底解决 deviceId 随机化 + iOS 取不到 serial | — |

### 4.2 方案 B：广播稳定哈希（隐私加固）
固件广播 `HMAC(serial, 固定盐)` 或截断 SHA256 前 6 字节；App 把信任表里每个已知 serial 也用同盐算哈希，扫描期比对哈希。

| 优点 | 缺点 |
|---|---|
| 空中不泄露真实 MAC，抗追踪 | 两侧都要算哈希，复杂度高 |
| 仍能扫描期识别已知设备 | 哈希碰撞需处理（6 字节空间够，但要做兜底） |
| | 旧固件无法降级（哈希与明文不互通）——可接受，属新能力 |

**结论**：个人车锁用方案 A 通常可接受（本来设备名就挂了 3 字节 MAC 后缀，泄露已部分发生）。若你介意被陌生人用蓝牙持续跟踪定位，选方案 B。两者可后续切换，不影响 App 匹配框架。

### 4.3 为什么不直接「挪电池到 scanRspData 腾位置」
| 方案 | 优点 | 缺点 |
|---|---|---|
| 电池留 advertData（本文采用） | 系统蓝牙电量显示零影响；advertData 余 11 字节刚好够 | 31/31 满负荷 |
| 电池挪 scanRspData | advertData 余量更大 | scanRspData 也仅余 10 字节，挪过去后若再塞 serial 仍不够；且改变系统电量显示路径有未知风险，没必要 |

---

## 5. 优劣总览（O3 阶段 a vs 阶段 b）

| 维度 | 阶段 a（JS 持久化 serial 作次要确认键） | 阶段 b（固件广播完整 serial，本文） |
|---|---|---|
| 是否解决 deviceId 随机化 | 否（连上后才有 serial，连之前仍靠 deviceId） | **是**（扫描期即按 serial 认设备） |
| 是否解决 iOS 取不到 serial | 否 | **是** |
| 改动位置 | 仅 App | 固件 + App |
| 风险 | 低 | 中（需真机验证广播解析、Doze 后台扫描一致性） |
| 收益 | 边际 | 根治 |

**结论**：阶段 a 是安慰剂，阶段 b 才是 O3 的真正落地。TODO① 注释应改写为「阶段 b：固件广播完整 serial（方案 A 原始 MAC / B 哈希），扫描期按 serial 匹配」。

---

## 6. 风险与验证清单
1. **广播满 31 字节**：烧录后用 nRF Connect / 手机 BLE 扫描器确认 advertData 出现 `FF FF FF 4B 47 <6字节MAC>`，且电池 `0x180F` 仍在、系统蓝牙仍显示电量。
2. **向后兼容**：旧固件（无 KG 块 / 仅 3 字节）下，App 不应崩溃，降级为 deviceId 匹配。
3. **Doze / 后台扫描**：Android 进入 Doze 后，manufacturer data 解析是否仍一致（部分国产 ROM 后台扫描会丢 advertisData，只给 name）——这是关键验证点，若 ROM 后台只给 name，则扫描期仍只能靠 `KeyGo-XXXXXX` 名里的 6 hex 后缀，方案 A 的 12 位 serial 在后台扫描下退化为 6 位，需在 App 侧做双层兜底。
4. **隐私**：方案 A 下确认你接受广播完整 MAC。

---

## 7. 待办 / 开放问题
- [ ] 确认 CH582M 广播填充是否支持 31 字节满负荷（部分栈实现建议留 1~2 字节余量，必要时去掉 Appearance 或改用方案 B 的 6 字节哈希）。
- [ ] 决定方案 A 还是 B（隐私偏好）。
- [ ] 真机验证后台扫描下 manufacturer data 是否可达。
- [ ] 落地后把 TODO① 注释改写为阶段 b 描述。
