# 侧边书脊布局 + flex column 下的「居中」陷阱

> 来源：KeyGo 小程序 `pages/index/index.vue` 的「已知设备 (N)」重连卡片重构（2026-08-26）。
> 把原本在卡片顶部/卡内的「已知设备 (N)」标题，改成贴在卡片左侧的「书脊」小标签，右侧承载设备列表。
> 本文沉淀两个易混点：(1) `flex-direction: column` 时 `align-items` 管的是**水平**方向；(2) `padding` 两值 / 四值简写的真实含义。

---

## 一、目标效果

```
┌──────────┬─────────────────────┐
│  已知设备 │  奇骏          连接 ⋯ │
│   (2)     │  E4:66:E5:5C:D8:B9   │
│          ├─────────────────────┤
│          │  KeyGo-C48C5D   连接 ⋯│
│          │  54:6C:50:5D:8C:C4   │
└──────────┴─────────────────────┘
```

「已知设备」4 字 + 「(N)」两行竖排，作为左侧书脊浮在 card 背景上（无底色、无边框），且**整体相对书脊盒子水平居中**。

---

## 二、Vue 模板结构

```vue
<!-- 外层 section：flex row，书脊在左、设备卡在右 -->
<view class="known-section" v-if="!bleStore.connected && bleStore.knownDevicesList.length" @tap="onListTap">
  <!-- 左侧书脊：竖排两行 -->
  <view class="reconnect-label">
    <text class="reconnect-title">已知设备</text>
    <text class="reconnect-count">({{ bleStore.knownDevicesList.length }})</text>
  </view>
  <!-- 右侧：设备卡容器（多设备 scroll-view / 单设备 known-item 共用） -->
  <view class="known-section-body">
    <template v-if="bleStore.knownDevicesList.length > 1">
      <scroll-view class="known-list" scroll-y @tap="onListTap">
        <!-- ... known-item 列表 ... -->
      </scroll-view>
    </template>
    <template v-else>
      <view class="known-item single-item"> <!-- ... --> </view>
    </template>
  </view>
</view>
```

要点：
- `.known-section` 是 `display:flex; flex-direction:row`，书脊与卡片横向并排。
- `.reconnect-label` 是 `flex: 0 0 auto`（固定宽不伸缩），`.known-section-body` 是 `flex: 1 1 auto`（占满剩余宽度）。
- 点击空白收起展开项绑在外层 `@tap="onListTap"`；按钮用 `@tap.stop` 拦截，不冒泡。

---

## 三、CSS 与两个易混点

### 3.1 flex column 下 `align-items` 管「水平」方向

```css
.reconnect-label {
  flex: 0 0 auto;
  width: 110rpx;          /* 书脊盒子固定宽 */
  padding: 24rpx 0;       /* 见 3.2 */
  display: flex;
  flex-direction: column; /* 主轴 = 垂直；交叉轴 = 水平 */
  align-items: center;    /* ★ 交叉轴对齐 = 让子元素在「水平方向」居中 */
  justify-content: center;/* 主轴对齐 = 让两行在「垂直方向」居中 */
  gap: 4rpx;              /* 已知设备 与 (N) 的垂直间距 */
  box-sizing: border-box;
}
```

**核心陷阱**：`flex-direction: column` 时——
- 主轴是**垂直**方向 → `justify-content` 控制上下
- 交叉轴是**水平**方向 → `align-items` 控制左右

所以「已知设备」和「(N)」之所以相对书脊盒子水平居中，靠的是 `align-items: center`，**不是** `justify-content`。

若写成 `align-items: flex-start`，文字会贴盒子左缘（这就是早期版本 (N) 偏左的根源）。

### 3.2 `padding` 简写：两值 ≠ 四值

```css
padding: 24rpx 0;
```

这是**两值简写**：`padding: <上下> <左右>;`
- `24rpx` = 上下都是 24rpx
- `0` = **左右都是 0rpx**（不是「右 24、左 0」）

| 写法 | 含义 |
|---|---|
| `padding: 24rpx 0;` | 上下 24，左右 0 |
| `padding: 24rpx 0 24rpx 8rpx;` | 上 24 / 右 0 / 下 24 / 左 8（四值：`上 右 下 左`） |
| `padding: 24rpx 8rpx;` | 上下 24，左右 8 |

**「已知设备」左侧空白在哪调？**
- 因为 `padding: 24rpx 0` 左右都是 0，且 `align-items: center`，文字在 110rpx 盒子内水平居中 → 文字左缘距盒子左缘 = `(110 - 文字宽) / 2 ≈ 11rpx`。
- 想手动加左侧呼吸感：把 `padding` 改成四值 `padding: 24rpx 0 24rpx 8rpx;`（加左 padding 8rpx），盒子整体右移，文字跟着右移。
- 想让文字贴左：改 `align-items: center` → `flex-start`。

### 3.3 书脊宽 与 右侧间距 的解耦

右侧卡片内容的水平间隙由 `.known-section-body` 的左 padding 决定：

```css
.known-section-body {
  flex: 1 1 auto;
  min-width: 0;
  padding: 24rpx 24rpx 24rpx 6rpx;  /* 第四个值 = 书脊右缘 → 卡片内容的间隙 */
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}
```

**实际间隙** = 书脊 `width`(110rpx) + body 左 padding(6rpx) = 116rpx。

调书脊宽度只需改 `.reconnect-label { width }` 一处；若想同步收紧书脊与卡片的视觉距离，再调 body 左 padding 即可。两者解耦，互不影响居中逻辑。

---

## 四、硬规则速记

1. **flex 方向决定对齐轴**：`flex-direction: column` 时，`align-items` 管水平、`justify-content` 管垂直；别记反。
2. **padding 简写位数**：1 值=四边同；2 值=`<上下> <左右>`；3 值=`<上> <左右> <下>`；4 值=`<上 右 下 左>`。两值里没有独立的「左/右」。
3. **「文字左侧空白」来源**：先看法 `align-items`（交叉轴居中会给文字两侧留白），再看盒子自身 `padding-left`；本例居中空白来自 `align-items:center`，不是 padding。
4. **书脊宽 / 间距解耦**：固定宽盒 + `flex:0 0 auto` 做书脊；右侧间距交给 body 的 `padding-left`，调宽只动一处。

---

## 五、踩坑回顾（本次会话）

- 第一版把「已知设备 (N)」放在卡片顶部 `.section-header`，呈现为竖排两行左对齐——视觉上 (N) 偏左、且与卡内设备名错位。
- 误以为要「横排单行」，改 `flex-direction: row` → 与截图不符。
- 最终确认为「侧边书脊」：外层 `row`，书脊 `column + align-items:center` 居中，(N) 相对书脊居中。
- 书脊宽度从 64rpx → 120rpx → 110rpx 逐步收敛到与你截图一致；body 左 padding 从 12rpx 压到 6rpx。
