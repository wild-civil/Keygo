# CH582M BLE 最简工程 - 使用说明

> 📁 工程位置：`CH582M_BLE_Simple/`

---

## 这个工程能做什么？

让 CH582M 开发板发送 BLE 广播，手机蓝牙能搜到名为 **"BLE-Key-Go"** 的设备。

---

## 使用方法（两种方式）

### 方式一：基于官方例程修改（推荐 ⭐）

适合不想折腾库文件的同学，代码量最少。

#### 第 1 步：下载官方 SDK

1. 去沁恒官网下载 CH58x EVT 包：
   - 地址：https://www.wch.cn/downloads/CH583EVT_ZIP.html
   - 或者搜 "CH582 EVT"

2. 解压后找到这个路径：
   ```
   CH583EVT/EVT/EXAM/BLE/Peripheral/
   ```

#### 第 2 步：复制官方例程

1. 把 `Peripheral` 文件夹**整个复制**到 `CH582M/` 下面
2. 重命名为 `CH582M_BLE_Simple`

#### 第 3 步：替换代码文件

把工程里的这些文件**删除**，然后把本工程 `src/` 下的对应文件复制进去：

| 删除这个文件 | 替换为本工程的 |
|-------------|---------------|
| `APP/peripheral.c` | `src/peripheral.c` |
| `APP/peripheral.h` | `src/CONFIG.h`（改名） |

#### 第 4 步：编译烧录

1. 用 MounRiver Studio 打开工程
2. `F7` 编译
3. `F8` 烧录
4. 手机搜蓝牙，看到 **"BLE-Key-Go"** 就成功了！

---

### 方式二：从零创建工程（需要手动配置）

适合想完全自己来的同学。

#### 第 1 步：下载 SDK 和 IDE

| 软件 | 下载地址 |
|------|---------|
| MounRiver Studio | http://www.mounriver.com/download |
| CH58x EVT (含BLE库) | https://www.wch.cn/downloads/CH583EVT_ZIP.html |

#### 第 2 步：安装 MounRiver Studio

一路下一步就行。

#### 第 3 步：从 SDK 复制文件

从官方 SDK 复制以下文件到工程目录：

```
需要的文件：
├── LIB/                    ← BLE 协议栈库（必须）
│   ├── CH58xBLE_LIB.a      ← BLE 库
│   ├── Bluetooth_LIB.a     ← 蓝牙通用库
│   └── USB_LIB.a           ← USB 库（可能不需要）
├── EVT/PUB/               ← 公共文件
│   ├── inc/                ← 头文件
│   │   ├── CH58xBLE_LIB.h
│   │   ├── CONFIG.h
│   │   ├── ble_state.h
│   │   ├── global_var.h
│   │   └── ...
│   └── src/
│       └── ...
└── 标准外设驱动            ← 串口、GPIO 等
    ├── StdPeriphDriver/
    └── ...
```

#### 第 4 步：创建 MounRiver 工程

在 MounRiver Studio 里：
1. `File` → `New` → `Project`
2. 选择 `CH58x` 系列
3. 选择芯片 `CH582M`
4. 创建空工程

#### 第 5 步：配置工程

1. 添加源文件到 `src/` 目录
2. 添加头文件路径：
   - `LIB/inc`
   - `EVT/PUB/inc`
   - `StdPeriphDriver/inc`
3. 链接 BLE 库文件：
   - 添加 `LIB/CH58xBLE_LIB.a`
   - 添加 `LIB/Bluetooth_LIB.a`

#### 第 6 步：复制源代码

把本工程的 `src/` 下的文件复制进去：
- `Main.c`
- `CONFIG.h`
- `peripheral.c`

#### 第 7 步：编译烧录

`F7` 编译，`F8` 烧录。

---

## 常见问题

### Q: 编译报错 "undefined reference to xxx"？

一般是没添加 BLE 库文件。请确认：
1. `LIB/CH58xBLE_LIB.a` 已添加
2. 头文件路径正确

### Q: 编译报错 "cannot open source file CH58xBLE_LIB.h"？

没添加头文件路径。在工程属性 → C/C++ General → Paths 中添加：
- `LIB/inc/`
- `EVT/PUB/inc/`

### Q: 手机搜不到设备？

1. 检查是否烧录成功
2. 检查代码有没有跑起来（串口打印）
3. 换个 BLE 调试 APP 试试

### Q: 设备名字不对？

检查 `scanRspData[]` 数组里长度字节和字符数是否匹配。

---

## 代码结构说明

| 文件 | 作用 |
|------|------|
| `Main.c` | 程序入口，初始化 BLE 协议栈 |
| `CONFIG.h` | 配置参数（设备名、UUID、间隔等） |
| `peripheral.c` | BLE 从机应用逻辑（广播、连接、服务） |

---

## 下一步

等你把这个最简工程跑通了，我们就可以：
1. 添加 GATT 服务（FF00）和特征值（FF01-FF04）
2. 实现数据收发
3. 添加配对绑定功能
4. 逐步移植完整的 BLE-Key-Go 逻辑

有问题随时问！
