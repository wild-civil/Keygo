# BLE 广播修改模板

等你把官方 Peripheral 例程跑通后，照着这个文件改，就能把设备名和服务 UUID 改成 BLE-Key-Go 的样子。

---

## 要改的文件

官方例程里的：`APP/peripheral.c`

---

## 修改 1：设备名称

找到 `scanRspData` 数组，把设备名改成 "BLE-Key-Go"：

```c
// 改之前
static uint8_t scanRspData[] =
{
  // complete name
  0x12,   // length of this data
  GAP_ADTYPE_LOCAL_NAME_COMPLETE,
  'S','i','m','p','l','e',' ','P','e','r','i','p','h','e','r','a','l',
  // ... 后面还有
};

// 改之后
static uint8_t scanRspData[] =
{
  // complete name
  0x0A,   // length = 1(类型字节) + 9(名字长度) = 10 = 0x0A
  GAP_ADTYPE_LOCAL_NAME_COMPLETE,
  'B','L','E','-','K','e','y','-','G','o',
  // ... 后面保持不变
};
```

> 💡 **怎么算长度？**
> - 长度字节 = Type(1字节) + Data(N字节)
> - "BLE-Key-Go" 有 9 个字符，所以长度 = 1 + 9 = 10 = 0x0A

---

## 修改 2：服务 UUID（FF00）

找到 `advertData` 数组，把服务 UUID 改成我们的 FF00：

```c
// 改之前（官方例程用的是 Simple Profile 的 UUID）
static uint8_t advertData[] =
{
  0x02,   // length of this data
  GAP_ADTYPE_FLAGS,
  DEFAULT_DISCOVERABLE_MODE | GAP_ADTYPE_FLAGS_BREDR_NOT_SUPPORTED,

  0x03,   // length of this data
  GAP_ADTYPE_16BIT_MORE,
  LO_UINT16(SIMPLEPROFILE_SERV_UUID),
  HI_UINT16(SIMPLEPROFILE_SERV_UUID),
};

// 改之后（用我们的 0xFF00）
static uint8_t advertData[] =
{
  0x02,   // length of this data
  GAP_ADTYPE_FLAGS,
  DEFAULT_DISCOVERABLE_MODE | GAP_ADTYPE_FLAGS_BREDR_NOT_SUPPORTED,

  0x03,   // length of this data
  GAP_ADTYPE_16BIT_MORE,
  0x00,   // FF00 的低字节
  0xFF,   // FF00 的高字节
};
```

> 💡 **为什么是 0x00 在前，0xFF 在后？**
> BLE 是小端模式（Little Endian），低字节在前，高字节在后。
> 所以 0xFF00 存成 [0x00, 0xFF]。

---

## 修改 3：广播间隔（可选）

找到 `Peripheral_Init` 函数里的广播间隔设置，改成我们想要的：

```c
// 原来的（单位：0.625ms，160 = 100ms）
uint16_t initial_adv_interval = DEFAULT_ADVERTISING_INTERVAL;

// 改成 100ms（和 ESP32 版本一致）
// 100ms / 0.625ms = 160，所以就是 160
// 官方默认值一般就是 160，不用改也行
```

---

## 修改完之后

1. 按 `F7` 编译
2. 按 `F8` 烧录
3. 用手机 BLE 调试助手扫描
4. 你应该能看到：
   - 设备名：**BLE-Key-Go**
   - 服务 UUID：**FF00**

如果能看到，就说明广播部分搞定了！🎉

---

## 广播数据格式小科普

BLE 广播包是 **LTV 格式**，一段一段的：

```
[长度1][类型1][数据1...] [长度2][类型2][数据2...] ...
```

每一段的第一个字节是**长度**（包含类型字节，但不包含长度字节自己），第二个字节是**类型**，后面是**数据**。

常见类型：
| 类型值 | 名称 | 说明 |
|--------|------|------|
| 0x01 | Flags | 设备标志位（必须有） |
| 0x02/0x03 | 16-bit UUID | 服务 UUID 列表 |
| 0x09 | Complete Local Name | 完整设备名 |
| 0x0A | Tx Power Level | 发射功率 |

广播包最多 31 字节，扫描回复包也是最多 31 字节。
