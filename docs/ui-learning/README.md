# KeyGo · UI 学习复盘系列

> 边做项目（KeyGo uni-app + Android 蓝牙车锁）边沉淀的 **CSS / UI / 前端架构** 复盘文档，统一归档于 `docs/ui-learning/`。
> 每篇都基于真实代码改动，可作为后续「UI 学习复盘博客」的素材。文件命名：`YYYY-MM-DD_主题.md`。

---

## 目录

| # | 文档 | 一句话摘要 | 核心硬规则 |
|---|---|---|---|
| 1 | [padding-left 与 text-indent 悬挂缩进](./2026-07-25_padding-left与text-indent悬挂缩进详解.md) | 用 `padding-left`+`text-indent:-1em` 做零 DOM 悬挂缩进列表 | `padding-left` 定左边界，`text-indent` 调首行偏移；排版缩进用 `em` |
| 2 | [小程序 v-show / v-if / display 切换](./2026-07-25_小程序v-show-v-if-display切换复盘.md) | mp-weixin 上 `v-show`/`style display` 切不动，`v-if` 打断 swiper 手势 | 切显隐保 DOM → `:class`+`display:none`；`v-if` 仅在允许卸载且非 swiper 内时用 |
| 3 | [死滚动 100vh 与 box-sizing](./2026-07-25_死滚动100vh与box-sizing复盘.md) | 滚动内容页误用 `100vh` + 未开 border-box 导致死滚 | 滚动内容页用 `min-height:100%`+`box-sizing:border-box`，不用 `100vh` |
| 4 | [CSS 变量主题系统与 color-mix 兼容](./2026-07-25_CSS变量主题系统与旧安卓color-mix兼容性.md) | 主题换肤用 CSS 变量，老安卓 WebView 不支持 `color-mix` | 主题一律 `var(--x)`；老机型项目弃用 `color-mix`，用显式值 |
| 5 | [mp-weixin Pinia 非单例与 globalThis](./2026-07-25_mp-weixin-Pinia非单例与globalThis共享.md) | 小程序多 Page 致 store 多实例、跨页状态矛盾 | 跨 page 共享实例挂 `globalThis`，别依赖模块级单例 |
| 6 | [蓝牙开启交互：modal 双弹 vs banner 引导](./2026-07-25_蓝牙开启交互modal双弹与banner引导.md) | 被动流程不弹系统框，改用红 banner 引导避免双弹 | 主动操作才 modal，被动/后台流程走内联引导 |
| 7 | [前端单位选择：rpx / em / vh-vw](./2026-07-25_前端单位选择rpx-em-vh-vw取舍.md) | rpx 管布局、em 管排版、vh 慎用于滚动页 | 布局 rpx、排版 em、滚动页高度用 100%+border-box |
| 8 | [蓝牙 banner 全局横幅组件化与跨页条件渲染](./2026-07-25_蓝牙banner全局横幅组件化与跨页条件渲染.md) | `BtStateBanner` 抽组件 + 壳层 `v-show` 跨 tab 门控 + 组件内互斥用 `v-if` | 重复 UI+共享状态→抽零 props 组件；壳层门控 v-show（MP 改 `:class`）；组件内互斥用 `v-if` |

---

## 跨文档「硬规则」速查

1. **切显隐**：mp-weixin 上用 `:class` + `display:none`；`v-if` 只在允许卸载且不在 `swiper` 内时用；`v-show`/`:style display` 在 MP 不可靠。
2. **滚动页高度**：`min-height:100%` + `box-sizing:border-box`，禁用 `100vh`。
3. **主题/颜色**：全用 CSS 变量 `var(--x)`，老安卓 WebView 项目不用 `color-mix`，写显式值。
4. **状态共享**：跨 page 的 store/单例挂 `globalThis`，不靠模块级变量（mp-weixin 多 Page 架构）。
5. **单位分工**：布局 `rpx`、文字排版缩进/行高 `em`、全屏外壳 `100vh`（谨慎）、滚动内容页 `100%`。
6. **交互打断**：用户主动操作才弹 modal；冷启动/后台/自动流程用内联 banner 引导，避免双弹。
7. **组件化**：重复 UI + 共享 store + 与页面主逻辑无关 → 抽零 props 的展示+交互组件；平台差异封进组件，壳页面保持干净。
8. **异步状态机**：系统状态多来源（如蓝牙）须有单一权威源 + 来源优先级 + 过渡态保护，否则 UI 红绿乱跳。

---

## 待续主题（备选下一篇）

- `swiper` + `scroll-view` 嵌套滚动架构的取舍
- 电量/连接状态的「防抖合并刷新」（`_displayCoalescer` 100ms 提交）的 UI 性能思路
- 真机/基座调试的「诊断日志」套路（`[A1-DIAG]`/`[v3.36.3fix11.4-DIAG]` 这类带标签 console 的定位法）
