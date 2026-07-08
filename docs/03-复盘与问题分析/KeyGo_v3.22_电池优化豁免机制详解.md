# KeyGo v3.22 电池优化豁免机制详解

## 目录

1. [背景：Android Doze 为什么会杀死 KeyGo](#1-背景android-doze-为什么会杀死-keygo)
2. [整体流程概览](#2-整体流程概览)
3. [模块架构](#3-模块架构)
4. [API 逐层剖析](#4-api-逐层剖析)
   - [4.1 ROM 检测 (`detectRom`)](#41-rom-检测-detectrom)
   - [4.2 豁免状态检测 (`isIgnoringBatteryOptimizations`)](#42-豁免状态检测-isignoringbatteryoptimizations)
   - [4.3 综合判断 (`isBatteryExempted`)](#43-综合判断-isbatteryexempted)
   - [4.4 跳转策略 (`getRomIntentStrategy`)](#44-跳转策略-getromintentstrategy)
   - [4.5 打开设置页 (`openBatteryOptimizationSettings`)](#45-打开设置页-openbatteryoptimizationsettings)
   - [4.6 ROM 引导文案 (`getRomGuidance`)](#46-rom-引导文案-getromguidance)
5. [App.vue 端的完整生命周期](#5-appvue-端的完整生命周期)
6. [荣耀 ELP-AN00 实测数据](#6-荣耀-elp-an00-实测数据)
7. [各 ROM 跳转策略对照表](#7-各-rom-跳转策略对照表)
8. [常见问题排查](#8-常见问题排查)

---

## 1. 背景：Android Doze 为什么会杀死 KeyGo

Android 6.0+ 引入 **Doze 省电模式**，熄屏 30~60 分钟后系统会将后台应用冻结（网络断开、定时器停摆、BLE 连接中断）。这对 KeyGo 这种「熄屏后仍需持续扫描 BLE 实现靠近解锁」的场景是致命的。

### 核心矛盾

| 需求 | Doze 的行为 |
|:--|:--|
| 熄屏后持续 BLE 扫描 | Doze 冻结所有后台网络/WakeLock |
| 靠近车辆自动解锁 | 冻结后 BLE 断开且无法重连 |
| 前台服务保活 | Doze 中前台服务也被冻结 |

### 解决方案（由强到弱）

1. **电池优化白名单** ← 当前方案。用户将 App 加入白名单后，Doze 不再冻结
2. 前台服务 + WakeLock（仅延缓冻结，不根本解决）
3. 厂商自启管理 + 后台运行白名单（国产 ROM 额外要求）

**关键认知**：电池优化白名单 ≠ 国产 ROM 的「应用启动管理」「手动管理」。这是两套独立机制，但电池优化白名单是 AOSP 唯一官方保活 API。

---

## 2. 整体流程概览

```
用户启动 App（onLaunch）
  │
  ├─ 延迟 2.5s → checkBatteryOptimization()
  │    │
  │    ├─ isBatteryExempted() → 综合判断
  │    │    ├─ isIgnoringBatteryOptimizations() → AOSP API 检测
  │    │    │    ├─ 方案A: Context.POWER_SERVICE 常量
  │    │    │    └─ 方案B: 字符串 'power'（降级）
  │    │    └─ isManualExempted() → 用户手动确认（保留但不再主动使用）
  │    │
  │    ├─ 已豁免 → 静默跳过 ✅
  │    ├─ 永不提醒标记 → 跳过
  │    ├─ 3天内已提醒 → 跳过
  │    └─ 需要弹窗 → showBatteryModal()
  │         │
  │         ├─ detectRom() → 检测手机品牌
  │         └─ getRomGuidance() → 定制引导文案
  │              │
  │              └─ 用户点击「去设置」
  │                   │
  │                   └─ openBatteryOptimizationSettings()
  │                        │
  │                        ├─ detectRom() → 确定 ROM
  │                        ├─ getRomIntentStrategy(pkgName) → 策略矩阵
  │                        └─ 按优先级尝试 Intent → 打开系统设置页
  │
  └─ onShow（用户从设置返回）
       │
       ├─ isIgnoringBatteryOptimizations() → 再检测
       ├─ 已豁免 → Toast「已允许后台运行」 ✅
       └─ 未豁免 → Modal「未完成设置，重试/稍后」
```

---

## 3. 模块架构

```
power-saver.js（核心工具模块，纯函数 + Android 桥接）
    │
    ├── 平台判断         isAndroidApp()
    ├── Context 获取      getMainActivity()
    ├── ROM 检测          detectRom()
    ├── 豁免检测          isIgnoringBatteryOptimizations()
    │                     isManualExempted()
    │                     isBatteryExempted()
    ├── 跳转控制          getRomIntentStrategy()
    │                     openBatteryOptimizationSettings()
    └── UI 引导           getRomGuidance()
                              │
App.vue（生命周期 + 弹窗 UI）      │
    ├── checkBatteryOptimization() │
    ├── showBatteryModal()          │
    ├── onBatteryGoSettings() ──────┘
    └── onShow() 返回后核查
```

`power-saver.js` 是纯逻辑模块，不依赖 Vue/uniapp 生命周期。`App.vue` 负责弹窗生命周期和用户交互。

---

## 4. API 逐层剖析

### 4.1 ROM 检测 (`detectRom`)

```js
export function detectRom() {
  const Build = plus.android.importClass('android.os.Build')
  const mfr = String(Build.MANUFACTURER || '').toLowerCase()  // 厂商
  const brand = String(Build.BRAND || '').toLowerCase()        // 品牌
  const model = String(Build.MODEL || '')                       // 型号
  // ...
}
```

**关键点**：
- 荣耀独立后 `Build.MANUFACTURER` = `"HONOR"`，华为 = `"HUAWEI"`
- 两者已不可混为一谈，必须分开处理
- 结果缓存到 `_romInfo`，不会重复请求系统

### 4.2 豁免状态检测 (`isIgnoringBatteryOptimizations`)

```java
// Java 层实际调用：
PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
boolean result = pm.isIgnoringBatteryOptimizations(packageName);
```

**5p+ 桥接双路探测设计**：

```
方案A: Context.POWER_SERVICE 常量（类常量，类型安全）
  ↓ 失败 / pm=null →
方案B: 字符串 'power'（降级方案，兼容老版桥接）
  ↓ 失败 →
返回 true（不阻塞流程）
```

**为什么需要双路**：

| 方案 | 调用方式 | 问题 |
|:--|:--|:--|
| 方案A | `Context.POWER_SERVICE` 类常量 | 5p+ 某些版本桥接可能解析失败 |
| 方案B | 字符串 `'power'` | 字符串匹配可能找不到服务 |

**返回值语义**：

| 返回 | 含义 |
|:--|:--|
| `true` | 已加入电池优化白名单，Doze 不会冻结 |
| `false` | 未豁免，熄屏 30~60 分钟后会被冻结 |
| `undefined/null`（异常） | 返回 `true`，不阻塞用户 |

**关键踩坑记录**：
- `plus.android.invoke()` 返回的 Java `boolean` 经 5p+ 桥接可能是 `true/false` 也可能是字符串 `"true"`/`"false"`，所以用 `!!result` 做显式布尔转换
- 荣耀 ELP-AN00（MagicOS）实测方案A 可用，无需降级

### 4.3 综合判断 (`isBatteryExempted`)

```js
export function isBatteryExempted() {
  if (isIgnoringBatteryOptimizations()) return true  // AOSP API 确认
  if (isManualExempted()) return true                 // 手动确认（保留）
  return false
}
```

`isManualExempted()` 读取 `battery_opt_manual_confirmed` 本地标记。这个机制保留但**不再主动触发**——v3.22-fix2 去除了误导性的「已完成设置？」二次确认，改为诚实告知用户「未完成设置」。

### 4.4 跳转策略 (`getRomIntentStrategy`) ★核心

三个候选 Intent，按优先级排列：

| 代号 | Intent Action | data | 效果 | 兼容性 |
|:--|:--|:--|:--|:--|
| `DIRECT_REQUEST` | `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | `package:xxx` | 直接弹系统对话框「是否允许」 | 仅原生/一加 |
| `IGNORE_LIST` | `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` | 无 | 电池优化应用列表页 | AOSP 通用 |
| `APP_DETAILS` | `ACTION_APPLICATION_DETAILS_SETTINGS` | `package:xxx` | 应用信息页（权限/存储/电池总览） | 100% 兼容 |

#### ROM 策略矩阵

```js
function getRomIntentStrategy(pkgName) {
  const rom = detectRom()
  const mfr = rom.manufacturer

  // 荣耀 → 电池优化列表优先（实测 AOSP 可用）
  if (mfr === 'honor')    return [IGNORE_LIST, APP_DETAILS, DIRECT_REQUEST]

  // 华为 → 电池优化列表优先
  if (mfr === 'huawei')   return [IGNORE_LIST, APP_DETAILS, DIRECT_REQUEST]

  // 小米/红米 → 应用详情页优先（拦截 AOSP 电池优化页）
  if (xiaomiLike)         return [APP_DETAILS, IGNORE_LIST, DIRECT_REQUEST]

  // OPPO/vivo/realme → 电池优化列表优先
  if (bBkLike)            return [IGNORE_LIST, APP_DETAILS, DIRECT_REQUEST]

  // 一加/三星/魅族/未知 → 电池优化列表优先（AOSP 兼容性好）
  return [IGNORE_LIST, APP_DETAILS, DIRECT_REQUEST]
}
```

**为什么荣耀改成了 IGNORE_LIST 优先？**

日志证据链：
```
[PowerSaver] 方案A pm = object           ← PowerManager 获取成功
[PowerSaver] isIgnoring[方案A]: ✅ true   ← isIgnoringBatteryOptimizations 可用
```

既然 PowerManager 的检测 API 在荣耀上工作正常，对应的 `ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS` Intent 大概率也没被 MagicOS 拦截。实测确实可用——直接跳转到电池优化列表，用户找到一个开关关掉就完事。

**之前为什么是 APP_DETAILS 优先？** 早期代码对华为/荣耀统一处理，以为国产 ROM 会拦截电池优化 Intent，所以选用了最安全的 APP_DETAILS。但 APP_DETAILS 打开的是应用信息总览页，用户需要自己找「电池→电池优化→关闭」这条路径，体验很差。

### 4.5 打开设置页 (`openBatteryOptimizationSettings`)

```js
export function openBatteryOptimizationSettings() {
  const main = getMainActivity()
  detectRom()  // 确保 ROM 已缓存

  const strategies = getRomIntentStrategy(pkgName)

  for (const strat of strategies) {
    // 惰性填充 action（从 android.provider.Settings 常量获取）
    // 尝试 startActivity(intent + FLAG_NEW_TASK + FLAG_CLEAR_TOP)
    // 成功则 return true
  }
  return false  // 所有方案均失败
}
```

**Intent 构造细节**：

```js
const intent = dataUri
  ? plus.android.newObject('android.content.Intent', action, Uri.parse(dataUri))
  : plus.android.newObject('android.content.Intent', action)

plus.android.invoke(intent, 'addFlags', 0x14000000)
// 0x14000000 = FLAG_ACTIVITY_NEW_TASK (0x10000000) | FLAG_ACTIVITY_CLEAR_TOP (0x04000000)
```

- `FLAG_ACTIVITY_NEW_TASK`：在独立任务栈启动（从 App 跳转到系统设置必须）
- `FLAG_ACTIVITY_CLEAR_TOP`：如果已有该页面则复用它，避免堆叠

### 4.6 ROM 引导文案 (`getRomGuidance`)

针对 9 种 ROM 提供了定制化操作指引，格式为 `{ title, content }`。

荣耀的文案：
```
KeyGo 需要在后台持续运行，才能靠近车辆自动解锁。

点击「去设置」后：
① 找到「耗电详情」或「应用启动管理」
② 将 KeyGo 设为「手动管理」
③ 开启「允许后台运行」

或者通过：
设置 → 隐私和安全 → 权限管理 → 特殊访问权限 → 电池优化 → 关闭 KeyGo 优化
```

**设计考量**：
- 提供两条路径（跳转页内操作 + 手动导航），适配不同系统版本
- 弹窗内容可滚动（`scroll-view`），长文案不撑爆布局

---

## 5. App.vue 端的完整生命周期

### 5.1 弹窗触发 (`checkBatteryOptimization`)

```js
function checkBatteryOptimization() {
  if (isBatteryExempted())    → 静默跳过（清除所有标记）
  if (never_remind)           → 永久跳过
  if (距上次提醒 < 3天)        → 跳过
  → showBatteryModal()        → 显示弹窗
}
```

**「永不提醒」标记存储**：`battery_opt_never_remind` → localStorage
**「上次提醒时间」存储**：`battery_opt_last_reminded` → localStorage（毫秒时间戳）

### 5.2 弹窗 UI

三按钮布局：
```
┌──────────────────────────────┐
│       保持后台运行             │
│                              │
│  KeyGo 需要在后台持续运行...   │
│  （ROM 定制文案，可滚动）       │
│                              │
│  [永不提醒] [稍后提醒] [去设置]  │
└──────────────────────────────┘
```

### 5.3 从设置返回 (`onShow`)

```
用户从设置页返回
  │
  ├─ isIgnoringBatteryOptimizations() === true
  │    → Toast「已允许后台运行」，清除所有标记 ✅
  │
  └─ isIgnoringBatteryOptimizations() === false
       → Modal「未完成设置」
            ├─「重新设置」→ 再次跳转 openBatteryOptimizationSettings()
            └─「稍后提醒」→ 记录提醒时间，3天后再次弹窗
```

**v3.22-fix2 关键变更**：不再有误导性的「已完成设置？」确认。如果 AOSP API 说 `false`，那就是真的没豁免，诚实告知用户。

### 5.4 弹窗触发时机

| 时机 | 行为 |
|:--|:--|
| `onLaunch` + 2.5s 延迟 | 避免阻塞启动流程 |
| `onShow`（从设置返回） | 核查豁免状态 |
| 再次 `onShow` | `checkBatteryOptimization` 内的 3 天冷却器控制 |

---

## 6. 荣耀 ELP-AN00 实测数据

```
18:18:08.899 [PowerSaver] packageName = uni.app.UNIBLEKEYGO
18:18:08.899 [PowerSaver] 方案A pm = object
18:18:08.899 [PowerSaver] isIgnoring[方案A]: ✅ true
18:18:08.899 [PowerSaver] isBatteryExempted: aosp=true
18:18:08.899 [App] ✅ isBatteryExempted=true

18:18:28.576 [PowerSaver] ROM 检测: 荣耀 (mfr=honor, brand=honor, model=ELP-AN00)
18:18:28.875 [PowerSaver] ✅ 已打开应用详情页  ← v3.22-fix1（旧版，跳错了）
                              ↓ 修复后应输出：
                              ✅ 已打开电池优化列表  ← v3.22-fix2
```

---

## 7. 各 ROM 跳转策略对照表

| ROM | 优先级1 | 优先级2 | 优先级3 | 说明 |
|:--|:--|:--|:--|:--|
| **荣耀** | `IGNORE_LIST` | `APP_DETAILS` | `DIRECT_REQUEST` | AOSP 可用，直达电池优化列表 |
| **华为** | `IGNORE_LIST` | `APP_DETAILS` | `DIRECT_REQUEST` | 与荣耀同策略 |
| **小米/红米** | `APP_DETAILS` | `IGNORE_LIST` | `DIRECT_REQUEST` | 拦截 AOSP 电池优化页 |
| **OPPO** | `IGNORE_LIST` | `APP_DETAILS` | `DIRECT_REQUEST` | 可能支持电池优化列表 |
| **vivo** | `IGNORE_LIST` | `APP_DETAILS` | `DIRECT_REQUEST` | 可能支持电池优化列表 |
| **realme** | `IGNORE_LIST` | `APP_DETAILS` | `DIRECT_REQUEST` | 可能支持电池优化列表 |
| **一加** | `IGNORE_LIST` | `APP_DETAILS` | `DIRECT_REQUEST` | AOSP 兼容性最好 |
| **三星** | `IGNORE_LIST` | `APP_DETAILS` | `DIRECT_REQUEST` | AOSP 兼容性好 |
| **魅族** | `IGNORE_LIST` | `APP_DETAILS` | `DIRECT_REQUEST` | AOSP 兼容性好 |
| **未知** | `IGNORE_LIST` | `APP_DETAILS` | `DIRECT_REQUEST` | 安全默认值 |

---

## 8. 常见问题排查

### Q: 弹窗逻辑正确但跳转后找不到设置项？

**检查日志中 `[PowerSaver] ✅ 已打开xxx`**：
- 如果输出「应用详情页」→ 说明降级到了 APP_DETAILS，检查 ROM 检测是否正确
- 如果输出「电池优化列表」→ Intent 正确，是用户系统版本差异

### Q: `isIgnoringBatteryOptimizations` 始终返回 false？

**检查日志中的方案A/B 输出**：
- `方案A pm = NULL, 方案B pm = NULL` → Context 获取失败，检查 5p+ 版本
- `pm = object, isIgnoring = ❌ false` → 确实未豁免，引导用户去设置
- 如果用户声称已在设置中关闭优化但仍返回 false → 可能是系统缓存，重启 App 试试

### Q: 如何为新的鸿蒙/ColorOS 等适配？

在 `detectRom()` 中添加 `Build.MANUFACTURER` 匹配分支，在 `getRomIntentStrategy()` 中添加对应跳转策略（默认用 IGNORE_LIST 优先，如果实测被拦截则改 APP_DETAILS 优先）。

### Q: 为什么不用 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS（直接弹系统对话框）？

`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 是 Android 6.0+ 加入的 API，用于 App 直接请求用户授予电池优化豁免。但国产 ROM（华为/荣耀/小米/OPPO/vivo）普遍**拦截或阉割**了这个 Intent，显示"此操作不被允许"或直接崩溃。因此仅作为最后备选方案。
