#ifndef __CONFIG_H__
#define __CONFIG_H__

#include "CH58x_common.h"
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

/* ============================================================
 *  BLE-Key-Go v3.5 for CH582M
 *  配置总配置定义
 * ============================================================ */

/* -------- 引脚定义 -------- */
#define PIN_UNLOCK          GPIO_Pin_2      // PA2: 解锁
#define PIN_LOCK            GPIO_Pin_3     // PA3: 锁车
#define PIN_TRUNK           GPIO_Pin_4     // PA4: 后备箱
#define PIN_KEY_POWER       GPIO_Pin_5     // PA5: 钥匙供电
#define PIN_LED             GPIO_Pin_8     // PA8: 状态LED
#define PIN_BIND            GPIO_Pin_9     // PA9: 配对按键(低有效)

#define PIN_PORT_UNLOCK    GPIOA
#define PIN_PORT_LOCK      GPIOA
#define PIN_PORT_TRUNK     GPIOA
#define PIN_PORT_KEY_POWER  GPIOA
#define PIN_PORT_LED       GPIOA
#define PIN_PORT_BIND      GPIOA

/* -------- 电平定义 -------- */
#define NMOS_ON             1
#define NMOS_OFF            0
#define PMOS_ON             0
#define PMOS_OFF            1

/* -------- BLE UUIDs -------- */
#define DEVICE_NAME_PREFIX  "KeyGo"
#define SERVICE_UUID_128    {0xfb,0x34,0x9b,0x5f,0x80,0x00,0x00,0x80,0x00,0x10,0x00,0x00,0x00,0xff,0x00,0x00}
#define CONFIG_CHAR_UUID    {0xfb,0x34,0x9b,0x5f,0x80,0x00,0x00,0x80,0x00,0x10,0x00,0x00,0x01,0xff,0x00,0x00}
#define STATUS_CHAR_UUID    {0xfb,0x34,0x9b,0x5f,0x80,0x00,0x00,0x80,0x00,0x10,0x00,0x00,0x02,0xff,0x00,0x00}
#define COMMAND_CHAR_UUID   {0xfb,0x34,0x9b,0x5f,0x80,0x00,0x00,0x80,0x00,0x10,0x00,0x00,0x03,0xff,0x00,0x00}
#define SERIAL_CHAR_UUID    {0xfb,0x34,0x9b,0x5f,0x80,0x00,0x00,0x80,0x00,0x10,0x00,0x00,0x04,0xff,0x00,0x00}

#define MANUFACTURER_ID     0xFFFF
#define MANUFACTURER_DATA   "KG"

/* -------- 默认参数 -------- */
#define DEFAULT_RSSI_UNLOCK     -45
#define DEFAULT_RSSI_LOCK      -65
#define DEFAULT_HYSTERESIS_DB     5
#define DEFAULT_SPIKE_REJECT_DB  25
#define DEFAULT_UNLOCK_COUNT     3
#define DEFAULT_LOCK_COUNT       5
#define DEFAULT_SAMPLE_INTERVAL  500
#define DEFAULT_DLOCK_DELAY     5000

#define DEFAULT_KF_Q                4.0f
#define DEFAULT_KF_R                16.0f

#define DEFAULT_KEY_POWER_DELAY    200
#define DEFAULT_KEY_PRESS_DURATION  300
#define DEFAULT_KEY_RELEASE_DELAY  500

#define DEFAULT_PAIRING_PIN        "123456"
#define DEFAULT_PAIRING_TIMEOUT  30000
#define FACTORY_RESET_HOLD_MS    5000

#define MANUAL_COOLDOWN_MS        8000
#define BONDING_TIMEOUT_MS      60000
#define SECURITY_REQUEST_DELAY_MS  500

#define SPIKE_CONSECUTIVE_REQUIRED  2

#define STATUS_NOTIFY_INTERVAL     1000
#define BUTTON_DEBOUNCE_MS       50

#define MAX_CUSTOM_NAME_LEN     20
#define MAX_PIN_LEN             6
#define MIN_PIN_LEN             4

#define DEVICE_NAME_MAX_LEN      32
#define SERIAL_NUMBER_LEN      12
#define MAC_ADDR_LEN          6

/* -------- 状态枚举 -------- */
typedef enum {
    STATE_LOCKED = 0,
    STATE_UNLOCKED = 1,
    STATE_ACTION = 2
} KeyState_t;

/* -------- 全局配置结构体 -------- */
typedef struct {
    int16_t rssiUnlockThreshold;
    int16_t rssiLockThreshold;
    int16_t rssiHysteresisDb;
    int16_t rssiSpikeRejectDb;
    uint16_t unlockCountRequired;
    uint16_t lockCountRequired;
    uint16_t rssiSampleIntervalMs;
    uint16_t disconnectLockDelayMs;
    float kf_q;
    float kf_r;
    char pairingPin[MAX_PIN_LEN + 1];
    bool pinDefault;
    char customDeviceName[MAX_CUSTOM_NAME_LEN + 1];
    uint8_t deviceMac[MAC_ADDR_LEN];
    char deviceName[DEVICE_NAME_MAX_LEN];
    char serialNumber[SERIAL_NUMBER_LEN + 1];
} SystemConfig_t;

/* -------- 全局运行时状态 -------- */
typedef struct {
    KeyState_t currentState;
    bool deviceConnected;
    bool encryptionEstablished;
    bool hasBondedDevices;
    bool pairingModeActive;
    uint32_t pairingModeStartMs;
    int16_t latestRSSI;
    float filteredRSSI;
    bool rssiInitialized;
    uint16_t unlockCounter;
    uint16_t lockCounter;
    bool manualCommandCooldown;
    uint32_t manualCommandTimestampMs;
    uint32_t disconnectTimestampMs;
    uint32_t connectStartMs;
    bool wasBondedOnConnect;
    bool securityRequestPending;
    uint32_t securityRequestAtMs;
    uint16_t connectionHandle;
    uint8_t peerAddr[MAC_ADDR_LEN];
    uint8_t pinChangeError;
} RuntimeState_t;

extern SystemConfig_t g_cfg;
extern RuntimeState_t g_st;

extern volatile uint32_t g_sysTickMs;

void Delay_Ms(uint32_t ms);
uint32_t GetSysTickMs(void);

#endif
