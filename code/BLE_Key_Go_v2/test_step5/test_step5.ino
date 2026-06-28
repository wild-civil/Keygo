/*
 * Step 5 - Full v2 firmware with all features, simplified to isolate the crash
 */

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <Preferences.h>

// ---- Pins ----
#define PIN_UNLOCK      2
#define PIN_LOCK        3
#define PIN_TRUNK       4
#define PIN_KEY_POWER   5
#define PIN_LED         8

#define NMOS_ON    HIGH
#define NMOS_OFF   LOW
#define PMOS_ON    LOW
#define PMOS_OFF   HIGH

// ---- BLE UUIDs ----
#define DEVICE_NAME        "BLE-Key-Go-v2"
#define SERVICE_UUID       "0000ff00-0000-1000-8000-00805f9b34fb"
#define CONFIG_CHAR_UUID   "0000ff01-0000-1000-8000-00805f9b34fb"
#define STATUS_CHAR_UUID   "0000ff02-0000-1000-8000-00805f9b34fb"
#define COMMAND_CHAR_UUID  "0000ff03-0000-1000-8000-00805f9b34fb"

// ---- Parameters ----
int rssiUnlockThreshold = -45;
int rssiLockThreshold = -65;
int unlockCountRequired = 3;
int lockCountRequired = 5;
int rssiSampleIntervalMs = 500;
int disconnectLockDelayMs = 5000;
int keyPowerUpDelayMs = 200;
int keyPressDurationMs = 300;
int keyReleaseDelayMs = 500;

// ---- RSSI filter (EMA: exponential moving average) ----
// alpha=0.5 → 63% weight to latest sample, reacts in ~2 samples
// alpha=0.3 → slower but smoother; alpha=0.7 → very responsive but jittery
float rssiEmaAlpha = 0.8;
float filteredRSSI = -999;
int latestRSSI = -999;
bool rssiFilterInitialized = false;

// ---- State ----
enum KeyState { STATE_LOCKED, STATE_UNLOCKED, STATE_ACTION };
KeyState currentState = STATE_LOCKED;
int unlockCounter = 0;
int lockCounter = 0;
bool deviceConnected = false;
bool rssiDisplayMode = true;
uint16_t nimbleConnHandle = 0;
unsigned long lastRssiReadMs = 0;
unsigned long lastStatusNotifyMs = 0;
unsigned long disconnectTimestampMs = 0;
unsigned long manualCommandTimestampMs = 0;
bool manualCommandCooldown = false;
#define MANUAL_COMMAND_COOLDOWN_MS 8000

BLEServer* pServer = nullptr;
BLECharacteristic* pStatusCharacteristic = nullptr;
Preferences preferences;

// ---- Forward declarations ----
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

// ---- Server callbacks (NimBLE only) ----
class ServerCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer* server, ble_gap_conn_desc* desc) override {
        deviceConnected = true;
        nimbleConnHandle = desc->conn_handle;
        resetRssiFilter();
        unlockCounter = 0;
        lockCounter = 0;
        Serial.printf("[BLE] phone connected, conn_handle=%u\n", nimbleConnHandle);
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
};

class ConfigCallbacks : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* characteristic) override {
        String value = characteristic->getValue().c_str();
        value.trim();
        if (parseConfigLine(value)) {
            saveConfig();
            Serial.printf("[CONFIG] updated by BLE: %s\n", value.c_str());
            notifyStatus();
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
        } else if (cmd == "LOCK") {
            executeLockSequence();
            currentState = STATE_LOCKED;
            resetRssiFilter();
            manualCommandTimestampMs = millis();
            manualCommandCooldown = true;
        } else if (cmd == "TRUNK") {
            executeTrunkSequence();
        } else if (cmd == "STATUS") {
            notifyStatus();
        }
    }
};

void setup() {
    // Early LED blink
    pinMode(PIN_LED, OUTPUT);
    for (int i = 0; i < 3; i++) {
        digitalWrite(PIN_LED, HIGH); delay(150);
        digitalWrite(PIN_LED, LOW);  delay(150);
    }

    Serial.begin(115200);
    Serial.setTimeout(50);
    delay(2000);

    Serial.println();
    Serial.println("==== BLE-Key-Go v2 (NimBLE) ====");

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
    printHelp();

    Serial.print("[1] BLEDevice::init... ");
    BLEDevice::init(DEVICE_NAME);
    Serial.println("OK");

    Serial.print("[2] createServer... ");
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());
    Serial.println("OK");

    Serial.print("[3] createService... ");
    BLEService* service = pServer->createService(SERVICE_UUID);
    Serial.println("OK");

    Serial.print("[4] configCharacteristic... ");
    BLECharacteristic* configChar = service->createCharacteristic(CONFIG_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE);
    configChar->setCallbacks(new ConfigCallbacks());
    Serial.println("OK");

    Serial.print("[5] statusCharacteristic... ");
    pStatusCharacteristic = service->createCharacteristic(STATUS_CHAR_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
    pStatusCharacteristic->addDescriptor(new BLE2902());
    Serial.println("OK");

    Serial.print("[6] commandCharacteristic... ");
    BLECharacteristic* cmdChar = service->createCharacteristic(COMMAND_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE);
    cmdChar->setCallbacks(new CommandCallbacks());
    Serial.println("OK");

    Serial.print("[7] service->start... ");
    service->start();
    Serial.println("OK");

    Serial.print("[8] advertising... ");
    startAdvertising();
    Serial.println("OK");

    Serial.println("==== Ready, advertising as BLE-Key-Go-v2 ====");
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
    if (!deviceConnected || nimbleConnHandle == 0) return;
    int8_t rssi = 0;
    int rc = ble_gap_conn_rssi(nimbleConnHandle, &rssi);
    if (rc == 0) {
        latestRSSI = rssi;
        updateRssiFilter(latestRSSI);
        if (rssiDisplayMode) {
            Serial.printf("[RSSI] raw=%d filtered=%d state=%s\n",
                          latestRSSI, (int)filteredRSSI, stateToString().c_str());
        }
    }
}

void updateRssiFilter(int newRssi) {
    if (newRssi == -999) { filteredRSSI = -999; rssiFilterInitialized = false; return; }
    if (!rssiFilterInitialized) {
        // First sample: seed the filter instantly
        filteredRSSI = newRssi;
        rssiFilterInitialized = true;
    } else {
        // EMA: filtered = alpha * raw + (1-alpha) * old_filtered
        filteredRSSI = rssiEmaAlpha * newRssi + (1.0f - rssiEmaAlpha) * filteredRSSI;
    }
}

void resetRssiFilter() {
    filteredRSSI = -999;
    rssiFilterInitialized = false;
}

void processStateMachine() {
    if (manualCommandCooldown) {
        if (millis() - manualCommandTimestampMs >= MANUAL_COMMAND_COOLDOWN_MS) {
            manualCommandCooldown = false;
        } else return;
    }
    if (filteredRSSI == -999 || currentState == STATE_ACTION) return;

    if (currentState == STATE_LOCKED) {
        if (filteredRSSI >= rssiUnlockThreshold) {
            unlockCounter++;
            lockCounter = 0;
            if (unlockCounter >= unlockCountRequired) {
                currentState = STATE_ACTION;
                executeUnlockSequence();
                currentState = STATE_UNLOCKED;
                unlockCounter = 0;
                lockCounter = 0;
                notifyStatus();
            }
        } else unlockCounter = 0;
    } else if (currentState == STATE_UNLOCKED) {
        if (filteredRSSI <= rssiLockThreshold) {
            lockCounter++;
            unlockCounter = 0;
            if (lockCounter >= lockCountRequired) {
                currentState = STATE_ACTION;
                executeLockSequence();
                currentState = STATE_LOCKED;
                unlockCounter = 0;
                lockCounter = 0;
                resetRssiFilter();
                notifyStatus();
            }
        } else lockCounter = 0;
    }
}

void executeUnlockSequence() {
    digitalWrite(PIN_KEY_POWER, PMOS_ON); delay(keyPowerUpDelayMs);
    digitalWrite(PIN_UNLOCK, NMOS_ON);    delay(keyPressDurationMs);
    digitalWrite(PIN_UNLOCK, NMOS_OFF);   delay(keyReleaseDelayMs);
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
}

void executeLockSequence() {
    digitalWrite(PIN_KEY_POWER, PMOS_ON); delay(keyPowerUpDelayMs);
    digitalWrite(PIN_LOCK, NMOS_ON);      delay(keyPressDurationMs);
    digitalWrite(PIN_LOCK, NMOS_OFF);     delay(keyReleaseDelayMs);
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
}

void executeTrunkSequence() {
    digitalWrite(PIN_KEY_POWER, PMOS_ON); delay(keyPowerUpDelayMs);
    digitalWrite(PIN_TRUNK, NMOS_ON);     delay(keyPressDurationMs);
    digitalWrite(PIN_TRUNK, NMOS_OFF);    delay(keyReleaseDelayMs);
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
}

void updateLED() {
    static unsigned long lastBlinkMs = 0;
    static bool ledState = false;
    if (deviceConnected) { digitalWrite(PIN_LED, HIGH); return; }
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

    if (upper == "HELP") printHelp();
    else if (upper == "STATUS") printStatus();
    else if (upper == "UNLOCK") {
        executeUnlockSequence();
        currentState = STATE_UNLOCKED;
        resetRssiFilter();
        manualCommandTimestampMs = millis();
        manualCommandCooldown = true;
    } else if (upper == "LOCK") {
        executeLockSequence();
        currentState = STATE_LOCKED;
        resetRssiFilter();
        manualCommandTimestampMs = millis();
        manualCommandCooldown = true;
    } else if (upper == "TRUNK") executeTrunkSequence();
    else if (upper == "RSSI") {
        rssiDisplayMode = !rssiDisplayMode;
        Serial.printf("[RSSI] display: %s\n", rssiDisplayMode ? "on" : "off");
    } else if (upper.startsWith("CFG ")) {
        if (parseConfigLine(cmd.substring(4))) { saveConfig(); Serial.println("[CONFIG] saved"); }
        else Serial.println("[ERROR] format: cfg unlock=-45 lock=-65 uc=5 lc=10 interval=500");
    }
}

bool parseConfigLine(String line) {
    line.trim(); line.toLowerCase();
    if (line.length() == 0) return false;
    int parsed = 0, start = 0;
    while (start < line.length()) {
        int end = line.indexOf(' ', start);
        if (end < 0) end = line.length();
        String token = line.substring(start, end);
        token.trim();
        int eq = token.indexOf('=');
        if (eq > 0) {
            String key = token.substring(0, eq);
            int value = token.substring(eq + 1).toInt();
            if (key == "unlock") { rssiUnlockThreshold = value; parsed++; }
            else if (key == "lock") { rssiLockThreshold = value; parsed++; }
            else if (key == "uc") { unlockCountRequired = max(1, value); parsed++; }
            else if (key == "lc") { lockCountRequired = max(1, value); parsed++; }
            else if (key == "interval") { rssiSampleIntervalMs = max(100, value); parsed++; }
            else if (key == "dlock") { disconnectLockDelayMs = max(0, value); parsed++; }
            else if (key == "rssi") {
                latestRSSI = value;
                updateRssiFilter(latestRSSI);
                parsed++;
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
    payload += "\"connected\":"; payload += String(deviceConnected ? 1 : 0);
    payload += ",\"state\":\"";  payload += stateToString(); payload += "\"";
    payload += ",\"rssi\":";      payload += String(latestRSSI);
    payload += ",\"filtered\":";  payload += String((int)filteredRSSI);
    payload += ",\"unlock\":";    payload += String(rssiUnlockThreshold);
    payload += ",\"lock\":";      payload += String(rssiLockThreshold);
    payload += "}";
    pStatusCharacteristic->setValue(payload.c_str());
    if (deviceConnected) pStatusCharacteristic->notify();
}

void printStatus() {
    Serial.println();
    Serial.printf("State: %s  RSSI: %d/%d  Counters: u=%d/%d l=%d/%d\n",
                  stateToString().c_str(), latestRSSI, (int)filteredRSSI,
                  unlockCounter, unlockCountRequired, lockCounter, lockCountRequired);
}

void printHelp() {
    Serial.println("Commands: status rssi unlock lock trunk");
    Serial.println("  cfg unlock=-45 lock=-65 uc=5 lc=10 interval=500 dlock=5000");
    Serial.println("  cfg rssi=-40  (manual RSSI injection for test)");
    Serial.println();
}
