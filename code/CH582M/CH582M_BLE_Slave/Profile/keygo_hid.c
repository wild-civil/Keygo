/********************************** (C) COPYRIGHT *******************************
 * File Name          : keygo_hid.c
 * Author             : KeyGo（CH582M 主固件）
 * Version            : v3.34.0
 * Date               : 2026/07/16
 * Description        : 无App模式 HID 锚点（策略 A · 被动锚点）
 *                      只注册 HID-over-GATT 服务数据库(0x1812 + Report Map)，
 *                      让 OS 把设备当 HID 外设、已配对时自动重连。
 *                      不接管 GAP Role（保留主固件业务回调）。
 *                      设计原则详见 keygo_hid.h 顶部注释。
 ********************************************************************************/

#include "CONFIG.h"
#include "keygo_hid.h"

/*********************************************************************
 * UUID 列表（小端，ATT_BT_UUID_SIZE=2）
 */
static const uint8_t kgHidServUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(KG_HID_SERV_UUID), HI_UINT16(KG_HID_SERV_UUID)};
static const uint8_t kgHidInfoUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(KG_HID_INFORMATION_UUID), HI_UINT16(KG_HID_INFORMATION_UUID)};
static const uint8_t kgHidReportMapUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(KG_REPORT_MAP_UUID), HI_UINT16(KG_REPORT_MAP_UUID)};
static const uint8_t kgHidCtrlPtUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(KG_HID_CTRL_PT_UUID), HI_UINT16(KG_HID_CTRL_PT_UUID)};
static const uint8_t kgHidReportUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(KG_REPORT_UUID), HI_UINT16(KG_REPORT_UUID)};
static const uint8_t kgHidProtoModeUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(KG_PROTOCOL_MODE_UUID), HI_UINT16(KG_PROTOCOL_MODE_UUID)};
static const uint8_t kgHidReportRefUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(GATT_REPORT_REF_UUID), HI_UINT16(GATT_REPORT_REF_UUID)};

/*********************************************************************
 * HID Information 值（bcdHID=0x0111 / bCountryCode=0 / Flags）
 */
static const uint8_t kgHidInfo[KG_HID_INFORMATION_LEN] = {
    LO_UINT16(0x0111), HI_UINT16(0x0111), // bcdHID (USB HID version)
    0x00,                                       // bCountryCode
    KG_HID_FEATURE_FLAGS                            // Flags (RemoteWake)
};

/*********************************************************************
 * HID Report Map 值（Consumer Devices：音量±，范例）
 *   供 OS 建立 HID 设备所需；本模块为被动锚点，不实际发送报告。
 */
static const uint8_t kgHidReportMap[] = {
    0x05, 0x0c, // USAGE_PAGE (Consumer Devices)
    0x09, 0x01, // USAGE (Consumer Control)
    0xa1, 0x01, // COLLECTION (Application)
    0x85, 0x01, //   REPORT_ID (1)
    0x15, 0x00, //   LOGICAL_MINIMUM (0)
    0x25, 0x01, //   LOGICAL_MAXIMUM (1)
    0x75, 0x08, //   REPORT_SIZE (8)
    0x95, 0x01, //   REPORT_COUNT (1)
    0x09, 0xe9, //   USAGE (Volume Up)
    0x81, 0x06, //   INPUT (Data,Var,Rel)
    0x09, 0xea, //   USAGE (Volume Down)
    0x81, 0x06, //   INPUT (Data,Var,Rel)
    0xc0         // END_COLLECTION
};
static uint16_t kgHidReportMapLen = sizeof(kgHidReportMap);

/*********************************************************************
 * 属性值持有变量
 */
static const gattAttrType_t kgHidService = {ATT_BT_UUID_SIZE, kgHidServUUID};

static uint8_t kgHidInfoProps      = GATT_PROP_READ;

static uint8_t kgHidReportMapProps = GATT_PROP_READ;

static uint8_t kgHidCtrlPtProps    = GATT_PROP_WRITE_NO_RSP;
static uint8_t kgHidCtrlPt;

static uint8_t kgHidProtoModeProps = GATT_PROP_READ | GATT_PROP_WRITE_NO_RSP;
static uint8_t kgHidProtoMode     = KG_HID_PROTOCOL_MODE_REPORT;

static uint8_t kgHidReportInProps  = GATT_PROP_READ | GATT_PROP_NOTIFY;
static uint8_t kgHidReportIn;
static gattCharCfg_t kgHidReportInCccd[GATT_MAX_NUM_CONN];

static uint8_t kgHidReportRefIn[KG_HID_REPORT_REF_LEN] = {
    KG_HID_RPT_ID_CONSUMER_IN, KG_HID_REPORT_TYPE_INPUT};

static uint8_t kgHidFeatureProps   = GATT_PROP_READ | GATT_PROP_WRITE;
static uint8_t kgHidFeature;

static uint8_t kgHidReportRefFeat[KG_HID_REPORT_REF_LEN] = {
    KG_HID_RPT_ID_FEATURE, KG_HID_REPORT_TYPE_FEATURE};

/*********************************************************************
 * GATT 属性表（★ 不含「Included Service」：HID-over-GATT 规范中
 *   包含电池服务为【可选】项，且主固件已有独立 0x180F 电池服务，
 *   去掉此项可避免对外部电池服务句柄的依赖，保持零耦合。）
 */
static gattAttribute_t kgHidAttrTbl[] = {
    // HID Service
    {
        {ATT_BT_UUID_SIZE, primaryServiceUUID},
        GATT_PERMIT_READ,
        0,
        (uint8_t *)&kgHidService
    },

    // HID Information characteristic declaration
    {
        {ATT_BT_UUID_SIZE, characterUUID},
        GATT_PERMIT_READ,
        0,
        &kgHidInfoProps
    },

    // HID Information characteristic
    {
        {ATT_BT_UUID_SIZE, kgHidInfoUUID},
        GATT_PERMIT_ENCRYPT_READ,
        0,
        (uint8_t *)kgHidInfo
    },

    // HID Control Point characteristic declaration
    {
        {ATT_BT_UUID_SIZE, characterUUID},
        GATT_PERMIT_READ,
        0,
        &kgHidCtrlPtProps
    },

    // HID Control Point characteristic
    {
        {ATT_BT_UUID_SIZE, kgHidCtrlPtUUID},
        GATT_PERMIT_ENCRYPT_WRITE,
        0,
        &kgHidCtrlPt
    },

    // HID Protocol Mode characteristic declaration
    {
        {ATT_BT_UUID_SIZE, characterUUID},
        GATT_PERMIT_READ,
        0,
        &kgHidProtoModeProps
    },

    // HID Protocol Mode characteristic
    {
        {ATT_BT_UUID_SIZE, kgHidProtoModeUUID},
        GATT_PERMIT_ENCRYPT_READ | GATT_PERMIT_ENCRYPT_WRITE,
        0,
        &kgHidProtoMode
    },

    // HID Report Map characteristic declaration
    {
        {ATT_BT_UUID_SIZE, characterUUID},
        GATT_PERMIT_READ,
        0,
        &kgHidReportMapProps
    },

    // HID Report Map characteristic
    {
        {ATT_BT_UUID_SIZE, kgHidReportMapUUID},
        GATT_PERMIT_ENCRYPT_READ,
        0,
        (uint8_t *)kgHidReportMap
    },

    // HID Report characteristic, Consumer input declaration
    {
        {ATT_BT_UUID_SIZE, characterUUID},
        GATT_PERMIT_READ,
        0,
        &kgHidReportInProps
    },

    // HID Report characteristic, Consumer input
    {
        {ATT_BT_UUID_SIZE, kgHidReportUUID},
        GATT_PERMIT_ENCRYPT_READ,
        0,
        &kgHidReportIn
    },

    // HID Report characteristic client characteristic configuration (CCCD)
    {
        {ATT_BT_UUID_SIZE, clientCharCfgUUID},
        GATT_PERMIT_READ | GATT_PERMIT_ENCRYPT_WRITE,
        0,
        (uint8_t *)&kgHidReportInCccd
    },

    // HID Report Reference characteristic descriptor, Consumer input
    {
        {ATT_BT_UUID_SIZE, kgHidReportRefUUID},
        GATT_PERMIT_READ,
        0,
        kgHidReportRefIn
    },

    // Feature Report declaration
    {
        {ATT_BT_UUID_SIZE, characterUUID},
        GATT_PERMIT_READ,
        0,
        &kgHidFeatureProps
    },

    // Feature Report
    {
        {ATT_BT_UUID_SIZE, kgHidReportUUID},
        GATT_PERMIT_ENCRYPT_READ | GATT_PERMIT_ENCRYPT_WRITE,
        0,
        &kgHidFeature
    },

    // HID Report Reference characteristic descriptor, feature
    {
        {ATT_BT_UUID_SIZE, kgHidReportRefUUID},
        GATT_PERMIT_READ,
        0,
        kgHidReportRefFeat
    },
};

/*********************************************************************
 * 属性索引枚举（与上面数组下标对应）
 */
enum
{
    KG_HID_SERVICE_IDX,
    KG_HID_INFO_DECL_IDX,
    KG_HID_INFO_IDX,
    KG_HID_CTRL_PT_DECL_IDX,
    KG_HID_CTRL_PT_IDX,
    KG_HID_PROTOCOL_MODE_DECL_IDX,
    KG_HID_PROTOCOL_MODE_IDX,
    KG_HID_REPORT_MAP_DECL_IDX,
    KG_HID_REPORT_MAP_IDX,
    KG_HID_REPORT_IN_DECL_IDX,
    KG_HID_REPORT_IN_IDX,
    KG_HID_REPORT_IN_CCCD_IDX,
    KG_HID_REPORT_REF_IN_IDX,
    KG_HID_FEATURE_DECL_IDX,
    KG_HID_FEATURE_IDX,
    KG_HID_REPORT_REF_FEATURE_IDX
};

/*********************************************************************
 * LOCAL 函数前向声明（必须在 kgHidCBs 初始化之前声明）
 */
static bStatus_t KeyGo_HidReadAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                     uint8_t *pValue, uint16_t *pLen,
                                     uint16_t offset, uint16_t maxLen, uint8_t method);
static bStatus_t KeyGo_HidWriteAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                      uint8_t *pValue, uint16_t len,
                                      uint16_t offset, uint8_t method);

/*********************************************************************
 * 服务回调表
 */
static gattServiceCBs_t kgHidCBs = {
    KeyGo_HidReadAttrCB,   // Read callback
    KeyGo_HidWriteAttrCB,  // Write callback
    NULL                  // Authorization callback
};



/*********************************************************************
 * @fn      KeyGo_HidReadAttrCB
 * @brief   HID 锚点属性读回调（自包含实现，复刻 WCH HID 例程语义）
 */
static bStatus_t KeyGo_HidReadAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                     uint8_t *pValue, uint16_t *pLen,
                                     uint16_t offset, uint16_t maxLen, uint8_t method)
{
    bStatus_t status = SUCCESS;
    uint16_t uuid = BUILD_UINT16(pAttr->type.uuid[0], pAttr->type.uuid[1]);

    (void)connHandle; (void)method;

    // 仅 Report Map 支持长读（offset）
    if (offset > 0 && uuid != KG_REPORT_MAP_UUID) {
        return ATT_ERR_ATTR_NOT_LONG;
    }

    if (uuid == KG_REPORT_UUID) {
        // 输入报告值 / 特征报告值：按属性指针区分
        if (pAttr->pValue == (uint8_t *)&kgHidReportIn) {
            *pLen = 1;
            pValue[0] = kgHidReportIn;
        } else if (pAttr->pValue == (uint8_t *)&kgHidFeature) {
            *pLen = 1;
            pValue[0] = kgHidFeature;
        } else {
            *pLen = 0;
        }
    } else if (uuid == KG_REPORT_MAP_UUID) {
        if (offset >= kgHidReportMapLen) {
            status = ATT_ERR_INVALID_OFFSET;
        } else {
            *pLen = MIN(maxLen, (uint16_t)(kgHidReportMapLen - offset));
            tmos_memcpy(pValue, (uint8_t *)kgHidReportMap + offset, *pLen);
        }
    } else if (uuid == KG_HID_INFORMATION_UUID) {
        *pLen = KG_HID_INFORMATION_LEN;
        tmos_memcpy(pValue, (uint8_t *)kgHidInfo, KG_HID_INFORMATION_LEN);
    } else if (uuid == GATT_REPORT_REF_UUID) {
        *pLen = KG_HID_REPORT_REF_LEN;
        tmos_memcpy(pValue, pAttr->pValue, KG_HID_REPORT_REF_LEN);
    } else if (uuid == KG_PROTOCOL_MODE_UUID) {
        *pLen = KG_HID_PROTOCOL_MODE_LEN;
        pValue[0] = kgHidProtoMode;
    } else {
        // 注：CCCD 读回 ATT_ERR_ATTR_NOT_FOUND（与 WCH 例程一致；
        //   被动锚点不发送通知，CCCD 读回对 OS 识别 HID 无影响）。
        *pLen = 0;
        status = ATT_ERR_ATTR_NOT_FOUND;
    }

    return status;
}

/*********************************************************************
 * @fn      KeyGo_HidWriteAttrCB
 * @brief   HID 锚点属性写回调（自包含实现）
 */
static bStatus_t KeyGo_HidWriteAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                      uint8_t *pValue, uint16_t len,
                                      uint16_t offset, uint8_t method)
{
    bStatus_t status = SUCCESS;
    uint16_t uuid = BUILD_UINT16(pAttr->type.uuid[0], pAttr->type.uuid[1]);

    (void)connHandle; (void)method;

    // HID 属性均非长写
    if (offset > 0) {
        return ATT_ERR_ATTR_NOT_LONG;
    }

    if (uuid == KG_HID_CTRL_PT_UUID) {
        // Control Point：仅接受 Suspend / Exit Suspend（被动锚点无需动作）
        if (len == 1 &&
            (pValue[0] == KG_HID_CMD_SUSPEND || pValue[0] == KG_HID_CMD_EXIT_SUSPEND)) {
            /* accept */
        } else if (len != 1) {
            status = ATT_ERR_INVALID_VALUE_SIZE;
        } else {
            status = ATT_ERR_INVALID_VALUE;
        }
    } else if (uuid == GATT_CLIENT_CHAR_CFG_UUID) {
        // 仅输入报告的 CCCD 需要处理（启用/停用通知）
        if (pAttr->pValue == (uint8_t *)&kgHidReportInCccd) {
            status = GATTServApp_ProcessCCCWriteReq(connHandle, pAttr, pValue, len,
                                                    offset, GATT_CLIENT_CFG_NOTIFY);
        } else {
            status = ATT_ERR_ATTR_NOT_FOUND;
        }
    } else if (uuid == KG_PROTOCOL_MODE_UUID) {
        if (len == KG_HID_PROTOCOL_MODE_LEN &&
            (pValue[0] == KG_HID_PROTOCOL_MODE_BOOT ||
             pValue[0] == KG_HID_PROTOCOL_MODE_REPORT)) {
            kgHidProtoMode = pValue[0];
        } else if (len != KG_HID_PROTOCOL_MODE_LEN) {
            status = ATT_ERR_INVALID_VALUE_SIZE;
        } else {
            status = ATT_ERR_INVALID_VALUE;
        }
    } else if (uuid == KG_REPORT_UUID) {
        // 输入/特征报告值：被动锚点仅存储，不发送
        if (pAttr->pValue == (uint8_t *)&kgHidReportIn) {
            if (len == 1) kgHidReportIn = pValue[0];
            else status = ATT_ERR_INVALID_VALUE_SIZE;
        } else if (pAttr->pValue == (uint8_t *)&kgHidFeature) {
            if (len == 1) kgHidFeature = pValue[0];
            else status = ATT_ERR_INVALID_VALUE_SIZE;
        } else {
            status = ATT_ERR_ATTR_NOT_FOUND;
        }
    } else {
        status = ATT_ERR_ATTR_NOT_FOUND;
    }

    return status;
}

/*********************************************************************
 * @fn      KeyGo_Hid_AddService
 * @brief   注册 HID 锚点 GATT 服务（策略 A：仅建库，不接管 GAP）
 * @return  Success or Failure
 */
bStatus_t KeyGo_Hid_AddService(void)
{
    bStatus_t status = SUCCESS;

    // 初始化输入报告 CCCD
    GATTServApp_InitCharCfg(INVALID_CONNHANDLE, kgHidReportInCccd);

    // 注册 GATT 属性表 + 回调
    status = GATTServApp_RegisterService(kgHidAttrTbl,
                                        GATT_NUM_ATTRS(kgHidAttrTbl),
                                        GATT_MAX_ENCRYPT_KEY_SIZE,
                                        &kgHidCBs);

    PRINT("[HID] anchor service registered (0x1812), status=%d, attrs=%d\n",
          status, GATT_NUM_ATTRS(kgHidAttrTbl));
    return status;
}

/******************************** endfile @ keygo_hid.c ******************************/
