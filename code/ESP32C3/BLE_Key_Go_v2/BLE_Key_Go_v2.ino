/*
 * BLE-Key-Go v2 - ESP32-C3 Peripheral RSSI validation firmware
 *
 * Goal:
 *   - ESP32-C3 advertises as a BLE peripheral.
 *   - Phone connects with nRF Connect or a future app.
 *   - ESP32 reads connection RSSI and runs hysteresis logic locally.
 *   - Existing MOS/key timing from v1 is preserved.
 *
 * RSSI reading strategy (dual-stack):
 *   - NimBLE (ESP32-C3 default in 3.3.x):
 *       ble_gap_conn_rssi() synchronous read via conn_handle from onConnect(desc)
 *   - Bluedroid (ESP32, S2, S3):
 *       esp_ble_gap_read_rssi() async + gapEventHandler callback
 */

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Preferences.h>

// ---- Determine BLE stack and include appropriate headers ----
#if defined(CONFIG_BLUEDROID_ENABLED)
  #include <esp_gap_ble_api.h>
  #define BLE_KEY_GO_HAS_NATIVE_RSSI   1
  #define BLE_KEY_GO_STACK_BLUEDROID   1
  #define BLE_KEY_GO_STACK_NIMBLE      0
#elif defined(CONFIG_NIMBLE_ENABLED)
  // NimBLE: ble_gap_conn_rssi() declared in ble_gap.h (already included by BLEDevice.h)
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

#define NMOS_ON    HIGH
#define NMOS_OFF   LOW
#define PMOS_ON    LOW
#define PMOS_OFF   HIGH

// ---------------- BLE UUIDs ----------------
#define DEVICE_NAME        "BLE-Key-Go-v2"
#define SERVICE_UUID       "0000ff00-0000-1000-8000-00805f9b34fb"
#define CONFIG_CHAR_UUID   "0000ff01-0000-1000-8000-00805f9b34fb"
#define STATUS_CHAR_UUID   "0000ff02-0000-1000-8000-00805f9b34fb"
#define COMMAND_CHAR_UUID  "0000ff03-0000-1000-8000-00805f9b34fb"

// ---------------- Tunable parameters ----------------
int rssiUnlockThreshold = -45;
int rssiLockThreshold = -65;
int unlockCountRequired = 5;
int lockCountRequired = 10;
int rssiSampleIntervalMs = 500;
int disconnectLockDelayMs = 5000;

int keyPowerUpDelayMs = 200;
int keyPressDurationMs = 300;
int keyReleaseDelayMs = 500;

// ---------------- RSSI filter ----------------
#define RSSI_FILTER_WINDOW 5
int rssiBuffer[RSSI_FILTER_WINDOW];
int rssiBufferIndex = 0;
int rssiBufferCount = 0;
int filteredRSSI = -999;
int latestRSSI = -999;

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
#define MANUAL_COMMAND_COOLDOWN_MS 8000  // 手动命令后 8 秒内状态机不介入
bool nativeRssiWarningPrinted = false;

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
void readConnectionRssi();
void updateRssiFilter(int newRssi);
void resetRssiFilter();
void loadConfig();
void saveConfig();
void printStatus();
void printHelp();
void notifyStatus();
String stateToString();
void startAdvertising();
bool parseConfigLine(String line);

// ---- Bluedroid GAP RSSI callback ----
#if BLE_KEY_GO_STACK_BLUEDROID
static void gapEventHandler(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t* param) {
    if (event != ESP_GAP_BLE_READ_RSSI_COMPLETE_EVT) return;

    if (param->read_rssi_cmpl.status == ESP_BT_STATUS_SUCCESS) {
        latestRSSI = param->read_rssi_cmpl.rssi;
        updateRssiFilter(latestRSSI);

        if (rssiDisplayMode) {
            Serial.printf("[RSSI] raw=%d filtered=%d state=%s\n",
                          latestRSSI, filteredRSSI, stateToString().c_str());
        }
    } else {
        Serial.printf("[RSSI] read failed, status=%d\n", param->read_rssi_cmpl.status);
    }
}
#endif

// ---- Server callbacks (dual-stack) ----
class ServerCallbacks : public BLEServerCallbacks {
public:
    // ---- Bluedroid: onConnect with extended param ----
#if BLE_KEY_GO_STACK_BLUEDROID
    void onConnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
        deviceConnected = true;
        connectionId = param->connect.conn_id;
        memcpy(connectedRemoteAddress, param->connect.remote_bda, sizeof(esp_bd_addr_t));
        resetRssiFilter();
        unlockCounter = 0;
        lockCounter = 0;
        Serial.printf("[BLE] phone connected (Bluedroid), conn_id=%u\n", connectionId);
    }

    void onDisconnect(BLEServer* server, esp_ble_gatts_cb_param_t* param) override {
        deviceConnected = false;
        latestRSSI = -999;
        disconnectTimestampMs = millis();
        resetRssiFilter();
        unlockCounter = 0;
        lockCounter = 0;
        Serial.println("[BLE] phone disconnected, advertising restarted");
        startAdvertising();
    }
#endif

    // ---- NimBLE: onConnect with connection descriptor ----
#if BLE_KEY_GO_STACK_NIMBLE
    void onConnect(BLEServer* server, ble_gap_conn_desc* desc) override {
        deviceConnected = true;
        nimbleConnHandle = desc->conn_handle;
        connectionId = desc->conn_handle;  // reuse for logging
        resetRssiFilter();
        unlockCounter = 0;
        lockCounter = 0;
        Serial.printf("[BLE] phone connected (NimBLE), conn_handle=%u\n", nimbleConnHandle);
    }

    void onDisconnect(BLEServer* server, ble_gap_conn_desc* desc) override {
        deviceConnected = false;
        latestRSSI = -999;
        nimbleConnHandle = 0;
        disconnectTimestampMs = millis();
        resetRssiFilter();
        unlockCounter = 0;
        lockCounter = 0;
        Serial.println("[BLE] phone disconnected, advertising restarted");
        startAdvertising();
    }
#endif

    // ---- Fallback: basic onConnect (should never be called if stack is known) ----
#if !BLE_KEY_GO_STACK_BLUEDROID && !BLE_KEY_GO_STACK_NIMBLE
    void onConnect(BLEServer* server) override {
        deviceConnected = true;
        resetRssiFilter();
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
        resetRssiFilter();
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
    void onWrite(BLECharacteristic* characteristic) override {
        String cmd = characteristic->getValue().c_str();
        cmd.trim();
        cmd.toUpperCase();

        if (cmd == "UNLOCK") {
            executeUnlockSequence();
            currentState = STATE_UNLOCKED;
            resetRssiFilter();
            manualCommandTimestampMs = millis();
            manualCommandCooldown = true;
            Serial.println("[STATE] manual unlock, RSSI state machine paused 8s");
        } else if (cmd == "LOCK") {
            executeLockSequence();
            currentState = STATE_LOCKED;
            resetRssiFilter();
            manualCommandTimestampMs = millis();
            manualCommandCooldown = true;
            Serial.println("[STATE] manual lock, RSSI state machine paused 8s");
        } else if (cmd == "TRUNK") {
            executeTrunkSequence();
            // 后备箱不改变锁状态，不需要冷却
        } else if (cmd == "STATUS") {
            notifyStatus();
        } else {
            Serial.printf("[BLE] unknown command: %s\n", cmd.c_str());
        }
    }
};

void setup() {
    // ---- Early LED blink: confirm program is running ----
    pinMode(PIN_LED, OUTPUT);
    for (int i = 0; i < 3; i++) {
        digitalWrite(PIN_LED, HIGH);
        delay(150);
        digitalWrite(PIN_LED, LOW);
        delay(150);
    }

    Serial.begin(115200);
    Serial.setTimeout(50);
    // ESP32-C3 USB CDC may need extra time to enumerate
    delay(2000);

    // Print banner (should appear even if BLE init fails)
    Serial.println();
    Serial.println("============================================");
    Serial.println("  BLE-Key-Go v2 starting...");
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

    resetRssiFilter();
    loadConfig();

    Serial.println();
    Serial.println("==== BLE-Key-Go v2 Peripheral RSSI Validation ====");
#if BLE_KEY_GO_STACK_BLUEDROID
    Serial.println("[BUILD] Stack: Bluedroid, Native RSSI: enabled (async)");
#elif BLE_KEY_GO_STACK_NIMBLE
    Serial.println("[BUILD] Stack: NimBLE, Native RSSI: enabled (sync)");
#else
    Serial.println("[BUILD] Stack: unknown, Native RSSI: unavailable (manual mode)");
#endif
    printHelp();

    BLEDevice::init(DEVICE_NAME);

#if BLE_KEY_GO_STACK_BLUEDROID
    BLEDevice::setCustomGapHandler(gapEventHandler);
#endif
    // NimBLE: no need to set custom GAP handler — we use ble_gap_conn_rssi() directly

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
    commandCharacteristic->setCallbacks(new CommandCallbacks());

    service->start();
    startAdvertising();
    notifyStatus();

    Serial.printf("[BLE] advertising as %s\n", DEVICE_NAME);
}

void loop() {
    handleSerialCommand();

    if (deviceConnected && millis() - lastRssiReadMs >= (unsigned long)rssiSampleIntervalMs) {
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

void startAdvertising() {
    BLEAdvertising* advertising = BLEDevice::getAdvertising();
    advertising->addServiceUUID(SERVICE_UUID);
    advertising->setScanResponse(true);
    advertising->setMinPreferred(0x06);
    advertising->setMaxPreferred(0x12);
    BLEDevice::startAdvertising();
}

void readConnectionRssi() {
    if (!deviceConnected) return;

#if BLE_KEY_GO_STACK_NIMBLE
    // NimBLE: synchronous read — simple and direct
    if (nimbleConnHandle == 0) return;
    int8_t rssi = 0;
    int rc = ble_gap_conn_rssi(nimbleConnHandle, &rssi);
    if (rc == 0) {
        latestRSSI = rssi;
        updateRssiFilter(latestRSSI);
        if (rssiDisplayMode) {
            Serial.printf("[RSSI] raw=%d filtered=%d state=%s\n",
                          latestRSSI, filteredRSSI, stateToString().c_str());
        }
    } else {
        // Only print first few failures to avoid spam
        static int failCount = 0;
        if (failCount < 3) {
            Serial.printf("[RSSI] ble_gap_conn_rssi failed: rc=%d\n", rc);
            failCount++;
        }
    }

#elif BLE_KEY_GO_STACK_BLUEDROID
    // Bluedroid: async — result comes via gapEventHandler
    esp_err_t err = esp_ble_gap_read_rssi(connectedRemoteAddress);
    if (err != ESP_OK) {
        static int failCount = 0;
        if (failCount < 3) {
            Serial.printf("[RSSI] esp_ble_gap_read_rssi failed: %d\n", err);
            failCount++;
        }
    }

#else
    // No native RSSI — fallback to manual injection via FF01/serial
    if (!nativeRssiWarningPrinted) {
        nativeRssiWarningPrinted = true;
        Serial.println("[RSSI] native read unavailable; use cfg rssi=-50 or FF01 rssi=-50");
    }
#endif
}

void updateRssiFilter(int newRssi) {
    if (newRssi == -999) {
        filteredRSSI = -999;
        return;
    }

    rssiBuffer[rssiBufferIndex] = newRssi;
    rssiBufferIndex = (rssiBufferIndex + 1) % RSSI_FILTER_WINDOW;
    if (rssiBufferCount < RSSI_FILTER_WINDOW) {
        rssiBufferCount++;
    }

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

void processStateMachine() {
    // 手动命令冷却期：手动操作后 8 秒内状态机不介入，避免与用户意图冲突
    if (manualCommandCooldown) {
        if (millis() - manualCommandTimestampMs >= MANUAL_COMMAND_COOLDOWN_MS) {
            manualCommandCooldown = false;
            Serial.println("[STATE] manual command cooldown ended, RSSI state machine resumed");
        } else {
            return;  // 冷却中，跳过状态机
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
        if (filteredRSSI <= rssiLockThreshold) {
            lockCounter++;
            unlockCounter = 0;
            if (lockCounter >= lockCountRequired) {
                Serial.println("[STATE] lock threshold reached");
                currentState = STATE_ACTION;
                executeLockSequence();
                currentState = STATE_LOCKED;
                unlockCounter = 0;
                lockCounter = 0;
                resetRssiFilter();
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

void updateLED() {
    static unsigned long lastBlinkMs = 0;
    static bool ledState = false;

    if (deviceConnected) {
        digitalWrite(PIN_LED, HIGH);
        return;
    }

    if (millis() - lastBlinkMs >= 1000) {
        lastBlinkMs = millis();
        ledState = !ledState;
        digitalWrite(PIN_LED, ledState);
    }
}

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
        resetRssiFilter();
        manualCommandTimestampMs = millis();
        manualCommandCooldown = true;
        Serial.println("[STATE] serial manual unlock, RSSI state machine paused 8s");
    } else if (upper == "LOCK") {
        executeLockSequence();
        currentState = STATE_LOCKED;
        resetRssiFilter();
        manualCommandTimestampMs = millis();
        manualCommandCooldown = true;
        Serial.println("[STATE] serial manual lock, RSSI state machine paused 8s");
    } else if (upper == "TRUNK") {
        executeTrunkSequence();
    } else if (upper == "RSSI") {
        rssiDisplayMode = !rssiDisplayMode;
        Serial.printf("[CONFIG] RSSI display: %s\n", rssiDisplayMode ? "on" : "off");
    } else if (upper.startsWith("CFG ")) {
        String params = cmd.substring(4);
        if (parseConfigLine(params)) {
            saveConfig();
            Serial.println("[CONFIG] saved");
        } else {
            Serial.println("[ERROR] cfg format: cfg unlock=-45 lock=-65 uc=5 lc=10 interval=500");
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
            int value = token.substring(eq + 1).toInt();

            if (key == "unlock") {
                rssiUnlockThreshold = value;
                parsed++;
            } else if (key == "lock") {
                rssiLockThreshold = value;
                parsed++;
            } else if (key == "uc") {
                unlockCountRequired = max(1, value);
                parsed++;
            } else if (key == "lc") {
                lockCountRequired = max(1, value);
                parsed++;
            } else if (key == "interval") {
                rssiSampleIntervalMs = max(100, value);
                parsed++;
            } else if (key == "dlock") {
                disconnectLockDelayMs = max(0, value);
                parsed++;
            } else if (key == "rssi") {
                latestRSSI = value;
                updateRssiFilter(latestRSSI);
                parsed++;
                Serial.printf("[RSSI] manual raw=%d filtered=%d\n", latestRSSI, filteredRSSI);
            }
        }
        start = end + 1;
    }

    return parsed > 0 && rssiUnlockThreshold > rssiLockThreshold;
}

void loadConfig() {
    preferences.begin("ble-key-go", false);
    rssiUnlockThreshold = preferences.getInt("unlock", rssiUnlockThreshold);
    rssiLockThreshold = preferences.getInt("lock", rssiLockThreshold);
    unlockCountRequired = preferences.getInt("uc", unlockCountRequired);
    lockCountRequired = preferences.getInt("lc", lockCountRequired);
    rssiSampleIntervalMs = preferences.getInt("interval", rssiSampleIntervalMs);
    disconnectLockDelayMs = preferences.getInt("dlock", disconnectLockDelayMs);
}

void saveConfig() {
    preferences.putInt("unlock", rssiUnlockThreshold);
    preferences.putInt("lock", rssiLockThreshold);
    preferences.putInt("uc", unlockCountRequired);
    preferences.putInt("lc", lockCountRequired);
    preferences.putInt("interval", rssiSampleIntervalMs);
    preferences.putInt("dlock", disconnectLockDelayMs);
}

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
    payload += ",\"state\":\"";
    payload += stateToString();
    payload += "\"";
    payload += ",\"rssi\":";
    payload += String(latestRSSI);
    payload += ",\"filtered\":";
    payload += String(filteredRSSI);
    payload += ",\"unlock\":";
    payload += String(rssiUnlockThreshold);
    payload += ",\"lock\":";
    payload += String(rssiLockThreshold);
    payload += ",\"uc\":";
    payload += String(unlockCountRequired);
    payload += ",\"lc\":";
    payload += String(lockCountRequired);
    payload += ",\"disconnectLockMs\":";
    payload += String(disconnectLockDelayMs);
    payload += ",\"manualCooldown\":";
    payload += String(manualCommandCooldown ? 1 : 0);
    payload += "}";

    pStatusCharacteristic->setValue(payload.c_str());
    if (deviceConnected) {
        pStatusCharacteristic->notify();
    }
}

void printStatus() {
    Serial.println();
    Serial.println("==== STATUS ====");
    Serial.printf("BLE connected: %s\n", deviceConnected ? "yes" : "no");
    Serial.printf("State: %s\n", stateToString().c_str());
    Serial.printf("RSSI raw/filtered: %d / %d\n", latestRSSI, filteredRSSI);
    Serial.printf("Threshold unlock/lock: %d / %d dBm\n", rssiUnlockThreshold, rssiLockThreshold);
    Serial.printf("Confirm unlock/lock: %d / %d\n", unlockCounter, lockCounter);
    Serial.printf("Required unlock/lock: %d / %d\n", unlockCountRequired, lockCountRequired);
    Serial.printf("Sample interval: %d ms\n", rssiSampleIntervalMs);
    Serial.printf("Disconnect lock delay: %d ms\n", disconnectLockDelayMs);
    Serial.println();
}

void printHelp() {
    Serial.println("Commands:");
    Serial.println("  status");
    Serial.println("  rssi");
    Serial.println("  unlock");
    Serial.println("  lock");
    Serial.println("  trunk");
    Serial.println("  cfg unlock=-45 lock=-65 uc=5 lc=10 interval=500");
    Serial.println("  cfg rssi=-40     (manual RSSI injection if native RSSI is unavailable)");
    Serial.println();
    Serial.println("nRF Connect:");
    Serial.println("  Connect to BLE-Key-Go-v2");
    Serial.println("  Read/notify FF02 for status");
    Serial.println("  Write FF01: unlock=-45 lock=-65 uc=5 lc=10 interval=500 dlock=5000");
    Serial.println("  Write FF01: rssi=-40 / rssi=-80 for manual logic test");
    Serial.println("  Write FF03: UNLOCK / LOCK / TRUNK / STATUS");
    Serial.println();
}
