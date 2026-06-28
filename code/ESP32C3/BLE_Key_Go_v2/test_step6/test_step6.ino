/*
 * Step 6 - Kalman filter for RSSI   测试用
 *
 * 1D Kalman: x = state (true RSSI), z = measurement (raw RSSI)
 *   Predict:  x = x,  p = p + q
 *   Update:   k = p / (p + r)
 *             x = x + k * (z - x)
 *             p = (1 - k) * p
 *
 * Tuning:
 *   q = process noise  → higher = trust raw more, faster response
 *   r = measurement noise → higher = smooth more, slower response
 *
 * Default: q=4.0, r=16.0 → responsive but filters single-sample spikes
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
int rssiUnlockThreshold = -45;   // RSSI above this → candidate for unlock
int rssiLockThreshold = -65;     // RSSI below this → candidate for lock
int rssiHysteresisDb = 5;       // extra tightening when already unlocked (lock needs this much lower)
int rssiSpikeRejectDb = 25;     // drop raw samples that deviate > this from kalman estimate (spike rejection)
int unlockCountRequired = 3;
int lockCountRequired = 5;
int rssiSampleIntervalMs = 500;
int disconnectLockDelayMs = 5000;
int keyPowerUpDelayMs = 200;
int keyPressDurationMs = 300;
int keyReleaseDelayMs = 500;

// ---- 1D Kalman filter for RSSI ----
// q: process noise covariance  — larger = trust raw changes more, faster tracking
// r: measurement noise covariance — larger = trust raw less, heavier smoothing
//   q↑ = faster tracking but more jitter;  r↑ = heavier smoothing but slower response
//   Quick recipes:  q=4 r=16 (responsive) | q=2 r=40 (balanced) | q=1 r=80 (smooth)
// Default: q=4, r=16  —  responsive: ~80% of step in 1 sample, ~2x spike attenuation
//   This is fast enough for unlock (< 2s) while still damping single-sample glitches.
float kf_q = 4.0f;
float kf_r = 16.0f;
float kf_x = -999;   // state estimate
float kf_p = 1.0f;   // error covariance
bool  kf_initialized = false;

float filteredRSSI = -999;
int   latestRSSI = -999;

// Spike rejection: require N consecutive spikes before accepting a real trend change
int spikeConsecutiveCount = 0;
int spikeConsecutiveRequired = 2;  // 2 consecutive spikes = real change, feed to kalman

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
void updateKalmanFilter(int measurement);
void resetKalmanFilter();
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
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        Serial.printf("[BLE] phone connected, conn_handle=%u\n", nimbleConnHandle);
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
            resetKalmanFilter();
            manualCommandTimestampMs = millis();
            manualCommandCooldown = true;
            Serial.println("[STATE] BLE manual unlock, RSSI state machine paused 8s");
        } else if (cmd == "LOCK") {
            executeLockSequence();
            currentState = STATE_LOCKED;
            resetKalmanFilter();
            manualCommandTimestampMs = millis();
            manualCommandCooldown = true;
            Serial.println("[STATE] BLE manual lock, RSSI state machine paused 8s");
        } else if (cmd == "TRUNK") {
            executeTrunkSequence();
        } else if (cmd == "STATUS") {
            notifyStatus();
        }
    }
};

void setup() {
    pinMode(PIN_LED, OUTPUT);
    for (int i = 0; i < 3; i++) {
        digitalWrite(PIN_LED, HIGH); delay(150);
        digitalWrite(PIN_LED, LOW);  delay(150);
    }

    Serial.begin(115200);
    Serial.setTimeout(50);
    delay(2000);

    Serial.println();
    Serial.println("==== BLE-Key-Go v2 (Kalman RSSI) ====");

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
    printHelp();

    BLEDevice::init(DEVICE_NAME);

    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());

    BLEService* service = pServer->createService(SERVICE_UUID);

    BLECharacteristic* configChar = service->createCharacteristic(CONFIG_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE);
    configChar->setCallbacks(new ConfigCallbacks());

    pStatusCharacteristic = service->createCharacteristic(STATUS_CHAR_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
    pStatusCharacteristic->addDescriptor(new BLE2902());

    BLECharacteristic* cmdChar = service->createCharacteristic(COMMAND_CHAR_UUID, BLECharacteristic::PROPERTY_WRITE);
    cmdChar->setCallbacks(new CommandCallbacks());

    service->start();
    startAdvertising();

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
        // Spike rejection with consecutive-spike gating:
        //   - Single outlier (body block) → discard, don't touch kalman
        //   - N consecutive outliers (fast running away) → accept as real trend
        // This distinguishes momentary dropouts from genuine distance changes.
        bool spikeRejected = false;
        bool isSpike = kf_initialized && abs(rssi - (int)filteredRSSI) > rssiSpikeRejectDb;

        if (isSpike) {
            spikeConsecutiveCount++;
            if (spikeConsecutiveCount >= spikeConsecutiveRequired) {
                // Sustained deviation — real trend change, feed to kalman
                updateKalmanFilter(latestRSSI);
                spikeConsecutiveCount = 0;  // reset gate
            } else {
                spikeRejected = true;
                // Accumulate uncertainty so kalman is ready when gate opens
                kf_p = kf_p + kf_q * 2.0f;
            }
        } else {
            spikeConsecutiveCount = 0;  // back to normal
            updateKalmanFilter(latestRSSI);
        }

        if (rssiDisplayMode) {
            Serial.printf("[RSSI] raw=%d kalman=%d state=%s%s\n",
                          latestRSSI, (int)filteredRSSI, stateToString().c_str(),
                          spikeRejected ? " (spike)" : "");
        }
    }
}

// ---- 1D Kalman filter ----
void updateKalmanFilter(int measurement) {
    if (!kf_initialized) {
        // Seed: trust first measurement fully
        kf_x = (float)measurement;
        kf_p = kf_r;  // initial uncertainty = measurement noise
        kf_initialized = true;
        filteredRSSI = measurement;
        return;
    }

    // Predict: state unchanged (RSSI is modeled as random walk)
    kf_p = kf_p + kf_q;

    // Update: incorporate measurement
    float k = kf_p / (kf_p + kf_r);   // Kalman gain (0..1)
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
//  Hysteresis prevents rapid toggling near threshold boundaries:
//  - Locked → Unlock: kalman >= rssiUnlockThreshold  (e.g. -45 dBm)
//  - Unlocked → Lock: kalman <= (rssiLockThreshold - hysteresis)  (e.g. -70 dBm)
//  This creates a dead zone where small RSSI fluctuations don't cause state flips.
void processStateMachine() {
    if (manualCommandCooldown) {
        if (millis() - manualCommandTimestampMs >= MANUAL_COMMAND_COOLDOWN_MS) {
            manualCommandCooldown = false;
            Serial.println("[STATE] manual command cooldown ended, RSSI state machine resumed");
        } else return;
    }
    if (filteredRSSI == -999 || currentState == STATE_ACTION) return;

    if (currentState == STATE_LOCKED) {
        // Need signal STRONGER than unlock threshold to open
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
        // Need signal WEAKER than (lockThreshold - hysteresis) to lock
        // e.g. lock=-65, hyst=5 → effective threshold = -70 dBm
        // This prevents locking just because signal dipped to -66 for a moment
        int effectiveLock = rssiLockThreshold - rssiHysteresisDb;
        if (filteredRSSI <= effectiveLock) {
            lockCounter++;
            unlockCounter = 0;
            if (lockCounter >= lockCountRequired) {
                currentState = STATE_ACTION;
                executeLockSequence();
                currentState = STATE_LOCKED;
                unlockCounter = 0;
                lockCounter = 0;
                resetKalmanFilter();
                notifyStatus();
            }
        } else lockCounter = 0;
    }
}

// ---- Key sequences ----
void executeUnlockSequence() {
    Serial.println("[KEY] unlock");
    digitalWrite(PIN_KEY_POWER, PMOS_ON); delay(keyPowerUpDelayMs);
    digitalWrite(PIN_UNLOCK, NMOS_ON);    delay(keyPressDurationMs);
    digitalWrite(PIN_UNLOCK, NMOS_OFF);   delay(keyReleaseDelayMs);
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
}

void executeLockSequence() {
    Serial.println("[KEY] lock");
    digitalWrite(PIN_KEY_POWER, PMOS_ON); delay(keyPowerUpDelayMs);
    digitalWrite(PIN_LOCK, NMOS_ON);      delay(keyPressDurationMs);
    digitalWrite(PIN_LOCK, NMOS_OFF);     delay(keyReleaseDelayMs);
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
}

void executeTrunkSequence() {
    Serial.println("[KEY] trunk");
    digitalWrite(PIN_KEY_POWER, PMOS_ON); delay(keyPowerUpDelayMs);
    digitalWrite(PIN_TRUNK, NMOS_ON);     delay(keyPressDurationMs);
    digitalWrite(PIN_TRUNK, NMOS_OFF);    delay(keyReleaseDelayMs);
    digitalWrite(PIN_KEY_POWER, PMOS_OFF);
}

// ---- LED ----
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

// ---- Serial commands ----
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
    } else if (upper == "TRUNK") executeTrunkSequence();
    else if (upper == "RSSI") {
        rssiDisplayMode = !rssiDisplayMode;
        Serial.printf("[RSSI] display: %s\n", rssiDisplayMode ? "on" : "off");
    } else if (upper.startsWith("CFG ")) {
        if (parseConfigLine(cmd.substring(4))) { saveConfig(); Serial.println("[CONFIG] saved"); }
        else Serial.println("[ERROR] format: cfg unlock=-45 lock=-65 hyst=5 uc=3 lc=5 interval=500 q=4 r=16");
    }
}

// ---- Config parser ----
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
                updateKalmanFilter(latestRSSI);
                parsed++;
            }
        }
        start = end + 1;
    }
    return parsed > 0 && rssiUnlockThreshold > rssiLockThreshold;
}

// ---- NVS config ----
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

// ---- Helpers ----
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
    payload += ",\"hyst\":";      payload += String(rssiHysteresisDb);
    payload += ",\"cooldown\":";   payload += String(manualCommandCooldown ? 1 : 0);
    payload += "}";
    pStatusCharacteristic->setValue(payload.c_str());
    if (deviceConnected) pStatusCharacteristic->notify();
}

void printStatus() {
    Serial.println();
    Serial.printf("State: %s  RSSI raw/kalman: %d/%d  Counters: u=%d/%d l=%d/%d\n",
                  stateToString().c_str(), latestRSSI, (int)filteredRSSI,
                  unlockCounter, unlockCountRequired, lockCounter, lockCountRequired);
    Serial.printf("Thresholds: unlock>=%d  lock<=%d  hyst=%d  spike=%d\n",
                  rssiUnlockThreshold, rssiLockThreshold, rssiHysteresisDb, rssiSpikeRejectDb);
    Serial.printf("Kalman: q=%.1f r=%.1f\n", kf_q, kf_r);
}

void printHelp() {
    Serial.println("Commands: status rssi unlock lock trunk");
    Serial.println("  cfg unlock=-45 lock=-65 hyst=5 spike=25 uc=3 lc=5 interval=500 dlock=5000");
    Serial.println("  cfg q=4 r=16   (Kalman: q=process noise, r=measure noise)");
    Serial.println("  cfg rssi=-40    (manual RSSI injection for test)");
    Serial.println();
}
