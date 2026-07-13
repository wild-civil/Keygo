/********************************** (C) COPYRIGHT *******************************
 * File Name          : gattprofile.c
 * Author             : KeyGo v3.5 (CH582M 移植)
 * Date               : 2026/06/30
 * Description        : BLE Key-Go GATT 服务 — 4 个无加密特征值
 *                       FF01(RSSI) = WO, FF02(Status) = Notify,
 *                       FF03(Command) = WO, FF04(Serial) = RO
 *********************************************************************************/

/*********************************************************************
 * INCLUDES
 */
#include "CONFIG.h"
#include "gattprofile.h"

/*********************************************************************
 * CONSTANTS
 */

// Attribute table 索引 (用于通知发送和 CCCD 管理)
#define SIMPLEPROFILE_CHAR2_VALUE_POS  5   // FF02 Notify value
#define SIMPLEPROFILE_CHAR2_CCCD_POS   6   // FF02 CCCD

/*********************************************************************
 * UUIDs (16-bit BLE UUIDs in little-endian)
 */
const uint8_t simpleProfileServUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(SIMPLEPROFILE_SERV_UUID), HI_UINT16(SIMPLEPROFILE_SERV_UUID)
};
const uint8_t simpleProfilechar1UUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(SIMPLEPROFILE_CHAR1_UUID), HI_UINT16(SIMPLEPROFILE_CHAR1_UUID)
};
const uint8_t simpleProfilechar2UUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(SIMPLEPROFILE_CHAR2_UUID), HI_UINT16(SIMPLEPROFILE_CHAR2_UUID)
};
const uint8_t simpleProfilechar3UUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(SIMPLEPROFILE_CHAR3_UUID), HI_UINT16(SIMPLEPROFILE_CHAR3_UUID)
};
const uint8_t simpleProfilechar4UUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(SIMPLEPROFILE_CHAR4_UUID), HI_UINT16(SIMPLEPROFILE_CHAR4_UUID)
};

/*********************************************************************
 * LOCAL VARIABLES
 */
static simpleProfileCBs_t *simpleProfile_AppCBs = NULL;

/*********************************************************************
 * Profile Attributes - variables
 */

// Service
static const gattAttrType_t simpleProfileService = {ATT_BT_UUID_SIZE, simpleProfileServUUID};

// ---- Char1 (FF01): RSSI 写入, WO (20 bytes) ----
static uint8_t simpleProfileChar1Props = GATT_PROP_WRITE;
static uint8_t simpleProfileChar1[SIMPLEPROFILE_CHAR1_LEN] = {0};
static uint8_t simpleProfileChar1UserDesp[] = "RSSI\0";

// ---- Char2 (FF02): 状态通知, Notify (200 bytes) ----
static uint8_t simpleProfileChar2Props = GATT_PROP_NOTIFY;
static uint8_t simpleProfileChar2[SIMPLEPROFILE_CHAR2_LEN] = {0};
static gattCharCfg_t simpleProfileChar2Config[PERIPHERAL_MAX_CONNECTION];
static uint8_t simpleProfileChar2UserDesp[] = "Status\0";

// ---- Char3 (FF03): 命令写入, WO (50 bytes) ----
static uint8_t simpleProfileChar3Props = GATT_PROP_WRITE;
static uint8_t simpleProfileChar3[SIMPLEPROFILE_CHAR3_LEN] = {0};
static uint8_t simpleProfileChar3UserDesp[] = "Command\0";

// ---- ★ 2026-07-11 命令交付环形缓冲 ----
//   根因：应用回调 simpleProfileChangeCB 触发时，共享缓冲 simpleProfileChar3
//   可能已被下一条 GATT 写（或射频中断重入）覆盖，导致派发读到错位命令
//   （BIND→AUTH:FAIL:SHORT / NONCE→BIND:FAIL:SHORT，差一个命令）。
//   修复：在【GATT 写到达的同步时刻】(simpleProfile_WriteAttrCB) 把完整命令
//   快照进本环，应用侧 SimpleProfile_PopCmd() 按 FIFO 弹出处理，与
//   simpleProfileChar3 彻底解耦，不再受其复用影响。
#define CMD_RING_DEPTH  4
static uint8_t  s_cmdRing[CMD_RING_DEPTH][SIMPLEPROFILE_CHAR3_LEN];
static uint16_t s_cmdRingLen[CMD_RING_DEPTH];
static uint8_t  s_cmdRingHead = 0;   // 下一个写入位置
static uint8_t  s_cmdRingTail = 0;   // 下一个弹出位置
static uint8_t  s_cmdRingCnt  = 0;

static void SimpleProfile_PushCmd(const uint8_t *buf, uint16_t len)
{
    uint16_t c = (len > SIMPLEPROFILE_CHAR3_LEN) ? SIMPLEPROFILE_CHAR3_LEN : len;
    if (c == 0) return;
    tmos_memcpy(s_cmdRing[s_cmdRingHead], buf, c);
    s_cmdRingLen[s_cmdRingHead] = c;
    s_cmdRingHead = (s_cmdRingHead + 1) % CMD_RING_DEPTH;
    if (s_cmdRingCnt < CMD_RING_DEPTH) {
        s_cmdRingCnt++;
    } else {
        s_cmdRingTail = (s_cmdRingTail + 1) % CMD_RING_DEPTH;  /* 满：丢弃最旧 */
    }
}

uint8_t SimpleProfile_PopCmd(uint8_t *out, uint16_t *outLen)
{
    if (s_cmdRingCnt == 0) return 0;
    uint16_t c = s_cmdRingLen[s_cmdRingTail];
    tmos_memcpy(out, s_cmdRing[s_cmdRingTail], c);
    *outLen = c;
    s_cmdRingTail = (s_cmdRingTail + 1) % CMD_RING_DEPTH;
    s_cmdRingCnt--;
    return 1;
}

// ---- Char4 (FF04): 序列号读取, RO (12 bytes) ----
static uint8_t simpleProfileChar4Props = GATT_PROP_READ;
static uint8_t simpleProfileChar4[SIMPLEPROFILE_CHAR4_LEN] = {0};
static uint8_t simpleProfileChar4UserDesp[] = "Serial\0";

/*********************************************************************
 * ★ Profile Attributes Table — 无加密要求
 *    使用 GATT_PERMIT_READ / GATT_PERMIT_WRITE
 *    连接即可读写所有特征值
 *********************************************************************/
static gattAttribute_t simpleProfileAttrTbl[] = {
    // ── Service Declaration ──
    {
        {ATT_BT_UUID_SIZE, primaryServiceUUID},
        GATT_PERMIT_READ,
        0,
        (uint8_t *)&simpleProfileService
    },
    // ── Char1 (FF01): RSSI Write Only ──
    {
        {ATT_BT_UUID_SIZE, characterUUID},
        GATT_PERMIT_READ,
        0,
        &simpleProfileChar1Props
    },
    {
        {ATT_BT_UUID_SIZE, simpleProfilechar1UUID},
        GATT_PERMIT_WRITE,              // ★ 普通写入（无加密要求） 到时候需要配对再加密
        0,
        simpleProfileChar1
    },
    {
        {ATT_BT_UUID_SIZE, charUserDescUUID},
        GATT_PERMIT_READ,
        0,
        simpleProfileChar1UserDesp
    },
    // ── Char2 (FF02): Status Notify ──
    {
        {ATT_BT_UUID_SIZE, characterUUID},
        GATT_PERMIT_READ,
        0,
        &simpleProfileChar2Props
    },
    {
        {ATT_BT_UUID_SIZE, simpleProfilechar2UUID},
        0,                                       // Notify 值本身不需要直接读写权限
        0,
        simpleProfileChar2
    },
    {
        {ATT_BT_UUID_SIZE, clientCharCfgUUID},
        GATT_PERMIT_READ | GATT_PERMIT_WRITE,  // ★ CCCD 普通读写（无加密要求） 到时候需要配对再加密
        0,
        (uint8_t *)simpleProfileChar2Config
    },
    {
        {ATT_BT_UUID_SIZE, charUserDescUUID},
        GATT_PERMIT_READ,
        0,
        simpleProfileChar2UserDesp
    },
    // ── Char3 (FF03): Command Write Only ──
    {
        {ATT_BT_UUID_SIZE, characterUUID},
        GATT_PERMIT_READ,
        0,
        &simpleProfileChar3Props
    },
    {
        {ATT_BT_UUID_SIZE, simpleProfilechar3UUID},
        GATT_PERMIT_WRITE,  // ★ 明文写：无头设备 Just-Works 配对无 MITM 防护，安全边界改由应用层 BIND/AUTH(HMAC) 承担，去掉加密门控以杜绝强制配对弹窗
        0,
        simpleProfileChar3
    },
    {
        {ATT_BT_UUID_SIZE, charUserDescUUID},
        GATT_PERMIT_READ,
        0,
        simpleProfileChar3UserDesp
    },
    // ── Char4 (FF04): Serial Read Only ──
    {
        {ATT_BT_UUID_SIZE, characterUUID},
        GATT_PERMIT_READ,
        0,
        &simpleProfileChar4Props
    },
    {
        {ATT_BT_UUID_SIZE, simpleProfilechar4UUID},
        GATT_PERMIT_READ,   // ★ 明文读：序列号(=MAC)用于 KDF 派生 bindKey，需随时可读以便恢复绑定态；安全由应用层 AUTH 保证，去掉加密门控
        0,
        simpleProfileChar4
    },
    {
        {ATT_BT_UUID_SIZE, charUserDescUUID},
        GATT_PERMIT_READ,
        0,
        simpleProfileChar4UserDesp
    },
};

/*********************************************************************
 * LOCAL FUNCTION DECLARATIONS
 */
static bStatus_t simpleProfile_ReadAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                          uint8_t *pValue, uint16_t *pLen, uint16_t offset,
                                          uint16_t maxLen, uint8_t method);
static bStatus_t simpleProfile_WriteAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                           uint8_t *pValue, uint16_t len, uint16_t offset,
                                           uint8_t method);
static void simpleProfile_HandleConnStatusCB(uint16_t connHandle, uint8_t changeType);

/*********************************************************************
 * PROFILE CALLBACKS
 */
gattServiceCBs_t simpleProfileCBs = {
    simpleProfile_ReadAttrCB,
    simpleProfile_WriteAttrCB,
    NULL  // No authorization callback
};

/*********************************************************************
 * PUBLIC FUNCTIONS
 */

bStatus_t SimpleProfile_AddService(uint32_t services)
{
    // Initialize CCCD for FF02 (notify)
    GATTServApp_InitCharCfg(INVALID_CONNHANDLE, simpleProfileChar2Config);
    // Register link status callback
    linkDB_Register(simpleProfile_HandleConnStatusCB);

    if (services & SIMPLEPROFILE_SERVICE)
    {
        return GATTServApp_RegisterService(simpleProfileAttrTbl,
                                           GATT_NUM_ATTRS(simpleProfileAttrTbl),
                                           GATT_MAX_ENCRYPT_KEY_SIZE,
                                           &simpleProfileCBs);
    }
    return SUCCESS;
}

bStatus_t SimpleProfile_RegisterAppCBs(simpleProfileCBs_t *appCallbacks)
{
    if (appCallbacks)
    {
        simpleProfile_AppCBs = appCallbacks;
        return SUCCESS;
    }
    return bleAlreadyInRequestedMode;
}

bStatus_t SimpleProfile_SetParameter(uint8_t param, uint16_t len, void *value)
{
    uint16_t *pTargetLen = NULL;
    uint8_t  *pTargetBuf = NULL;

    switch (param)
    {
        case SIMPLEPROFILE_CHAR1: pTargetLen = &(uint16_t){SIMPLEPROFILE_CHAR1_LEN}; pTargetBuf = simpleProfileChar1; break;
        case SIMPLEPROFILE_CHAR2: pTargetLen = &(uint16_t){SIMPLEPROFILE_CHAR2_LEN}; pTargetBuf = simpleProfileChar2; break;
        case SIMPLEPROFILE_CHAR3: pTargetLen = &(uint16_t){SIMPLEPROFILE_CHAR3_LEN}; pTargetBuf = simpleProfileChar3; break;
        case SIMPLEPROFILE_CHAR4: pTargetLen = &(uint16_t){SIMPLEPROFILE_CHAR4_LEN}; pTargetBuf = simpleProfileChar4; break;
        default: return INVALIDPARAMETER;
    }

    if (len <= *pTargetLen)
    {
        tmos_memcpy(pTargetBuf, value, len);
        return SUCCESS;
    }
    return bleInvalidRange;
}

bStatus_t SimpleProfile_GetParameter(uint8_t param, void *value)
{
    uint16_t *pTargetLen = NULL;
    uint8_t  *pTargetBuf = NULL;

    switch (param)
    {
        case SIMPLEPROFILE_CHAR1: pTargetLen = &(uint16_t){SIMPLEPROFILE_CHAR1_LEN}; pTargetBuf = simpleProfileChar1; break;
        case SIMPLEPROFILE_CHAR2: pTargetLen = &(uint16_t){SIMPLEPROFILE_CHAR2_LEN}; pTargetBuf = simpleProfileChar2; break;
        case SIMPLEPROFILE_CHAR3: pTargetLen = &(uint16_t){SIMPLEPROFILE_CHAR3_LEN}; pTargetBuf = simpleProfileChar3; break;
        case SIMPLEPROFILE_CHAR4: pTargetLen = &(uint16_t){SIMPLEPROFILE_CHAR4_LEN}; pTargetBuf = simpleProfileChar4; break;
        default: return INVALIDPARAMETER;
    }

    tmos_memcpy(value, pTargetBuf, *pTargetLen);
    return SUCCESS;
}

/*********************************************************************
 * @fn      simpleProfile_Notify
 *
 * @brief   通过 FF02 发送通知 (状态 JSON)
 */
bStatus_t simpleProfile_Notify(uint16_t connHandle, attHandleValueNoti_t *pNoti)
{
    uint16_t value = GATTServApp_ReadCharCfg(connHandle, simpleProfileChar2Config);
    if (value & GATT_CLIENT_CFG_NOTIFY)
    {
        pNoti->handle = simpleProfileAttrTbl[SIMPLEPROFILE_CHAR2_VALUE_POS].handle;
        return GATT_Notification(connHandle, pNoti, FALSE);
    }
    return bleIncorrectMode;
}

/*********************************************************************
 * @fn      simpleProfile_GetHandle
 *
 * @brief   获取特征值对应的 GATT handle (调试用)
 */
uint16_t simpleProfile_GetHandle(uint8_t charID)
{
    switch (charID)
    {
        case SIMPLEPROFILE_CHAR1: return simpleProfileAttrTbl[2].handle;
        case SIMPLEPROFILE_CHAR2: return simpleProfileAttrTbl[SIMPLEPROFILE_CHAR2_VALUE_POS].handle;
        case SIMPLEPROFILE_CHAR3: return simpleProfileAttrTbl[9].handle;
        case SIMPLEPROFILE_CHAR4: return simpleProfileAttrTbl[12].handle;
        default: return 0;
    }
}

/*********************************************************************
 * @fn      simpleProfile_ReadAttrCB
 */
static bStatus_t simpleProfile_ReadAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                          uint8_t *pValue, uint16_t *pLen, uint16_t offset,
                                          uint16_t maxLen, uint8_t method)
{
    if (offset > 0) return ATT_ERR_ATTR_NOT_LONG;

    if (pAttr->type.len == ATT_BT_UUID_SIZE)
    {
        uint16_t uuid = BUILD_UINT16(pAttr->type.uuid[0], pAttr->type.uuid[1]);
        switch (uuid)
        {
            case SIMPLEPROFILE_CHAR1_UUID:
                *pLen = (maxLen > SIMPLEPROFILE_CHAR1_LEN) ? SIMPLEPROFILE_CHAR1_LEN : maxLen;
                tmos_memcpy(pValue, simpleProfileChar1, *pLen);
                break;

            case SIMPLEPROFILE_CHAR2_UUID:
                *pLen = (maxLen > SIMPLEPROFILE_CHAR2_LEN) ? SIMPLEPROFILE_CHAR2_LEN : maxLen;
                tmos_memcpy(pValue, simpleProfileChar2, *pLen);
                break;

            case SIMPLEPROFILE_CHAR3_UUID:
                *pLen = (maxLen > SIMPLEPROFILE_CHAR3_LEN) ? SIMPLEPROFILE_CHAR3_LEN : maxLen;
                tmos_memcpy(pValue, simpleProfileChar3, *pLen);
                break;

            case SIMPLEPROFILE_CHAR4_UUID:
                *pLen = (maxLen > SIMPLEPROFILE_CHAR4_LEN) ? SIMPLEPROFILE_CHAR4_LEN : maxLen;
                tmos_memcpy(pValue, simpleProfileChar4, *pLen);
                break;

            default:
                *pLen = 0;
                return ATT_ERR_ATTR_NOT_FOUND;
        }
        return SUCCESS;
    }
    *pLen = 0;
    return ATT_ERR_INVALID_HANDLE;
}

/*********************************************************************
 * @fn      simpleProfile_WriteAttrCB
 */
/* ★ 2026-07-11: FF03 长写(prepare-write)累积长度。各分片按 offset 拼回
 *   simpleProfileChar3，execute 时一次性交给应用层。静态持久，跨多次写回调有效。 */
static uint16_t g_ff03WrTotal = 0;
static bStatus_t simpleProfile_WriteAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                           uint8_t *pValue, uint16_t len, uint16_t offset,
                                           uint8_t method)
{
    bStatus_t status = SUCCESS;
    uint8_t   notifyApp = 0xFF;
    uint8_t  *appVal    = pValue;   /* ★ 传给应用的值指针（长写时为完整缓冲）*/
    uint16_t  appLen    = len;      /* ★ 传给应用的完整长度（长写时为累积总长）*/

    // 拒绝需要授权的写操作 (此 Profile 不使用 authorization)
    if (gattPermitAuthorWrite(pAttr->permissions))
        return ATT_ERR_INSUFFICIENT_AUTHOR;

    if (pAttr->type.len == ATT_BT_UUID_SIZE)
    {
        uint16_t uuid = BUILD_UINT16(pAttr->type.uuid[0], pAttr->type.uuid[1]);
        switch (uuid)
        {
            case SIMPLEPROFILE_CHAR1_UUID:   // FF01: RSSI（不支持长写，offset 必为 0）
                if (offset != 0) {
                    status = ATT_ERR_ATTR_NOT_LONG;
                } else if (len > SIMPLEPROFILE_CHAR1_LEN) {
                    status = ATT_ERR_INVALID_VALUE_SIZE;
                } else {
                    tmos_memcpy(simpleProfileChar1, pValue, len);
                    if (len < SIMPLEPROFILE_CHAR1_LEN) simpleProfileChar1[len] = '\0';
                    notifyApp = SIMPLEPROFILE_CHAR1;
                }
                break;

            case SIMPLEPROFILE_CHAR3_UUID:   // FF03: Command（★ 支持长写 prepare-write 重组）
                if (method == ATT_PREPARE_WRITE_REQ) {
                    /* 长写分段：offset==0 表示新一轮开始，清零累积长度；
                     * 之后按 offset 把各片拼回 simpleProfileChar3，等 EXECUTE 再交给应用。
                     * ★ 2026-07-11 根因修复：旧逻辑对 offset!=0 直接返回
                     *   ATT_ERR_ATTR_NOT_LONG，导致 BIND/AUTH 等长写被截断丢弃，
                     *   固件只收到首片 → BIND:FAIL:SHORT / 绑定无响应。 */
                    if (offset == 0) g_ff03WrTotal = 0;
                    if (offset + len > SIMPLEPROFILE_CHAR3_LEN) {
                        status = ATT_ERR_INVALID_VALUE_SIZE;
                    } else {
                        tmos_memcpy(simpleProfileChar3 + offset, pValue, len);
                        if (offset + len > g_ff03WrTotal) g_ff03WrTotal = offset + len;
                        /* 不通知应用，等 EXECUTE */
                    }
                } else if (method == ATT_EXECUTE_WRITE_REQ) {
                    /* 长写提交：把累积的完整命令一次性交给应用 */
                    simpleProfileChar3[g_ff03WrTotal] = '\0';
                    /* ★ 2026-07-11 修复：写到达即快照进环形缓冲，与 simpleProfileChar3 解耦 */
                    SimpleProfile_PushCmd(simpleProfileChar3, g_ff03WrTotal);
                    appVal    = simpleProfileChar3;
                    appLen    = g_ff03WrTotal;
                    g_ff03WrTotal = 0;
                    notifyApp = SIMPLEPROFILE_CHAR3;
                } else {
                    /* 普通短写 (ATT_WRITE_REQ / ATT_WRITE_CMD)，offset 必为 0 */
                    if (len > SIMPLEPROFILE_CHAR3_LEN) {
                        status = ATT_ERR_INVALID_VALUE_SIZE;
                    } else {
                        tmos_memcpy(simpleProfileChar3, pValue, len);
                        if (len < SIMPLEPROFILE_CHAR3_LEN) simpleProfileChar3[len] = '\0';
                        SimpleProfile_PushCmd(simpleProfileChar3, len);
                        appVal    = simpleProfileChar3;
                        appLen    = len;
                        notifyApp = SIMPLEPROFILE_CHAR3;
                    }
                }
                break;

            case GATT_CLIENT_CHAR_CFG_UUID:  // FF02 CCCD
                status = GATTServApp_ProcessCCCWriteReq(connHandle, pAttr, pValue, len,
                                                        offset, GATT_CLIENT_CFG_NOTIFY);
                break;

            default:
                status = ATT_ERR_ATTR_NOT_FOUND;
                break;
        }
    }
    else
    {
        status = ATT_ERR_INVALID_HANDLE;
    }

    // 通知应用层（★ 长写时用完整缓冲 appVal 与累积长度 appLen）
    if ((notifyApp != 0xFF) && simpleProfile_AppCBs && simpleProfile_AppCBs->pfnSimpleProfileChange)
    {
        simpleProfile_AppCBs->pfnSimpleProfileChange(notifyApp, appVal, appLen);
    }

    return status;
}

/*********************************************************************
 * @fn      simpleProfile_HandleConnStatusCB
 */
static void simpleProfile_HandleConnStatusCB(uint16_t connHandle, uint8_t changeType)
{
    if (connHandle != LOOPBACK_CONNHANDLE)
    {
        if ((changeType == LINKDB_STATUS_UPDATE_REMOVED) ||
            ((changeType == LINKDB_STATUS_UPDATE_STATEFLAGS) && (!linkDB_Up(connHandle))))
        {
            GATTServApp_InitCharCfg(connHandle, simpleProfileChar2Config);
        }
    }
}

/*********************************************************************
*********************************************************************/
