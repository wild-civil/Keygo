/*
 * BLE-Key-Go v3.0 — 双层密码 + 信任列表
 *
 * ── v3.0 核心变更 ──────────────────────────────────────
 *   ● 双层密码体系：
 *     连接密码 (connPassword): 4-6位数字，默认 1234
 *     绑定密码 (bindPassword): 4-12位(支持中文)，默认 123456
 *   ● 信任列表：通过连接密码验证的 MAC 永久信任，下次免密直连
 *   ● 修改连接密码 → 清空信任列表（所有人需重新验证）
 *   ● 5 次错误连接密码 → 锁定 60 秒
 *   ● 移除：分享密钥整套机制（SHARE:GEN/AUTH/REVOKE）
 *   ● 移除：单 MAC 绑定（改为信任列表）
 *   ● 物理按键短按 → 30s 配对窗口（跳过所有密码）
 *
 * ── 安全流程 ──────────────────────────────────────────
 *   新 MAC 连接 → 输入连接密码（默认1234）
 *     ├─ 错误5次 → 锁定60s
 *     └─ 正确 → MAC入信任列表 → 输入绑定密码（默认123456）
 *                  ├─ 错误 → 断开+移出信任列表
 *                  └─ 正确 → 授权完成，进入控制
 *   已信任 MAC 连接 → 直通，跳过所有密码
 *   物理按键配对窗口 → 30s内免密码授权
 *
 * ── 继承 ──────────────────────────────────────────────
 *   ● 双栈 BLE（NimBLE + Bluedroid）
 *   ● RSSI 管线：尖峰丢弃 → 1D Kalman → 滞后状态机
 *   ● NOR Flash 持久化（Preferences NVS）
 *   ● 断连锁车 / 手动命令冷却
 */

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Preferences.h>
#include <esp_mac.h>

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
#define PIN_UNLOCK      2
#define PIN_LOCK        3
#define PIN_TRUNK       4
#define PIN_KEY_POWER   5
#define PIN_LED         8
#define PIN_BIND        9       // 物理配对按键（低电平触发，需外部上拉）

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

// ---------------- 1D Kalman filter for RSSI ----------------
float kf_q = 4.0f;
float kf_r = 16.0f;
float kf_x = -999;
float kf_p = 1.0f;
bool  kf_initialized = false;

float filteredRSSI = -999;
int   latestRSSI = -999;

int spikeConsecutiveCount = 0;
int spikeConsecutiveRequired = 2;

// ---------------- Security (v3.0) ----------------
#define PAIRING_MODE_TIMEOUT_MS   30000
#define FACTORY_RESET_HOLD_MS     5000
#define MAC_ADDR_MAX_LEN          18
#define DEFAULT_CONN_PWD          "1234"          // 出厂连接密码（4位数字）
#define DEFAULT_BIND_PWD          "123456"        // 出厂绑定密码（6位数字）
#define MAX_CONN_FAILS            5               // 最大连接密码错误次数
#define CONN_LOCKOUT_MS           60000           // 锁定60秒
#define UNAUTH_TIMEOUT_MS         120000          // 未授权连接2分钟超时

// ★ v3.0: 密码
String  connPassword = DEFAULT_CONN_PWD;           // 连接密码（NVS持久化）
String  bindPassword = DEFAULT_BIND_PWD;           // 绑定密码（NVS持久化）

// ★ v3.0: 信任列表（分号分隔的 MAC 字符串）
String  trustedMacs = "";

// ★ v3.0: 当前连接验证状态
bool    connectionAuthorized = false;              // 完全授权（可控制）
bool    connVerified = false;                      // 连接密码已验证
bool    bindVerified = false;                      // 绑定密码已验证

// ★ v3.0: 连接密码错误计数 + 锁定时钟
int           connFailCount = 0;
unsigned long connLockUntil = 0;                   // millis 锁定结束时间

// ★ 配对模式（物理按键触发）
bool          pairingModeActive = false;
unsigned long pairingModeStartMs = 0;

// ★ v3.1: 设备自定义名称
String  customDeviceName = "";                        // 用户自定义设备名

// ★ v3.1: 密码修改操作结果（用于 App 反馈）
int     lastOpResult = 0;                             // 0=idle 1=OK 2=old_pwd_err 3=fmt_err
int     lastOpType   = 0;                             // 0=none 1=conn_change 2=bind_change

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
void loadSecurity();                                // ★ v3.0: 加载密码+信任列表
void saveConnPassword();                            // ★ v3.0
void saveBindPassword();                            // ★ v3.0
void saveTrustList();                               // ★ v3.0
bool isConnDefault();                               // ★ v3.0
bool isBindDefault();                               // ★ v3.0
void printStatus();
void printHelp();
void notifyStatus();
String stateToString();
String macToString(const uint8_t* mac, int len);
void startAdvertising();
bool parseConfigLine(String line);

// ★ v3.0: 信任列表管理
bool isMacTrusted(const uint8_t* mac, int len);
void addMacToTrustList(const uint8_t* mac, int len);
void removeMacFromTrustList(const uint8_t* mac, int len);
void clearTrustList();

// ★ v3.0: 获取当前连接的远端 MAC 字符串
String getRemoteMac();

// ---- Bluedroid GAP RSSI callback ----
#if BLE_KEY_GO_STACK_BLUEDROID
static void gapEventHandler(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t* param) {
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

// ---- Server callbacks (dual-stack) ----
class ServerCallbacks : public BLEServerCallbacks {
#if BLE_KEY_GO_STACK_BLUEDROID
    void onConnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
        deviceConnected = true;
        connectionId = param->connect.conn_id;
        memcpy(connectedRemoteAddress, param->connect.remote_bda, sizeof(esp_bd_addr_t));

        // ★ v3.0: 信任列表检查
        bool trusted = isMacTrusted(param->connect.remote_bda, sizeof(esp_bd_addr_t));
        bool inPairing = pairingModeActive;

        if (trusted || inPairing) {
            connectionAuthorized = true;
            connVerified = true;
            bindVerified = true;
            connFailCount = 0;  // 重置错误计数
            Serial.printf("[SEC] %s authorized (trusted=%s pairing=%s) addr=%s\n",
                          inPairing ? "Pairing mode:" : "Trusted MAC:",
                          trusted ? "yes" : "no",
                          inPairing ? "yes" : "no",
                          macToString(param->connect.remote_bda, sizeof(esp_bd_addr_t)).c_str());
        } else {
            connectionAuthorized = false;
            connVerified = false;
            bindVerified = false;
            Serial.printf("[SEC] New MAC connected: %s → needs CONN password\n",
                          macToString(param->connect.remote_bda, sizeof(esp_bd_addr_t)).c_str());
        }

        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
    }

    void onDisconnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
        deviceConnected = false;
        connectionAuthorized = false;
        connVerified = false;
        bindVerified = false;
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
        memcpy(nimblePeerAddr, desc->peer_id_addr.val, 6);

        bool trusted = isMacTrusted(desc->peer_id_addr.val, 6);
        bool inPairing = pairingModeActive;

        if (trusted || inPairing) {
            connectionAuthorized = true;
            connVerified = true;
            bindVerified = true;
            connFailCount = 0;
            Serial.printf("[SEC] %s authorized (trusted=%s pairing=%s) addr=%s\n",
                          inPairing ? "Pairing mode:" : "Trusted MAC:",
                          trusted ? "yes" : "no",
                          inPairing ? "yes" : "no",
                          macToString(desc->peer_id_addr.val, 6).c_str());
        } else {
            connectionAuthorized = false;
            connVerified = false;
            bindVerified = false;
            Serial.printf("[SEC] New MAC connected: %s → needs CONN password\n",
                          macToString(desc->peer_id_addr.val, 6).c_str());
        }

        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
    }

    void onDisconnect(BLEServer* server, ble_gap_conn_desc* desc) override {
        deviceConnected = false;
        connectionAuthorized = false;
        connVerified = false;
        bindVerified = false;
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
        connectionAuthorized = true;
        connVerified = true;
        bindVerified = true;
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
        connVerified = false;
        bindVerified = false;
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
            Serial.println("[SEC] config write rejected: not authorized");
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
public:
    void onWrite(BLECharacteristic* characteristic) override {
        String cmd = characteristic->getValue().c_str();
        cmd.trim();
        String upper = cmd;
        upper.toUpperCase();

        // ★ v3.0: CONN / BIND 不需要鉴权（用于首次验证流程）
        if (upper.startsWith("CONN:")) {
            handleConnPassword(cmd.substring(5));
            return;
        }
        if (upper.startsWith("BIND:")) {
            handleBindPassword(cmd.substring(5));
            return;
        }

        // ★ v3.0: 其余命令需鉴权
        if (!connectionAuthorized) {
            Serial.printf("[SEC] command '%s' rejected: not authorized\n", cmd.c_str());
            return;
        }

        // ★ v3.0: 修改密码（需鉴权）
        if (upper.startsWith("CHCONN:")) {
            handleConnChange(cmd.substring(7));
            return;
        }
        if (upper.startsWith("CHBIND:")) {
            handleBindChange(cmd.substring(7));
            return;
        }
        // ★ v3.1: 设置设备名称
        if (upper.startsWith("NAME:")) {
            handleSetName(cmd.substring(5));
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

    // ★ v3.0: 验证连接密码
    void handleConnPassword(String enteredPassword) {
        enteredPassword.trim();

        // 检查锁定
        if (connLockUntil > 0 && millis() < connLockUntil) {
            unsigned long remain = (connLockUntil - millis()) / 1000;
            Serial.printf("[SEC] CONN locked: %lu seconds remaining\n", remain);
            notifyStatus();
            return;
        }
        // 锁定到期自动解除
        if (connLockUntil > 0 && millis() >= connLockUntil) {
            connLockUntil = 0;
            connFailCount = 0;
        }

        if (!deviceConnected) {
            Serial.println("[SEC] CONN failed: no device connected");
            return;
        }

        if (enteredPassword == connPassword) {
            connVerified = true;
            connFailCount = 0;
            // ★ 将此 MAC 加入信任列表
            addConnectedMacToTrustList();
            Serial.println("[SEC] CONN password OK → MAC added to trust list");
        } else {
            connFailCount++;
            Serial.printf("[SEC] CONN password FAILED (%d/%d) entered='%s'\n",
                          connFailCount, MAX_CONN_FAILS, enteredPassword.c_str());
            if (connFailCount >= MAX_CONN_FAILS) {
                connLockUntil = millis() + CONN_LOCKOUT_MS;
                Serial.printf("[SEC] CONN LOCKED for %d seconds!\n", CONN_LOCKOUT_MS / 1000);
                pServer->disconnect(connectionId);
            }
        }
        notifyStatus();
    }

    // ★ v3.0: 验证绑定密码
    void handleBindPassword(String enteredPassword) {
        enteredPassword.trim();

        if (!deviceConnected) {
            Serial.println("[SEC] BIND failed: no device connected");
            return;
        }

        if (enteredPassword == bindPassword) {
            bindVerified = true;
            connectionAuthorized = true;
            Serial.println("[SEC] BIND password OK → fully authorized");
        } else {
            Serial.printf("[SEC] BIND password FAILED entered='%s'\n", enteredPassword.c_str());
            // 移出信任列表 + 断开
            removeConnectedMacFromTrustList();
            pServer->disconnect(connectionId);
        }
        notifyStatus();
    }

    // ★ v3.0: 修改连接密码: CHCONN:old:new
    void handleConnChange(String params) {
        params.trim();
        int colon = params.indexOf(':');
        if (colon < 1) {
            Serial.println("[SEC] CHCONN format: CHCONN:oldPassword:newPassword");
            lastOpResult = 3; lastOpType = 1;  // ★ fmt_err
            notifyStatus();
            return;
        }
        String oldPwd = params.substring(0, colon);
        String newPwd = params.substring(colon + 1);
        oldPwd.trim();
        newPwd.trim();

        if (oldPwd != connPassword) {
            Serial.println("[SEC] CHCONN failed: old password mismatch");
            lastOpResult = 2; lastOpType = 1;  // ★ old_pwd_err
            notifyStatus();
            return;
        }
        if (newPwd.length() < 4 || newPwd.length() > 6) {
            Serial.println("[SEC] CHCONN failed: new password must be 4-6 digits");
            lastOpResult = 3; lastOpType = 1;  // ★ fmt_err
            notifyStatus();
            return;
        }

        connPassword = newPwd;
        saveConnPassword();
        // ★ 修改连接密码 → 清空信任列表
        clearTrustList();
        lastOpResult = 1; lastOpType = 1;      // ★ success
        Serial.printf("[SEC] CONN password changed, trust list cleared (default: %s)\n",
                      isConnDefault() ? "yes" : "no");
        notifyStatus();
    }

    // ★ v3.0: 修改绑定密码: CHBIND:old:new
    void handleBindChange(String params) {
        params.trim();
        int colon = params.indexOf(':');
        if (colon < 1) {
            Serial.println("[SEC] CHBIND format: CHBIND:oldPassword:newPassword");
            lastOpResult = 3; lastOpType = 2;  // ★ fmt_err
            notifyStatus();
            return;
        }
        String oldPwd = params.substring(0, colon);
        String newPwd = params.substring(colon + 1);
        oldPwd.trim();
        newPwd.trim();

        if (oldPwd != bindPassword) {
            Serial.println("[SEC] CHBIND failed: old password mismatch");
            lastOpResult = 2; lastOpType = 2;  // ★ old_pwd_err
            notifyStatus();
            return;
        }
        if (newPwd.length() < 4 || newPwd.length() > 36) {
            Serial.println("[SEC] CHBIND failed: new password must be 4-12 chars (max 36 bytes)");
            lastOpResult = 3; lastOpType = 2;  // ★ fmt_err
            notifyStatus();
            return;
        }

        bindPassword = newPwd;
        saveBindPassword();
        // ★ 修改绑定密码不影响信任列表
        lastOpResult = 1; lastOpType = 2;      // ★ success
        Serial.printf("[SEC] BIND password changed (default: %s)\n",
                      isBindDefault() ? "yes" : "no");
        notifyStatus();
    }

    // ★ v3.1: 设置设备自定义名称: NAME:xxx
    void handleSetName(String name) {
        name.trim();
        if (name.length() > 20) {
            Serial.println("[NAME] too long (max 20 chars)");
            lastOpResult = 3; lastOpType = 3;
            notifyStatus();
            return;
        }
        customDeviceName = name;
        preferences.putString("dev_name", customDeviceName);
        lastOpResult = 1; lastOpType = 3;
        Serial.printf("[NAME] set to: %s\n", customDeviceName.c_str());
        notifyStatus();
    }

private:
    // ★ 将当前连接 MAC 加入信任列表
    void addConnectedMacToTrustList() {
        String mac = getRemoteMac();
        if (mac.length() > 0 && mac != "00:00:00:00:00:00") {
            addMacToTrustListStr(mac);
        }
    }

    // ★ 从信任列表移除当前连接 MAC
    void removeConnectedMacFromTrustList() {
        String mac = getRemoteMac();
        if (mac.length() > 0) {
            removeMacFromTrustListStr(mac);
        }
    }

    void addMacToTrustListStr(String mac) {
        mac.toUpperCase();
        if (trustedMacs.indexOf(mac) >= 0) return; // 已存在
        if (trustedMacs.length() > 0) trustedMacs += ";";
        trustedMacs += mac;
        saveTrustList();
        Serial.printf("[SEC] MAC added to trust list: %s\n", mac.c_str());
    }

    void removeMacFromTrustListStr(String mac) {
        mac.toUpperCase();
        int idx = trustedMacs.indexOf(mac);
        if (idx < 0) return;
        // 移除该 MAC 及可能的前导分号
        int endIdx = idx + mac.length();
        if (idx > 0 && trustedMacs.charAt(idx - 1) == ';') {
            idx--;
        }
        if (endIdx < trustedMacs.length() && trustedMacs.charAt(endIdx) == ';') {
            endIdx++;
        }
        trustedMacs.remove(idx, endIdx - idx);
        // 清理多余的尾部分号
        while (trustedMacs.endsWith(";")) {
            trustedMacs.remove(trustedMacs.length() - 1);
        }
        saveTrustList();
        Serial.printf("[SEC] MAC removed from trust list: %s\n", mac.c_str());
    }
};

// ---- GATT 回调实例（全局访问） ----
CommandCallbacks* g_commandCallbacks = nullptr;

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
    Serial.println("  BLE-Key-Go v3.0 starting...");
    Serial.printf ("  Device: %s\n", deviceName);
    Serial.println("  Dual Password + Trust List Security");
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
    loadSecurity();           // ★ v3.0: 加载密码+信任列表

    Serial.println();
    Serial.printf("==== BLE-Key-Go v3.0 | Device: %s ====\n", deviceName);
#if BLE_KEY_GO_STACK_BLUEDROID
    Serial.println("[BUILD] Stack: Bluedroid, Native RSSI: enabled (async)");
#elif BLE_KEY_GO_STACK_NIMBLE
    Serial.println("[BUILD] Stack: NimBLE, Native RSSI: enabled (sync)");
#else
    Serial.println("[BUILD] Stack: unknown, Native RSSI: unavailable (manual mode)");
#endif
    Serial.printf("[FILTER] Kalman q=%.1f r=%.1f, spike=%ddB, hyst=%ddB\n",
                  kf_q, kf_r, rssiSpikeRejectDb, rssiHysteresisDb);
    Serial.printf("[SEC] Conn password default: %s\n", isConnDefault() ? "YES" : "no");
    Serial.printf("[SEC] Bind password default: %s\n", isBindDefault() ? "YES" : "no");
    Serial.printf("[SEC] Trust list: %d MACs\n", countTrustedMacs());
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
    g_commandCallbacks = cmdCb;
    commandCharacteristic->setCallbacks(cmdCb);

    service->start();
    startAdvertising();
    notifyStatus();

    Serial.printf("[BLE] advertising as %s, service %s\n", deviceName, SERVICE_UUID);
}

void loop() {
    handleSerialCommand();
    handleBindButton();

    // ★ v3.0: 未授权连接超时检测
    {
        static unsigned long unauthConnectedAt = 0;
        if (deviceConnected && !connectionAuthorized) {
            if (unauthConnectedAt == 0) unauthConnectedAt = millis();
            if (millis() - unauthConnectedAt > UNAUTH_TIMEOUT_MS) {
                Serial.println("[SEC] unauthorized timeout (120s) — disconnecting");
                pServer->disconnect(connectionId);
                unauthConnectedAt = 0;
            }
        } else {
            unauthConnectedAt = 0;
        }
    }

    // ★ v3.0: 连接密码锁定检测
    if (connLockUntil > 0 && millis() >= connLockUntil) {
        connLockUntil = 0;
        connFailCount = 0;
        Serial.println("[SEC] CONN lockout expired");
    }

    // ★ 配对模式超时
    if (pairingModeActive && millis() - pairingModeStartMs >= PAIRING_MODE_TIMEOUT_MS) {
        pairingModeActive = false;
        Serial.println("[SEC] pairing mode timeout");
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

// ====================== Security Functions (v3.0) ======================

String getRemoteMac() {
#if BLE_KEY_GO_STACK_BLUEDROID
    return macToString(connectedRemoteAddress, 6);
#elif BLE_KEY_GO_STACK_NIMBLE
    return macToString(nimblePeerAddr, 6);
#else
    return "";
#endif
}

bool isMacTrusted(const uint8_t* mac, int len) {
    if (trustedMacs.length() == 0) return false;
    String remote = macToString(mac, len);
    remote.toUpperCase();
    return trustedMacs.indexOf(remote) >= 0;
}

void clearTrustList() {
    trustedMacs = "";
    saveTrustList();
    Serial.println("[SEC] trust list cleared");
}

int countTrustedMacs() {
    if (trustedMacs.length() == 0) return 0;
    int count = 1;
    for (int i = 0; i < trustedMacs.length(); i++) {
        if (trustedMacs.charAt(i) == ';') count++;
    }
    return count;
}

String macToString(const uint8_t* mac, int len) {
    if (len < 1) return "??";
    char buf[MAC_ADDR_MAX_LEN];
    snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return String(buf);
}

// ---- NVS 加载/保存 ----
void loadSecurity() {
    connPassword = preferences.getString("conn_pwd", DEFAULT_CONN_PWD);
    bindPassword = preferences.getString("bind_pwd", DEFAULT_BIND_PWD);
    trustedMacs  = preferences.getString("trust_list", "");
    customDeviceName = preferences.getString("dev_name", "");     // ★ v3.1
    Serial.printf("[SEC] loaded: conn_pwd %s default, bind_pwd %s default, %d trusted MACs\n",
                  isConnDefault() ? "IS" : "NOT",
                  isBindDefault() ? "IS" : "NOT",
                  countTrustedMacs());
}

void saveConnPassword() {
    preferences.putString("conn_pwd", connPassword);
}

void saveBindPassword() {
    preferences.putString("bind_pwd", bindPassword);
}

void saveTrustList() {
    if (trustedMacs.length() > 0) {
        preferences.putString("trust_list", trustedMacs);
    } else {
        preferences.remove("trust_list");
    }
}

bool isConnDefault() {
    return connPassword == DEFAULT_CONN_PWD;
}

bool isBindDefault() {
    return bindPassword == DEFAULT_BIND_PWD;
}

// ★ 物理按键处理
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
            clearTrustList();
            connPassword = DEFAULT_CONN_PWD;
            bindPassword = DEFAULT_BIND_PWD;
            saveConnPassword();
            saveBindPassword();
            preferences.clear();
            saveConnPassword();
            saveBindPassword();
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
            connFailCount = 0;
            connLockUntil = 0;

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
            Serial.printf("[SEC] pairing mode active for %d seconds\n",
                          PAIRING_MODE_TIMEOUT_MS / 1000);
            Serial.println("[SEC] any device may connect now — all passwords bypassed");
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

    // 连接密码锁定中 → 500ms 双闪
    if (connLockUntil > 0) {
        if (millis() - lastBlinkMs >= 250) {
            lastBlinkMs = millis();
            ledState = !ledState;
            digitalWrite(PIN_LED, ledState);
        }
        return;
    }

    // 未授权连接中 → 500ms 快闪
    if (deviceConnected && !connectionAuthorized) {
        if (millis() - lastBlinkMs >= 500) {
            lastBlinkMs = millis();
            ledState = !ledState;
            digitalWrite(PIN_LED, ledState);
        }
        return;
    }

    // 信任列表为空（新设备/未绑定过）→ 每秒慢闪
    if (trustedMacs.length() == 0) {
        if (millis() - lastBlinkMs >= 1000) {
            lastBlinkMs = millis();
            ledState = !ledState;
            digitalWrite(PIN_LED, ledState);
        }
        return;
    }

    // 有信任设备、未连接 → 2 秒悠闲闪
    if (millis() - lastBlinkMs >= 2000) {
        lastBlinkMs = millis();
        ledState = !ledState;
        digitalWrite(PIN_LED, ledState);
    }
}

// ====================== Serial Commands ======================

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
        pairingModeActive = true;
        pairingModeStartMs = millis();
        Serial.printf("[SEC] pairing mode active for %d seconds\n", PAIRING_MODE_TIMEOUT_MS / 1000);
    } else if (upper.startsWith("CONN ")) {
        // 串口验证连接密码: "conn 1234"
        String pwd = cmd.substring(5);
        pwd.trim();
        if (g_commandCallbacks) {
            g_commandCallbacks->handleConnPassword(pwd);
        }
    } else if (upper.startsWith("BIND ")) {
        // 串口验证绑定密码: "bind 123456"
        String pwd = cmd.substring(5);
        pwd.trim();
        if (g_commandCallbacks) {
            g_commandCallbacks->handleBindPassword(pwd);
        }
    } else if (upper.startsWith("CHCONN ")) {
        // 串口修改连接密码: "chconn oldPassword newPassword"
        String params = cmd.substring(7);
        params.trim();
        int space = params.indexOf(' ');
        if (space > 0) {
            String oldPwd = params.substring(0, space);
            String newPwd = params.substring(space + 1);
            if (g_commandCallbacks) {
                g_commandCallbacks->handleConnChange(oldPwd + ":" + newPwd);
            }
        } else {
            Serial.println("[SEC] CHCONN format: chconn oldPassword newPassword");
        }
    } else if (upper.startsWith("CHBIND ")) {
        // 串口修改绑定密码: "chbind oldPassword newPassword"
        String params = cmd.substring(7);
        params.trim();
        int space = params.indexOf(' ');
        if (space > 0) {
            String oldPwd = params.substring(0, space);
            String newPwd = params.substring(space + 1);
            if (g_commandCallbacks) {
                g_commandCallbacks->handleBindChange(oldPwd + ":" + newPwd);
            }
        } else {
            Serial.println("[SEC] CHBIND format: chbind oldPassword newPassword");
        }
    } else if (upper == "TRUSTLIST") {
        // 串口查看信任列表
        if (trustedMacs.length() == 0) {
            Serial.println("[SEC] trust list: empty");
        } else {
            Serial.printf("[SEC] trust list (%d MACs):\n", countTrustedMacs());
            String copy = trustedMacs;
            int pos = 0;
            int idx = 0;
            while ((pos = copy.indexOf(';')) >= 0) {
                Serial.printf("  [%d] %s\n", idx++, copy.substring(0, pos).c_str());
                copy = copy.substring(pos + 1);
            }
            if (copy.length() > 0) {
                Serial.printf("  [%d] %s\n", idx++, copy.c_str());
            }
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

    // ★ 用短键名压缩 JSON，避免 BLE MTU 截断
    // c=connected a=authorized b=bound st=state r=rssi f=filtered
    // ul=unlock lk=lock hy=hyst uc/lc 不变, mc=manualCooldown
    // dn=deviceName pm=pairingMode cv/cn/bn/bv=密码状态 cl/cs=锁定 cd/bd=默认提示 tc=信任数
    // d2=customName lr=lastOpResult lo=lastOpType
    String p = "{";
    p += "\"c\":" + String(deviceConnected ? 1 : 0);
    p += ",\"a\":" + String(connectionAuthorized ? 1 : 0);
    p += ",\"b\":" + String(isBindDefault() ? 0 : 1);
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
    p += ",\"d2\":\"" + String(customDeviceName) + "\"";    // ★ v3.1: 自定义名称
    p += ",\"pm\":" + String(pairingModeActive ? 1 : 0);
    p += ",\"cv\":" + String(connVerified ? 1 : 0);
    p += ",\"cn\":" + String((!connVerified && deviceConnected) ? 1 : 0);
    p += ",\"bn\":" + String((connVerified && !bindVerified && deviceConnected) ? 1 : 0);
    p += ",\"bv\":" + String(bindVerified ? 1 : 0);
    p += ",\"cl\":" + String((connLockUntil > 0 && millis() < connLockUntil) ? 1 : 0);
    p += ",\"cs\":" + String((connLockUntil > 0 && millis() < connLockUntil) ? (int)((connLockUntil - millis()) / 1000) : 0);
    p += ",\"cd\":" + String(isConnDefault() ? 1 : 0);
    p += ",\"bd\":" + String(isBindDefault() ? 1 : 0);
    p += ",\"tc\":" + String(countTrustedMacs());
    p += ",\"lr\":" + String(lastOpResult);                    // ★ v3.1
    p += ",\"lo\":" + String(lastOpType);                      // ★ v3.1
    p += "}";

    // ★ v3.1: 单次通知后重置操作结果（App 已读取）
    if (lastOpResult > 0) {
        lastOpResult = 0;
        lastOpType = 0;
    }

    pStatusCharacteristic->setValue(p.c_str());
    if (deviceConnected) {
        pStatusCharacteristic->notify();
    }
}

void printStatus() {
    Serial.println();
    Serial.println("==== STATUS ====");
    Serial.printf("Device: %s\n", deviceName);
    Serial.printf("Conn password: %s (default: %s)\n", isConnDefault() ? "DEFAULT" : "custom", isConnDefault() ? "yes" : "no");
    Serial.printf("Bind password: %s (default: %s)\n", isBindDefault() ? "DEFAULT" : "custom", isBindDefault() ? "yes" : "no");
    Serial.printf("Trust list: %d MACs\n", countTrustedMacs());
    Serial.printf("Pairing mode: %s\n", pairingModeActive ? "ACTIVE" : "inactive");
    Serial.printf("Conn locked: %s\n", (connLockUntil > 0 && millis() < connLockUntil) ? "YES" : "no");
    Serial.printf("BLE connected: %s\n", deviceConnected ? "yes" : "no");
    if (deviceConnected) {
        Serial.printf("  → Authorized: %s\n", connectionAuthorized ? "yes" : "NO");
        Serial.printf("  → Conn verified: %s\n", connVerified ? "yes" : "no");
        Serial.printf("  → Bind verified: %s\n", bindVerified ? "yes" : "no");
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
    Serial.println();
}

void printHelp() {
    Serial.println("Commands:");
    Serial.println("  status    rssi    unlock    lock    trunk    pairing    trustlist");
    Serial.println("  conn <pwd>       bind <pwd>");
    Serial.println("  chconn <old> <new>   chbind <old> <new>");
    Serial.println("  cfg unlock=-45 lock=-65 hyst=5 spike=25 uc=3 lc=5");
    Serial.println("              interval=500 dlock=5000 q=4 r=16");
    Serial.println("  cfg rssi=-40     (manual RSSI injection for test)");
    Serial.println();
    Serial.println("nRF Connect / App:");
    Serial.printf ("  Scan for service UUID: %s\n", SERVICE_UUID);
    Serial.printf ("  Device name: %s\n", deviceName);
    Serial.println("  Write FF03: UNLOCK / LOCK / TRUNK / STATUS  (requires authorization)");
    Serial.println("  Write FF03: CONN:<password>  (verify connection password)");
    Serial.println("  Write FF03: BIND:<password>  (verify bind password)");
    Serial.println("  Write FF03: CHCONN:<old>:<new> / CHBIND:<old>:<new>  (change passwords)");
    Serial.println("  Write FF03: NAME:<name>                          (set device name, max 20 chars)");
    Serial.println();
    Serial.println("Security:");
    Serial.println("  Default conn password: 1234 (change with CHCONN → clears trust list)");
    Serial.println("  Default bind password: 123456 (change with CHBIND)");
    Serial.println("  5 wrong conn attempts → 60s lockout");
    Serial.println();
    Serial.println("Hardware (PIN 9):");
    Serial.println("  Short press (<2s): pairing mode (30s, bypasses all passwords)");
    Serial.println("  Long press (>5s):  factory reset (clears everything, then restart)");
    Serial.println();
}
