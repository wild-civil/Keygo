# CSS 复盘：padding-left 与 text-indent（以悬挂缩进为例）

> 来源：KeyGo App `pages/help/help.vue` 的"快速上手"列表重构。
> 目标：把这次用到的两个 CSS 属性讲透，作为后续 UI 学习复盘博客的素材。

---

## 0. 我们实际写了什么

`help.vue` 的"当钥匙用"步骤里，需要一段**引导行 + 悬挂项目符号列表**：

```html
<text class="step-desc step-desc--lead">重连策略有三档（「配置」页 → 智能重连模式）：</text>
<text class="step-desc step-desc--item">·舒适（亮屏自动连，默认）</text>
<text class="step-desc step-desc--item">·手动（纯手动，不自动连）</text>
<text class="step-desc step-desc--item">·极速（GPS+运动感知，通勤无感)</text>
<text class="step-desc step-desc--lead">开启「Beta ·无App模式」后，即使 App 没运行，手机走近也会由设备自动解锁。</text>
```

对应的样式（`.step-desc` 基类已是 `display:block`）：

```css
.step-desc        { font-size: 22rpx; line-height: 1.5; display: block; }
.step-desc--lead  { padding-left: 2em; text-indent: -1em; } /* 引导行 */
.step-desc--item  { padding-left: 3em; text-indent: -1em; } /* 列表项（悬挂） */
```

最终视觉层次（相对 step-content 左缘）：
- 引导行文本起点 ≈ `2em − 1em = 1em`
- 列表项 `·` 起点 ≈ `3em − 1em = 2em`（比引导行深 1em，形成嵌套感）

全程**没有新增任何 DOM 节点**（没用 `<ul>/<li>`、没用 flex 子弹），纯靠两个属性把缩进算出来。

---

## 1. padding-left：盒模型的内边距

CSS 盒模型从内到外是：`content → padding → border → margin`。
`padding-left` 是**内容区左边**到**边框内侧**的距离，属于"内边距"。

要点：
- 它把**整个内容盒子**（包括第一行和所有换行后的行）一起向右推 `N`。
- 与 `margin-left` 的区别：`padding` 是盒子内部留白（背景色会铺到 padding 区），`margin` 是盒子外部的间距（背景不铺）。本例用 padding 是因为我们只想让文字内缩，不涉及外部布局间距。
- 对块级元素（`display:block`）才稳定生效；本例 `.step-desc` 已是 `display:block`，所以没问题。

一句话：`padding-left` 决定"整段文字的左边界在哪"。

---

## 2. text-indent：仅首行缩进

`text-indent` 只缩进**块级元素的第一行**，后续行不受影响。

要点：
- 正值：首行向右缩（中文段落常用的"首行空两格"就是 `text-indent: 2em`）。
- **负值合法**：首行向左拉，从而"挂"在左边界外面——这是悬挂缩进的关键。
- 只对块级容器有意义；行内元素（`display:inline`）上不生效。
- 它缩的是"行"不是"盒子"，所以换行后的第二行不会跟着缩。

一句话：`text-indent` 决定"第一行相对左边界的偏移"。

---

## 3. 组合拳：悬挂缩进（hanging indent）

把两者叠加，就能让**首行比后续行更靠左**，形成经典的悬挂缩进：

```
容器左缘
│
├─ 1em ── 引导行文本（padding 2em，首行被拉回 −1em）
│
├─ 2em ── ·舒适（padding 3em，首行被拉回 −1em，· 落在 2em 处）
│          （若换行）第二行回到 padding 3em 处 → 比 · 深 1em
├─ 2em ── ·手动
├─ 2em ── ·极速
```

数学关系（对每个元素独立）：
- 首行实际起点 = `padding-left + text-indent`
- 后续行起点 = `padding-left`

本例：
- 列表项首行 = `3em + (−1em) = 2em`；换行后 = `3em`。→ · 挂在 2em 的"凹槽"里，换行文字对齐到 3em，正是参考文献/词条里那种"项目符号在左、正文右对齐"的专业观感。
- 引导行首行 = `2em + (−1em) = 1em`；换行后 = `2em`。

> 坑点提醒：`text-indent` 只影响首行。如果某个列表项的文字**换行成两行**，第二行会回到 `padding-left`（3em）位置，而不是缩在 · 下面——这其实是好事（悬挂缩进本就该如此）。但若你期望"第二行也对齐到 · 下面"，那得用 flex 方案（见 §5）。

---

## 4. 为什么用 em 而不是 rpx / px

- `em` 是**相对当前元素 font-size** 的单位。本例 `font-size: 22rpx`，所以 `1em = 22rpx`、`2em = 44rpx`。
- 好处：缩进随字号**等比缩放**。哪天你把 `.step-desc` 字号改成 24rpx，所有缩进自动跟着变，不用逐个改数值——这是排版里比写死 px 更"专业"的做法。
- `rpx` 是 uni-app 的响应式像素（750rpx = 屏宽），适合做整体布局栅格；但纯文字排版的"段内缩进"用 `em` 语义更准（它描述的是"相对字号几倍"）。
- `px` 写死则完全不随字号变，调整主题/无障碍放大时会错位。

经验法则：**布局间距用 rpx，文字排版的缩进/行高用 em。**

---

## 5. 这个技巧的适用场景与替代方案

### 适合用"padding-left + text-indent"悬挂缩进
- 轻量列表、说明项、脚注，且**不想为列表额外加 DOM**。
- 单行或少量换行的项目符号（· / - / 数字前缀写在文本里即可）。
- 追求极简结构、和周围 `display:block` 文本混排的场景。

### 替代方案 A：语义化 `<ul><li>`
- 优点：结构语义正确，屏幕阅读器能识别为列表，`list-style` 管 bullets。
- 缺点：uni-app / 小程序里 `<ul>/<li>` 默认样式需重置，且你这段是混在 `<text>` 引导行里的，套 `<ul>` 反而破坏现有结构。

### 替代方案 B：flex 子弹
```html
<view class="row"><text class="bullet">·</text><text class="txt">舒适（亮屏自动连，默认）</text></view>
```
```css
.row { display: flex; }
.bullet { width: 1em; flex: none; }
.txt { flex: 1; }
```
- 优点：bullet 是独立节点，**换行的第二行永远对齐到正文（不会掉进凹槽）**，对齐最稳。
- 缺点：每列表项多两层 DOM，简单短列表显得重。

结论：短列表、追求零 DOM → 用本文的悬挂缩进；长文、频繁换行、要绝对对齐 → 用 flex 子弹。

---

## 6. 一句话总结

| 属性 | 作用范围 | 能否为负 | 典型用途 |
|---|---|---|---|
| `padding-left` | 整个盒子（所有行） | 否（负无意义） | 整段左缩进 / 留白 |
| `text-indent` | 仅首行 | 能（悬挂缩进） | 段落首行缩进 / 悬挂项目符号 |

`padding-left` 定"左边界"，`text-indent` 调"首行偏移"，二者一加一减即得悬挂缩进。
