/*
 * ============================================================
 *  BLE车钥匙舒适进入系统 - ESP32-C3 面包板验证版 v1.1
 *  BLE Passive Entry System - ESP32-C3 Prototype v1.1
 * ============================================================
 *
 *  v1.1 更新内容：
 *    - 加快扫描响应（0.5秒/次，间隔100ms）
 *    - 加入RSSI滑动平均滤波（5次窗口）
 *    - 修复手机消失不锁车的bug
 *    - 修复超时锁车bug（手机在附近自动重置计时）
 *    - 减少连续判定次数，响应更快
 *    - 修复解锁序列步骤编号注释
 *
 * 【硬件接线图】
 *
 *   ESP32-C3 开发板                    MOS + 车钥匙
 *  ┌──────────────┐                  ┌──────────────────────┐
 *  │          GPIO2├────────────────→│ N-MOS1 Gate → 解锁键  │
 *  │          GPIO3├────────────────→│ N-MOS2 Gate → 锁车键  │
 *  │          GPIO4├────────────────→│ N-MOS3 Gate → 后备箱  │
 *  │          GPIO5├────────────────→│ P-MOS  Gate → 钥匙VCC │
 *  │          GPIO8├──→ LED状态指示   │                      │
 *  │           GND ├────────────────→│ MOS公共源极(GND)      │
 *  │           3.3V├────────────────→│ P-MOS源极(3.3V→钥匙) │
 *  └──────────────┘                  └──────────────────────┘
 *
 *  N-MOS接线（以解锁键为例）：
 *    GPIO2 ──→ [100Ω] ──→ Gate
 *    10kΩ下拉: Gate ──→ GND（防止GPIO浮空时误触发）
 *    Drain ──→ 钥匙解锁键信号端
 *    Source ──→ GND
 *    MOS导通 = 按键信号端被拉到GND = 等效按下按键
 *
 *  P-MOS接线（钥匙供电控制）：
 *    GPIO5 ──→ [100Ω] ──→ Gate
 *    10kΩ上拉: Gate ──→ 3.3V（默认关断，钥匙断电）
 *    Source ──→ 3.3V
 *    Drain ──→ 钥匙VCC
 *    GPIO5 = LOW → Vgs=-3.3V → 导通 → 钥匙上电
 *    GPIO5 = HIGH → Vgs=0V   → 关断 → 钥匙断电
 *
 * 【工作原理】
 *   1. ESP32-C3持续扫描BLE广播，寻找绑定手机的MAC地址
 *   2. 找到后读取RSSI（信号强度），滑动平均滤波后判断距离
 *   3. RSSI > 解锁阈值 且持续N次 → 自动解锁
 *   4. RSSI < 锁车阈值 或手机消失 且持续M次 → 自动锁车
 *   5. 两阈值之间有"死区"，防止在边界距离反复触发
 *
 * 【串口命令】115200bps
 *   help           - 显示帮助
 *   status         - 显示系统状态
 *   scan           - 扫描附近BLE设备（5秒）
 *   pair MAC       - 绑定手机MAC，如 pair AA:BB:CC:DD:EE:FF
 *   pairname 名称  - 按蓝牙名称绑定（iOS随机MAC时用这个）
 *   unpair         - 解除绑定
 *   unlock         - 手动解锁
 *   lock           - 手动锁车
 *   trunk          - 手动开后备箱
 *   rssi           - 开关RSSI实时显示
 *   thresh 解锁 锁车 - 修改阈值，如 thresh -55 -75
 *
 * 【开发环境】
 *   Arduino IDE → 板卡管理器安装 "esp32 by Espressif"
 *   开发板选择: "ESP32C3 Dev Module"
 *   BLE库已内置，无需额外安装
 *
 * 【iOS注意】
 *   iOS使用随机MAC地址（每15分钟更换），无法用MAC绑定！
 *   请用 pairname 命令按蓝牙名称绑定，或等二期微信小程序
 */

#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>

// ================================================================
//  第一部分：引脚定义
//  ESP32-C3可用GPIO: 0-10, 12-21（部分被Flash占用）
//  安全选择: GPIO2-5做控制, GPIO8做板载LED
//  注意: GPIO11被Flash占用, GPIO12-17一般也被Flash占用
//  注意: GPIO0/1有Strap功能(启动模式选择), 建议不用
// ================================================================

#define PIN_UNLOCK      2   // N-MOS1: 解锁键控制
#define PIN_LOCK        3   // N-MOS2: 锁车键控制
#define PIN_TRUNK       4   // N-MOS3: 后备箱键控制
#define PIN_KEY_POWER   5   // P-MOS:  钥匙供电控制（高端开关）
#define PIN_LED         8   // 板载LED（不同开发板可能不同，看板子丝印）

// ================================================================
//  第二部分：MOS控制逻辑
//
//  N-MOS（控制按键）：
//    高电平(HIGH) → Vgs > 阈值 → 导通 → 按键信号端拉到GND → 等效按下
//    低电平(LOW)  → Vgs = 0   → 关断 → 按键断开 → 等效松开
//
//  P-MOS（控制供电）：
//    低电平(LOW)  → Vgs = -3.3V → 导通 → 3.3V→钥匙VCC → 钥匙上电
//    高电平(HIGH) → Vgs = 0V    → 关断 → 钥匙断电
// ================================================================

#define NMOS_ON    HIGH   // N-MOS导通 = GPIO高电平
#define NMOS_OFF   LOW    // N-MOS关断 = GPIO低电平
#define PMOS_ON    LOW    // P-MOS导通 = GPIO低电平
#define PMOS_OFF   HIGH   // P-MOS关断 = GPIO高电平

// ================================================================
//  第三部分：RSSI阈值与算法参数（可运行时修改）
//
//  RSSI = Received Signal Strength Indicator（接收信号强度指示）
//  单位dBm，数值越大信号越强（注意是负数，-50比-70强）
//  大致对应关系（车内环境，仅供参考）：
//    -40 dBm ≈ 手机贴着天线
//    -50 dBm ≈ 0.5米
//    -60 dBm ≈ 1-2米
//    -70 dBm ≈ 3-5米
//    -80 dBm ≈ 5-8米
//    -90 dBm ≈ 10米+
//
//  双阈值滞后原理：
//    解锁阈值(-60) > 锁车阈值(-70)，中间10dBm是"死区"
//    手机靠近：RSSI必须升到-60以上才解锁
//    手机远离：RSSI必须降到-70以下才锁车
//    死区内不动作 → 防止边界抖动反复触发
// ================================================================

int rssiUnlockThreshold = -60;    // 解锁阈值(dBm): RSSI高于此值=手机靠近
int rssiLockThreshold   = -70;    // 锁车阈值(dBm): RSSI低于此值=手机远离
int unlockCountRequired = 3;      // 连续N次RSSI超解锁阈值才触发（防误触）
int lockCountRequired   = 5;      // 连续M次RSSI低于锁车阈值才触发（防误锁）
                                   // 锁车要求更多次 → 宁可慢锁不愿误锁
int scanTimeSeconds     = 1;      // 每次BLE扫描持续时间（秒），越快响应越及时
int scanIntervalMs      = 100;    // 两次扫描间隔（毫秒）
int autoLockTimeoutS    = 120;    // 解锁后多久没动就自动锁车（秒），手机在附近会重置

// ================================================================
//  第三点五部分：RSSI滑动平均滤波
//
//  为什么需要滤波？
//    BLE RSSI波动非常大，同一位置可能在±5~10dBm之间跳
//    直接用原始值判断，计数器会频繁归零，响应变慢且不稳定
//
//  滑动平均原理：
//    保存最近N次RSSI采样，取平均值作为判断依据
//    新数据进来，最老的数据出去 → 像一个滑动的窗口
//    窗口越大越稳定，但响应越慢；窗口越小越灵敏，但容易误触
//    5次窗口是一个比较平衡的选择
// ================================================================

#define RSSI_FILTER_WINDOW  5      // RSSI滑动平均窗口大小
int  rssiBuffer[RSSI_FILTER_WINDOW];  // 缓存最近N次RSSI
int  rssiBufferIndex = 0;       // 当前写入位置
int  rssiBufferCount = 0;       // 已缓存的有效数据量（刚开机时不满）
int  filteredRSSI = -999;       // 滤波后的RSSI值

// ================================================================
//  第四部分：按键时序参数
//
//  原车钥匙内部有一个MCU芯片，它的工作流程是：
//  1. 上电 → 内部初始化（约50-200ms）
//  2. 检测到按键 → 编码滚动码 → 调制433MHz信号 → 发射
//  3. 发射完成后才能断电
//  如果时序不对，钥匙MCU还没初始化就触发按键=白按
// ================================================================

int keyPowerUpDelayMs   = 200;    // 钥匙上电后等MCU初始化(ms)
int keyPressDurationMs  = 150;    // 模拟按压时长(ms)
int keyReleaseDelayMs   = 500;    // 释放后等RF发射完成(ms)

// ================================================================
//  第五部分：系统状态定义
//
//  状态机是整个系统的核心大脑，它决定"当前该做什么"
//
//  状态转换图：
//
//    LOCKED ──RSSI>阈值×N次──→ UNLOCKING ──时序完成──→ UNLOCKED
//      ↑                                                  │
//      │                                                  │
//    LOCKING ←──时序完成─── RSSI<阈值×M次 ──────────────┘
//                    或手机消失×M次
//
//    任何时候都可以通过串口命令手动触发 unlock / lock
// ================================================================

enum SystemState {
    STATE_LOCKED,       // 已锁车，持续扫描等待手机靠近
    STATE_UNLOCKING,    // 正在执行解锁按键时序
    STATE_UNLOCKED,     // 已解锁，持续扫描等待手机远离
    STATE_LOCKING       // 正在执行锁车按键时序
};

// ================================================================
//  第六部分：全局变量
// ================================================================

// --- 绑定信息 ---
String pairedMacAddress  = "";     // 绑定的手机MAC地址
String pairedDeviceName  = "";     // 绑定的手机蓝牙名称（iOS备用）
bool   useNameMatching   = false;  // 是否使用名称匹配模式

// --- 状态机 ---
SystemState currentState = STATE_LOCKED;
int unlockCounter = 0;             // 解锁计数器
int lockCounter   = 0;             // 锁车计数器

// --- RSSI数据 ---
int  lastRSSI         = -999;      // 最近一次测量到的RSSI（原始值）
bool phoneFoundThisScan = false;   // 本次扫描是否找到了手机

// --- 超时计时 ---
unsigned long lastSeenTimestamp = 0;  // 最后一次看到手机的时间戳

// --- BLE扫描 ---
BLEScan* pBLEScan = nullptr;

// --- 调试开关 ---
bool rssiDisplayMode = false;      // RSSI实时串口输出

// ================================================================
//  第七部分：BLE扫描回调
//
//  当ESP32扫描到附近任何一个BLE设备时，就会调用这个函数
//  我们在这里判断：这个设备是不是我们绑定的手机？
//  如果是，就记录它的RSSI信号强度
// ================================================================

class MyAdvertisedDeviceCallbacks : public BLEAdvertisedDeviceCallbacks {
    void onResult(BLEAdvertisedDevice advertisedDevice) override {
        
        // 获取扫描到的设备MAC地址，统一转大写方便比较
        String deviceMac = advertisedDevice.getAddress().toString().c_str();
        deviceMac.toUpperCase();

        bool matched = false;

        // 匹配方式1：按MAC地址匹配（推荐，Android手机用这个）
        if (!useNameMatching && pairedMacAddress.length() > 0) {
            String targetMac = pairedMacAddress;
            targetMac.toUpperCase();
            if (deviceMac == targetMac) {
                matched = true;
            }
        }

        // 匹配方式2：按蓝牙设备名称匹配（iOS随机MAC时用这个）
        if (useNameMatching && pairedDeviceName.length() > 0) {
            if (advertisedDevice.haveName()) {
                String deviceName = advertisedDevice.getName().c_str();
                if (deviceName.indexOf(pairedDeviceName) >= 0) {
                    matched = true;
                }
            }
        }

        // 匹配成功！记录RSSI
        if (matched) {
            lastRSSI = advertisedDevice.getRSSI();
            phoneFoundThisScan = true;

            // 实时显示模式（调试用）
            if (rssiDisplayMode) {
                Serial.printf("[RSSI] 原始:%d  滤波:%d  状态:%s\n",
                    lastRSSI, filteredRSSI,
                    currentState == STATE_LOCKED ? "🔒已锁" :
                    currentState == STATE_UNLOCKED ? "🔓已解" : "⏳动作中");
            }
        }
    }
};

// ================================================================
//  第八部分：函数声明（告诉编译器这些函数存在）
// ================================================================

void executeUnlockSequence();
void executeLockSequence();
void executeTrunkSequence();
void processStateMachine();
void handleSerialCommand();
void startBLEScan();
void updateLED();
void printStatus();
void printHelp();
void scanNearbyDevices();
void updateRssiFilter(int newRssi);
void resetRssiFilter();

// ================================================================
//  第九部分：setup() - Arduino初始化，只执行一次
// ================================================================

void setup() {
    // --- 初始化串口 ---
    Serial.begin(115200);
    delay(1000);  // 等串口就绪
    Serial.println();
    Serial.println("╔══════════════════════════════════════════╗");
    Serial.println("║   BLE车钥匙舒适进入系统 v1.1             ║");
    Serial.println("║   ESP32-C3 面包板验证版                  ║");
    Serial.println("╚══════════════════════════════════════════╝");
    Serial.println();

    // --- 初始化GPIO ---
    pinMode(PIN_UNLOCK, OUTPUT);
    pinMode(PIN_LOCK, OUTPUT);
    pinMode(PIN_TRUNK, OUTPUT);
    pinMode(PIN_KEY_POWER, OUTPUT);
    pinMode(PIN_LED, OUTPUT);

    // 初始状态：所有MOS关断，确保钥匙断电（安全第一！）
    digitalWrite(PIN_UNLOCK, NMOS_OFF);
    digitalWrite(PIN_LOCK, NMOS_OFF);
    digitalWrite(PIN_TRUNK, NMOS_OFF);
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);  // P-MOS关断 = 钥匙断电
    digitalWrite(PIN_LED, LOW);

    Serial.println("[INIT] ✅ GPIO初始化完成，所有MOS关断，钥匙断电");

    // --- 初始化RSSI滤波缓冲区 ---
    resetRssiFilter();

    // --- 初始化BLE ---
    BLEDevice::init("BLE-Key-Go");  // 本设备的蓝牙名称

    // 创建扫描对象并设置参数
    pBLEScan = BLEDevice::getScan();
    pBLEScan->setAdvertisedDeviceCallbacks(new MyAdvertisedDeviceCallbacks());

    // 主动扫描 = 发送SCAN REQUEST → 设备回复SCAN RESPONSE
    // 主动扫描的RSSI更准确，但功耗略高（对电池供电无所谓）
    pBLEScan->setActiveScan(true);

    // 扫描间隔和窗口：
    //   interval = 多久发起一次扫描请求
    //   window   = 每次扫描持续多久
    pBLEScan->setInterval(100);   // 100ms间隔
    pBLEScan->setWindow(99);      // 99ms窗口（几乎100%时间在扫描）

    Serial.println("[INIT] ✅ BLE初始化完成，设备名: BLE-Key-Go");
    Serial.println();

    // --- 显示帮助 ---
    printHelp();
    Serial.println();
    Serial.println(">>> 第一步：输入 scan 扫描附近BLE设备 <<<");
    Serial.println();
}

// ================================================================
//  第十部分：loop() - Arduino主循环，反复执行
//
//  主循环流程：
//  ┌──────────────────────────────────┐
//  │ 1. 处理串口命令                   │
//  │ 2. 已绑定？→ BLE扫描+RSSI滤波    │
//  │ 3. 状态机判断                     │
//  │ 4. 已解锁？→ 检查超时             │
//  │ 5. 更新LED指示                   │
//  │ 6. 延时（控制扫描频率）           │
//  └──────────────────────────────────┘
// ================================================================

void loop() {
    // 第1步：处理串口命令（非阻塞，有数据才处理）
    handleSerialCommand();

    // 第2步：如果已绑定手机，执行BLE扫描并处理状态机
    if (pairedMacAddress.length() > 0 || pairedDeviceName.length() > 0) {
        // 本次扫描前，先标记"还没找到手机"
        phoneFoundThisScan = false;

        // 执行BLE扫描（阻塞scanTimeSeconds秒，扫描期间回调函数会被触发）
        startBLEScan();

        // 本次扫描结束后，更新RSSI滤波器
        if (phoneFoundThisScan) {
            // 找到了手机 → 把新RSSI加入滤波窗口
            updateRssiFilter(lastRSSI);
            lastSeenTimestamp = millis();  // 更新"最后见到手机"的时间
        } else {
            // 没找到手机 → RSSI视为很差（比锁车阈值还低很多）
            // 这样手机走出范围后，计数器会正常累加，最终触发锁车
            updateRssiFilter(-999);
        }

        // 根据滤波后的RSSI值更新状态机
        processStateMachine();
    }

    // 第3步：超时自动锁车保护
    // 改进：只有当手机真的消失了（很久没见到）才超时锁车
    // 如果手机一直在附近（RSSI很好），就重置计时器，不锁车
    if (currentState == STATE_UNLOCKED && autoLockTimeoutS > 0) {
        unsigned long elapsedSinceSeen = (millis() - lastSeenTimestamp) / 1000;
        if (elapsedSinceSeen >= (unsigned long)autoLockTimeoutS) {
            Serial.println("[SAFETY] ⚠️ 手机长时间未检测到，自动锁车保护！");
            executeLockSequence();
            currentState = STATE_LOCKED;
            resetRssiFilter();
        }
    }

    // 第4步：更新LED状态指示
    updateLED();

    // 第5步：扫描间隔
    delay(scanIntervalMs);
}

// ================================================================
//  第十一部分：BLE扫描执行
// ================================================================

void startBLEScan() {
    // start(持续时间, 是否继续扫描)
    // false = 扫描完指定时间后自动停止
    // 扫描期间，MyAdvertisedDeviceCallbacks的onResult会被调用
    pBLEScan->start(scanTimeSeconds, false);

    // 清除缓存，释放内存
    // 不清除的话，每次扫描结果会累积，最终内存溢出！
    pBLEScan->clearResults();
}

// ================================================================
//  第十一点五部分：RSSI滑动平均滤波
//
//  核心思想：最近N次RSSI取平均值，平滑掉随机抖动
//
//  实现方式：环形缓冲区（Ring Buffer）
//    - 一个固定大小的数组 rssiBuffer
//    - 一个写入位置指针 rssiBufferIndex
//    - 新数据写到当前位置，指针+1，到末尾就绕回开头
//    - 这样最老的数据会被最新的数据覆盖
//
//  特殊处理：
//    - 手机消失时，RSSI设为-999
//    - 但-999会把平均值拉得很低，导致误判
//    - 所以：手机消失时我们直接用-999作为"滤波值"
//           手机存在时才用滑动平均
// ================================================================

void updateRssiFilter(int newRssi) {
    // 如果手机消失了（newRssi == -999），直接把滤波值设为无效
    if (newRssi == -999) {
        filteredRSSI = -999;
        // 不清空缓冲区，手机重新出现时可以快速恢复
        return;
    }

    // 把新数据写入缓冲区当前位置
    rssiBuffer[rssiBufferIndex] = newRssi;
    rssiBufferIndex = (rssiBufferIndex + 1) % RSSI_FILTER_WINDOW;

    // 记录有效数据量（刚开机时缓冲区还没填满）
    if (rssiBufferCount < RSSI_FILTER_WINDOW) {
        rssiBufferCount++;
    }

    // 计算平均值
    int sum = 0;
    for (int i = 0; i < rssiBufferCount; i++) {
        sum += rssiBuffer[i];
    }
    filteredRSSI = sum / rssiBufferCount;
}

void resetRssiFilter() {
    for (int i = 0; i < RSSI_FILTER_WINDOW; i++) {
        rssiBuffer[i] = -999;
    }
    rssiBufferIndex = 0;
    rssiBufferCount = 0;
    filteredRSSI = -999;
}

// ================================================================
//  第十二部分：状态机核心逻辑
//
//  这是整个系统的"大脑"，决定什么时候解锁、什么时候锁车
//
//  关键设计思想：
//  1. 计数器机制：不是一次RSSI超阈值就触发，而是连续N次
//     → 相当于"滑动窗口"滤波，过滤掉RSSI的随机波动
//  2. 计数器归零：一旦出现不满足条件的RSSI，计数器清零
//     → 必须"连续"满足，中间断一次就重来
//  3. 解锁3次 vs 锁车5次：锁车更谨慎
//     → 宁可晚点锁，也不要在你还在车旁时误锁
//  4. 手机消失也计入远离：走出扫描范围也要能锁车
// ================================================================

void processStateMachine() {
    switch (currentState) {

        // ---- 已锁车状态：等待手机靠近 ----
        case STATE_LOCKED:
            // 只有检测到手机（filteredRSSI有效）且超过解锁阈值，才计数
            if (filteredRSSI != -999 && filteredRSSI >= rssiUnlockThreshold) {
                // RSSI超过解锁阈值，计数+1
                unlockCounter++;
                if (unlockCounter >= unlockCountRequired) {
                    Serial.printf("[STATE] 🔓 RSSI连续%d次≥%ddBm，触发解锁！\n",
                        unlockCountRequired, rssiUnlockThreshold);
                    currentState = STATE_UNLOCKING;
                } else if (unlockCounter == 1) {
                    // 第一次检测到，提示一下
                    Serial.printf("[STATE] 📡 检测到手机靠近 滤波RSSI=%d (%d/%d)\n",
                        filteredRSSI, unlockCounter, unlockCountRequired);
                }
            } else {
                // RSSI不够或没检测到，计数器归零
                if (unlockCounter > 0) {
                    Serial.printf("[STATE] 滤波RSSI=%d 未达阈值，计数归零\n", filteredRSSI);
                }
                unlockCounter = 0;
            }
            break;

        // ---- 解锁执行中 ----
        case STATE_UNLOCKING:
            executeUnlockSequence();
            currentState = STATE_UNLOCKED;
            lastSeenTimestamp = millis();  // 记录解锁时间（用于超时保护）
            unlockCounter = 0;
            lockCounter = 0;
            Serial.println("[STATE] ✅ 已切换到解锁状态");
            break;

        // ---- 已解锁状态：等待手机远离 ----
        case STATE_UNLOCKED:
            // 两种情况都算"远离"：
            //   1. 检测到手机，但RSSI低于锁车阈值
            //   2. 完全没检测到手机（filteredRSSI == -999）
            // 之前的bug：只判断了情况1，导致手机走出范围永远不锁车！
            if (filteredRSSI == -999 || filteredRSSI <= rssiLockThreshold) {
                // RSSI低于锁车阈值 或 手机消失，计数+1
                lockCounter++;
                if (lockCounter >= lockCountRequired) {
                    Serial.printf("[STATE] 🔒 手机远离/消失 连续%d次，触发锁车！\n",
                        lockCountRequired);
                    currentState = STATE_LOCKING;
                } else if (lockCounter == 1) {
                    Serial.printf("[STATE] 📡 检测到手机远离 滤波RSSI=%d (%d/%d)\n",
                        filteredRSSI, lockCounter, lockCountRequired);
                }
            } else {
                // RSSI还在死区内（手机在附近但不够近），归零
                if (lockCounter > 0) {
                    Serial.printf("[STATE] 滤波RSSI=%d 仍在范围内，锁车计数归零\n", filteredRSSI);
                }
                lockCounter = 0;
            }
            break;

        // ---- 锁车执行中 ----
        case STATE_LOCKING:
            executeLockSequence();
            currentState = STATE_LOCKED;
            unlockCounter = 0;
            lockCounter = 0;
            resetRssiFilter();
            Serial.println("[STATE] ✅ 已切换到锁车状态");
            break;
    }
}

// ================================================================
//  第十三部分：解锁时序
//
//  解锁时序图（总耗时约850ms）：
//
//  时间:  0ms      200ms     350ms           850ms
//         │         │         │               │
//  P-MOS: ┃━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┃  上电→断电
//         │         │         │               │
//  N-MOS: │         ┃━━━━━━━┃│               │  按下→释放
//         │         │ 150ms  │               │
//         │ 200ms   │        │    500ms       │
//         │ 等MCU   │        │  等RF发射      │
//
//  为什么是这个顺序？
//    1. 先给钥匙上电 → 钥匙MCU需要时间启动
//    2. 等MCU就绪 → 才能检测到按键
//    3. 按下150ms → 模拟人手按压的时长
//    4. 等RF发射 → 433MHz信号发完才能断电
//    5. 断电省电 → 不用时钥匙不耗电
// ================================================================

void executeUnlockSequence() {
    Serial.println("┌─────────────────────────────────┐");
    Serial.println("│  ▶▶▶ 执行解锁序列              │");
    Serial.println("└─────────────────────────────────┘");

    // 第1步：P-MOS导通，给钥匙供电
    digitalWrite(PIN_KEY_POWER, PMOS_ON);
    Serial.println("  [1/6] 🔑 钥匙上电 (P-MOS ON)");

    // 第2步：等待钥匙内部MCU初始化
    delay(keyPowerUpDelayMs);
    Serial.println("  [2/6] ⏳ 等待钥匙MCU初始化");

    // 第3步：模拟按下解锁键
    digitalWrite(PIN_UNLOCK, NMOS_ON);
    Serial.println("  [3/6] 👆 模拟按下解锁键");

    // 第4步：保持按压
    delay(keyPressDurationMs);
    Serial.println("  [4/6] ⏳ 保持按压");

    // 第5步：释放按键
    digitalWrite(PIN_UNLOCK, NMOS_OFF);
    Serial.println("  [5/6] ✋ 释放解锁键");

    // 第6步：等待RF信号发射完成
    delay(keyReleaseDelayMs);

    // 第7步：P-MOS关断，钥匙断电
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
    Serial.println("  [6/6] 💤 钥匙断电 (P-MOS OFF)");
    Serial.println("  ✅ 解锁序列完成！\n");
}

// ================================================================
//  第十四部分：锁车时序
//
//  和解锁完全相同，只是触发的按键从"解锁"换成"锁车"
// ================================================================

void executeLockSequence() {
    Serial.println("┌─────────────────────────────────┐");
    Serial.println("│  ◀◀◀ 执行锁车序列              │");
    Serial.println("└─────────────────────────────────┘");

    digitalWrite(PIN_KEY_POWER, PMOS_ON);
    Serial.println("  [1/6] 🔑 钥匙上电");
    delay(keyPowerUpDelayMs);

    digitalWrite(PIN_LOCK, NMOS_ON);
    Serial.println("  [2/6] 👆 模拟按下锁车键");
    delay(keyPressDurationMs);

    digitalWrite(PIN_LOCK, NMOS_OFF);
    Serial.println("  [3/6] ✋ 释放锁车键");
    delay(keyReleaseDelayMs);

    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
    Serial.println("  [4/6] 💤 钥匙断电");
    Serial.println("  ✅ 锁车序列完成！\n");
}

// ================================================================
//  第十五部分：后备箱时序（仅手动触发）
// ================================================================

void executeTrunkSequence() {
    Serial.println("┌─────────────────────────────────┐");
    Serial.println("│  🔧 执行后备箱序列              │");
    Serial.println("└─────────────────────────────────┘");

    digitalWrite(PIN_KEY_POWER, PMOS_ON);
    delay(keyPowerUpDelayMs);

    digitalWrite(PIN_TRUNK, NMOS_ON);
    Serial.println("  模拟按下后备箱键");
    delay(keyPressDurationMs);

    digitalWrite(PIN_TRUNK, NMOS_OFF);
    delay(keyReleaseDelayMs);

    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
    Serial.println("  ✅ 后备箱序列完成！\n");
}

// ================================================================
//  第十六部分：LED状态指示
//
//  不同闪烁模式让你一眼看出系统当前状态：
//    慢闪(2s周期) = 已锁车，待机中
//    常亮         = 已解锁
//    快闪(100ms)  = 正在执行解锁/锁车动作
// ================================================================

void updateLED() {
    static unsigned long lastBlink = 0;
    static bool ledState = false;

    switch (currentState) {
        case STATE_LOCKED:
            // 慢闪：每2秒切换一次
            if (millis() - lastBlink > 2000) {
                ledState = !ledState;
                digitalWrite(PIN_LED, ledState);
                lastBlink = millis();
            }
            break;

        case STATE_UNLOCKING:
        case STATE_LOCKING:
            // 快闪：每100ms切换一次
            if (millis() - lastBlink > 100) {
                ledState = !ledState;
                digitalWrite(PIN_LED, ledState);
                lastBlink = millis();
            }
            break;

        case STATE_UNLOCKED:
            // 常亮
            digitalWrite(PIN_LED, HIGH);
            break;
    }
}

// ================================================================
//  第十七部分：串口命令处理
// ================================================================

void handleSerialCommand() {
    if (!Serial.available()) return;

    // 读取一行命令（以换行符结尾）
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();  // 去掉首尾空格和换行

    if (cmd.length() == 0) return;

    // 保存原始输入（用于提取参数，区分大小写）
    String rawCmd = cmd;
    cmd.toUpperCase();  // 命令本身不区分大小写

    // ---------- help ----------
    if (cmd == "HELP") {
        printHelp();
    }
    // ---------- status ----------
    else if (cmd == "STATUS") {
        printStatus();
    }
    // ---------- scan ----------
    else if (cmd == "SCAN") {
        scanNearbyDevices();
    }
    // ---------- pair MAC地址 ----------
    else if (cmd.startsWith("PAIR ")) {
        String mac = rawCmd.substring(5);
        mac.trim();
        mac.toUpperCase();

        if (mac.length() == 17) {
            pairedMacAddress = mac;
            pairedDeviceName = "";
            useNameMatching = false;
            currentState = STATE_LOCKED;
            unlockCounter = 0;
            lockCounter = 0;
            resetRssiFilter();
            Serial.printf("[CONFIG] ✅ 已绑定手机MAC: %s\n", pairedMacAddress.c_str());
            Serial.println("[CONFIG] 系统开始扫描该手机的BLE信号...\n");
        } else {
            Serial.println("[ERROR] MAC格式错误！正确格式: AA:BB:CC:DD:EE:FF");
        }
    }
    // ---------- pairname 蓝牙名称 ----------
    else if (cmd.startsWith("PAIRNAME ")) {
        String name = rawCmd.substring(9);
        name.trim();

        if (name.length() > 0) {
            pairedDeviceName = name;
            pairedMacAddress = "";
            useNameMatching = true;
            currentState = STATE_LOCKED;
            unlockCounter = 0;
            lockCounter = 0;
            resetRssiFilter();
            Serial.printf("[CONFIG] ✅ 已绑定蓝牙名称: %s\n", pairedDeviceName.c_str());
            Serial.println("[CONFIG] 提示：iOS会随机更换MAC，名称匹配更稳定");
            Serial.println("[CONFIG] 系统开始扫描该手机的BLE信号...\n");
        } else {
            Serial.println("[ERROR] 名称不能为空！用法: pairname iPhone");
        }
    }
    // ---------- unpair ----------
    else if (cmd == "UNPAIR") {
        pairedMacAddress = "";
        pairedDeviceName = "";
        useNameMatching = false;
        currentState = STATE_LOCKED;
        unlockCounter = 0;
        lockCounter = 0;
        resetRssiFilter();
        Serial.println("[CONFIG] ✅ 已解除手机绑定\n");
    }
    // ---------- unlock ----------
    else if (cmd == "UNLOCK") {
        Serial.println("[MANUAL] 🔓 手动解锁");
        executeUnlockSequence();
        currentState = STATE_UNLOCKED;
        lastSeenTimestamp = millis();
    }
    // ---------- lock ----------
    else if (cmd == "LOCK") {
        Serial.println("[MANUAL] 🔒 手动锁车");
        executeLockSequence();
        currentState = STATE_LOCKED;
        resetRssiFilter();
    }
    // ---------- trunk ----------
    else if (cmd == "TRUNK") {
        Serial.println("[MANUAL] 🚗 手动开后备箱");
        executeTrunkSequence();
    }
    // ---------- rssi 开关 ----------
    else if (cmd == "RSSI") {
        rssiDisplayMode = !rssiDisplayMode;
        Serial.printf("[CONFIG] RSSI实时显示: %s\n",
            rssiDisplayMode ? "✅ 开启" : "❌ 关闭");
    }
    // ---------- thresh 修改阈值 ----------
    else if (cmd.startsWith("THRESH ")) {
        String params = cmd.substring(7);
        int spaceIdx = params.indexOf(' ');
        if (spaceIdx > 0) {
            int newUnlock = params.substring(0, spaceIdx).toInt();
            int newLock = params.substring(spaceIdx + 1).toInt();

            if (newUnlock > newLock) {
                rssiUnlockThreshold = newUnlock;
                rssiLockThreshold = newLock;
                Serial.printf("[CONFIG] ✅ 阈值已更新: 解锁=%d dBm, 锁车=%d dBm\n",
                    rssiUnlockThreshold, rssiLockThreshold);
            } else {
                Serial.println("[ERROR] 解锁阈值必须大于锁车阈值！");
                Serial.println("  例: thresh -55 -75 (解锁-55dBm, 锁车-75dBm)");
            }
        } else {
            Serial.printf("[CONFIG] 当前阈值: 解锁=%d dBm, 锁车=%d dBm\n",
                rssiUnlockThreshold, rssiLockThreshold);
            Serial.println("  修改用法: thresh 解锁阈值 锁车阈值");
            Serial.println("  例: thresh -55 -75");
        }
    }
    // ---------- 未知命令 ----------
    else {
        Serial.printf("[ERROR] 未知命令: %s\n", rawCmd.c_str());
        Serial.println("  输入 help 查看所有可用命令\n");
    }
}

// ================================================================
//  第十八部分：扫描附近BLE设备
//
//  这是一个独立于主循环的扫描功能
//  用于第一次配对时找到你手机的MAC地址或蓝牙名称
// ================================================================

void scanNearbyDevices() {
    Serial.println();
    Serial.println("┌──────────────────────────────────────────────┐");
    Serial.println("│  📡 扫描附近BLE设备（5秒）...                 │");
    Serial.println("└──────────────────────────────────────────────┘");
    Serial.println();

    // 用全局pBLEScan扫描（getScan()返回单例，不能重复创建）
    pBLEScan->stop();
    pBLEScan->clearResults();
    pBLEScan->setActiveScan(true);
    pBLEScan->start(5);  // 扫描5秒

    // 获取扫描结果
    int count = pBLEScan->getResults()->getCount();

    // 打印表头
    Serial.println("  序号  MAC地址              RSSI      设备名称");
    Serial.println("  ────  ───────────────────  ────────  ──────────");

    // 遍历所有发现的设备
    for (int i = 0; i < count; i++) {
        BLEAdvertisedDevice device = pBLEScan->getResults()->getDevice(i);
        String name = device.haveName() ? device.getName().c_str() : "(未命名)";
        String mac = device.getAddress().toString().c_str();
        mac.toUpperCase();

        Serial.printf("  %2d    %-20s  %4d dBm  %s\n",
            i + 1, mac.c_str(), device.getRSSI(), name.c_str());
    }

    Serial.println();
    Serial.printf("  共发现 %d 个BLE设备\n", count);
    Serial.println();
    Serial.println("  ┌────────────────────────────────────────────┐");
    Serial.println("  │ 找到你手机后：                              │");
    Serial.println("  │   Android: pair AA:BB:CC:DD:EE:FF          │");
    Serial.println("  │   iOS:     pairname 你iPhone的蓝牙名称       │");
    Serial.println("  └────────────────────────────────────────────┘");
    Serial.println();

    // 清除扫描结果，释放内存
    pBLEScan->clearResults();
}

// ================================================================
//  第十九部分：打印系统状态
// ================================================================

void printStatus() {
    Serial.println();
    Serial.println("╔══════════════════════════════════════════╗");
    Serial.println("║      BLE车钥匙舒适进入 - 系统状态         ║");
    Serial.println("╠══════════════════════════════════════════╣");

    // 绑定信息
    if (useNameMatching) {
        Serial.printf("║ 匹配模式: 蓝牙名称                       ║\n");
        Serial.printf("║ 绑定名称: %-30s║\n", pairedDeviceName.c_str());
    } else if (pairedMacAddress.length() > 0) {
        Serial.printf("║ 匹配模式: MAC地址                        ║\n");
        Serial.printf("║ 绑定MAC:  %-30s║\n", pairedMacAddress.c_str());
    } else {
        Serial.printf("║ 绑定状态: ❌ 未绑定                       ║\n");
    }

    // 当前状态
    const char* stateStr = "";
    const char* stateEmoji = "";
    switch (currentState) {
        case STATE_LOCKED:   stateStr = "已锁车"; stateEmoji = "🔒"; break;
        case STATE_UNLOCKING: stateStr = "解锁中"; stateEmoji = "🔓"; break;
        case STATE_UNLOCKED: stateStr = "已解锁"; stateEmoji = "🔓"; break;
        case STATE_LOCKING:  stateStr = "锁车中"; stateEmoji = "🔒"; break;
    }
    Serial.printf("║ 当前状态: %s %-25s║\n", stateEmoji, stateStr);

    // RSSI（原始值 + 滤波值）
    if (filteredRSSI > -999) {
        const char* dist = "";
        if (filteredRSSI >= -45) dist = "贴着/极近";
        else if (filteredRSSI >= -55) dist = "~0.5m";
        else if (filteredRSSI >= -65) dist = "~1-2m";
        else if (filteredRSSI >= -75) dist = "~3-5m";
        else dist = "~5m+";
        Serial.printf("║ 滤波RSSI: %4d dBm (%-18s)║\n", filteredRSSI, dist);
        if (lastRSSI > -999) {
            Serial.printf("║ 原始RSSI: %4d dBm                       ║\n", lastRSSI);
        }
    } else {
        Serial.printf("║ 最近RSSI: 未检测到                       ║\n");
    }

    // 计数器
    Serial.printf("║ 解锁计数: %2d / %-2d                         ║\n",
        unlockCounter, unlockCountRequired);
    Serial.printf("║ 锁车计数: %2d / %-2d                        ║\n",
        lockCounter, lockCountRequired);

    // 阈值
    Serial.printf("║ 解锁阈值: %d dBm                          ║\n", rssiUnlockThreshold);
    Serial.printf("║ 锁车阈值: %d dBm                          ║\n", rssiLockThreshold);
    Serial.printf("║ 死区宽度: %d dBm                          ║\n",
        rssiUnlockThreshold - rssiLockThreshold);

    // 最后见到手机的时间
    if (currentState == STATE_UNLOCKED && autoLockTimeoutS > 0) {
        unsigned long elapsed = (millis() - lastSeenTimestamp) / 1000;
        unsigned long remain = autoLockTimeoutS - elapsed;
        if (elapsed < (unsigned long)autoLockTimeoutS) {
            Serial.printf("║ 超时倒计: %lus / %us (最后见到手机%lus前)║\n",
                remain, autoLockTimeoutS, elapsed);
        } else {
            Serial.printf("║ 超时状态: 已超时 (最后见到手机%lus前)    ║\n", elapsed);
        }
    }

    Serial.println("╚══════════════════════════════════════════╝");
    Serial.println();
}

// ================================================================
//  第二十部分：打印帮助信息
// ================================================================

void printHelp() {
    Serial.println("╔══════════════════════════════════════════╗");
    Serial.println("║      BLE车钥匙舒适进入 - 命令帮助         ║");
    Serial.println("╠══════════════════════════════════════════╣");
    Serial.println("║                                          ║");
    Serial.println("║  scan              扫描附近BLE设备        ║");
    Serial.println("║  pair MAC          按MAC绑定手机          ║");
    Serial.println("║  pairname 名称     按蓝牙名绑定(iOS用)   ║");
    Serial.println("║  unpair            解除绑定               ║");
    Serial.println("║                                          ║");
    Serial.println("║  status            查看系统状态           ║");
    Serial.println("║  rssi              开关RSSI实时显示       ║");
    Serial.println("║  thresh 解锁 锁车  修改阈值               ║");
    Serial.println("║                                          ║");
    Serial.println("║  unlock            手动解锁               ║");
    Serial.println("║  lock              手动锁车               ║");
    Serial.println("║  trunk             手动开后备箱           ║");
    Serial.println("║                                          ║");
    Serial.println("║  help              显示本帮助             ║");
    Serial.println("║                                          ║");
    Serial.println("╚══════════════════════════════════════════╝");
    Serial.println();
    Serial.println("  快速上手步骤：");
    Serial.println("    1️⃣  打开手机蓝牙");
    Serial.println("    2️⃣  输入 scan 扫描附近设备");
    Serial.println("    3️⃣  找到手机后输入 pair AA:BB:CC:DD:EE:FF");
    Serial.println("    4️⃣  系统自动开始工作！");
    Serial.println("    5️⃣  输入 rssi 实时观察RSSI变化");
    Serial.println("    6️⃣  输入 thresh -55 -75 调整阈值");
}
