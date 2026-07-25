# CSS 变量主题系统 + 旧安卓 WebView 的 color-mix 兼容性

> 来源：KeyGo App `App.vue` 的 `.theme-dark` / `.theme-light` 全套 CSS 变量色板，以及 `config.vue` 的 Beta 配色矩阵。修复点：为兼容旧安卓 WebView，**放弃 `color-mix()` 自动派生、改用显式 4 套色值**。
> 目标：讲清"设计 token（CSS 变量驱动主题）"的工程做法，以及新 CSS 特性在老 WebView 上的兼容性坑。UI 复盘素材。

---

## 0. 机制：一套变量驱动整站主题

`App.vue` 在 `:root` / `.theme-dark` / `.theme-light` 下定义全套颜色变量（背景、边框、文字、状态色、渐变、强调色…），例如：

```css
.theme-dark {
  --bg-page: #0f0f1a;
  --bg-card: #1a1a2e;
  --text-primary: #e8edf4;
  --accent: #00d4ff;
  /* …几十个 token */
}
.theme-light {
  --bg-page: #f0f2f5;
  --bg-card: #ffffff;
  --text-primary: #1a1a2e;
  --accent: #0077cc;
}
```

`themeStore` 切换根节点的 `themeClass`（`theme-dark` / `theme-light`），所有用 `var(--xxx)` 的元素**自动换色**。平滑过渡靠把 `transition` 放在会切换 `themeClass` 的元素上：

```css
.app-root { transition: background-color .3s, color .3s; }
```

这就是前端常见的 **Design Token** 思路：颜色只在一处定义，全站引用，换肤 = 换一组变量。

---

## 1. 坑：想用 color-mix() 偷懒，老机型整块失效

Beta 实验特性（无App模式）需要一组"主色 + 浅底 + 描边 + 文字"四件套。直觉上最优雅的写法是让浅色自动从主色派生：

```css
--beta: #7c3aed;
--beta-soft:   color-mix(in srgb, var(--beta) 14%, transparent);  /* ❌ 优雅但危险 */
--beta-border: color-mix(in srgb, var(--beta) 45%, transparent);
--beta-text:   color-mix(in srgb, var(--beta) 60%, white);
```

**问题**：`color-mix()` 需要较新的渲染引擎（约 Chrome 110 / 2023 年后的系统）。KeyGo 运行在 **Android WebView**（尤其老机型系统 WebView 不随 Chrome 更新），旧版 WebView 不认识 `color-mix` → 该变量解析失败 → **所有引用它的属性整块失效**（颜色丢失/落到继承值）。

`App.vue` 的注释明确点出：
```css
/* ⚠️ 兼容性提醒：若将来想用 CSS color-mix() 让下面这 3 个值自动从 --beta 派生（省去手动配套），
   请注意旧版 Android WebView（约 Chrome 110 / 2023 年之前的系统）不支持 color-mix，
   会整块颜色失效；当前特意用显式值以确保老机型也正常。 */
--beta-soft:   rgba(124, 58, 237, 0.14);
--beta-border: rgba(124, 58, 237, 0.45);
--beta-text:   #a78bfa;
```
亮色主题同样显式写：
```css
--beta-soft:   #f5f3ff;
--beta-border: #ddd6fe;
--beta-text:   #7c3aed;
```

---

## 2. 衍生：Beta 配色矩阵（4 主色 × 4 处变量）

`config.vue` 里用户可切换 Beta 主色（紫 / 橙 / 青 / 靛蓝），每种都要配套 4 处变量。代码用注释矩阵固化套路：

```
│ 方案   │ 主色--beta│ 暗色(-soft/-border/-text)      │ 亮色(-soft/-border/-text)      │
│ 紫    │ #7c3aed   │ rgba(124,58,237,.14)/.45/#a78bfa│ #f5f3ff/#ddd6fe/#7c3aed       │
│ 橙    │ #f59e0b   │ ...                              │ ...                            │
套路：--beta 用主色实色；-soft 用主色极浅色调（亮色实色/暗色半透明）；-border 比 -soft 略深；
     -text 亮色用主色深一档(浅底可读)、暗色用主色亮一档(深底可读)。配好 4 处即整块换色。
```

即：**换一个主色 = 手动维护 4 处变量**，而不是 `color-mix` 一行搞定。代价是重复，收益是老机型 100% 正常。

---

## 3. 知识点速记

| 概念 | 要点 |
|---|---|
| CSS 变量（Custom Properties） | 定义在 `:root`/类选择器下，子元素 `var()` 继承；换类即换肤 |
| Design Token | 颜色/间距集中定义、全站引用，主题切换零改业务代码 |
| `color-mix()` | 从两色按比例混合生成新色；Chrome 111+ 才稳定，旧 WebView 不支持 |
| 兼容性兜底 | 老机型/WebView 项目慎用 `color-mix`/`oklch`/`:has` 等新特性；优先显式值或 `@supports` 兜底 |

---

## 4. 经验法则

- 主题/换肤**一律用 CSS 变量**，业务里只写 `var(--x)`，别写死颜色。
- 面向 Android WebView / 老旧系统的项目，**新 CSS 特性先查 caniuse + 真机**，别假设"现代浏览器都支持"。
- 需要在"优雅（color-mix 派生）"和"兼容（显式值）"间取舍时，**用户基数广 + 老机型多 → 选显式值**。
- 若坚持用新特性，至少加 `@supports (color: color-mix(in srgb, red, blue))` 兜底，失败回退显式值。
