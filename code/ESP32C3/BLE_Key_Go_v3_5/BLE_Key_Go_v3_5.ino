/*
 * BLE-Key-Go v3.5 — GATT 加密强制 + 特征值权限保护
 *
 * ── v3.5 核心变更 ──────────────────────────────────────
 *   ● 根因修复：v3.0-v3.4 所有特征值均无加密权限保护！
 *     BLE 协议分两层 — GAP 连接（不需要配对）+ GATT 数据（需权限控制）
 *     之前特征值裸奔，未配对手机也能读写 FF01/FF02/FF03/FF04
 *     包括自定义名称 d2 字段，这就是「没配对也能看见名称」的原因
 *   ● 所有特征值 + CCCD 描述符设置 ESP_GATT_PERM_*_ENCRYPTED
 *     FF01(Config): WRITE_ENCRYPTED
 *     FF02(Status): READ_ENCRYPTED + CCCD RW_ENCRYPTED
 *     FF03(Command): WRITE_ENCRYPTED
 *     FF04(Serial):  READ_ENCRYPTED
 *     未配对手机连接后：读/写/订阅通知 全部被 BLE 栈拒绝
 *   ● onConnect 后 500ms 主动发起安全请求（强制弹出 PIN 框）
 *     之前依赖手机端主动请求配对，如果手机不请求就永远不配对
 *     现在 ESP32 主动调用 esp_ble_set_encryption() 强制弹出 PIN 框
 *   ● notifyStatus() 未加密时 d2="" 双重保护
 *     即使加密权限失效，也不在 JSON 中泄露自定义名称
 *   ● 旧 bond 失效自动检测（三路兜底）
 *     onPassKeyRequest / onAuthenticationComplete(fail) / loop 60s 超时
 *     deleteAllBonds() 同步清除自定义名称（NVS dev_name）
 *   ● 加密状态精准追踪
 *     encryptionEstablished 区分"GATT 连接"与"配对加密"
 *     Status JSON "enc" 字段真实反映加密状态
 *   ● PIN 修改后 ESP.restart() 确保 bond 数据彻底清除
 *
 * ── v3.3 核心变更 ──────────────────────────────────────
 *   ● 设备指纹（广播包 Manufacturer Data 携带 MAC 后缀）
 *     扫描阶段即可识别设备身份，不依赖可被篡改的设备名
 *   ● FF04 序列号特征（Read-Only，出厂 MAC 完整 hex）
 *     连接后读取 12 位 hex，不可伪造，作为设备唯一标识
 *   ● Status JSON 新增 "sn" 字段
 *     每秒推送设备指纹，运行时持续追踪
 *   ● deleteAllBonds 后主动断开当前连接
 *     修复清 bond 后旧连接仍然存活的 bug
 *   ● PIN 修改流程优化
 *     增加 hasBondedDevices 清理 + notifyStatus 推送
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
#define SERIAL_CHAR_UUID    "0000ff04-0000-1000-8000-00805f9b34fb"  // ★ v3.3: 设备序列号，只读

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

// ★ v3.3: 设备永久标识 — 蓝牙 MAC 出厂烧录，永不改变，作为设备指纹根基
uint8_t deviceMac[6];

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
bool encryptionEstablished = false;            // ★ v3.4: 实际 BLE 加密状态（仅 auth 成功时为 true）
bool wasBondedOnConnect = false;               // ★ v3.5: 连接时是否有旧 bond（用于超时检测）
bool securityRequestPending = false;           // ★ v3.5: 是否需要主动发起安全请求
unsigned long securityRequestAtMs = 0;         // ★ v3.5: 安全请求发起时间（延迟用）
#define SECURITY_REQUEST_DELAY_MS 500           // ★ v3.5: 连接后 500ms 发起安全请求
bool rssiDisplayMode = false;                   // 默认关闭 不输出

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

// ★ v3.5.10: 应用层 PIN 验证（NimBLE Just Works 配对后，App 发送 VERIFY:<pin> 验证）
bool pinVerified = false;                      // 当前连接是否已通过应用层 PIN 验证
int  pinVerifyFailCount = 0;                   // PIN 验证失败次数（防暴力破解）
#define PIN_VERIFY_MAX_FAILS 3                 // 最多允许 3 次错误尝试

// ★ v3.5.11: NimBLE Just Works 哨兵 — 区分"旧 bond 复用"与"新配对"
//   NimBLE NO_INPUT_OUTPUT 模式下 onPassKeyRequest 不会触发，
//   需要用 onConfirmPIN/onPassKeyNotify 来检测是否正在进行新配对。
bool freshPairingInProgress = false;
bool nativeRssiWarningPrinted = false;

// 按键去抖
unsigned long lastButtonCheckMs = 0;
#define BUTTON_DEBOUNCE_MS 50
bool lastButtonState = true;
unsigned long buttonPressStartMs = 0;

// 连接后未加密超时
unsigned long connectStartMs = 0;
#define BONDING_TIMEOUT_MS  60000    // 60 秒内未完成 bonding 则断开

// ★ v3.5.16: 加密完成后 PIN 验证截止时间（防恶意占线）
//   加密完成但 pinVerified 持续为 false → 攻击者连上了但不知道 PIN → 踢掉
unsigned long encryptionEstablishedAtMs = 0;
#define PIN_VERIFY_DEADLINE_MS  30000  // 30 秒内必须通过 PIN 验证

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
            encryptionEstablished = true;    // ★ v3.4: GAP 层认证成功
            encryptionEstablishedAtMs = millis();  // ★ v3.5.16
            pinVerified = true;              // ★ v3.5.10: Bluedroid 静态 PIN 验证成功 → 授权
            pinVerifyFailCount = 0;
            Serial.println("[SEC] Bonding complete — device authorized & encrypted");
        } else {
            Serial.printf("[SEC] Bonding failed: reason=0x%02x\n", param->auth_cmpl.fail_reason);
            // ★ v3.5: 如果之前已配对但现在认证失败 → 手机端取消了配对 → 清除一切
            if (hasBondedDevices) {
                Serial.println("[SEC] Old bond invalid, clearing bonds & device name...");
                deleteAllBonds();
            }
            // ★ v3.4: 认证失败，保持 encryptionEstablished=false
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
        // ★ v3.5: 烟雾弹检测 — 旧 bond 失效的唯一可靠信号
        //   如果已配对手机重连，链路层静默加密，不会触发 onPassKeyRequest()。
        //   如果 onPassKeyRequest() 触发且 hasBondedDevices==true，说明手机端
        //   bond 已被删除（用户在蓝牙设置中「取消配对」）→ 同步清除设备端 bond 和名称
        if (hasBondedDevices) {
            Serial.println("[SEC] ⚠ Stale bond detected — phone re-pairing → clearing old bond & name");
            freshPairingInProgress = true;   // ★ v3.5.11: 旧 bond 失效 → 新配对哨兵
            // 清除 NVS 中旧 bond 数据（不调用 deleteAllBonds，避免断开当前连接）
            {
                Preferences bp;
                if (bp.begin("ble", false)) { bp.clear(); bp.end(); }
            }
            // 清除自定义名称
            customDeviceName = "";
            preferences.putString("dev_name", "");
            // 重置 bond 标记（配对成功后会在 onAuthenticationComplete 中重新设为 true）
            hasBondedDevices = false;
            encryptionEstablished = false;
            pinVerified = false;             // ★ v3.5.10
            pinVerifyFailCount = 0;          // ★ v3.5.10
            wasBondedOnConnect = false;
            securityRequestPending = false;  // ★ v3.5
            Serial.println("[SEC] Old bond & custom name cleared → proceeding as fresh pairing");
            notifyStatus();  // ★ v3.5: 立即推送清除后的状态给 App
        }
        uint32_t pin = (uint32_t)pairingPIN.toInt();
        Serial.printf("[SEC] returning static PIN: %06u\n", pin);
        return pin;
    }
    void onPassKeyNotify(uint32_t pass_key) override {
        Serial.printf("[SEC] passkey notify: %06u", pass_key);
        // ★ v3.5.12: 增加 stale bond 检测 — 手机端取消配对后 NimBLE 可能走此路径
        if (hasBondedDevices) {
            Serial.println(" → stale bond! Clearing & disconnecting zombie connection");
            freshPairingInProgress = true;
            deleteAllBonds();                   // 彻底清除 bond + 断开僵尸连接
            return;                             // 不继续配对，让 onDisconnect 触发干净重连
        }
        Serial.println(" → fresh pairing");
        freshPairingInProgress = true;          // ★ v3.5.11: NimBLE Just Works 哨兵
    }
    bool onConfirmPIN(uint32_t pass_key) override {
        // ★ v3.5.12: NimBLE Just Works 哨兵 — 收到此回调 = 正在配对（非旧 bond 复用）
        //   如果 hasBondedDevices==true，说明手机端取消了配对但仍保持连接
        //   → 链接已变成僵尸状态（加密丢失、GATT 阻塞、RSSI 乱跳）
        //   → 必须 deleteAllBonds() 断开连接，触发干净的 onDisconnect → 重新广播
        if (hasBondedDevices) {
            Serial.printf("[SEC] ⚠ Stale bond via onConfirmPIN(%06u) → clearing & disconnecting zombie\n", pass_key);
            freshPairingInProgress = true;
            deleteAllBonds();                   // 清除 bond + 名称 + 断开僵尸连接
            notifyStatus();                     // 通知 App 连接已断
            return false;                       // 拒绝本次配对，让重连走干净流程
        }
        freshPairingInProgress = true;
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
            encryptionEstablished = true;    // ★ v3.4: 仅认证成功才标记加密完成
            encryptionEstablishedAtMs = millis();  // ★ v3.5.16
            pinVerified = true;              // ★ v3.5.10: Bluedroid 静态 PIN 验证成功 → 授权
            pinVerifyFailCount = 0;
            Serial.println("[SEC] authentication complete — bonded & encrypted");
        } else {
            Serial.printf("[SEC] authentication failed: reason=0x%02x\n", auth_cmpl.fail_reason);
            // ★ v3.5: 旧 bond 失效（手机端取消配对）→ 自动清除
            if (hasBondedDevices) {
                Serial.println("[SEC] Old bond invalid, clearing bonds & device name...");
                deleteAllBonds();
            }
            // ★ v3.4: 认证失败，保持 encryptionEstablished=false
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
            encryptionEstablished = true;    // ★ v3.4: 仅认证成功才标记加密完成
            encryptionEstablishedAtMs = millis();  // ★ v3.5.16: 记录加密完成时刻，用于 PIN 验证截止
            // ★ v3.5.11: 区分旧 bond 复用 vs 新配对 → 用 freshPairingInProgress 哨兵
            //   NimBLE Just Works(NO_INPUT_OUTPUT) 下 onPassKeyRequest 不会触发，
            //   仅 onConfirmPIN/onPassKeyNotify 能可靠标记"正在配对新 bond"。
            //   旧 bond 复用 → 无任何配对回调 → freshPairingInProgress=false → 免密
            //   新配对/stale bond → 配对回调触发 → freshPairingInProgress=true → 需验证
            pinVerified = (wasBondedOnConnect && !freshPairingInProgress);
            freshPairingInProgress = false;  // ★ 重置哨兵
            pinVerifyFailCount = 0;
            Serial.printf("[SEC] auth complete — pinVerified=%s (fresh=%s, wasBonded=%s)\n",
                          pinVerified ? "AUTO" : "REQUIRED",
                          freshPairingInProgress ? "yes" : "no",
                          wasBondedOnConnect ? "yes" : "no");
        } else {
            Serial.println("[SEC] authentication failed");
            freshPairingInProgress = false;  // ★ v3.5.11
            // ★ v3.5: 旧 bond 失效（手机端取消配对）→ 自动清除
            if (hasBondedDevices) {
                Serial.println("[SEC] Old bond invalid, clearing bonds & device name...");
                deleteAllBonds();
            }
            // ★ v3.4: 认证失败，保持 encryptionEstablished=false
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
        encryptionEstablished = false;       // ★ v3.4: 连接 ≠ 加密，reset
        wasBondedOnConnect = hasBondedDevices; // ★ v3.5: 记录连接前 bond 状态
        pinVerified = false;                 // ★ v3.5.10: 新连接必须重新验证或自动续约
        pinVerifyFailCount = 0;              // ★ v3.5.10: 重置暴力破解计数
        freshPairingInProgress = false;      // ★ v3.5.11
        securityRequestPending = true;       // ★ v3.5: 延迟后主动发起加密请求
        securityRequestAtMs = millis();
        connectionId = param->connect.conn_id;
        connectStartMs = millis();
        encryptionEstablishedAtMs = 0;       // ★ v3.5.16
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
        encryptionEstablished = false;       // ★ v3.4: 断开即清除加密标记
        wasBondedOnConnect = false;          // ★ v3.5
        pinVerified = false;                 // ★ v3.5.10
        pinVerifyFailCount = 0;              // ★ v3.5.10
        freshPairingInProgress = false;      // ★ v3.5.11
        encryptionEstablishedAtMs = 0;       // ★ v3.5.16
        securityRequestPending = false;      // ★ v3.5
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
        encryptionEstablished = false;       // ★ v3.4: 连接 ≠ 加密，reset
        wasBondedOnConnect = hasBondedDevices; // ★ v3.5: 记录连接前 bond 状态
        pinVerified = false;                 // ★ v3.5.10: 新连接必须重新验证（onAuthComplete 中自动续约）
        pinVerifyFailCount = 0;              // ★ v3.5.10: 重置暴力破解计数
        freshPairingInProgress = false;      // ★ v3.5.11: 重置哨兵
        securityRequestPending = true;       // ★ v3.5: 延迟后主动发起加密请求
        securityRequestAtMs = millis();
        nimbleConnHandle = desc->conn_handle;
        connectionId = desc->conn_handle;
        connectStartMs = millis();
        encryptionEstablishedAtMs = 0;       // ★ v3.5.16: 新连接清除 PIN 验证截止计时器
        memcpy(nimblePeerAddr, desc->peer_id_addr.val, 6);

        Serial.println("[BLE] phone connected — encryption handled by BLE stack");
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        notifyStatus();
    }

    void onDisconnect(BLEServer* server, ble_gap_conn_desc* desc) override {
        deviceConnected = false;
        encryptionEstablished = false;       // ★ v3.4: 断开即清除加密标记
        wasBondedOnConnect = false;          // ★ v3.5
        pinVerified = false;                 // ★ v3.5.10
        pinVerifyFailCount = 0;              // ★ v3.5.10
        freshPairingInProgress = false;      // ★ v3.5.11
        encryptionEstablishedAtMs = 0;       // ★ v3.5.16
        securityRequestPending = false;      // ★ v3.5
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
        encryptionEstablished = false;       // ★ v3.4
        wasBondedOnConnect = hasBondedDevices; // ★ v3.5
        pinVerified = false;                 // ★ v3.5.10
        pinVerifyFailCount = 0;              // ★ v3.5.10
        freshPairingInProgress = false;      // ★ v3.5.11
        securityRequestPending = true;       // ★ v3.5
        securityRequestAtMs = millis();
        resetKalmanFilter();
        unlockCounter = 0;
        lockCounter = 0;
        nativeRssiWarningPrinted = false;
        Serial.println("[BLE] phone connected (no native RSSI)");
        Serial.println("[BLE] write rssi=-50 to FF01 or serial cfg for logic test");
    }

    void onDisconnect(BLEServer* server) override {
        deviceConnected = false;
        encryptionEstablished = false;       // ★ v3.4
        wasBondedOnConnect = false;          // ★ v3.5
        pinVerified = false;                 // ★ v3.5.10
        pinVerifyFailCount = 0;              // ★ v3.5.10
        freshPairingInProgress = false;      // ★ v3.5.11
        securityRequestPending = false;      // ★ v3.5
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
            // ★ v3.12: 不自动 saveConfig() — 配置仅存 RAM，手机每次连接下发覆盖
            //   ESP32 NVS Flash 也有擦写寿命限制，避免每次连接都写
            Serial.printf("[CONFIG] updated by BLE (RAM-only): %s\n", value.c_str());
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

        // ★ v3.5.10: 应用层 PIN 验证 — 唯一不需要 pinVerified 的命令
        if (upper.startsWith("VERIFY:")) {
            handleVerify(cmd.substring(7));
            return;
        }

        // ★ v3.5.10: 所有敏感命令需要应用层 PIN 验证
        //   Just Works 配对后链路已加密，但未验证用户身份
        if (!pinVerified) {
            Serial.printf("[SEC] Command rejected (pinVerified=false): %s\n", cmd.c_str());
            return;
        }

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

    // ★ v3.5.10: 应用层 PIN 验证 — Just Works 配对后 App 发送 VERIFY:<pin>
    void handleVerify(String pinInput) {
        pinInput.trim();

        // 防暴力破解（极端情况兜底：如果因某种原因 pinVerifyFailCount 未重置就再次收到 VERIFY）
        if (pinVerifyFailCount >= PIN_VERIFY_MAX_FAILS) {
            Serial.printf("[SEC] VERIFY blocked — too many failures (%d), wait for reconnect\n", pinVerifyFailCount);
            return;
        }

        if (pinInput == pairingPIN) {
            pinVerified = true;
            pinVerifyFailCount = 0;
            encryptionEstablishedAtMs = 0;   // ★ v3.5.16: 验证通过后清除截止计时器
            Serial.println("[SEC] PIN VERIFY OK — device authorized");
        } else {
            pinVerifyFailCount++;
            pinVerified = false;
            Serial.printf("[SEC] PIN VERIFY FAIL (%d/%d) — wrong PIN: '%s'\n",
                          pinVerifyFailCount, PIN_VERIFY_MAX_FAILS, pinInput.c_str());
            if (pinVerifyFailCount >= PIN_VERIFY_MAX_FAILS) {
                Serial.println("[SEC] Max failures reached, clearing bond & disconnecting...");
                // ★ v3.5.15: 先清除 bond → 再通知 → 再断开
                //   不清 bond 会导致重连时 wasBondedOnConnect=true → pinVerified=AUTO 绕过 PIN
                deleteAllBonds();
                notifyStatus();
                delay(500);
                if (pServer && deviceConnected) {
                    pServer->disconnect(connectionId);
                }
                return;
            }
        }
        notifyStatus();  // ★ 推送 pinv 状态变化给 App
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
            pinChangeError = 1;                // ★ v3.3: 旧 PIN 错误（声明式错误码）
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

        // ★ v3.4: 删除 bond + 保存新 PIN + 重启确保彻底清除旧密钥
        //   重启原因：ESP32 BLE bond 数据存储在 NVS 底层，preferences.clear("ble")
        //   可能无法完整清除，重启后 BLE 栈从 NVS 重新读取，确保干净状态
        deleteAllBonds();
        pairingPIN = newPIN;
        pinDefault = (pairingPIN == DEFAULT_PAIRING_PIN);
        savePIN();
        Serial.printf("[SEC] PIN changed to %s, restarting in 500ms...\n", newPIN.c_str());
        delay(500);                // 等待 NVS 刷入完成
        ESP.restart();             // ★ v3.4: 重启设备，确保 BLE 栈干净启动
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
    esp_read_mac(deviceMac, ESP_MAC_BT);  // ★ v3.3: 全局变量，所有函数可访问 MAC 指纹
    snprintf(deviceName, sizeof(deviceName), "%s-%02X%02X%02X",
             DEVICE_NAME_PREFIX, deviceMac[3], deviceMac[4], deviceMac[5]);

    // ---- Print banner ----
    Serial.println();
    Serial.println("============================================");
    Serial.println("  BLE-Key-Go v3.5 starting...");
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
    Serial.printf("==== BLE-Key-Go v3.5 | Device: %s ====\n", deviceName);
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
    // ★ v3.5.10: Just Works — NimBLE 不支持静态 PIN 验证，改为链路层静默加密
    //   真正的 PIN 校验移到应用层：App 通过 FF03 发送 VERIFY:<pin> 命令
    BLESecurity *pSecurity = new BLESecurity();
    pSecurity->setAuthenticationMode(ESP_LE_AUTH_BOND);           // Legacy pairing + Bonding（无 SC）
    pSecurity->setCapability(BLE_HS_IO_NO_INPUT_OUTPUT);          // Just Works: 无用户交互，静默加密
    pSecurity->setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
    pSecurity->setRespEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
    BLEDevice::setSecurityCallbacks(new SecurityCallbacks());     // 仅用于追踪 auth 完成事件
#endif

#if BLE_KEY_GO_STACK_BLUEDROID
    BLEDevice::setCustomGapHandler(gapEventHandler);
#endif

    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());

    BLEService* service = pServer->createService(SERVICE_UUID);

    // ★ v3.5: FF01 — 配置特征（Write，加密后可用）
    BLECharacteristic* configCharacteristic = service->createCharacteristic(
        CONFIG_CHAR_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    configCharacteristic->setAccessPermissions(ESP_GATT_PERM_WRITE_ENCRYPTED);  // ★ v3.5: 未配对拒绝写入
    configCharacteristic->setCallbacks(new ConfigCallbacks());

    // ★ v3.5: FF02 — 状态特征（Read + Notify，加密后可用）
    pStatusCharacteristic = service->createCharacteristic(
        STATUS_CHAR_UUID,
        BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
    );
    pStatusCharacteristic->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED);  // ★ v3.5: 未配对拒绝读取
    BLE2902* cccd = new BLE2902();
    cccd->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED | ESP_GATT_PERM_WRITE_ENCRYPTED);  // ★ v3.5: 未配对拒绝订阅
    pStatusCharacteristic->addDescriptor(cccd);

    // ★ v3.5: FF03 — 命令特征（Write，加密后可用）
    BLECharacteristic* commandCharacteristic = service->createCharacteristic(
        COMMAND_CHAR_UUID,
        BLECharacteristic::PROPERTY_WRITE
    );
    commandCharacteristic->setAccessPermissions(ESP_GATT_PERM_WRITE_ENCRYPTED);  // ★ v3.5: 未配对拒绝写入
    CommandCallbacks* cmdCb = new CommandCallbacks();
    g_commandCallbacks = cmdCb;
    commandCharacteristic->setCallbacks(cmdCb);

    // ★ v3.3: FF04 — 设备序列号特征（Read-only，出厂唯一，永不改变）
    BLECharacteristic* serialCharacteristic = service->createCharacteristic(
        SERIAL_CHAR_UUID,
        BLECharacteristic::PROPERTY_READ
    );
    serialCharacteristic->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED);  // ★ v3.5: 未配对拒绝读取
    char serialStr[13];
    snprintf(serialStr, sizeof(serialStr), "%02X%02X%02X%02X%02X%02X",
             deviceMac[0], deviceMac[1], deviceMac[2],
             deviceMac[3], deviceMac[4], deviceMac[5]);
    serialCharacteristic->setValue(serialStr);
    Serial.printf("[SERIAL] Device Serial Number: %s\n", serialStr);

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

    // ★ v3.5: 连接后延迟发起安全请求（强制手机弹出 PIN 框）
    //   根因：之前依赖手机主动发起配对，但手机可能不发起
    //   修复：ESP32 主动调用 esp_ble_set_encryption() 触发配对流程
    if (securityRequestPending && deviceConnected && !encryptionEstablished) {
        if (millis() - securityRequestAtMs >= SECURITY_REQUEST_DELAY_MS) {
            securityRequestPending = false;
            Serial.println("[SEC] Requesting encryption...");
#if BLE_KEY_GO_STACK_BLUEDROID
            esp_ble_set_encryption(connectedRemoteAddress, ESP_BLE_SEC_ENCRYPT);
#elif BLE_KEY_GO_STACK_NIMBLE
            ble_gap_security_initiate(nimbleConnHandle);
#else
            Serial.println("[SEC] Stack unknown, skip security request");
#endif
        }
    }

    // ★ v3.5: Bonding 超时检测（连接后 60s 未完成配对则断开）
    //   三路检测：
    //     1. wasBondedOnConnect → 旧 bond 失效，被动断开重来
    //     2. onPassKeyRequest + hasBondedDevices → 手机端取消配对（主动清除）
    //     3. onAuthenticationComplete(fail) + hasBondedDevices → 加密失败（主动清除）
    if (deviceConnected) {
        static bool timeoutWarned = false;
        unsigned long elapsed = millis() - connectStartMs;
        if (elapsed > BONDING_TIMEOUT_MS && !timeoutWarned) {
            if (!encryptionEstablished) {
                if (wasBondedOnConnect) {
                    // ★ v3.5: 连接前有 bond 但超时未加密 → 旧 bond 已失效
                    Serial.println("[SEC] Bonding timeout (60s) with stale bond → clearing & disconnecting");
                    deleteAllBonds();
                } else if (!hasBondedDevices) {
                    Serial.println("[SEC] Bonding timeout (60s) — disconnecting");
                    pServer->disconnect(connectionId);
                }
            }
            timeoutWarned = true;
        }
        if (!deviceConnected) {
            timeoutWarned = false;
        }

        // ★ v3.5.16: PIN 验证截止时间（防恶意占线）
        //   加密已完成但 pinVerified 持续为 false → 攻击者连上了但不知道 PIN
        //   30 秒内未通过 PIN 验证 → 主动断开，释放连接给合法用户
        if (encryptionEstablished && !pinVerified && encryptionEstablishedAtMs > 0) {
            unsigned long unpinElapsed = millis() - encryptionEstablishedAtMs;
            if (unpinElapsed >= PIN_VERIFY_DEADLINE_MS) {
                Serial.printf("[SEC] PIN verify deadline exceeded (%lums > %lums), disconnecting...\n",
                              unpinElapsed, (unsigned long)PIN_VERIFY_DEADLINE_MS);
                if (pServer && deviceConnected) {
                    pServer->disconnect(connectionId);
                }
                encryptionEstablishedAtMs = 0;
            }
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
    hasBondedDevices = false;
    encryptionEstablished = false;    // ★ v3.4: 清 bond 即取消加密标记
    wasBondedOnConnect = false;       // ★ v3.5: 跟踪变量同步清除
    pinVerified = false;              // ★ v3.5.10: 清 bond 同时清除验证状态
    pinVerifyFailCount = 0;           // ★ v3.5.10
    freshPairingInProgress = false;   // ★ v3.5.11
    securityRequestPending = false;   // ★ v3.5: 安全请求标记同步清除
    encryptionEstablishedAtMs = 0;   // ★ v3.5.16

    // ★ v3.5: 清除自定义设备名称（取消配对 = 设备回到出厂空白状态）
    customDeviceName = "";
    preferences.putString("dev_name", "");

    Serial.println("[SEC] All BLE bonds deleted (name cleared)");

    // ★ v3.3: 主动断开当前连接（清 NVS bond 不会自动断连 BLE）
    if (deviceConnected && pServer) {
        Serial.println("[SEC] Disconnecting current connection after bond clear...");
        pServer->disconnect(connectionId);
        deviceConnected = false;
    }
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

    // ★ v3.4: 显式控制广播数据，避免设备名被截断为 "Ke"
    //   根因：BLE 广播包仅 31 字节，Flags(3) + 128bit UUID(18) + 完整名 "KeyGo-71C65A"(15) = 36 > 31
    //   修复：UUID 移到 Scan Response，广播包只放完整名，手机蓝牙列表直接显示 "KeyGo-71C65A"
    BLEAdvertisementData advertData;

    advertData.setAppearance(0x00C1);                            // ★ Appearance: 外观：通用手表
    // advertData.setCompleteServices(BLEUUID((uint16_t)0x180F));   // ★ 服务：Battery Service (电池服务)  UUID — 触发手机图标


    advertData.setName(String(deviceName));               // ★ 完整名 "KeyGo-71C65A"

    // Scan Response: Service UUID + 厂商数据（App 靠厂商数据筛选，不依赖 UUID）
    String mfrData;
    mfrData += (char)(MANUFACTURER_ID & 0xFF);
    mfrData += (char)((MANUFACTURER_ID >> 8) & 0xFF);
    mfrData += MANUFACTURER_DATA;                         // "KG" 协议标记
    mfrData += (char)deviceMac[3];                        // ★ v3.3: MAC 后缀字节（设备指纹，3 bytes）
    mfrData += (char)deviceMac[4];
    mfrData += (char)deviceMac[5];
    BLEAdvertisementData scanData;
    scanData.setCompleteServices(BLEUUID(SERVICE_UUID));
    scanData.setManufacturerData(mfrData);

    advertising->setAdvertisementData(advertData);
    advertising->setScanResponseData(scanData);

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

    // ★ v3.5.14: 加密建立前阻止自动解锁
    //   根因：executeUnlockSequence 中的 delay() 会阻塞 NimBLE 事件队列，
    //   在加密协商期间调用会导致 BLE 连接断开。
    //   同时也确保只有已授权的设备才能触发自动控制。
    if (!encryptionEstablished || !pinVerified) return;

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
    // dn=deviceName d2=customName(★ v3.5: 仅加密时发送实际值，未加密时为空)
    // sn=serialNumber(MAC后缀)
    // pm=pairingMode pd=pinDefault pce=pin_change_error pinv=pinVerified(★ v3.5.10)
    String p = "{";
    p += "\"c\":" + String(deviceConnected ? 1 : 0);
    p += ",\"enc\":" + String(encryptionEstablished ? 1 : 0);   // ★ v3.4: 真实加密状态，非连接状态
    p += ",\"bdd\":" + String(hasBondedDevices ? 1 : 0);
    p += ",\"pinv\":" + String(pinVerified ? 1 : 0);            // ★ v3.5.10: 应用层 PIN 验证状态
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
    // ★ v3.5: 自定义名称 d2 — 仅加密连接时泄露实际值，未加密时返回空串
    //   双重保护：特征值已有 ESP_GATT_PERM_READ_ENCRYPTED，JSON 层面再过滤一道
    p += ",\"d2\":\"" + String(encryptionEstablished ? customDeviceName : "") + "\"";
    {
        char snHex[7];
        snprintf(snHex, 7, "%02X%02X%02X", deviceMac[3], deviceMac[4], deviceMac[5]);
        p += ",\"sn\":\"" + String(snHex) + "\"";    // ★ v3.3: 设备指纹（MAC 后缀）
    }
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
        Serial.printf("[SEC] PIN changed to %s, restarting in 500ms...\n", newPIN.c_str());
        delay(500);
        ESP.restart();             // ★ v3.4: 重启确保 BLE 栈干净启动
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
