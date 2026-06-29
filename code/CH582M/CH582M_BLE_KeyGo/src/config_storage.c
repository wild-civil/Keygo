#include "config_storage.h"
#include "CH58x_flash.h"

static uint32_t crc32_table[256];
static bool crc_table_inited = false;

static void crc32_init_table(void) {
    if (crc_table_inited) return;
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t crc = i;
        for (uint32_t j = 0; j < 8; j++) {
            if (crc & 1)
                crc = (crc >> 1) ^ 0xEDB88320;
            else
                crc >>= 1;
        }
        crc32_table[i] = crc;
    }
    crc_table_inited = true;
}

uint32_t Storage_CRC32(const uint8_t *data, uint32_t len) {
    crc32_init_table();
    uint32_t crc = 0xFFFFFFFF;
    for (uint32_t i = 0; i < len; i++) {
        crc = (crc >> 8) ^ crc32_table[(crc ^ data[i]) & 0xFF];
    }
    return ~crc;
}

void Storage_Init(void) {
    crc32_init_table();
}

bool Storage_Load(StorageData_t *data) {
    if (!data) return false;

    StorageData_t *flashData = (StorageData_t *)STORAGE_ADDR;

    if (flashData->magic != STORAGE_MAGIC) {
        return false;
    }
    if (flashData->version != STORAGE_VERSION) {
        return false;
    }

    uint32_t calcCrc = Storage_CRC32(
        (const uint8_t *)flashData + sizeof(uint32_t) * 3,
        sizeof(StorageData_t) - sizeof(uint32_t) * 3
    );

    if (calcCrc != flashData->crc32) {
        return false;
    }

    memcpy(data, flashData, sizeof(StorageData_t));
    return true;
}

bool Storage_Save(const StorageData_t *data) {
    if (!data) return false;

    StorageData_t tmpData;
    memcpy(&tmpData, data, sizeof(StorageData_t));
    tmpData.magic = STORAGE_MAGIC;
    tmpData.version = STORAGE_VERSION;
    tmpData.crc32 = Storage_CRC32(
        (const uint8_t *)&tmpData + sizeof(uint32_t) * 3,
        sizeof(StorageData_t) - sizeof(uint32_t) * 3
    );

    FLASH_ROM_ERASE(STORAGE_ADDR, FLASH_PAGE_SIZE);

    if (FLASH_ROM_WRITE(STORAGE_ADDR, (uint8_t *)&tmpData, sizeof(StorageData_t)) != 0) {
        return false;
    }

    return true;
}

void Storage_FactoryReset(void) {
    FLASH_ROM_ERASE(STORAGE_ADDR, FLASH_PAGE_SIZE);
}

void Storage_LoadToGlobal(void) {
    StorageData_t data;
    if (Storage_Load(&data)) {
        g_cfg.rssiUnlockThreshold = data.rssiUnlockThreshold;
        g_cfg.rssiLockThreshold = data.rssiLockThreshold;
        g_cfg.rssiHysteresisDb = data.rssiHysteresisDb;
        g_cfg.rssiSpikeRejectDb = data.rssiSpikeRejectDb;
        g_cfg.unlockCountRequired = data.unlockCountRequired;
        g_cfg.lockCountRequired = data.lockCountRequired;
        g_cfg.rssiSampleIntervalMs = data.rssiSampleIntervalMs;
        g_cfg.disconnectLockDelayMs = data.disconnectLockDelayMs;
        g_cfg.kf_q = data.kf_q;
        g_cfg.kf_r = data.kf_r;
        strncpy(g_cfg.pairingPin, data.pairingPin, MAX_PIN_LEN);
        g_cfg.pairingPin[MAX_PIN_LEN] = '\0';
        strncpy(g_cfg.customDeviceName, data.customDeviceName, MAX_CUSTOM_NAME_LEN);
        g_cfg.customDeviceName[MAX_CUSTOM_NAME_LEN] = '\0';
        g_cfg.pinDefault = (strcmp(g_cfg.pairingPin, DEFAULT_PAIRING_PIN) == 0);
    } else {
        g_cfg.rssiUnlockThreshold = DEFAULT_RSSI_UNLOCK;
        g_cfg.rssiLockThreshold = DEFAULT_RSSI_LOCK;
        g_cfg.rssiHysteresisDb = DEFAULT_HYSTERESIS_DB;
        g_cfg.rssiSpikeRejectDb = DEFAULT_SPIKE_REJECT_DB;
        g_cfg.unlockCountRequired = DEFAULT_UNLOCK_COUNT;
        g_cfg.lockCountRequired = DEFAULT_LOCK_COUNT;
        g_cfg.rssiSampleIntervalMs = DEFAULT_SAMPLE_INTERVAL;
        g_cfg.disconnectLockDelayMs = DEFAULT_DLOCK_DELAY;
        g_cfg.kf_q = DEFAULT_KF_Q;
        g_cfg.kf_r = DEFAULT_KF_R;
        strcpy(g_cfg.pairingPin, DEFAULT_PAIRING_PIN);
        g_cfg.pinDefault = true;
        g_cfg.customDeviceName[0] = '\0';
    }
}

void Storage_SaveFromGlobal(void) {
    StorageData_t data;
    memset(&data, 0, sizeof(data));
    data.rssiUnlockThreshold = g_cfg.rssiUnlockThreshold;
    data.rssiLockThreshold = g_cfg.rssiLockThreshold;
    data.rssiHysteresisDb = g_cfg.rssiHysteresisDb;
    data.rssiSpikeRejectDb = g_cfg.rssiSpikeRejectDb;
    data.unlockCountRequired = g_cfg.unlockCountRequired;
    data.lockCountRequired = g_cfg.lockCountRequired;
    data.rssiSampleIntervalMs = g_cfg.rssiSampleIntervalMs;
    data.disconnectLockDelayMs = g_cfg.disconnectLockDelayMs;
    data.kf_q = g_cfg.kf_q;
    data.kf_r = g_cfg.kf_r;
    strncpy(data.pairingPin, g_cfg.pairingPin, MAX_PIN_LEN);
    strncpy(data.customDeviceName, g_cfg.customDeviceName, MAX_CUSTOM_NAME_LEN);
    Storage_Save(&data);
}
