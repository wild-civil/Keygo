/*
 * BLE-Key-Go v2.3 - PIN Security + Binding
 *
 * [新增] v2.3  vs  v2.2
 * ───────────────────────────────────────────────────────
 *   ● PIN 码安全：默认 123456，BIND 前必须验证 PIN（物理按键配对窗口除外）
 *   ● 修改 PIN：CHPIN:oldPin:newPin（需授权）
 *   ● Status JSON 新增字段：pin_ok, pin_default
 *   ● 恢复出厂：长按 PIN 9 同时清除 PIN 恢复为 123456
 *
 * [继承] v2.2 骨架
 * ───────────────────────────────────────────────────────
 *   ● 设备唯一名：KeyGo-<MAC后3字节hex>   ← 所有设备刷同一份固件
 *   ● 广播包：Service UUID + Manufacturer Data 双重标识
 *   ● MAC 白名单：首次连接自动绑定，之后仅允许已绑定设备连接
 *   ● 物理按键配对模式：PIN 9 短按 → 30s 窗口允许新设备绑定
 *   ● 恢复出厂：PIN 9 长按 5s → 清除所有绑定和配置
 *   ● FF03 新增命令：BIND / UNBIND
 *   ● Status JSON 新增字段：bound, deviceName
 *
 * [继承] v2.1 骨架
 * ───────────────────────────────────────────────────────
 *   ● 双栈 BLE（NimBLE + Bluedroid）
 *   ● RSSI 管线：尖峰丢弃 → 1D Kalman → 滞后状态机
 *   ● NOR Flash 持久化（Preferences NVS）
 *   ● 断连锁车 / 手动命令冷却
 *
 * 数据路径:
 *   raw RSSI → [spike reject: 连续N个离群才放行]
 *            → [Kalman filter: q=4 r=16]
 *            → [Hysteresis state machine: dead zone]
 *            → [key output pins]
 *
 * 连接安全:
 *   onConnect → 检查 NVS 是否有 bound_mac
 *            → 无：自动接受（首次使用 / 恢复出厂后）
 *            → 有：对比远端 MAC → 匹配则通过，不匹配则断开
 *            → 配对模式（按键触发）：临时放行任意 MAC，也可发 BIND 绑定
 */

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Preferences.h>
#include <esp_mac.h>  // ★ for esp_read_mac()

// ---- Determine BLE stack and include appropriate headers ----
#if defined(CONFIG_BLUEDROID_ENABLED)
  #include <esp_gap_ble_api.h>
  #define BLE_KEY_GO_HAS_NATIVE_RSSI   1
  #define BLE_KEY_GO_STACK_BLUEDROID   1
  #define BLE_KEY_GO_STACK_NIMBLE      0
#elif defined(CONFIG_NIMBLE_ENABLED)
  #define BLE_KEY_GO_HAS_NATIVE_RSSI   1
  #define BLE_KEY_GO_STACK_BLUEDROID   0
  #define BLE_KEY_GO_STACK_NIMBLE      1
#else
  #define BLE_KEY_GO_HAS_NATIVE_RSSI   0
  #define BLE_KEY_GO_STACK_BLUEDROID   0
  #define BLE_KEY_GO_STACK_NIMBLE      0
#endif

// ---------------- Pins ----------------
#define PIN_UNLOCK      2       // 解锁 NMOS/继电器
#define PIN_LOCK        3       // 锁车 NMOS/继电器
#define PIN_TRUNK       4       // 后备 NMOS/箱继电器
#define PIN_KEY_POWER   5       // 钥匙供电 PMOS/箱继电器
#define PIN_LED         8       // 状态指示灯
#define PIN_BIND        9       // 物理配对按键（低电平触发，需外部上拉）

#define NMOS_ON    HIGH
#define NMOS_OFF   LOW
#define PMOS_ON    LOW
#define PMOS_OFF   HIGH

// ---------------- BLE UUIDs ----------------
#define DEVICE_NAME_PREFIX  "KeyGo"              // 前缀，后接 MAC 后 3 字节构成唯一名
#define SERVICE_UUID        "0000ff00-0000-1000-8000-00805f9b34fb"
#define CONFIG_CHAR_UUID    "0000ff01-0000-1000-8000-00805f9b34fb"
#define STATUS_CHAR_UUID    "0000ff02-0000-1000-8000-00805f9b34fb"
#define COMMAND_CHAR_UUID   "0000ff03-0000-1000-8000-00805f9b34fb"
#define MANUFACTURER_ID     0xFFFF                    // 测试用厂商 ID（量产需注册 Bluetooth SIG 正式 ID）
#define MANUFACTURER_DATA   "KG"                      // KeyGo 产品标识

// ---------------- Tunable parameters ----------------
int rssiUnlockThreshold = -45;       // RSSI above this → candidate for unlock
int rssiLockThreshold = -65;         // RSSI below this → candidate for lock
int rssiHysteresisDb = 5;            // extra tightening when unlocked (effective lock = lock - hyst)
int rssiSpikeRejectDb = 25;          // drop raw samples that deviate > this from kalman (spike rejection)
int unlockCountRequired = 3;
int lockCountRequired = 5;
int rssiSampleIntervalMs = 500;
int disconnectLockDelayMs = 5000;

int keyPowerUpDelayMs = 200;
int keyPressDurationMs = 300;
int keyReleaseDelayMs = 500;

// ---------------- 1D Kalman filter for RSSI ----------------
float kf_q = 4.0f;               // process noise  — 越大跟踪越快（默认4）
float kf_r = 16.0f;              // measurement noise — 越大越平滑（默认16）
float kf_x = -999;               // state estimate
float kf_p = 1.0f;               // error covariance
bool  kf_initialized = false;

float filteredRSSI = -999;
int   latestRSSI = -999;

// Spike rejection
int spikeConsecutiveCount = 0;
int spikeConsecutiveRequired = 2;

// ---------------- Binding / Security ----------------
#define PAIRING_MODE_TIMEOUT_MS 30000  // 配对窗口 30 秒
#define FACTORY_RESET_HOLD_MS   5000   // 恢复出厂需長按 5 秒
#define MAC_ADDR_MAX_LEN        18     // "AA:BB:CC:DD:EE:FF\0"

// 被触发配对模式（按键）时的瞬时标记，持续 PAIRING_MODE_TIMEOUT_MS
bool    pairingModeActive = false;
unsigned long pairingModeStartMs = 0;

// 当前连接者是否已通过白名单校验
bool    connectionAuthorized = false;

// NVS 存储的已绑定 MAC（空字符串 → 未绑定）
String  bondedMac = "";

// ★ PIN 码安全
#define DEFAULT_PIN "123456"                         // 出厂默认 PIN
String  devicePin = DEFAULT_PIN;                     // 当前 PIN（从 NVS 加载）
bool    pinVerified = false;                         // 本次连接 PIN 已验证通过

// 设备唯一名，在 setup() 中根据 MAC 动态生成
char    deviceName[32];

// ---------------- State ----------------
enum KeyState {
    STATE_LOCKED,
    STATE_UNLOCKED,
    STATE_ACTION
};

KeyState currentState = STATE_LOCKED;
int unlockCounter = 0;
int lockCounter = 0;
bool deviceConnected = false;
bool rssiDisplayMode = true;

uint16_t connectionId = 0;
#if BLE_KEY_GO_STACK_BLUEDROID
esp_bd_addr_t connectedRemoteAddress = {0};
#endif
#if BLE_KEY_GO_STACK_NIMBLE
uint16_t nimbleConnHandle = 0;
#endif
unsigned long lastRssiReadMs = 0;
unsigned long lastStatusNotifyMs = 0;
unsigned long disconnectTimestampMs = 0;
unsigned long manualCommandTimestampMs = 0;
bool manualCommandCooldown = false;
#define MANUAL_COMMAND_COOLDOWN_MS 8000   // 手动命令后 8 秒状态机暂停
bool nativeRssiWarningPrinted = false;

// 按键去抖
unsigned long lastButtonCheckMs = 0;
#define BUTTON_DEBOUNCE_MS 50
bool lastButtonState = true;              // 上拉，默认高电平
unsigned long buttonPressStartMs = 0;     // 按下时刻

BLEServer* pServer = nullptr;
BLECharacteristic* pStatusCharacteristic = nullptr;
Preferences preferences;

// ---------------- Forward declarations ----------------
void executeUnlockSequence();
void executeLockSequence();
void executeTrunkSequence();
void processStateMachine();
void updateLED();
void handleSerialCommand();
void handleBindButton();                          // ★ 新增
void readConnectionRssi();
void updateKalmanFilter(int measurement);
void resetKalmanFilter();
void loadConfig();
void saveConfig();
void loadBondInfo();                              // ★ 新增
void saveBondInfo();                              // ★ 新增
void loadPin();                                   // ★ PIN 码加载
void savePin();                                   // ★ PIN 码保存
bool isDefaultPin();                              // ★ 是否出厂 PIN
void printStatus();
void printHelp();
void notifyStatus();
String stateToString();
String macToString(const uint8_t* mac, int len);  // ★ 新增
void startAdvertising();
bool parseConfigLine(String line);
bool isMacAuthorized(const uint8_t* mac, int len); // ★ 新增

// ---- Bluedroid GAP RSSI callback ----
#if BLE_KEY_GO_STACK_BLUEDROID
static void gapEventHandler(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t* param) {
    if (event != ESP_GAP_BLE_READ_RSSI_COMPLETE_EVT) return;

    if (param->read_rssi_cmpl.status == ESP_BT_STATUS_SUCCESS) {
        int8_t rssi = param->read_rssi_cmpl.rssi;
        latestRSSI = rssi;

        // Spike rejection
        bool spikeRejected = false;
        bool isSpike = kf_initialized && abs(rssi - (int)filteredRSSI) > rssiSpikeRejectDb;
        if (isSpike) {
            spikeConsecutiveCount++;
            if (spikeConsecutiveCount >= spikeConsecutiveRequired) {
                updateKalmanFilter(rssi);
                spikeConsecutiveCount = 0;
            } else {
                spikeRejected = true;
                kf_p = kf_p + kf_q * 2.0f;
            }
        } else {
            spikeConsecutiveCount = 0;
            updateKalmanFilter(rssi);
        }

        if (rssiDisplayMode) {
            Serial.printf("[RSSI] raw=%d filtered=%d state=%s%s\n",
                          latestRSSI, (int)filteredRSSI, stateToString().c_str(),
                          spikeRejected ? " (spike)" : "");
        }
    } else {
        Serial.printf("[RSSI] read failed, status=%d\n", param->read_rssi_cmpl.status);
    }
}
#endif

// ---- Server callbacks (dual-stack) ----
class ServerCallbacks : public BLEServerCallbacks {
#if BLE_KEY_GO_STACK_BLUEDROID
    void onConnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
        deviceConnected = true;
        connectionId = param->connect.conn_id;
        memcpy(connectedRemoteAddress, param->connect.remote_bda, sizeof(esp_bd_addr_t));

        // ★ 白名单校验
        connectionAuthorized = isMacAuthorized(param->connect.remote_bda, sizeof(esp_bd_addr_t));
        if (!connectionAuthorized) {
            Serial.printf("[SECURITY] unauthorized device connected: %s → will disconnect\n",
                          macToString(param->connect.remote_bda, sizeof(esp_bd_addr_t)).c_str());
            // 稍后在 loop() 中主动断开
        } else {
            Serial.printf("[BLE] phone connected (Bluedroid), conn_id=%u, addr=%s\n",
                          connectionId, macToString(param->connect.remote_bda, sizeof(esp_bd_addr_t)).c_str());
            Serial.printf("[SECURITY] authorized (bound device or pairing mode)\n");
        }

        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
    }

    void onDisconnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
        deviceConnected = false;
        connectionAuthorized = false;
        pinVerified = false;                         // ★ 清除 PIN 验证状态
        latestRSSI = -999;
        disconnectTimestampMs = millis();
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        Serial.println("[BLE] phone disconnected, advertising restarted");
        startAdvertising();
    }
#endif

#if BLE_KEY_GO_STACK_NIMBLE
    void onConnect(BLEServer* server, ble_gap_conn_desc* desc) override {
        deviceConnected = true;
        nimbleConnHandle = desc->conn_handle;
        connectionId = desc->conn_handle;

        // ★ 白名单校验
        // NimBLE 的 peer_id_addr 在 desc 中
        uint8_t* peerAddr = desc->peer_id_addr.val;
        connectionAuthorized = isMacAuthorized(peerAddr, 6);
        if (!connectionAuthorized) {
            Serial.printf("[SECURITY] unauthorized device connected: %s → will disconnect\n",
                          macToString(peerAddr, 6).c_str());
        } else {
            Serial.printf("[BLE] phone connected (NimBLE), conn_handle=%u, addr=%s\n",
                          nimbleConnHandle, macToString(peerAddr, 6).c_str());
            Serial.printf("[SECURITY] authorized (bound device or pairing mode)\n");
        }

        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
    }

    void onDisconnect(BLEServer* server, ble_gap_conn_desc* desc) override {
        deviceConnected = false;
        connectionAuthorized = false;
        pinVerified = false;                         // ★ 清除 PIN 验证状态
        latestRSSI = -999;
        nimbleConnHandle = 0;
        disconnectTimestampMs = millis();
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        Serial.println("[BLE] phone disconnected, advertising restarted");
        startAdvertising();
    }
#endif

#if !BLE_KEY_GO_STACK_BLUEDROID && !BLE_KEY_GO_STACK_NIMBLE
    void onConnect(BLEServer* server) override {
        deviceConnected = true;
        connectionAuthorized = true;  // 未识别栈 → 放宽检查
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        nativeRssiWarningPrinted = false;
        Serial.println("[BLE] phone connected (no native RSSI)");
        Serial.println("[BLE] write rssi=-50 to FF01 or serial cfg for logic test");
    }

    void onDisconnect(BLEServer* server) override {
        deviceConnected = false;
        connectionAuthorized = false;
        pinVerified = false;                         // ★ 清除 PIN 验证状态
        latestRSSI = -999;
        disconnectTimestampMs = millis();
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        Serial.println("[BLE] phone disconnected, advertising restarted");
        startAdvertising();
    }
#endif
};

class ConfigCallbacks : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* characteristic) override {
        if (!connectionAuthorized) {
            Serial.println("[SECURITY] config write rejected: not authorized");
            return;
        }
        String value = characteristic->getValue().c_str();
        value.trim();
        if (parseConfigLine(value)) {
            saveConfig();
            Serial.printf("[CONFIG] updated by BLE: %s\n", value.c_str());
            notifyStatus();
        } else {
            Serial.printf("[CONFIG] invalid BLE config: %s\n", value.c_str());
        }
    }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
public:  // ★ 供 serial 命令和 FF03 BLE 命令共同调用
    void onWrite(BLECharacteristic* characteristic) override {
        String cmd = characteristic->getValue().c_str();
        cmd.trim();
        String upper = cmd;
        upper.toUpperCase();

        // ★ BIND / UNBIND / PIN 不需要鉴权（用于首次绑定流程）
        if (upper == "BIND") {
            handleBindCommand();
            return;
        }
        if (upper == "UNBIND") {
            handleUnbindCommand();
            return;
        }
        // ★ PIN 验证命令（无需鉴权）
        if (upper.startsWith("PIN:")) {
            handlePinVerify(cmd.substring(4));
            return;
        }
        // ★ 修改 PIN（需鉴权，在下方鉴权检查后处理）

        // ★ 其余命令需鉴权
        if (!connectionAuthorized) {
            Serial.printf("[SECURITY] command '%s' rejected: not authorized\n", cmd.c_str());
            return;
        }

        // ★ 修改 PIN（需鉴权）: CHPIN:oldPin:newPin
        if (upper.startsWith("CHPIN:")) {
            handlePinChange(cmd.substring(6));
            return;
        }

        if (upper == "UNLOCK") {
            executeUnlockSequence();
            currentState = STATE_UNLOCKED;
            resetKalmanFilter();
            manualCommandTimestampMs = millis();
            manualCommandCooldown = true;
            Serial.println("[STATE] BLE manual unlock, RSSI state machine paused 8s");
        } else if (upper == "LOCK") {
            executeLockSequence();
            currentState = STATE_LOCKED;
            resetKalmanFilter();
            manualCommandTimestampMs = millis();
            manualCommandCooldown = true;
            Serial.println("[STATE] BLE manual lock, RSSI state machine paused 8s");
        } else if (upper == "TRUNK") {
            executeTrunkSequence();
        } else if (upper == "STATUS") {
            notifyStatus();
        } else {
            Serial.printf("[BLE] unknown command: %s\n", cmd.c_str());
        }
    }

    // ★ 处理 BIND 命令：将当前连接的设备 MAC 存入白名单
    //    ★ v2.3: BIND 需要 PIN 验证（物理按键配对的 30s 窗口除外）
    void handleBindCommand() {
        if (!deviceConnected) {
            Serial.println("[SECURITY] BIND failed: no device connected");
            return;
        }
        // 物理按键配对模式 → 跳过 PIN 验证（已通过物理接触授权）
        if (!pairingModeActive && !pinVerified) {
            Serial.println("[SECURITY] BIND rejected: PIN not verified. Send 'PIN:<code>' first.");
            return;
        }
        saveConnectedMac();
    }

    // ★ 处理 PIN 验证命令: "PIN:123456"
    void handlePinVerify(String enteredPin) {
        enteredPin.trim();
        if (enteredPin == devicePin) {
            pinVerified = true;
            Serial.println("[SECURITY] PIN verified OK");
        } else {
            pinVerified = false;
            Serial.printf("[SECURITY] PIN verification FAILED (entered: '%s')\n", enteredPin.c_str());
        }
        notifyStatus();
    }

    // ★ 处理修改 PIN 命令: "CHPIN:oldPin:newPin"
    void handlePinChange(String params) {
        params.trim();
        int colon = params.indexOf(':');
        if (colon < 1) {
            Serial.println("[SECURITY] CHPIN format: CHPIN:oldPin:newPin");
            return;
        }
        String oldPin = params.substring(0, colon);
        String newPin = params.substring(colon + 1);
        oldPin.trim();
        newPin.trim();

        if (oldPin != devicePin) {
            Serial.println("[SECURITY] PIN change failed: old PIN mismatch");
            return;
        }
        if (newPin.length() < 4 || newPin.length() > 16) {
            Serial.println("[SECURITY] PIN change failed: new PIN must be 4-16 characters");
            return;
        }

        devicePin = newPin;
        savePin();
        Serial.printf("[SECURITY] PIN changed successfully (is default: %s)\n",
                      isDefaultPin() ? "yes" : "no");
        notifyStatus();
    }

    // ★ 处理 UNBIND 命令：清除白名单
    void handleUnbindCommand() {
        if (!connectionAuthorized) {
            Serial.println("[SECURITY] UNBIND rejected: not authorized");
            return;
        }
        clearBondInfo();
        Serial.println("[SECURITY] UNBIND: all bindings cleared, device ready for new pairing");
        notifyStatus();
    }

    // ★ 保存当前连接设备的 MAC 为绑定设备
    void saveConnectedMac() {
        String newMac = "";

#if BLE_KEY_GO_STACK_BLUEDROID
        newMac = macToString(connectedRemoteAddress, 6);
#elif BLE_KEY_GO_STACK_NIMBLE
        // NimBLE: conn_handle 存在但无法通过公共 API 直接获取远端地址
        // 此处建议在 ServerCallbacks::onConnect 中保存地址
        Serial.println("[SECURITY] BIND: NimBLE binding requires manual address entry via serial");
        Serial.println("           Use serial command: cfg bound_mac=AA:BB:CC:DD:EE:FF");
        return;
#endif

        if (newMac.length() == 0 || newMac == "00:00:00:00:00:00") {
            Serial.println("[SECURITY] BIND failed: invalid MAC address");
            return;
        }

        bondedMac = newMac;
        saveBondInfo();
        connectionAuthorized = true;
        pairingModeActive = false;  // 绑定成功，关闭配对窗口

        Serial.printf("[SECURITY] BIND success: bound to %s\n", newMac.c_str());
        notifyStatus();
    }

    // ★ 清除所有绑定信息
    void clearBondInfo() {
        bondedMac = "";
        connectionAuthorized = false;
        saveBondInfo();
    }
};

// ---- GATT 回调实例（全局访问） ----
CommandCallbacks* g_commandCallbacks = nullptr;

void setup() {
    // ---- Early LED blink: confirm program is running ----
    pinMode(PIN_LED, OUTPUT);
    for (int i = 0; i < 3; i++) {
        digitalWrite(PIN_LED, HIGH);
        delay(150);
        digitalWrite(PIN_LED, LOW);
        delay(150);
    }

    // ---- Init bind button ----
    pinMode(PIN_BIND, INPUT_PULLUP);  // 默认高电平，按下为低

    Serial.begin(115200);
    Serial.setTimeout(50);
    delay(2000);  // ESP32-C3 USB CDC enumeration time

    // ---- Build unique device name ----
    // ★ esp_read_mac() 是 ESP32 Arduino 标准的 MAC 读取方法
    //    ESP_MAC_BT 读取蓝牙 MAC（WiFi 和 BT 通常共享同一 MAC，或 BT MAC = WiFi MAC + 1）
    uint8_t macBytes[6];
    esp_read_mac(macBytes, ESP_MAC_BT);
    snprintf(deviceName, sizeof(deviceName), "%s-%02X%02X%02X",
             DEVICE_NAME_PREFIX, macBytes[3], macBytes[4], macBytes[5]);

    // ---- Print banner ----
    Serial.println();
    Serial.println("============================================");
    Serial.println("  BLE-Key-Go v2.3 starting...");
    Serial.printf ("  Device: %s\n", deviceName);
    Serial.println("  PIN Security + Binding + MAC Whitelist");
    Serial.println("============================================");

    pinMode(PIN_UNLOCK, OUTPUT);
    pinMode(PIN_LOCK, OUTPUT);
    pinMode(PIN_TRUNK, OUTPUT);
    pinMode(PIN_KEY_POWER, OUTPUT);

    digitalWrite(PIN_UNLOCK, NMOS_OFF);
    digitalWrite(PIN_LOCK, NMOS_OFF);
    digitalWrite(PIN_TRUNK, NMOS_OFF);
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
    digitalWrite(PIN_LED, LOW);

    resetKalmanFilter();
    loadConfig();
    loadBondInfo();           // ★ 加载绑定信息
    loadPin();                // ★ 加载 PIN 码

    Serial.println();
    Serial.printf("==== BLE-Key-Go v2.3 | Device: %s ====\n", deviceName);
#if BLE_KEY_GO_STACK_BLUEDROID
    Serial.println("[BUILD] Stack: Bluedroid, Native RSSI: enabled (async)");
#elif BLE_KEY_GO_STACK_NIMBLE
    Serial.println("[BUILD] Stack: NimBLE, Native RSSI: enabled (sync)");
#else
    Serial.println("[BUILD] Stack: unknown, Native RSSI: unavailable (manual mode)");
#endif
    Serial.printf("[FILTER] Kalman q=%.1f r=%.1f, spike=%ddB, hyst=%ddB\n",
                  kf_q, kf_r, rssiSpikeRejectDb, rssiHysteresisDb);
    if (bondedMac.length() > 0) {
        Serial.printf("[SECURITY] Bound to: %s\n", bondedMac.c_str());
        Serial.println("[SECURITY] Press bind button (PIN 9) for 3s to enter pairing mode");
    } else {
        Serial.println("[SECURITY] NOT BOUND — first connection will auto-accept for binding");
        Serial.println("[SECURITY] BIND requires PIN verification (default: 123456)");
        Serial.println("[SECURITY] Send 'PIN:123456' via FF03 first, then 'BIND'");
    }
    printHelp();

    BLEDevice::init(deviceName);

#if BLE_KEY_GO_STACK_BLUEDROID
    BLEDevice::setCustomGapHandler(gapEventHandler);
#endif

    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());

    BLEService* service = pServer->createService(SERVICE_UUID);

    BLECharacteristic* configCharacteristic = service->createCharacteristic(
        CONFIG_CHAR_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    configCharacteristic->setCallbacks(new ConfigCallbacks());

    pStatusCharacteristic = service->createCharacteristic(
        STATUS_CHAR_UUID,
        BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
    );
    pStatusCharacteristic->addDescriptor(new BLE2902());

    BLECharacteristic* commandCharacteristic = service->createCharacteristic(
        COMMAND_CHAR_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    CommandCallbacks* cmdCb = new CommandCallbacks();
    g_commandCallbacks = cmdCb;  // 保存引用，供 serial 命令调用
    commandCharacteristic->setCallbacks(cmdCb);

    service->start();
    startAdvertising();
    notifyStatus();

    Serial.printf("[BLE] advertising as %s, service %s\n", deviceName, SERVICE_UUID);
}

void loop() {
    handleSerialCommand();
    handleBindButton();       // ★ 处理物理按键

    // ★ 安全：断开未授权连接
    if (deviceConnected && !connectionAuthorized) {
        // 给一个极短的稳定窗口（避免 onConnect 刚进来就立即断开）
        static unsigned long unauthConnectedAt = 0;
        if (unauthConnectedAt == 0) unauthConnectedAt = millis();
        if (millis() - unauthConnectedAt > 500) {
            Serial.println("[SECURITY] disconnecting unauthorized device");
            pServer->disconnect(connectionId);
            unauthConnectedAt = 0;
        }
    } else {
        // 复位计时器
        // (简化为不追踪，仅 500ms 窗口后断开)
    }

    // ★ 配对模式超时检测
    if (pairingModeActive && millis() - pairingModeStartMs >= PAIRING_MODE_TIMEOUT_MS) {
        pairingModeActive = false;
        Serial.println("[SECURITY] pairing mode timeout, whitelist restored");
        // 如果当前有未绑定的连接，立刻断开
        if (deviceConnected && !connectionAuthorized) {
            pServer->disconnect(connectionId);
        }
    }

    if (deviceConnected && connectionAuthorized &&
        millis() - lastRssiReadMs >= (unsigned long)rssiSampleIntervalMs) {
        lastRssiReadMs = millis();
        readConnectionRssi();
    }

    if (deviceConnected && connectionAuthorized) {
        processStateMachine();
    } else if (currentState == STATE_UNLOCKED && disconnectLockDelayMs > 0 &&
               millis() - disconnectTimestampMs >= (unsigned long)disconnectLockDelayMs) {
        Serial.println("[SAFETY] disconnected while unlocked, auto lock");
        currentState = STATE_ACTION;
        executeLockSequence();
        currentState = STATE_LOCKED;
        notifyStatus();
    }

    if (millis() - lastStatusNotifyMs >= 1000) {
        lastStatusNotifyMs = millis();
        notifyStatus();
    }

    updateLED();
    delay(20);
}

// ====================== Binding / Security ======================

/*
 * ★ 判断远端 MAC 是否被允许连接
 *
 * 放行条件（满足其一即可）：
 *   1. 未绑定（bondedMac 为空，首次使用） → 自动接受
 *   2. 配对模式激活中（pin 9 按键触发 30s 窗口） → 接受
 *   3. 远端 MAC 与 NVS 存储的 bondedMac 完全匹配 → 接受
 */
bool isMacAuthorized(const uint8_t* mac, int len) {
    if (bondedMac.length() == 0) {
        // 首次使用，自动允许
        return true;
    }
    if (pairingModeActive) {
        // 配对模式
        return true;
    }

    // 对比 MAC 字符串
    String remote = macToString(mac, len);
    if (remote.equalsIgnoreCase(bondedMac)) {
        return true;
    }

    Serial.printf("[SECURITY] denied: remote=%s, bonded=%s\n", remote.c_str(), bondedMac.c_str());
    return false;
}

/*
 * ★ MAC 转字符串 "AA:BB:CC:DD:EE:FF"
 */
String macToString(const uint8_t* mac, int len) {
    if (len < 1) return "??";
    char buf[MAC_ADDR_MAX_LEN];
    snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return String(buf);
}

/*
 * ★ 加载绑定信息
 */
void loadBondInfo() {
    bondedMac = preferences.getString("bonded_mac", "");
    if (bondedMac.length() > 0) {
        Serial.printf("[SECURITY] loaded bound MAC: %s\n", bondedMac.c_str());
    }
}

/*
 * ★ 保存绑定信息
 */
void saveBondInfo() {
    if (bondedMac.length() > 0) {
        preferences.putString("bonded_mac", bondedMac);
        Serial.printf("[SECURITY] saved bound MAC: %s\n", bondedMac.c_str());
    } else {
        preferences.remove("bonded_mac");
        Serial.println("[SECURITY] cleared bound MAC");
    }
}

/*
 * ★ 加载/保存/检查 PIN 码
 */
void loadPin() {
    devicePin = preferences.getString("device_pin", DEFAULT_PIN);
    Serial.printf("[SECURITY] PIN loaded (default: %s)
", isDefaultPin() ? "yes" : "no");
}

void savePin() {
    preferences.putString("device_pin", devicePin);
}

bool isDefaultPin() {
    return devicePin == DEFAULT_PIN;
}

/*
 * ★ 物理按键处理
 *
 * PIN 9, INPUT_PULLUP:
 *   - 短按（< 2s）：触发配对模式 30 秒   (LED 快闪)
 *   - 长按（> 5s）：恢复出厂设置         (LED 三闪后重启)
 *                  清除绑定信息 + 配置恢复默认
 */
void handleBindButton() {
    if (millis() - lastButtonCheckMs < BUTTON_DEBOUNCE_MS) return;
    lastButtonCheckMs = millis();

    bool currentState = digitalRead(PIN_BIND);  // HIGH=未按, LOW=按下

    // 按下沿
    if (lastButtonState == HIGH && currentState == LOW) {
        buttonPressStartMs = millis();
    }

    // 释放沿
    if (lastButtonState == LOW && currentState == HIGH) {
        unsigned long holdMs = millis() - buttonPressStartMs;
        if (holdMs >= FACTORY_RESET_HOLD_MS) {
            // ★ 长按 > 5s → 恢复出厂设置
            Serial.println("[FACTORY] RESET triggered — clearing all settings...");
            bondedMac = "";
            saveBondInfo();
            devicePin = DEFAULT_PIN;                  // ★ 恢复默认 PIN
            savePin();
            preferences.clear();  // 清除所有 NVS 配置
            // 重新写入默认 PIN（preferences.clear() 会清掉它）
            savePin();
            rssiUnlockThreshold = -45;
            rssiLockThreshold = -65;
            rssiHysteresisDb = 5;
            rssiSpikeRejectDb = 25;
            unlockCountRequired = 3;
            lockCountRequired = 5;
            rssiSampleIntervalMs = 500;
            disconnectLockDelayMs = 5000;
            kf_q = 4.0f;
            kf_r = 16.0f;
            pairingModeActive = false;
            connectionAuthorized = false;

            // LED 三闪
            for (int i = 0; i < 3; i++) {
                digitalWrite(PIN_LED, HIGH); delay(100);
                digitalWrite(PIN_LED, LOW);  delay(200);
            }
            Serial.println("[FACTORY] Reset complete. Restarting in 1s...");
            delay(1000);
            ESP.restart();
        } else if (holdMs > 200 && holdMs < 2000) {
            // ★ 短按 → 配对模式
            pairingModeActive = true;
            pairingModeStartMs = millis();
            Serial.printf("[SECURITY] pairing mode active for %d seconds\n",
                          PAIRING_MODE_TIMEOUT_MS / 1000);
            Serial.println("[SECURITY] any device may connect and send BIND now");
        }
    }

    lastButtonState = currentState;
}

// ====================== Advertising ======================

void startAdvertising() {
    BLEAdvertising* advertising = BLEDevice::getAdvertising();
    advertising->addServiceUUID(SERVICE_UUID);

    // ★ Manufacturer Data: 产品标识，App 可用于二次确认
    //    ESP32 Arduino BLE 库各版本 API 有差异，使用 BLEAdvertisementData 设置
    //    格式: 2 字节厂商 ID（小端）+ 自定义数据
    //    MANUFACTURER_ID=0xFFFF → 广播中为 FF FF
    String mfrData;
    mfrData += (char)(MANUFACTURER_ID & 0xFF);        // 厂商 ID 低字节
    mfrData += (char)((MANUFACTURER_ID >> 8) & 0xFF); // 厂商 ID 高字节
    mfrData += MANUFACTURER_DATA;                      // "KG"
    BLEAdvertisementData adData;
    adData.setManufacturerData(mfrData);
    advertising->setScanResponseData(adData);

    advertising->setScanResponse(true);
    advertising->setMinPreferred(0x06);
    advertising->setMaxPreferred(0x12);
    BLEDevice::startAdvertising();
}

// ====================== RSSI / Kalman / State Machine ======================

void readConnectionRssi() {
    if (!deviceConnected) return;

#if BLE_KEY_GO_STACK_NIMBLE
    if (nimbleConnHandle == 0) return;
    int8_t rssi = 0;
    int rc = ble_gap_conn_rssi(nimbleConnHandle, &rssi);
    if (rc == 0) {
        latestRSSI = rssi;

        // Spike rejection with consecutive-spike gating
        bool spikeRejected = false;
        bool isSpike = kf_initialized && abs(rssi - (int)filteredRSSI) > rssiSpikeRejectDb;

        if (isSpike) {
            spikeConsecutiveCount++;
            if (spikeConsecutiveCount >= spikeConsecutiveRequired) {
                updateKalmanFilter(rssi);
                spikeConsecutiveCount = 0;
            } else {
                spikeRejected = true;
                kf_p = kf_p + kf_q * 2.0f;
            }
        } else {
            spikeConsecutiveCount = 0;
            updateKalmanFilter(rssi);
        }

        if (rssiDisplayMode) {
            Serial.printf("[RSSI] raw=%d filtered=%d state=%s%s\n",
                          latestRSSI, (int)filteredRSSI, stateToString().c_str(),
                          spikeRejected ? " (spike)" : "");
        }
    } else {
        static int failCount = 0;
        if (failCount < 3) {
            Serial.printf("[RSSI] ble_gap_conn_rssi failed: rc=%d\n", rc);
            failCount++;
        }
    }

#elif BLE_KEY_GO_STACK_BLUEDROID
    esp_err_t err = esp_ble_gap_read_rssi(connectedRemoteAddress);
    if (err != ESP_OK) {
        static int failCount = 0;
        if (failCount < 3) {
            Serial.printf("[RSSI] esp_ble_gap_read_rssi failed: %d\n", err);
            failCount++;
        }
    }
#else
    if (!nativeRssiWarningPrinted) {
        nativeRssiWarningPrinted = true;
        Serial.println("[RSSI] native read unavailable; use cfg rssi=-50 or FF01 rssi=-50");
    }
#endif
}

// ---- 1D Kalman filter ----
void updateKalmanFilter(int measurement) {
    if (!kf_initialized) {
        kf_x = (float)measurement;
        kf_p = kf_r;
        kf_initialized = true;
        filteredRSSI = measurement;
        return;
    }

    // Predict
    kf_p = kf_p + kf_q;

    // Update
    float k = kf_p / (kf_p + kf_r);
    kf_x = kf_x + k * ((float)measurement - kf_x);
    kf_p = (1.0f - k) * kf_p;

    filteredRSSI = kf_x;
}

void resetKalmanFilter() {
    kf_x = -999;
    kf_p = 1.0f;
    kf_initialized = false;
    filteredRSSI = -999;
    spikeConsecutiveCount = 0;
}

// ---- State machine with hysteresis ----
void processStateMachine() {
    // 手动命令冷却期
    if (manualCommandCooldown) {
        if (millis() - manualCommandTimestampMs >= MANUAL_COMMAND_COOLDOWN_MS) {
            manualCommandCooldown = false;
            Serial.println("[STATE] manual command cooldown ended, RSSI state machine resumed");
        } else {
            return;
        }
    }

    if (filteredRSSI == -999 || currentState == STATE_ACTION) return;

    if (currentState == STATE_LOCKED) {
        if (filteredRSSI >= rssiUnlockThreshold) {
            unlockCounter++;
            lockCounter = 0;
            if (unlockCounter >= unlockCountRequired) {
                Serial.println("[STATE] unlock threshold reached");
                currentState = STATE_ACTION;
                executeUnlockSequence();
                currentState = STATE_UNLOCKED;
                unlockCounter = 0;
                lockCounter = 0;
                notifyStatus();
            }
        } else {
            unlockCounter = 0;
        }
    } else if (currentState == STATE_UNLOCKED) {
        int effectiveLock = rssiLockThreshold - rssiHysteresisDb;
        if (filteredRSSI <= effectiveLock) {
            lockCounter++;
            unlockCounter = 0;
            if (lockCounter >= lockCountRequired) {
                Serial.println("[STATE] lock threshold reached");
                currentState = STATE_ACTION;
                executeLockSequence();
                currentState = STATE_LOCKED;
                unlockCounter = 0;
                lockCounter = 0;
                resetKalmanFilter();
                notifyStatus();
            }
        } else {
            lockCounter = 0;
        }
    }
}

// ---- Key sequences ----
void executeUnlockSequence() {
    Serial.println("[KEY] unlock");
    digitalWrite(PIN_KEY_POWER, PMOS_ON);
    delay(keyPowerUpDelayMs);
    digitalWrite(PIN_UNLOCK, NMOS_ON);
    delay(keyPressDurationMs);
    digitalWrite(PIN_UNLOCK, NMOS_OFF);
    delay(keyReleaseDelayMs);
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
}

void executeLockSequence() {
    Serial.println("[KEY] lock");
    digitalWrite(PIN_KEY_POWER, PMOS_ON);
    delay(keyPowerUpDelayMs);
    digitalWrite(PIN_LOCK, NMOS_ON);
    delay(keyPressDurationMs);
    digitalWrite(PIN_LOCK, NMOS_OFF);
    delay(keyReleaseDelayMs);
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
}

void executeTrunkSequence() {
    Serial.println("[KEY] trunk");
    digitalWrite(PIN_KEY_POWER, PMOS_ON);
    delay(keyPowerUpDelayMs);
    digitalWrite(PIN_TRUNK, NMOS_ON);
    delay(keyPressDurationMs);
    digitalWrite(PIN_TRUNK, NMOS_OFF);
    delay(keyReleaseDelayMs);
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
}

// ---- LED ----
void updateLED() {
    static unsigned long lastBlinkMs = 0;
    static bool ledState = false;

    // 连接成功且已授权 → 常亮
    if (deviceConnected && connectionAuthorized) {
        digitalWrite(PIN_LED, HIGH);
        return;
    }

    // 配对模式 → 200ms 快闪
    if (pairingModeActive) {
        if (millis() - lastBlinkMs >= 200) {
            lastBlinkMs = millis();
            ledState = !ledState;
            digitalWrite(PIN_LED, ledState);
        }
        return;
    }

    // 未绑定 → 每秒慢闪
    if (bondedMac.length() == 0) {
        if (millis() - lastBlinkMs >= 1000) {
            lastBlinkMs = millis();
            ledState = !ledState;
            digitalWrite(PIN_LED, ledState);
        }
        return;
    }

    // 已绑定、未连接 → 2 秒悠闲闪
    if (millis() - lastBlinkMs >= 2000) {
        lastBlinkMs = millis();
        ledState = !ledState;
        digitalWrite(PIN_LED, ledState);
    }
}

// ---- Serial commands ----
void handleSerialCommand() {
    if (!Serial.available()) return;

    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.length() == 0) return;

    String upper = cmd;
    upper.toUpperCase();

    if (upper == "HELP") {
        printHelp();
    } else if (upper == "STATUS") {
        printStatus();
    } else if (upper == "BIND") {
        // ★ 串口绑定
        if (g_commandCallbacks && deviceConnected) {
            g_commandCallbacks->handleBindCommand();
        } else {
            Serial.println("[SECURITY] BIND requires an active BLE connection");
        }
    } else if (upper == "UNBIND") {
        // ★ 串口解绑
        if (g_commandCallbacks) {
            g_commandCallbacks->handleUnbindCommand();
        }
    } else if (upper == "UNLOCK") {
        executeUnlockSequence();
        currentState = STATE_UNLOCKED;
        resetKalmanFilter();
        manualCommandTimestampMs = millis();
        manualCommandCooldown = true;
        Serial.println("[STATE] serial manual unlock, RSSI state machine paused 8s");
    } else if (upper == "LOCK") {
        executeLockSequence();
        currentState = STATE_LOCKED;
        resetKalmanFilter();
        manualCommandTimestampMs = millis();
        manualCommandCooldown = true;
        Serial.println("[STATE] serial manual lock, RSSI state machine paused 8s");
    } else if (upper == "TRUNK") {
        executeTrunkSequence();
    } else if (upper == "RSSI") {
        rssiDisplayMode = !rssiDisplayMode;
        Serial.printf("[CONFIG] RSSI display: %s\n", rssiDisplayMode ? "on" : "off");
    } else if (upper == "PAIRING") {
        // ★ 串口进入配对模式
        pairingModeActive = true;
        pairingModeStartMs = millis();
        Serial.printf("[SECURITY] pairing mode active for %d seconds\n", PAIRING_MODE_TIMEOUT_MS / 1000);
    } else if (upper.startsWith("PIN ")) {
        // ★ 串口验证 PIN: "pin 123456"
        String pinCode = cmd.substring(4);
        pinCode.trim();
        if (g_commandCallbacks) {
            g_commandCallbacks->handlePinVerify(pinCode);
        }
    } else if (upper.startsWith("CHPIN ")) {
        // ★ 串口修改 PIN: "chpin 123456 654321"
        String params = cmd.substring(6);
        params.trim();
        // 串口命令使用空格分隔：CHPIN oldPin newPin
        int space = params.indexOf(' ');
        if (space > 0) {
            String oldPin = params.substring(0, space);
            String newPin = params.substring(space + 1);
            if (g_commandCallbacks) {
                g_commandCallbacks->handlePinChange(oldPin + ":" + newPin);
            }
        } else {
            Serial.println("[SECURITY] CHPIN format: chpin oldPin newPin");
        }
    } else if (upper.startsWith("CFG ")) {
        String params = cmd.substring(4);
        if (parseConfigLine(params)) {
            saveConfig();
            Serial.println("[CONFIG] saved");
        } else {
            Serial.println("[ERROR] cfg format: cfg unlock=-45 lock=-65 hyst=5 spike=25 uc=3 lc=5 interval=500 dlock=5000 q=4 r=16");
        }
    } else {
        Serial.printf("[ERROR] unknown command: %s\n", cmd.c_str());
    }
}

// ---- Config parse ----
bool parseConfigLine(String line) {
    line.trim();
    line.toLowerCase();
    if (line.length() == 0) return false;

    int parsed = 0;
    int start = 0;
    while (start < line.length()) {
        int end = line.indexOf(' ', start);
        if (end < 0) end = line.length();

        String token = line.substring(start, end);
        token.trim();
        int eq = token.indexOf('=');
        if (eq > 0) {
            String key = token.substring(0, eq);
            String valStr = token.substring(eq + 1);

            if (key == "unlock") { rssiUnlockThreshold = valStr.toInt(); parsed++; }
            else if (key == "lock") { rssiLockThreshold = valStr.toInt(); parsed++; }
            else if (key == "hyst") { rssiHysteresisDb = max(0, (int)valStr.toInt()); parsed++; }
            else if (key == "spike") { rssiSpikeRejectDb = max(5, (int)valStr.toInt()); parsed++; }
            else if (key == "uc") { unlockCountRequired = max(1, (int)valStr.toInt()); parsed++; }
            else if (key == "lc") { lockCountRequired = max(1, (int)valStr.toInt()); parsed++; }
            else if (key == "interval") { rssiSampleIntervalMs = max(100, (int)valStr.toInt()); parsed++; }
            else if (key == "dlock") { disconnectLockDelayMs = max(0, (int)valStr.toInt()); parsed++; }
            else if (key == "q") { kf_q = max(0.1f, valStr.toFloat()); parsed++; }
            else if (key == "r") { kf_r = max(0.1f, valStr.toFloat()); parsed++; }
            else if (key == "bound_mac") {
                // ★ 允许通过串口直接写入绑定 MAC（调试用）
                bondedMac = valStr;
                bondedMac.toUpperCase();
                saveBondInfo();
                parsed++;
                Serial.printf("[SECURITY] bound MAC set to: %s\n", bondedMac.c_str());
            }
            else if (key == "rssi") {
                latestRSSI = valStr.toInt();
                updateKalmanFilter((int)latestRSSI);
                parsed++;
                Serial.printf("[RSSI] manual raw=%d filtered=%d\n", latestRSSI, (int)filteredRSSI);
            }
        }
        start = end + 1;
    }

    return parsed > 0 && rssiUnlockThreshold > rssiLockThreshold;
}

// ---- NVS persistence ----
void loadConfig() {
    preferences.begin("ble-key-go", false);
    rssiUnlockThreshold = preferences.getInt("unlock", rssiUnlockThreshold);
    rssiLockThreshold = preferences.getInt("lock", rssiLockThreshold);
    rssiHysteresisDb = preferences.getInt("hyst", rssiHysteresisDb);
    rssiSpikeRejectDb = preferences.getInt("spike", rssiSpikeRejectDb);
    unlockCountRequired = preferences.getInt("uc", unlockCountRequired);
    lockCountRequired = preferences.getInt("lc", lockCountRequired);
    rssiSampleIntervalMs = preferences.getInt("interval", rssiSampleIntervalMs);
    disconnectLockDelayMs = preferences.getInt("dlock", disconnectLockDelayMs);
    kf_q = preferences.getFloat("kf_q", kf_q);
    kf_r = preferences.getFloat("kf_r", kf_r);
}

void saveConfig() {
    preferences.putInt("unlock", rssiUnlockThreshold);
    preferences.putInt("lock", rssiLockThreshold);
    preferences.putInt("hyst", rssiHysteresisDb);
    preferences.putInt("spike", rssiSpikeRejectDb);
    preferences.putInt("uc", unlockCountRequired);
    preferences.putInt("lc", lockCountRequired);
    preferences.putInt("interval", rssiSampleIntervalMs);
    preferences.putInt("dlock", disconnectLockDelayMs);
    preferences.putFloat("kf_q", kf_q);
    preferences.putFloat("kf_r", kf_r);
}

// ---- Status ----
String stateToString() {
    switch (currentState) {
        case STATE_LOCKED: return "LOCKED";
        case STATE_UNLOCKED: return "UNLOCKED";
        case STATE_ACTION: return "ACTION";
    }
    return "UNKNOWN";
}

void notifyStatus() {
    if (pStatusCharacteristic == nullptr) return;

    String payload = "{";
    payload += "\"connected\":";
    payload += String(deviceConnected ? 1 : 0);
    payload += ",\"authorized\":";                       // ★ 新增
    payload += String(connectionAuthorized ? 1 : 0);
    payload += ",\"bound\":";                            // ★ 新增
    payload += String(bondedMac.length() > 0 ? 1 : 0);
    payload += ",\"state\":\"";
    payload += stateToString();
    payload += "\"";
    payload += ",\"rssi\":";
    payload += String(latestRSSI);
    payload += ",\"filtered\":";
    payload += String((int)filteredRSSI);
    payload += ",\"unlock\":";
    payload += String(rssiUnlockThreshold);
    payload += ",\"lock\":";
    payload += String(rssiLockThreshold);
    payload += ",\"hyst\":";
    payload += String(rssiHysteresisDb);
    payload += ",\"uc\":";
    payload += String(unlockCountRequired);
    payload += ",\"lc\":";
    payload += String(lockCountRequired);
    payload += ",\"manualCooldown\":";
    payload += String(manualCommandCooldown ? 1 : 0);
    payload += ",\"deviceName\":\"";                     // ★ 新增
    payload += deviceName;
    payload += "\"";
    payload += ",\"pairingMode\":";                      // ★ 新增
    payload += String(pairingModeActive ? 1 : 0);
    payload += ",\"pin_ok\":";                           // ★ v2.3: PIN 验证结果
    payload += String(pinVerified ? 1 : 0);
    payload += ",\"pin_default\":";                      // ★ v2.3: 是否出厂默认 PIN
    payload += String(isDefaultPin() ? 1 : 0);
    payload += "}";

    pStatusCharacteristic->setValue(payload.c_str());
    if (deviceConnected) {
        pStatusCharacteristic->notify();
    }
}

void printStatus() {
    Serial.println();
    Serial.println("==== STATUS ====");
    Serial.printf("Device: %s\n", deviceName);
    Serial.printf("Bound: %s\n", bondedMac.length() > 0 ? bondedMac.c_str() : "NO (open enrollment)");
    Serial.printf("PIN: %s (default: %s)\n", isDefaultPin() ? "DEFAULT" : "custom", isDefaultPin() ? "yes" : "no");
    Serial.printf("PIN verified this session: %s\n", pinVerified ? "yes" : "no");
    Serial.printf("Pairing mode: %s\n", pairingModeActive ? "ACTIVE" : "inactive");
    Serial.printf("BLE connected: %s\n", deviceConnected ? "yes" : "no");
    if (deviceConnected) {
        Serial.printf("  → Authorized: %s\n", connectionAuthorized ? "yes" : "NO");
    }
    Serial.printf("State: %s\n", stateToString().c_str());
    Serial.printf("RSSI raw/filtered: %d / %d\n", latestRSSI, (int)filteredRSSI);
    Serial.printf("Threshold unlock/lock/hyst: %d / %d / %d dBm\n",
                  rssiUnlockThreshold, rssiLockThreshold, rssiHysteresisDb);
    Serial.printf("Spike reject: %d dB (consecutive needed: %d)\n",
                  rssiSpikeRejectDb, spikeConsecutiveRequired);
    Serial.printf("Kalman: q=%.1f r=%.1f\n", kf_q, kf_r);
    Serial.printf("Confirm unlock/lock: %d / %d\n", unlockCounter, lockCounter);
    Serial.printf("Required unlock/lock: %d / %d\n", unlockCountRequired, lockCountRequired);
    Serial.printf("Sample interval: %d ms\n", rssiSampleIntervalMs);
    Serial.printf("Disconnect lock delay: %d ms\n", disconnectLockDelayMs);
    Serial.printf("Manual cooldown: %s\n", manualCommandCooldown ? "active" : "idle");
    Serial.println();
}

void printHelp() {
    Serial.println("Commands:");
    Serial.println("  status    rssi    unlock    lock    trunk    pairing");
    Serial.println("  bind      unbind  pin <code>   chpin <old> <new>");
    Serial.println("  cfg unlock=-45 lock=-65 hyst=5 spike=25 uc=3 lc=5");
    Serial.println("              interval=500 dlock=5000 q=4 r=16");
    Serial.println("  cfg rssi=-40     (manual RSSI injection for test)");
    Serial.println("  cfg bound_mac=AA:BB:CC:DD:EE:FF (set binding manually)");
    Serial.println();
    Serial.println("nRF Connect / App:");
    Serial.printf ("  Scan for service UUID: %s\n", SERVICE_UUID);
    Serial.printf ("  Device name: %s (or similar with MAC suffix)\n", deviceName);
    Serial.println("  Read/notify FF02 for status JSON  (new fields: authorized, bound, pairingMode)");
    Serial.println("  Write FF01: cfg key=value...      (requires authorization)");
    Serial.println("  Write FF03: UNLOCK / LOCK / TRUNK / STATUS  (requires authorization)");
    Serial.println("  Write FF03: BIND / UNBIND / PIN:<code> / CHPIN:<old>:<new>");
    Serial.println("              (BIND blocked without PIN, physical pairing exempt)");
    Serial.println();
    Serial.println("Hardware (PIN 9):");
    Serial.println("  Short press (<2s): enter pairing mode (30s window, LED fast blink)");
    Serial.println("  Long press (>5s):  factory reset (clear binding + config, then restart)");
    Serial.println();
}
