# KeyGo —— Android 离线打包 & 原生插件集成 Checklist

> 适用工程（本机）：
> `D:\Documents\HBuilderProjects\HbuilderX _sdk\Android\5.14\Android-SDK@5.14.82649_20260630\Android-SDK@5.14.82649_20260630\HBuilder-Integrate-AS`
> 模块：`simpleDemo`
> appid：`__UNI__35B0789` / applicationId：`com.keygo.app` / versionName：`1.0.16`

---

## 0. 先理解三种打包方式的区别（避免再踩"看不到修复"的坑）

| 方式 | 代码来源 | 看到最新修复？ |
|------|----------|----------------|
| 标准基座（运行到手机） | HBuilderX 实时编译**工作区最新代码** | ✅ 永远最新 |
| 云打包 | 云端重新编译**工作区最新代码**生成 APK | ✅ 最新 |
| **离线打包（Android Studio）** | 工程里 `assets/apps/<appid>/www/` 的**静态资源快照** | ⚠️ 取决于是否重新导出覆盖 |

> ⚠️ **关键认知**：离线打包 ≠ 实时工作区代码。AS 编译的是 `simpleDemo/src/main/assets/apps/__UNI__35B0789/www` 这份快照，它**不会**随你在 HBuilderX 改代码自动更新。必须手动重新导出并覆盖，否则编出来的还是旧代码。

---

## Part A —— 离线打包标准步骤（每次改完前端都要走）

- [ ] **A1. HBuilderX 生成本地打包资源**
  - 菜单：`发行` → `原生App-本地打包` → `生成本地打包App资源`
  - 产物在：`app/BLE_Key_Go_App/unpackage/resources/__UNI__35B0789/` （内含 `www/` 目录）
- [ ] **A2. 覆盖到 AS 工程**
  - 把上一步生成的 **整个 `www` 目录** 复制到
    `simpleDemo/src/main/assets/apps/__UNI__35B0789/www`
    （覆盖旧文件，**建议先删除旧的 www 再粘贴**，避免残留旧文件）
- [ ] **A3. 核对 appid 一致**（已一致，长期留意）
  - `dcloud_control.xml` 的 appid == 工作区 `manifest.json` 的 appid == 资源目录名，三者必须相同
- [ ] **A4. Android Studio 全量重建（最容易漏的一步）**
  - `Build` → `Clean Project`
  - `Build` → `Rebuild Project`
  - 或直接删除 `simpleDemo/build/` 目录后 `Make Project`
  - ⚠️ 不 Clean 直接 Run，会复用 `build/intermediates/assets/` 里的**旧缓存资源**，导致"改了代码却看不到"
- [ ] **A5. 运行 / 出包**
  - 调试：`Run 'simpleDemo'` 到手机（debug 签名已在 `build.gradle` 配好）
  - 发布：`Build` → `Generate Signed Bundle / APK`（用工程自带 keystore）
- [ ] **A6. 验证装的是新包**
  - 手机上**卸载重装**再测，避免覆盖安装时用了旧缓存；或确认 `versionCode`（当前 116）已自增

---

## Part B —— 原生插件 Keygo-Foreground 集成（一次性，已做大部分）

> 插件作用：后台 BLE 扫描 + 亮屏/解锁监听（舒适模式后台重连核心）。
> 声明源：`app/BLE_Key_Go_App/nativeplugins/Keygo-Foreground/package.json`
> - type: `module`
> - name: `Keygo-Foreground`
> - class: `com.keygo.foreground.KeygoForegroundModule`

当前工程已满足的部分（**已 OK，不用动**）：

- [x ] **B1. aar 已放入 libs**
  `simpleDemo/libs/keygo-foreground.aar` 已存在
- [x ] **B2. build.gradle 已自动引用**
  `dependencies { implementation fileTree(dir:'libs', include:['*.aar','*.jar']) }` 会自动把 libs 下所有 aar 打进 APK
- [x ] **B3. AndroidManifest.xml 权限已齐**
  蓝牙(BLUETOOTH_SCAN/CONNECT)、位置(含 BACKGROUND)、前台服务(FOREGROUND_SERVICE + CONNECTED_DEVICE)、通知(POST_NOTIFICATIONS)、WAKE_LOCK、电池优化豁免 均已声明
- [x ] **B4. aar 自带 Service 声明**
  `KeygoBleScanService` 在 aar 内部 AndroidManifest 中声明，构建时由 manifest-merge 合并进最终 APK（无需在主 manifest 重复写）

**还差的一步（必做，否则 JS 端 `uni.requireNativePlugin('Keygo-Foreground')` 返回 null）**：

- [ ] **B5. 创建插件声明文件 `dcloud_uniplugins.json`**
  - 路径：`simpleDemo/src/main/assets/dcloud_uniplugins.json`
  - 内容：
    ```json
    {
      "nativePlugins": [
        {
          "plugins": [
            {
              "type": "module",
              "name": "Keygo-Foreground",
              "class": "com.keygo.foreground.KeygoForegroundModule"
            }
          ]
        }
      ]
    }
    ```
  - 改完后再走 **A4（Clean + Rebuild）**
- [ ] **B6. 验证插件生效**
  - 运行后，DEV 调试面板里的「前台服务」应显示「原生」；或在手机上锁屏后观察是否能后台重连
  - 若仍为 null：检查 aar 是否真打进 APK（`Build` → `Analyze APK` 看 `classes.dex`/libs 是否含 `com.keygo.foreground`）

---

## Part C —— "改了代码却看不到修复" 排查表（针对本次现象）

现象：标准基座能看到「繁忙(CONFLICT/TOO_FAST)」「DEV调试」，但 AS 离线包看不到。

排查顺序：
- [ ] **C1. 资源是否真的新？**
  在 `simpleDemo/src/main/assets/apps/__UNI__35B0789/www/app-service.js` 里搜 `指令冲突` / `DebugFloatPanel`。
  - 搜得到 → 资源是新的，问题在构建环节（跳 C2）
  - 搜不到 → 资源是旧的，回到 **A1~A2** 重新导出覆盖
- [ ] **C2. 是否 Clean + Rebuild 了？**
  AS 增量编译极易复用 `build/intermediates/assets/` 旧缓存。务必 `Clean Project` 再 `Rebuild`。
- [ ] **C3. 手机上是不是旧 APK？**
  卸载重装，或确认 Run 的是刚构建的 variant。
- [ ] **C4. appid 是否三位一致？**
  `dcloud_control.xml` / `manifest.json` / 资源目录名 不一致会导致加载错资源。

> 本次（2026-07-09）核查结果：C1 已搜到修复代码、appid 一致 → 根因落在 **C2/C3（构建缓存 / 旧 APK）**，与资源内容无关。

---

## 常见坑速查

- **改了前端但离线包没变** → 没走 A1~A2，或没 Clean（A4）。
- **原生前台服务不工作 / requireNativePlugin 返回 null** → 缺 B5 的 `dcloud_uniplugins.json`。
- **标准基座能跑、离线包崩** → 多半是 nativeplugins 没集成（标准基座不含你的自定义 aar）。
- **云打包次数满** → 离线打包可临时验证，但要记得走 A1~A2 覆盖最新资源，否则离线包也会"看不到修复"。
- **`.hbuilderx/launch.json` 被 IDE 改动** → 本地文件，勿提交；如需忽略加到 `.gitignore`。
