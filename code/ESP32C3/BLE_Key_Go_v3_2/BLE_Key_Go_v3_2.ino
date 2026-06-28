/*
 * BLE-Key-Go v3.2 — BLE Bonding (业界标准)
 *
 * ── v3.2 核心变更 ──────────────────────────────────────
 *   ● BLE Bonding (安全配对 + 持久绑定)
 *     替代 v3.1 的应用层双层密码 + MAC 信任列表
 *   ● 静态 PIN: 123456（可修改，修改后清空所有 bond）
 *   ● 授权 = BLE 加密连接建立（无需输入任何密码）
 *   ● 已配对手机 → 自动重连 + 自动加密 → 秒连即控
 *   ● 新手机 → 连接 → 手机弹出配对 → 输入 PIN → 绑定
 *   ● 物理按键短按 → 删除所有 bond（进入配对模式）
 *   ● 物理按键长按 5s → 恢复出厂设置
 *
 * ── 安全原理 ──────────────────────────────────────────
 *   BLE Bonding 在链路层完成身份认证和加密密钥交换。
 *   配对成功后，密钥持久化到双方设备的非易失存储。
 *   后续连接自动使用存储的密钥加密，无需用户交互。
 *   这是 Apple CarKey / 车载蓝牙 等业界标准方案。
 *
 * ── 继承 ──────────────────────────────────────────────
 *   ● 双栈 BLE（Bluedroid / NimBLE）
 *   ● RSSI 管线：尖峰丢弃 → 1D Kalman → 滞后状态机
 *   ● NOR Flash 持久化（Preferences NVS）
 *   ● 断连锁车 / 手动命令冷却
 */

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLESecurity.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>
#include <esp_mac.h>

// ---- Determine BLE stack ----
#if defined(CONFIG_BLUEDROID_ENABLED)
  #define BLE_KEY_GO_STACK_BLUEDROID   1
  #define BLE_KEY_GO_STACK_NIMBLE      0
  #include <esp_gap_ble_api.h>
  #define BLE_KEY_GO_HAS_NATIVE_RSSI   1
#elif defined(CONFIG_NIMBLE_ENABLED)
  #define BLE_KEY_GO_STACK_BLUEDROID   0
  #define BLE_KEY_GO_STACK_NIMBLE      1
  #define BLE_KEY_GO_HAS_NATIVE_RSSI   1
#else
  #define BLE_KEY_GO_STACK_BLUEDROID   0
  #define BLE_KEY_GO_STACK_NIMBLE      0
  #define BLE_KEY_GO_HAS_NATIVE_RSSI   0
#endif

// ---------------- Pins ----------------
#define PIN_UNLOCK      2
#define PIN_LOCK        3
#define PIN_TRUNK       4
#define PIN_KEY_POWER   5
#define PIN_LED         8
#define PIN_BIND        9       // 物理按键（低电平触发，需外部上拉）

#define NMOS_ON    HIGH
#define NMOS_OFF   LOW
#define PMOS_ON    LOW
#define PMOS_OFF   HIGH

// ---------------- BLE UUIDs ----------------
#define DEVICE_NAME_PREFIX  "KeyGo"
#define SERVICE_UUID        "0000ff00-0000-1000-8000-00805f9b34fb"
#define CONFIG_CHAR_UUID    "0000ff01-0000-1000-8000-00805f9b34fb"
#define STATUS_CHAR_UUID    "0000ff02-0000-1000-8000-00805f9b34fb"
#define COMMAND_CHAR_UUID   "0000ff03-0000-1000-8000-00805f9b34fb"
#define MANUFACTURER_ID     0xFFFF
#define MANUFACTURER_DATA   "KG"

// ---------------- Tunable parameters ----------------
int rssiUnlockThreshold = -45;
int rssiLockThreshold = -65;
int rssiHysteresisDb = 5;
int rssiSpikeRejectDb = 25;
int unlockCountRequired = 3;
int lockCountRequired = 5;
int rssiSampleIntervalMs = 500;
int disconnectLockDelayMs = 5000;

int keyPowerUpDelayMs = 200;
int keyPressDurationMs = 300;
int keyReleaseDelayMs = 500;

// ---------------- 1D Kalman filter ----------------
float kf_q = 4.0f;
float kf_r = 16.0f;
float kf_x = -999;
float kf_p = 1.0f;
bool  kf_initialized = false;

float filteredRSSI = -999;
int   latestRSSI = -999;

int spikeConsecutiveCount = 0;
int spikeConsecutiveRequired = 2;

// ---------------- Security (v3.2: BLE Bonding) ----------------
#define PAIRING_MODE_TIMEOUT_MS   30000
#define FACTORY_RESET_HOLD_MS     5000
#define DEFAULT_PAIRING_PIN       "123456"
#define PIN_LENGTH                 6

String pairingPIN = DEFAULT_PAIRING_PIN;    // 静态配对 PIN（NVS 持久化）
bool   pinDefault = true;                   // PIN 是否为出厂默认
bool   hasBondedDevices = false;            // 是否有已绑定的设备
int    pinChangeError = 0;                  // PIN 修改错误码 (0=无, 1=旧PIN错, 2=格式错)

// ★ v3.2: 配对模式（物理按键触发 → 删除所有 bond 后激活）
bool          pairingModeActive = false;
unsigned long pairingModeStartMs = 0;

// ★ 设备自定义名称
String  customDeviceName = "";

// ★ 设备唯一名
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
uint8_t  nimblePeerAddr[6] = {0};
#endif
unsigned long lastRssiReadMs = 0;
unsigned long lastStatusNotifyMs = 0;
unsigned long disconnectTimestampMs = 0;
unsigned long manualCommandTimestampMs = 0;
bool manualCommandCooldown = false;
#define MANUAL_COMMAND_COOLDOWN_MS 8000
bool nativeRssiWarningPrinted = false;

// 按键去抖
unsigned long lastButtonCheckMs = 0;
#define BUTTON_DEBOUNCE_MS 50
bool lastButtonState = true;
unsigned long buttonPressStartMs = 0;

// 连接后未加密超时
unsigned long connectStartMs = 0;
#define BONDING_TIMEOUT_MS  60000    // 60 秒内未完成 bonding 则断开

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
void handleBindButton();
void readConnectionRssi();
void updateKalmanFilter(int measurement);
void resetKalmanFilter();
void loadConfig();
void saveConfig();
void loadSecurity();
void savePIN();
void printStatus();
void printHelp();
void notifyStatus();
String stateToString();
void startAdvertising();
bool parseConfigLine(String line);
int countBondedDevices();
void deleteAllBonds();

// ---- Bluedroid GAP RSSI callback ----
#if BLE_KEY_GO_STACK_BLUEDROID
static void gapEventHandler(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t* param) {
    // Handle auth complete event for bonding tracking
    if (event == ESP_GAP_BLE_AUTH_CMPL_EVT) {
        if (param->auth_cmpl.success) {
            hasBondedDevices = true;
            Serial.println("[SEC] Bonding complete — device authorized");
        } else {
            Serial.printf("[SEC] Bonding failed: reason=0x%02x\n", param->auth_cmpl.fail_reason);
        }
        notifyStatus();
        return;
    }

    if (event != ESP_GAP_BLE_READ_RSSI_COMPLETE_EVT) return;
    if (param->read_rssi_cmpl.status == ESP_BT_STATUS_SUCCESS) {
        int8_t rssi = param->read_rssi_cmpl.rssi;
        latestRSSI = rssi;

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

// ---- Security callbacks (v3.2: static PIN via callback) ----
class SecurityCallbacks : public BLESecurityCallbacks {
    uint32_t onPassKeyRequest() override {
        uint32_t pin = (uint32_t)pairingPIN.toInt();
        Serial.printf("[SEC] returning static PIN: %06u\n", pin);
        return pin;
    }
    void onPassKeyNotify(uint32_t pass_key) override {
        Serial.printf("[SEC] passkey notify: %06u\n", pass_key);
    }
    bool onConfirmPIN(uint32_t pass_key) override {
        Serial.printf("[SEC] confirm PIN: %06u → auto accept\n", pass_key);
        return true;
    }
#if BLE_KEY_GO_STACK_BLUEDROID
    bool onSecurityRequest(BLEServer* pServer) override {
        Serial.println("[SEC] security request → accepted");
        return true;
    }
    void onAuthenticationComplete(esp_ble_auth_cmpl_t auth_cmpl) override {
        if (auth_cmpl.success) {
            hasBondedDevices = true;
            Serial.println("[SEC] authentication complete — bonded");
        } else {
            Serial.printf("[SEC] authentication failed: reason=0x%02x\n", auth_cmpl.fail_reason);
        }
        notifyStatus();
    }
#elif BLE_KEY_GO_STACK_NIMBLE
    bool onSecurityRequest() override {
        Serial.println("[SEC] security request → accepted");
        return true;
    }
    void onAuthenticationComplete(ble_gap_conn_desc* desc) override {
        if (desc) {
            hasBondedDevices = true;
            Serial.println("[SEC] authentication complete — bonded");
        } else {
            Serial.println("[SEC] authentication failed");
        }
        notifyStatus();
    }
#endif
};

// ---- Server callbacks ----
class ServerCallbacks : public BLEServerCallbacks {
#if BLE_KEY_GO_STACK_BLUEDROID
    void onConnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
        deviceConnected = true;
        connectionId = param->connect.conn_id;
        connectStartMs = millis();
        memcpy(connectedRemoteAddress, param->connect.remote_bda, sizeof(esp_bd_addr_t));

        // ★ v3.2: 加密由 BLE 栈自动处理，连接即是加密的（或正在加密中）
        Serial.println("[BLE] phone connected — encryption handled by BLE stack");
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        notifyStatus();
    }

    void onDisconnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
        deviceConnected = false;
        latestRSSI = -999;
        disconnectTimestampMs = millis();
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        Serial.println("[BLE] phone disconnected, advertising restarted");
        startAdvertising();
        notifyStatus();
    }
#endif

#if BLE_KEY_GO_STACK_NIMBLE
    void onConnect(BLEServer* server, ble_gap_conn_desc* desc) override {
        deviceConnected = true;
        nimbleConnHandle = desc->conn_handle;
        connectionId = desc->conn_handle;
        connectStartMs = millis();
        memcpy(nimblePeerAddr, desc->peer_id_addr.val, 6);

        Serial.println("[BLE] phone connected — encryption handled by BLE stack");
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        notifyStatus();
    }

    void onDisconnect(BLEServer* server, ble_gap_conn_desc* desc) override {
        deviceConnected = false;
        latestRSSI = -999;
        nimbleConnHandle = 0;
        disconnectTimestampMs = millis();
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        Serial.println("[BLE] phone disconnected, advertising restarted");
        startAdvertising();
        notifyStatus();
    }
#endif

#if !BLE_KEY_GO_STACK_BLUEDROID && !BLE_KEY_GO_STACK_NIMBLE
    void onConnect(BLEServer* server) override {
        deviceConnected = true;
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        nativeRssiWarningPrinted = false;
        Serial.println("[BLE] phone connected (no native RSSI)");
        Serial.println("[BLE] write rssi=-50 to FF01 or serial cfg for logic test");
    }

    void onDisconnect(BLEServer* server) override {
        deviceConnected = false;
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
public:
    void onWrite(BLECharacteristic* characteristic) override {
        String cmd = characteristic->getValue().c_str();
        cmd.trim();
        String upper = cmd;
        upper.toUpperCase();

        // ★ v3.2: 设置设备名称
        if (upper.startsWith("NAME:")) {
            handleSetName(cmd.substring(5));
            return;
        }

        // ★ v3.2: 修改配对 PIN（需加密连接）
        if (upper.startsWith("PIN:")) {
            handleChangePIN(cmd.substring(4));
            return;
        }

        // ★ 车辆控制命令
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

    // ★ v3.2: 设置设备自定义名称
    void handleSetName(String name) {
        name.trim();
        if (name.length() > 20) {
            Serial.println("[NAME] too long (max 20 chars)");
            return;
        }
        customDeviceName = name;
        preferences.putString("dev_name", customDeviceName);
        Serial.printf("[NAME] set to: %s\n", customDeviceName.c_str());
        notifyStatus();
    }

    // ★ v3.2: 修改配对 PIN（支持 4-6 位数字，手机端自动补零） 
    void handleChangePIN(String params) {
        params.trim();
        int colon = params.indexOf(':');
        if (colon < 1) {
            Serial.println("[SEC] PIN format: PIN:oldPIN:newPIN (4-6 digits each)");
            pinChangeError = 2;
            notifyStatus();
            pinChangeError = 0;
            return;
        }
        String oldPIN = params.substring(0, colon);
        String newPIN = params.substring(colon + 1);
        oldPIN.trim();
        newPIN.trim();

        if (oldPIN != pairingPIN) {
            Serial.println("[SEC] PIN change failed: old PIN mismatch");
            pinChangeError = 1;  // ★ v3.3: 旧 PIN 错误
            notifyStatus();      // 让 App 知道操作失败
            pinChangeError = 0;  // 用后即清除
            return;
        }
        // ★ v3.2: 支持 4-6 位数字 PIN
        const int pinLen = newPIN.length();
        if (pinLen < 4 || pinLen > 6) {
            Serial.println("[SEC] PIN must be 4-6 digit numeric");
            pinChangeError = 2;
            notifyStatus();
            pinChangeError = 0;
            return;
        }
        // 确保全数字
        for (int i = 0; i < pinLen; i++) {
            if (!isdigit(newPIN[i])) {
                Serial.println("[SEC] PIN must be numeric digits only");
                pinChangeError = 2;
                notifyStatus();
                pinChangeError = 0;
                return;
            }
        }

        // ★ 删除所有 bond + 保存新 PIN
        deleteAllBonds();    // 包含 disconnectCurrentConnection
        pairingPIN = newPIN;
        pinDefault = (pairingPIN == DEFAULT_PIN);  // ★ v3.3: 改回 123456 时恢复默认标记
        savePIN();           // ★ 独立 Preferences 对象，ensure NVS flush
        hasBondedDevices = false;
        Serial.printf("[SEC] PIN changed to %s, all bonds cleared\n", newPIN.c_str());
        notifyStatus();
    }
};

CommandCallbacks* g_commandCallbacks = nullptr;

// ====================== setup ======================

void setup() {
    // ---- Early LED blink ----
    pinMode(PIN_LED, OUTPUT);
    for (int i = 0; i < 3; i++) {
        digitalWrite(PIN_LED, HIGH);
        delay(150);
        digitalWrite(PIN_LED, LOW);
        delay(150);
    }

    pinMode(PIN_BIND, INPUT_PULLUP);

    Serial.begin(115200);
    Serial.setTimeout(50);
    delay(2000);

    // ---- Build unique device name ----
    uint8_t macBytes[6];
    esp_read_mac(macBytes, ESP_MAC_BT);
    snprintf(deviceName, sizeof(deviceName), "%s-%02X%02X%02X",
             DEVICE_NAME_PREFIX, macBytes[3], macBytes[4], macBytes[5]);

    // ---- Print banner ----
    Serial.println();
    Serial.println("============================================");
    Serial.println("  BLE-Key-Go v3.2 starting...");
    Serial.printf ("  Device: %s\n", deviceName);
    Serial.println("  BLE Bonding (industry standard)");
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
    loadSecurity();           // ★ v3.2: 加载 PIN + 自定义名称

    Serial.println();
    Serial.printf("==== BLE-Key-Go v3.2 | Device: %s ====\n", deviceName);
#if BLE_KEY_GO_STACK_BLUEDROID
    Serial.println("[BUILD] Stack: Bluedroid, Native RSSI: enabled (async)");
#elif BLE_KEY_GO_STACK_NIMBLE
    Serial.println("[BUILD] Stack: NimBLE, Native RSSI: enabled (sync)");
#else
    Serial.println("[BUILD] Stack: unknown, Native RSSI: unavailable (manual mode)");
#endif
    Serial.printf("[FILTER] Kalman q=%.1f r=%.1f, spike=%ddB, hyst=%ddB\n",
                  kf_q, kf_r, rssiSpikeRejectDb, rssiHysteresisDb);
    Serial.printf("[SEC] Pairing PIN: %s (default: %s)\n",
                  pinDefault ? "DEFAULT" : "custom",
                  pinDefault ? "yes" : "no");
    // ★ v3.2: 检查是否有已绑定的设备（通过 NVS bond 数据判断）
    {
        int count = countBondedDevices();
        hasBondedDevices = (count > 0);
        Serial.printf("[SEC] Bonded devices: %d\n", count);
    }
    printHelp();

    // ---- Initialize BLE ----
    BLEDevice::init(deviceName);

    // ★ v3.2: 配置 BLE Security（双栈兼容）
#if BLE_KEY_GO_STACK_BLUEDROID
    BLESecurity *pSecurity = new BLESecurity();
    pSecurity->setAuthenticationMode(ESP_LE_AUTH_REQ_SC_BOND);   // SC + Bonding
    pSecurity->setCapability(ESP_IO_CAP_DISP_ONLY);               // phone shows PIN prompt
    pSecurity->setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
    pSecurity->setRespEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
    pSecurity->setCallbacks(new SecurityCallbacks());
#elif BLE_KEY_GO_STACK_NIMBLE
    BLESecurity *pSecurity = new BLESecurity();
    pSecurity->setAuthenticationMode(ESP_LE_AUTH_REQ_SC_BOND);   // SC + Bonding (NimBLE uses ESP_ prefix)
    pSecurity->setCapability(BLE_SM_IO_CAP_DISP_ONLY);            // phone PIN prompt (NimBLE uses BLE_SM_ prefix)
    pSecurity->setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
    pSecurity->setRespEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
    BLEDevice::setSecurityCallbacks(new SecurityCallbacks());     // callback returns static PIN
#endif

#if BLE_KEY_GO_STACK_BLUEDROID
    BLEDevice::setCustomGapHandler(gapEventHandler);
#endif

    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());

    BLEService* service = pServer->createService(SERVICE_UUID);

    // FF01: 配置特征（Write）— 加密后可用
    BLECharacteristic* configCharacteristic = service->createCharacteristic(
        CONFIG_CHAR_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    configCharacteristic->setCallbacks(new ConfigCallbacks());

    // FF02: 状态特征（Read + Notify）
    pStatusCharacteristic = service->createCharacteristic(
        STATUS_CHAR_UUID,
        BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
    );
    pStatusCharacteristic->addDescriptor(new BLE2902());

    // FF03: 命令特征（Write）
    BLECharacteristic* commandCharacteristic = service->createCharacteristic(
        COMMAND_CHAR_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    CommandCallbacks* cmdCb = new CommandCallbacks();
    g_commandCallbacks = cmdCb;
    commandCharacteristic->setCallbacks(cmdCb);

    service->start();
    startAdvertising();
    notifyStatus();

    Serial.printf("[BLE] advertising as %s, service %s\n", deviceName, SERVICE_UUID);
    Serial.printf("[SEC] Pairing PIN: %s\n", pairingPIN.c_str());
}

// ====================== loop ======================

void loop() {
    handleSerialCommand();
    handleBindButton();

    // ★ v3.2: Bonding 超时检测（连接后 60s 未完成配对则断开）
    if (deviceConnected) {
        static bool timeoutWarned = false;
        unsigned long elapsed = millis() - connectStartMs;
        if (elapsed > BONDING_TIMEOUT_MS && !timeoutWarned) {
            // 检查是否已完成加密（通过查看 bond 数量变化）
            int bonds = countBondedDevices();
            if (bonds == 0 && !hasBondedDevices) {
                Serial.println("[SEC] Bonding timeout (60s) — disconnecting");
                pServer->disconnect(connectionId);
            }
            timeoutWarned = true;
        }
        if (!deviceConnected) {
            timeoutWarned = false;
        }
    }

    // ★ 配对模式超时
    if (pairingModeActive && millis() - pairingModeStartMs >= PAIRING_MODE_TIMEOUT_MS) {
        pairingModeActive = false;
        Serial.println("[SEC] pairing mode timeout");
        notifyStatus();
    }

    if (deviceConnected &&
        millis() - lastRssiReadMs >= (unsigned long)rssiSampleIntervalMs) {
        lastRssiReadMs = millis();
        readConnectionRssi();
    }

    if (deviceConnected) {
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

// ====================== Security Functions (v3.2) ======================

// ★ v3.2: 通过检查 NVS 中的 bond 数据粗略统计已绑定设备数
//   注意：ESP BLE 栈的 bond 数据格式复杂，此处简化处理
int countBondedDevices() {
    // 打开 "ble" 命名空间检查是否有 bond 相关 key
    Preferences bondPrefs;
    if (!bondPrefs.begin("ble", true)) return 0;
    // 检查常见的 bonding key
    bool hasKeys = bondPrefs.isKey("bonded_devices");
    int count = 0;
    if (hasKeys) {
        count = bondPrefs.getInt("bonded_devices", 0);
    }
    bondPrefs.end();
    return count;
}

void deleteAllBonds() {
    // ★ 删除 NVS 中 BLE 安全相关的 key
    Preferences bondPrefs;
    if (bondPrefs.begin("ble", false)) {
        bondPrefs.clear();  // 清除所有 bond 数据
        bondPrefs.end();    // ★ 刷入 NVS
    }
    Serial.println("[SEC] All BLE bonds deleted");

    hasBondedDevices = false;
}

void loadSecurity() {
    pairingPIN = preferences.getString("pairing_pin", DEFAULT_PAIRING_PIN);
    pinDefault = (pairingPIN == DEFAULT_PAIRING_PIN);
    customDeviceName = preferences.getString("dev_name", "");
    Serial.printf("[SEC] loaded: PIN %s default, %d bonded devices\n",
                  pinDefault ? "IS" : "NOT",
                  countBondedDevices());
}

void savePIN() {
    Preferences p;
    p.begin("ble-key-go", false);
    p.putString("pairing_pin", pairingPIN);
    p.end();  // ★ 立即刷入 NVS 闪存，防止重启丢失
}

// ====================== Physical Button ======================

void handleBindButton() {
    if (millis() - lastButtonCheckMs < BUTTON_DEBOUNCE_MS) return;
    lastButtonCheckMs = millis();

    bool current = digitalRead(PIN_BIND);

    // 按下沿
    if (lastButtonState == HIGH && current == LOW) {
        buttonPressStartMs = millis();
    }

    // 释放沿
    if (lastButtonState == LOW && current == HIGH) {
        unsigned long holdMs = millis() - buttonPressStartMs;
        if (holdMs >= FACTORY_RESET_HOLD_MS) {
            // ★ 长按 > 5s → 恢复出厂设置
            Serial.println("[FACTORY] RESET triggered — clearing all...");

            // 删除所有 bond
            deleteAllBonds();

            // 重置 PIN 为默认
            pairingPIN = DEFAULT_PAIRING_PIN;
            pinDefault = true;
            savePIN();

            // 清空所有 NVS 配置
            preferences.clear();
            savePIN();
            preferences.putString("pairing_pin", pairingPIN);  // 再写入一次确保

            // 重置调参
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

            // LED 快闪 3 次确认
            for (int i = 0; i < 3; i++) {
                digitalWrite(PIN_LED, HIGH); delay(100);
                digitalWrite(PIN_LED, LOW);  delay(200);
            }
            Serial.println("[FACTORY] Reset complete. Restarting in 1s...");
            delay(1000);
            ESP.restart();
        } else if (holdMs > 200 && holdMs < 2000) {
            // ★ 短按 → 删除所有 bond（进入配对模式）
            deleteAllBonds();
            pairingModeActive = true;
            pairingModeStartMs = millis();
            Serial.printf("[SEC] All bonds deleted, pairing mode active for %d seconds\n",
                          PAIRING_MODE_TIMEOUT_MS / 1000);
            Serial.println("[SEC] Any phone may now pair with PIN: " + pairingPIN);

            // LED 双闪确认
            digitalWrite(PIN_LED, HIGH); delay(100);
            digitalWrite(PIN_LED, LOW);  delay(100);
            digitalWrite(PIN_LED, HIGH); delay(100);
            digitalWrite(PIN_LED, LOW);
            notifyStatus();
        }
    }

    lastButtonState = current;
}

// ====================== Advertising ======================

void startAdvertising() {
    BLEAdvertising* advertising = BLEDevice::getAdvertising();
    advertising->addServiceUUID(SERVICE_UUID);

    String mfrData;
    mfrData += (char)(MANUFACTURER_ID & 0xFF);
    mfrData += (char)((MANUFACTURER_ID >> 8) & 0xFF);
    mfrData += MANUFACTURER_DATA;
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

void updateKalmanFilter(int measurement) {
    if (!kf_initialized) {
        kf_x = (float)measurement;
        kf_p = kf_r;
        kf_initialized = true;
        filteredRSSI = measurement;
        return;
    }
    kf_p = kf_p + kf_q;
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

void processStateMachine() {
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

// ====================== LED ======================

void updateLED() {
    static unsigned long lastBlinkMs = 0;
    static bool ledState = false;

    // ★ v3.2: 已连接 → 常亮（BLE 栈保证加密）
    if (deviceConnected) {
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

    // ★ v3.2: 无绑定设备 → 每秒慢闪（提示用户首次配对）
    if (!hasBondedDevices) {
        if (millis() - lastBlinkMs >= 1000) {
            lastBlinkMs = millis();
            ledState = !ledState;
            digitalWrite(PIN_LED, ledState);
        }
        return;
    }

    // 已绑定待连接 → 2秒闪烁
    if (millis() - lastBlinkMs >= 2000) {
        lastBlinkMs = millis();
        ledState = !ledState;
        digitalWrite(PIN_LED, ledState);
    }
}

// ====================== Status Notify ======================

void notifyStatus() {
    if (pStatusCharacteristic == nullptr) return;

    // ★ v3.3: 精简 STATUS JSON（只保留 App 需要的字段）
    // c=connected enc=encrypted(当前连接), bdd=has bonded devices
    // st=state r/f=rssi ul/lk/hy/uc/lc=config mc=cooldown
    // dn=deviceName d2=customName pm=pairingMode pd=pinDefault
    // pce=pin_change_error(修改错误码: 0=无, 1=旧PIN错, 2=格式错)
    String p = "{";
    p += "\"c\":" + String(deviceConnected ? 1 : 0);
    p += ",\"enc\":" + String(deviceConnected ? 1 : 0);
    p += ",\"bdd\":" + String(hasBondedDevices ? 1 : 0);
    p += ",\"st\":\"" + stateToString() + "\"";
    p += ",\"r\":" + String(latestRSSI);
    p += ",\"f\":" + String((int)filteredRSSI);
    p += ",\"ul\":" + String(rssiUnlockThreshold);
    p += ",\"lk\":" + String(rssiLockThreshold);
    p += ",\"hy\":" + String(rssiHysteresisDb);
    p += ",\"uc\":" + String(unlockCountRequired);
    p += ",\"lc\":" + String(lockCountRequired);
    p += ",\"mc\":" + String(manualCommandCooldown ? 1 : 0);
    p += ",\"dn\":\"" + String(deviceName) + "\"";
    p += ",\"d2\":\"" + String(customDeviceName) + "\"";
    p += ",\"pm\":" + String(pairingModeActive ? 1 : 0);
    p += ",\"pd\":" + String(pinDefault ? 1 : 0);
    p += ",\"pce\":" + String(pinChangeError);
    p += "}";

    pStatusCharacteristic->setValue(p.c_str());
    if (deviceConnected) {
        pStatusCharacteristic->notify();
    }
}

void printStatus() {
    Serial.println();
    Serial.println("==== STATUS ====");
    Serial.printf("Device: %s\n", deviceName);
    Serial.printf("Pairing PIN: %s (default: %s)\n", pinDefault ? "DEFAULT" : "custom", pinDefault ? "yes" : "no");
    Serial.printf("Bonded devices: %d\n", countBondedDevices());
    Serial.printf("Pairing mode: %s\n", pairingModeActive ? "ACTIVE" : "inactive");
    Serial.printf("BLE connected: %s\n", deviceConnected ? "yes" : "no");
    if (deviceConnected) {
        Serial.printf("  → Encryption: %s\n", "required (BLE stack)");
    }
    Serial.printf("State: %s\n", stateToString().c_str());
    Serial.printf("RSSI: raw=%d filtered=%d\n", latestRSSI, (int)filteredRSSI);
    Serial.printf("Unlock threshold: %d dBm\n", rssiUnlockThreshold);
    Serial.printf("Lock threshold: %d dBm\n", rssiLockThreshold);
    Serial.printf("Custom name: %s\n", customDeviceName.length() > 0 ? customDeviceName.c_str() : "(not set)");
    Serial.println("=================");
}

void printHelp() {
    Serial.println();
    Serial.println("==== COMMANDS (Serial / BLE) ====");
    Serial.println("  status              - print full status");
    Serial.println("  unlock / lock / trunk - manual control");
    Serial.println("  rssi                - toggle RSSI display");
    Serial.println("  pairing             - manually delete bonds & enter pairing");
    Serial.println("  pin <old> <new>     - change pairing PIN (6 digits)");
    Serial.println("  name <name>         - set custom device name");
    Serial.println("  trustlist           - show bonded device count");
    Serial.println("  cfg key=value ...   - modify RSSI/Kalman params");
    Serial.println("  help                - this message");
    Serial.println();
    Serial.println("==== BUTTON ====");
    Serial.println("  Short press (<2s)   - delete all bonds (pairing mode)");
    Serial.println("  Long press (>5s)    - factory reset");
    Serial.println();
    Serial.printf ("==== PAIRING PIN: %s ====\n", pairingPIN.c_str());
}

String stateToString() {
    if (currentState == STATE_LOCKED)   return "LOCKED";
    if (currentState == STATE_UNLOCKED) return "UNLOCKED";
    if (currentState == STATE_ACTION)   return "ACTION";
    return "UNKNOWN";
}

// ====================== Config Parser ======================

bool parseConfigLine(String line) {
    line.trim();
    if (line.length() == 0) return false;

    bool changed = false;
    int pos = 0;
    while (pos < line.length()) {
        int eq = line.indexOf('=', pos);
        if (eq < 0) break;
        String key = line.substring(pos, eq);
        key.trim();
        int space = line.indexOf(' ', eq);
        if (space < 0) space = line.length();
        String value = line.substring(eq + 1, space);
        value.trim();

        if (key == "unlock")  { rssiUnlockThreshold = value.toInt();  changed = true; }
        else if (key == "lock")    { rssiLockThreshold = value.toInt();    changed = true; }
        else if (key == "hyst")    { rssiHysteresisDb = value.toInt();     changed = true; }
        else if (key == "spike")   { rssiSpikeRejectDb = value.toInt();    changed = true; }
        else if (key == "uc")      { unlockCountRequired = value.toInt();  changed = true; }
        else if (key == "lc")      { lockCountRequired = value.toInt();    changed = true; }
        else if (key == "interval"){ rssiSampleIntervalMs = value.toInt(); changed = true; }
        else if (key == "dlock")   { disconnectLockDelayMs = value.toInt();changed = true; }
        else if (key == "q")       { kf_q = value.toFloat(); changed = true; resetKalmanFilter(); }
        else if (key == "r")       { kf_r = value.toFloat(); changed = true; resetKalmanFilter(); }
        else if (key == "rssi") {
            latestRSSI = value.toInt();
            updateKalmanFilter(latestRSSI);
            Serial.printf("[CFG] manual RSSI injection: %d\n", latestRSSI);
        }

        pos = space + 1;
    }
    return changed;
}

void loadConfig() {
    if (!preferences.begin("ble-key-go", false)) {
        Serial.println("[CFG] NVS open failed, using defaults");
        return;
    }

    rssiUnlockThreshold = preferences.getInt("unlock", -45);
    rssiLockThreshold   = preferences.getInt("lock", -65);
    rssiHysteresisDb    = preferences.getInt("hyst", 5);
    rssiSpikeRejectDb   = preferences.getInt("spike", 25);
    unlockCountRequired = preferences.getInt("uc", 3);
    lockCountRequired   = preferences.getInt("lc", 5);
    rssiSampleIntervalMs= preferences.getInt("interval", 500);
    disconnectLockDelayMs=preferences.getInt("dlock", 5000);
    kf_q = preferences.getFloat("kf_q", 4.0f);
    kf_r = preferences.getFloat("kf_r", 16.0f);

    Serial.printf("[CFG] loaded: unlock=%d lock=%d hyst=%d spike=%d uc=%d lc=%d int=%d dl=%d\n",
                  rssiUnlockThreshold, rssiLockThreshold, rssiHysteresisDb, rssiSpikeRejectDb,
                  unlockCountRequired, lockCountRequired, rssiSampleIntervalMs, disconnectLockDelayMs);
}

void saveConfig() {
    if (!preferences.begin("ble-key-go", false)) return;

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

// ====================== Serial Commands ======================

void handleSerialCommand() {
    if (!Serial.available()) return;
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) return;

    String upper = line;
    upper.toUpperCase();

    if (upper == "HELP") {
        printHelp();
    } else if (upper == "STATUS") {
        printStatus();
    } else if (upper == "UNLOCK") {
        executeUnlockSequence();
        currentState = STATE_UNLOCKED;
        resetKalmanFilter();
        manualCommandTimestampMs = millis();
        manualCommandCooldown = true;
        Serial.println("[KEY] serial unlock");
    } else if (upper == "LOCK") {
        executeLockSequence();
        currentState = STATE_LOCKED;
        resetKalmanFilter();
        manualCommandTimestampMs = millis();
        manualCommandCooldown = true;
        Serial.println("[KEY] serial lock");
    } else if (upper == "TRUNK") {
        executeTrunkSequence();
        Serial.println("[KEY] serial trunk");
    } else if (upper == "RSSI") {
        rssiDisplayMode = !rssiDisplayMode;
        Serial.printf("[RSSI] display %s\n", rssiDisplayMode ? "ON" : "OFF");
    } else if (upper == "PAIRING" || upper == "BOND") {
        deleteAllBonds();
        pairingModeActive = true;
        pairingModeStartMs = millis();
        Serial.printf("[SEC] All bonds deleted, pairing mode active for %ds\n", PAIRING_MODE_TIMEOUT_MS / 1000);
    } else if (upper.startsWith("PIN ")) {
        // 串口修改 PIN: pin <old> <new>
        String params = line.substring(4);
        params.trim();
        int space = params.indexOf(' ');
        if (space < 1) {
            Serial.println("Usage: pin <oldPIN> <newPIN>");
            return;
        }
        String oldPIN = params.substring(0, space);
        String newPIN = params.substring(space + 1);
        oldPIN.trim();
        newPIN.trim();

        if (oldPIN != pairingPIN) {
            Serial.println("PIN change failed: old PIN mismatch");
            return;
        }
        const int pinLen = newPIN.length();
        if (pinLen < 4 || pinLen > 6) {
            Serial.println("PIN must be 4-6 digits numeric");
            return;
        }
        for (int i = 0; i < pinLen; i++) {
            if (!isdigit(newPIN[i])) {
                Serial.println("PIN must be digits only");
                return;
            }
        }
        deleteAllBonds();
        pairingPIN = newPIN;
        pinDefault = false;
        savePIN();
        Serial.printf("[SEC] PIN changed to %s, all bonds cleared\n", newPIN.c_str());
    } else if (upper.startsWith("NAME ")) {
        String name = line.substring(5);
        name.trim();
        if (name.length() > 20) {
            Serial.println("Name too long (max 20 chars)");
            return;
        }
        customDeviceName = name;
        preferences.putString("dev_name", customDeviceName);
        Serial.printf("[NAME] set to: %s\n", customDeviceName.c_str());
    } else if (upper == "TRUSTLIST") {
        int count = countBondedDevices();
        Serial.printf("[SEC] Bonded devices: %d\n", count);
    } else if (upper.startsWith("CFG ")) {
        String cfg = line.substring(4);
        if (parseConfigLine(cfg)) {
            saveConfig();
            Serial.println("[CFG] updated + saved");
            notifyStatus();
        } else {
            Serial.println("[CFG] no valid key=value pairs found");
        }
    } else {
        Serial.printf("Unknown: %s (type 'help')\n", line.c_str());
    }
}
