#ifndef __CONFIG_STORAGE_H__
#define __CONFIG_STORAGE_H__

#include "config.h"

/* ============================================================
 *  Flash 持久化存储模块
 *  替代 ESP32 的 Preferences NVS
 *  使用 CH582M Flash 最后 2 页 (4KB) 存储配置
 * ============================================================ */

#define STORAGE_MAGIC       0x4B473335  // "KG35"
#define STORAGE_VERSION     1

#define FLASH_PAGE_SIZE     4096
#define STORAGE_ADDR        (0x0003F000)  // 256KB Flash 最后一页

typedef struct {
    uint32_t magic;
    uint32_t version;
    uint32_t crc32;
    int16_t  rssiUnlockThreshold;
    int16_t  rssiLockThreshold;
    int16_t  rssiHysteresisDb;
    int16_t  rssiSpikeRejectDb;
    uint16_t unlockCountRequired;
    uint16_t lockCountRequired;
    uint16_t rssiSampleIntervalMs;
    uint16_t disconnectLockDelayMs;
    float    kf_q;
    float    kf_r;
    char     pairingPin[MAX_PIN_LEN + 1];
    char     customDeviceName[MAX_CUSTOM_NAME_LEN + 1];
} StorageData_t;

void Storage_Init(void);
bool Storage_Load(StorageData_t *data);
bool Storage_Save(const StorageData_t *data);
void Storage_FactoryReset(void);

void Storage_LoadToGlobal(void);
void Storage_SaveFromGlobal(void);

uint32_t Storage_CRC32(const uint8_t *data, uint32_t len);

#endif
