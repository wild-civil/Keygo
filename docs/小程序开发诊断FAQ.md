# 小程序（mp-weixin）开发诊断 FAQ

> 适用分支：`dev/mini_program`。记录小程序侧编译/运行诊断与已知坑，供回归时参考。

## 1. 微信开发者工具提示「无依赖文件」（index2.js / App.wxml / CustomTabBar.wxml / power-saver.js 等）

- **成因**：这些文件位于 `unpackage/dist/dev/mp-weixin/`（HBuilderX 编译产物目录），是 uni-app 编译到小程序的混合 / 热重载中间产物（如 `pages/index/index2.js` 被主 `index.js` 动态 `require`）。工具做静态依赖扫描时，因其缺配对的 `.wxml` / `.json` 而**误报「无依赖文件」**。
- **影响**：无任何功能影响，真机运行正常。
- **处理（可选，仅为消除提示）**：微信开发者工具 →「工具」→「清除缓存」→「全部清除」并重启；或删除 `unpackage/dist/dev/mp-weixin` 整个目录后重新编译。**切勿手动删这些 `2` 文件**（下次编译会重新生成，中途删可能破坏构建）。

## 2. 小程序深色模式不跟随手机亮暗

- **前提（缺一不可）**：
  1. `manifest.json` 的 `mp-weixin` 节点需 `"darkmode": true` 且 `"themeLocation": "theme.json"`（已配）；
  2. 微信 App「我 → 设置 → 通用 → 外观」须设为「跟随系统」；
  3. 手机系统本身开启深色模式。
- **机制**：`stores/theme.js` 用 `wx.getSystemInfoSync().theme`（小程序原生，需上面前提才有值）+ `uni.onThemeChange` 监听 + auto 模式 3s 轮询；并兜底 `wx.getWindowInfo`/`wx.getAppBaseInfo`。各页面根 view 均 `:class="themeClass"` 响应式切换 CSS 变量。
- **诊断**：切系统主题时看 console `[Theme] wx.getSystemInfoSync 检测: dark/light` —— 出现 `dark` 即 JS 已检测（主题应切）；始终 `light` 或无 theme 输出，即微信未回报（检查前提第 2 步）。

## 3. 微信小程序 BLE 通知「全局单通道」坑（固件无响应 / RSSI 不显示）

- **坑**：微信小程序 `uni.onBLECharacteristicValueChange` 是**全局单通道**，多次 on/off 会互相覆盖。旧实现里 `readSerialNumber`/`readBatteryLevel` 的 `offBLECharacteristicValueChange` 曾误删 FF02 状态主 handler，导致 fwVersion 恒空、RSSI/电量不显示、BIND:OK 收不到（报「固件无响应」）。
- **修复**：`utils/ble.js` 改为**单一全局 handler + waiter 表**（`ensureGlobalNotifyHandler` / `registerNotifyWaiter`）。所有订阅（FF02 状态、`readSerialNumber`、`readBatteryLevel`）都经 `registerNotifyWaiter(charUUID, cb)` 注册，内部按 `characteristicId` 分发，互不覆盖。`store` 端 FF02 注册用 `registerNotifyWaiter`，断开时调其返回的 `unregister()` 清理。

## 4. 改 `utils/ble.js` 必须用 Python 直写（replace_in_file 静默失败坑）

- **现象**：`utils/ble.js` 较大，`replace_in_file` 可能**报错成功但实际未落盘**。曾两次导致 `registerNotifyWaiter` 定义缺失、编译报 `is not exported by utils/ble.js`。
- **对策**：改本文件一律用 Python `io.open` 读改写；写后重读断言关键字确实落盘；并用 `node --check`（复制为 `.mjs`）校验语法。临时脚本用完即删。
