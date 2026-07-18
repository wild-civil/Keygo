# UI 描述对照表（大白话 ↔ CSS 属性）

> 给不擅长描述界面的同学：照着「大白话」抄词，AI 就能精准改 UI。
> 配合 AI（CodeBuddy）使用时，直接复制文末的 **Prompt 模板** 发给它即可。

---

## 一、怎么用（三步走）

1. **说感受**：用大白话描述你想怎样（"电量放框里、别横跨、和 🔗 一样宽"）。
2. **AI 翻译 + 实现**：AI 把它翻成 CSS 并改好，**不会反复追问**。
3. **你看效果微调**：看完说"再靠左点 / 太高了"，AI 微调并**在代码写注释**告诉你每个数字管什么。

描述时尽量说清四件事：**哪个元素、放哪、多大、跟谁对齐**。

---

## 二、大白话 ↔ CSS 速查表

| 你想说的大白话 | 对应的 CSS 概念 / 属性 | 本项目例子 |
|---|---|---|
| 靠左 / 贴左 / 往左边靠 | `left`（绝对定位）或 `text-align:left` / `margin-right:auto` | `.card-batt { left: 30rpx }` |
| 居中 | `text-align:center` / `justify-content:center` / `align-items:center` / `margin:0 auto` | 文字居中、`flex` 居中 |
| 靠右 / 贴右 | `right` / `margin-left:auto` | 标签贴右 |
| 在 XXX 正下方 / 正上方 | `top` / `bottom`（绝对定位）或文档流顺序 | `.card-batt { bottom: 14rpx }` |
| 和 XXX 对齐（同一列） | 相同的 `left` 值 / `align-items` | 电量 `left` 与 🔗 同列 |
| 缩小 / 小一点 | `font-size`↓ / `padding`↓ / `width`↓ | 电量 `font-size:20rpx` |
| 大一点 | `font-size`↑ / `padding`↑ | — |
| 和 XXX 一样宽 | `width` 设同值 / `flex-basis:100%` | 整行元素 |
| 别横跨整行 / 只占一小块 | 不用 `width:100%`，改 `display:inline-flex` + 内容宽度 | 电量小胶囊 |
| **不要撑高父框 / 框高低不变** | `position:absolute`（脱离文档流，不占高度） | 电量胶囊 |
| 太挤 | `padding`↑ / `gap`↑ / `margin`↑ | — |
| 太松 / 太空 | `padding`↓ / `gap`↓ | — |
| 圆角 / 胶囊形 | `border-radius` | `border-radius:10rpx` |
| 绿底 / 红底（状态色） | `background` + 条件 class | `batt-low` 红底 |
| 隐藏（没数据时） | `v-if="条件"`（Vue）或 `display:none` | `v-if="deviceTempC!==null"` |
| 出现/消失带过渡 | `transition` / `opacity` | 卡片淡入 |
| 固定不动（不随滚动） | `position:fixed` | 顶部横幅 |
| 边框 / 描边 | `border` | `border:2rpx solid var(--border)` |

---

## 三、填空式描述模板（照抄改括号）

- 把【元素】放到【位置】，跟【参照物】对齐。
- 把【元素】【缩小 / 放大】一点。
- 【元素】不要【撑高父框 / 横跨整行】，做成【小标签 / 胶囊】。
- 【元素】离【上 / 下 / 左 / 右】边再【近 / 远】一点。
- 【元素】在【没连接 / 无数据】时自动隐藏。
- 这个区块看起来【不协调 / 太挤 / 太空】，帮我统一【间距 / 圆角 / 配色】。

---

## 四、直接发给 AI 的 Prompt（复制即用）

> 把【括号】换成你的内容即可。AI 会直接实现，不啰嗦。

**1. 定位类**
```
把【页面】里的【元素】挪到【位置】，跟【参照】左对齐，不要改变父框高度。
```

**2. 尺寸类**
```
把【元素】缩小成小胶囊/小标签，宽度只包住内容，不要横跨整行。
```

**3. 间距类**
```
【元素】和【参照】之间太挤/太空，把间距调得舒服一点。
```

**4. 配色类（状态色）**
```
【元素】按状态显示 绿(正常)/黄(偏高)/红(危险)，低中高各一档。
```

**5. 显隐类**
```
【元素】在【没连接 / 无数据】时自动隐藏，有数据时再显示。
```

**6. 整体协调类**
```
这个区块看起来不协调，帮我统一间距、圆角、配色，让它和旁边风格一致。
```

**7. 边看边改类**
```
刚才那版【具体哪里】不对：【再靠左一点 / 太高了 / 绿底太大】。帮我微调。
```

**8. 学习类（让 AI 教你）**
```
给我讲讲【position:absolute 和 正常布局】的区别，用本项目【电量胶囊】当例子。
```

---

## 五、本项目实战套路（KeyGo 已验证）

- **电量胶囊贴在 🔗 下方、且不撑高框**
  ```css
  .status-card { position: relative; }              /* 父框做定位锚点 */
  .card-batt   { position: absolute; left: 12rpx; bottom: 14rpx; } /* 绝对定位，脱离布局流 */
  ```
  - **想放到 🔗 上方？** 只把 `bottom` 换成 `top` 即可（`top`/`bottom` 二选一，别同时写）：
    ```css
    .card-batt { position: absolute; left: 12rpx; top: 14rpx; } /* top=贴卡片顶边 → 在竖居中的 🔗 之上 */
    ```
    > 原理：🔗 图标在卡片里竖直居中，`top:14rpx` 把胶囊钉在卡片顶边，所以视觉上落在图标「上方」；改回 `bottom` 则落到「下方」。数值越大离边越远。

- **温度卡片单独一块、无数据自动隐藏**
  ```html
  <view class="conn-extra" v-if="bleStore.deviceTempC !== null"> ... </view>
  ```
- **状态色用条件 class**（绿/黄/红）
  ```css
  .card-batt.batt-high { background: ...green }
  .card-batt.batt-mid  { background: ...yellow }
  .card-batt.batt-low  { background: ...red }
  ```

---

## 六、单位小知识

- **rpx**：uni-app 响应式像素，`750rpx = 屏幕宽度`，自动适配不同手机。本项目全用 rpx。
- **px**：物理像素，固定不缩放（一般不用）。
- 改一个数字就能看效果，多试几轮就顺手了。

---

> 本表是给「描述 UI 没把握」的同学用的速查。AI 改完会在代码里写中文注释，可以把注释当小抄看。
