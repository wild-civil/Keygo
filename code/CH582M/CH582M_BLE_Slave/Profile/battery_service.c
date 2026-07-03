/********************************** (C) COPYRIGHT *******************************
 * File Name          : battery_service.c
 * Author             : KeyGo v3.13
 * Date               : 2026/07/03
 * Description        : BLE Battery Service (0x180F) 实现
 *                      电量通过 CH582M 内部 VBAT ADC 通道读取，不需要外部引脚
 *
 * GATT 属性表结构:
 *   [0] Service Declaration  (0x2800, UUID=0x180F)
 *   [1] Char Declaration     (0x2803, Props=Read|Notify)
 *   [2] Char Value           (0x2A19, uint8_t 0-100)
 *   [3] CCCD                 (0x2902, Client Char Config)
 *********************************************************************************/

#include "CONFIG.h"
#include "battery_service.h"
#include "CH58x_adc.h"

#include <stdio.h>

/* ════════════════════════════════════════════════════════════════════════════
 * BLE UUID 常量
 * ════════════════════════════════════════════════════════════════════════════ */

static const uint8_t battServUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(BATT_SERV_UUID), HI_UINT16(BATT_SERV_UUID)
};

static const uint8_t battLevelUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(BATT_LEVEL_UUID), HI_UINT16(BATT_LEVEL_UUID)
};

/* ════════════════════════════════════════════════════════════════════════════
 * 服务实例变量
 * ════════════════════════════════════════════════════════════════════════════ */

static const gattAttrType_t battService = { ATT_BT_UUID_SIZE, battServUUID };

static uint8_t battLevelProps = GATT_PROP_READ | GATT_PROP_NOTIFY;
static uint8_t batteryLevel    = 100;               // 默认满电

static gattCharCfg_t battLevelClientCharCfg[GATT_MAX_NUM_CONN];

/* ════════════════════════════════════════════════════════════════════════════
 * 前向声明
 * ════════════════════════════════════════════════════════════════════════════ */

static bStatus_t batt_ReadAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                  uint8_t *pValue, uint16_t *pLen,
                                  uint16_t offset, uint16_t maxLen, uint8_t method);
static bStatus_t batt_WriteAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                   uint8_t *pValue, uint16_t len,
                                   uint16_t offset, uint8_t method);

/* ════════════════════════════════════════════════════════════════════════════
 * GATT 属性表
 * ════════════════════════════════════════════════════════════════════════════ */

static gattAttribute_t battAttrTbl[] = {
    /* [0] Battery Service Declaration */
    {
        { ATT_BT_UUID_SIZE, primaryServiceUUID },
        GATT_PERMIT_READ,
        0,
        (uint8_t *)&battService
    },

    /* [1] Battery Level Channel Declaration */
    {
        { ATT_BT_UUID_SIZE, characterUUID },
        GATT_PERMIT_READ,
        0,
        &battLevelProps
    },

    /* [2] Battery Level Value */
    {
        { ATT_BT_UUID_SIZE, battLevelUUID },
        GATT_PERMIT_READ,
        0,
        &batteryLevel
    },

    /* [3] Battery Level CCCD */
    {
        { ATT_BT_UUID_SIZE, clientCharCfgUUID },
        GATT_PERMIT_READ | GATT_PERMIT_WRITE,
        0,
        (uint8_t *)&battLevelClientCharCfg
    },
};

/* ════════════════════════════════════════════════════════════════════════════
 * GATT 服务回调表
 * ════════════════════════════════════════════════════════════════════════════ */

static gattServiceCBs_t battCBs = {
    batt_ReadAttrCB,
    batt_WriteAttrCB,
    NULL   // no authorization callback
};

/* ════════════════════════════════════════════════════════════════════════════
 * Public API
 * ════════════════════════════════════════════════════════════════════════════ */

bStatus_t Battery_AddService(void)
{
    GATTServApp_InitCharCfg(INVALID_CONNHANDLE, battLevelClientCharCfg);

    return GATTServApp_RegisterService(battAttrTbl,
                                        GATT_NUM_ATTRS(battAttrTbl),
                                        GATT_MAX_ENCRYPT_KEY_SIZE,
                                        &battCBs);
}

uint8_t Battery_GetLevel(void)
{
    return batteryLevel;
}

void Battery_Notify(void)
{
    uint16_t connHandle = 0;
    uint8_t  found = 0;
    uint16_t i;

    for (i = 0; i < GATT_MAX_NUM_CONN; i++) {
        if (battLevelClientCharCfg[i].connHandle != INVALID_CONNHANDLE &&
            battLevelClientCharCfg[i].value == GATT_CLIENT_CFG_NOTIFY) {
            connHandle = battLevelClientCharCfg[i].connHandle;
            found = 1;
            break;
        }
    }

    if (!found) return;

    attHandleValueNoti_t noti;
    noti.handle = battAttrTbl[BATT_LEVEL_VALUE_POS].handle;
    noti.len    = BATT_LEVEL_LEN;
    noti.pValue = GATT_bm_alloc(connHandle, ATT_HANDLE_VALUE_NOTI, BATT_LEVEL_LEN, NULL, 0);
    if (noti.pValue) {
        noti.pValue[0] = batteryLevel;
        GATT_Notification(connHandle, &noti, FALSE);
    }
}

void Battery_UpdateLevel(void)
{
    uint16_t adcVal;
    uint16_t vdd_mV;
    uint8_t  newLevel;

    /* ── 读取内部 VBAT ADC (CH582M 内置通道 14) ── */
    {
        uint8_t savedChannel = R8_ADC_CHANNEL;
        uint8_t savedCfg     = R8_ADC_CFG;

        /* 内部 VBAT 通道配置: 上电 + 输入缓冲 + PGA -12dB(1/4) + 采样时钟 3
         * ★ 必须用 -12dB: CH582M ADC 基准=1.05V, VBAT通道=VDD/3,
         *   若用 0dB 则 VDD≥3.15V 时输入端超量程→ADC 饱和在 4095→电压读错 */
        R8_ADC_CFG    = RB_ADC_POWER_ON | RB_ADC_BUF_EN | ADC_PGA_1_4 | (3 << 6);
        R8_ADC_CHANNEL = 14;   // CH_INTE_VBAT
        R8_ADC_CONVERT = RB_ADC_START;
        while (R8_ADC_CONVERT & RB_ADC_START);

        adcVal = R16_ADC_DATA;

        R8_ADC_CHANNEL = savedChannel;
        R8_ADC_CFG     = savedCfg;
    }

    /*
     * VBAT 内部通道: 电压 = VDD / 3，PGA = -12dB (1/4)，基准 = 1.05V bandgap
     * 所以: VDD(mV) = (adcVal * 1050 * 3 * 4) / 4096 = adcVal * 12600 / 4096
     *
     * 注: 此公式需要根据实际板子校准。不同芯片的 bandgap
     *     和分压比有轻微差异，后续可用万用表实测校准。
     */
    vdd_mV = (uint32_t)adcVal * 1050 * 12 / 4096;

    /* ── 电压 → 电量百分比 ──
     * 简化线性映射: 3.0V → 0%, 4.2V → 100%
     * 如果是通过 LDO 供电 (固定 3.3V), 则始终读不到 4.2V
     * TODO: 以后直连电池时使用放电曲线查表
     */
    if (vdd_mV >= 4200) {
        newLevel = 100;
    } else if (vdd_mV <= 3000) {
        newLevel = 0;
    } else {
        newLevel = (uint8_t)((uint32_t)(vdd_mV - 3000) * 100 / 1200);
    }

    /* ── 变化时更新 + 通知 ── */
    if (newLevel != batteryLevel) {
        batteryLevel = newLevel;
        PRINT("[BATT] Level updated: %d%%  (VDD=%d mV, ADC=%d)\n",
              batteryLevel, vdd_mV, adcVal);
        Battery_Notify();
    }
}

/* ════════════════════════════════════════════════════════════════════════════
 * GATT 读写回调
 * ════════════════════════════════════════════════════════════════════════════ */

static bStatus_t batt_ReadAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                  uint8_t *pValue, uint16_t *pLen,
                                  uint16_t offset, uint16_t maxLen, uint8_t method)
{
    uint16_t uuid = BUILD_UINT16(pAttr->type.uuid[0], pAttr->type.uuid[1]);

    switch (uuid) {
        case BATT_LEVEL_UUID:
            if (offset >= BATT_LEVEL_LEN) {
                return ATT_ERR_INVALID_OFFSET;
            }
            *pLen = MIN(maxLen, BATT_LEVEL_LEN - offset);
            pValue[0] = batteryLevel;
            return SUCCESS;

        default:
            *pLen = 0;
            return ATT_ERR_ATTR_NOT_FOUND;
    }
}

static bStatus_t batt_WriteAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                   uint8_t *pValue, uint16_t len,
                                   uint16_t offset, uint8_t method)
{
    uint16_t uuid = BUILD_UINT16(pAttr->type.uuid[0], pAttr->type.uuid[1]);

    switch (uuid) {
        case GATT_CLIENT_CHAR_CFG_UUID:
            return GATTServApp_ProcessCCCWriteReq(connHandle, pAttr,
                                                   pValue, len, offset,
                                                   GATT_CLIENT_CFG_NOTIFY);

        default:
            return ATT_ERR_ATTR_NOT_FOUND;
    }
}
