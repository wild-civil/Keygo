# 复活 `g_cfgRssiPeriodMs` — 方案设计

> 2026-08-04 | 讨论稿，尚未实施 | 关联 P16 (状态机 1s)

## 背景

P16 已将 `SBP_STATE_MACHINE_PERIOD` 从 3200(2s) 硬编码改为 1600(1s)，RSSI 响应从~4s 改善至~2s，用户体验显著提升。

但 `SBP_STATE_MACHINE_PERIOD` 仍是**编译期宏**，用户无法运行时调节响应速度。而 `g_cfgRssiPeriodMs`（APP 通过 FF01 下发）早已存在并正确接收存储，只是 `SBP_READ_RSSI_EVT` 被 fix22 移除后变成了**死参数**——数据到了但没人读。

**目标**：让 `g_cfgRssiPeriodMs` 重新接线，控制状态机轮询周期，实现运行时可调的"性能/省电"档位。

---

## 一、命名方案

当前名称混乱：

| 层级 | 当前名 | 问题 |
|------|--------|------|
| 固件宏 | `SBP_STATE_MACHINE_PERIOD` | 准确，但不够对外友好 |
| 固件变量 | `g_cfgRssiPeriodMs` | 误导——它控制的不只是 RSSI，而是整个状态机 |
| APP slider | "固件 RSSI 读取间隔" | 同上，用户不理解"RSSI" |
| 协议 key | `interval` | 过于泛化（跟什么间隔？） |

### 推荐重命名

| 层级 | 新名称 | 理由 |
|------|--------|------|
| 固件宏 | `SBP_STATE_MACHINE_PERIOD` | **保持不变**——它是内部实现细节 |
| 固件变量 | `g_sysPollPeriodMs` | "系统轮询周期"，准确描述其作用范围（状态机+FF02心跳+RSSI） |
| APP 显示 | "系统响应速度" | 用户能理解：快=灵敏但略费电，慢=省电但反应慢 |
| 协议 key | `poll_ms` | 比 `interval` 语义明确，且不破坏兼容（旧 key `interval` 保留兼容） |

兼容策略：固件同时接受 `poll_ms` 和 `interval` 两个 key，新的用新名，旧的也能用。

---

## 二、存储策略：per-phone vs 全局

### 现状对比

| 参数 | 存储方式 | RAM/Flash | 谁决定 |
|------|---------|-----------|--------|
| unlock/lock/uc/lc | per-phone (RAM) | RAM，连接下发 | 手机 APP |
| dlock/kr/autolock | per-phone (RAM) | RAM，连接下发 | 手机 APP |
| cooldown_ms | **全局 (Flash)** | DataFlash，写即持久化 | 任一手机 |
| **poll_ms (新)** | **待定** | — | — |

### 决策分析

**选项 A：per-phone (RAM，仅 APP 连接时生效)**
- ✅ 简单，不写 Flash，零磨损
- ✅ 不同手机可以不同偏好
- ❌ No-App 模式（无 APP 连接）无法调整，永远用默认 1s
- ❌ 断开连接后丢失，下次重连需要 APP 重新下发

**选项 B：全局 (DataFlash，持久化)**
- ✅ 所有手机统一行为（包括 No-App）
- ✅ 设一次永久生效
- ❌ Flash 写磨损（但配置写入是低频操作，可接受）
- ❌ 不同手机无法独立偏好（但这场景罕见）

**推荐：选项 B（全局 + DataFlash 持久化）**

理由：
1. **No-App 模式需要**。如果用户是拿 KeyGo 当钥匙扣（No-App），他调了 2s 省电，期望断开后继续保持——per-phone 做不到。
2. **这不是"手机偏好"，是"设备行为"**。响应速度是设备固件的属性，类似 cooldown_ms。
3. 写入频率极低（改一次用几个月），Flash 磨损可以忽略。
4. 如果将来真需要 per-phone 差异（一个家庭多人共用、有人想要快快有人想要省电），可以加一个 **"全局默认 + APP 可覆盖"** 的二级策略——但现在不需要这个复杂度。

### 初始值策略

- 固件默认值：`DEFAULT_POLL_PERIOD_MS = 1000`（1s，当前 P16 实测值）
- 如果 DataFlash 未写过（首次上电），使用默认值
- 用户在 APP 上调整后，写入 DataFlash，后续启动读取

---

## 三、档位设计

### 候选值分析

| 周期 | 状态机唤醒 | 有效 RSSI 更新 | 额外功耗 (vs Sleep) | 体验 |
|------|-----------|---------------|---------------------|------|
| 200ms | 5 Hz | ~400ms | ~5µA | 极快，但唤醒密度=BLE 连接事件密度，RSSI 读无增量价值 |
| 500ms | 2 Hz | ~1s | ~2µA | 快，接近实时反馈 |
| 1000ms | 1 Hz | ~2s | ~1µA | ★ 当前默认，已验证良好 |
| 2000ms | 0.5 Hz | ~4s | ~0.5µA | 偏慢，用户反馈"反应慢"的根源 |
| 5000ms | 0.2 Hz | ~10s | ~0.2µA | 极慢，只适合极端省电场景 |

### 200ms 为什么不推荐

```
200ms 唤醒 + GAPRole_ReadRssiCmd 异步 HCI → 回调 160-320ms 后
= 你发了 5 次 HCI 命令，但 BLE 连接事件只来 3-6 次
= 有效新数据 ≈ 每 320ms 一份（受连接间隔限制）
= 多出来的唤醒白费了
```

200ms 是 RSSI 独立定时器时代的遗留，那时有独立 `SBP_READ_RSSI_EVT` 只做一件事。**现在状态机要跑完整的逻辑（AUTH 检查/配置判定/FF02 推送），200ms 唤醒频率没有收益。**

### 推荐档位

```
500ms  → "性能"（真正需要极快响应的场景）
1000ms → "标准"（默认，已验证平衡点）
2000ms → "省电"（RSSI ~4s 响应，可接受下限）
5000ms → "超省电"（极端场景，长期无人靠近）
```

APP 端可显示为 4 档选择器（而非 slider），配上易懂文案：

| 值 | APP 显示 | 说明 |
|----|---------|------|
| 500ms | 性能 | 响应最快，功耗略高 |
| 1000ms | 标准 ⭐ | 推荐，速度与省电平衡 |
| 2000ms | 省电 | 响应偏慢，延长续航 |
| 5000ms | 超省电 | 反应最慢，极致续航 |

> 注：功耗差异在当前 472µA 总电流下占比 <1%，真正省电靠 LDO 换型。但语义上保留"档位感"对用户体验有意义。

---

## 四、固件实现计划

### 4.1 `SBP_STATE_MACHINE_PERIOD` 宏→变量

**核心改动**：把状态机定时器从硬编码宏改为运行时读变量

```c
// peripheral.h: 保留宏作为默认值
#define SBP_STATE_MACHINE_PERIOD_DEFAULT   1600   // 默认 ~1s

// peripheral.c: 连接建立时读 g_sysPollPeriodMs
static uint16_t getSysPollPeriodTicks(void) {
    uint32_t ticks = (uint32_t)g_sysPollPeriodMs * MS_TO_TMOS_TICK_NUM / MS_TO_TMOS_TICK_DEN;
    if (ticks < 640)  return 640;   // 下限 400ms (500ms 的 ticks=800, 留余量)
    if (ticks > 8000) return 8000;  // 上限 5000ms
    return (uint16_t)ticks;
}
```

### 4.2 三处定时器启动改为读变量

```c
// ① 连接建立时 (peripheral.c)
tmos_start_task(Peripheral_TaskID, SBP_STATE_MACHINE_EVT, getSysPollPeriodTicks());

// ② 状态机自循环 (peripheral.c)
KeyGo_ProcessStateMachine();
tmos_start_task(Peripheral_TaskID, SBP_STATE_MACHINE_EVT, getSysPollPeriodTicks());
// ↑ 每次读最新值，支持运行时热切换

// ③ 断连 → 停止（不变）
tmos_stop_task(Peripheral_TaskID, SBP_STATE_MACHINE_EVT);
```

### 4.3 配置变更时无需额外操作

因为状态机每拍自排下一拍，读的是 `g_sysPollPeriodMs` 当前值 → **APP 改了 interval 后，下一拍自动生效，无需重启定时器**。

### 4.4 Flash 持久化

新增 DataFlash slot（例如 `KEYGO_POLL_PERIOD_ADDR`），启动时读取，为 0xFF（未写过）则用默认值。

### 4.5 重命名清单

| 文件 | 改动 |
|------|------|
| `keygo_core.h/c` | `g_cfgRssiPeriodMs` → `g_sysPollPeriodMs`；新增持久化函数 |
| `peripheral.c` | 三处定时器改用 `getSysPollPeriodTicks()` |
| `peripheral.h` | 策略注释更新；`KEYGO_POLL_PERIOD_ADDR` 地址分配 |
| `keygo_config.c` | 读写 Flash 的持久化逻辑 |
| `config.vue` (APP) | slider 改档位选择器；文案 "固件 RSSI 读取间隔" → "系统响应速度" |

---

## 五、APP 端配合

### 5.1 配置页折叠优化（独立事项，可后做）

当前 config.vue 的选项列表较长（阈值×2 + 计数×2 + 间隔 + 延时 + 卡尔曼 + 冷却...），用户滚动负担重。

**方案**：按功能分组，默认折叠，点击展开

- **解锁/锁车参数**（默认展开）：阈值滑块、确认次数
- **响应速度**（默认展开）：poll_ms 档位选择器
- **高级设置**（默认折叠）：断连延时、冷却时间、卡尔曼 R 值

### 5.2 协议兼容

固件同时接受 `interval=500` 和 `poll_ms=500`，APP 优先用 `poll_ms`（新名），旧版 APP 仍可工作。

---

## 六、决策记录

| 决策 | 结论 | 理由 |
|------|------|------|
| 命名 | `g_sysPollPeriodMs` / `poll_ms` / "系统响应速度" | 准确描述作用范围，不再误导为纯 RSSI |
| 存储 | 全局 DataFlash | No-App 模式需要；写入频率极低 |
| 档位 | 500ms/1s/2s/5s，默认 1s | 排除 200ms（无效唤醒）；4 档覆盖全场景 |
| 实施时机 | 后续独立 PR，不混入当前 pm-test 分支 | 当前分支聚焦低功耗，功能改动应独立评审 |
| 兼容 | 固件同时接受 `interval` 和 `poll_ms` | 不破旧版 APP |

---

## 七、功耗影响速算

| 周期 | Avg 唤醒电流 | vs 1s 基准 |
|------|-------------|-----------|
| 500ms | +~1µA | +0.2% |
| 1000ms | 基准 | 0 |
| 2000ms | −~0.5µA | −0.1% |
| 5000ms | −~0.8µA | −0.2% |

在当前 ~472µA 总功耗中占比极微。真正省电靠硬件（LDO/板级），软件档位的意义是**给用户感知的可控性**而非实际省电。
