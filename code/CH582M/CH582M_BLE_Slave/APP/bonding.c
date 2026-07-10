/********************************** (C) COPYRIGHT *******************************
 * File Name          : bonding.c
 * Author             : KeyGo (CH582M) — 绑定/授权模块
 * Version            : v1.0 (Phase 1: 真实密码学 + challenge-response)
 * Date               : 2026/07/10
 * Description        : 所有者绑定信任列表 + GAP Bond Manager 回调 + 应用层
 *                      bindKey 派生(KDF=SHA256) + HMAC challenge-response 会话鉴权。
 *                      详见 bonding.h 顶部说明与 docs 对应方案文档。
 *******************************************************************************/
#include "bonding.h"
#include "HAL.h"   // PRINT / tmos_mem*

/* GetMACAddress 是 ISP583.h 提供的宏（FLASH_EEPROM_CMD 封装），经 CONFIG.h 已可见，
 * 直接调用即可，无需也不能做函数前向声明（否则宏展开成非法语法）。 */

/* RAM 镜像：信任列表（掉电由 DataFlash KEYGO_BOND_ADDR 持久化） */
static bondEntry_t s_bondTbl[BOND_ENTRY_MAX];
static uint8_t     s_bondCount = 0;

/* 会话态（单连接）：nonce 一次性 + 会话鉴权标记 */
static uint8_t s_nonce[BOND_NONCE_LEN];
static uint8_t s_nonceValid   = 0;
static uint8_t s_sessionAuthed = 0;

/* 默认绑定码（出厂，贴于设备/说明书）。首绑校验；owner 重绑可改码。
 * O5 待定：每颗芯片烧不同码 / 二维码标签，Phase 1 先用统一占位码。 */
#define DEFAULT_BIND_CODE_LEN  6
static const uint8_t DEFAULT_BIND_CODE[DEFAULT_BIND_CODE_LEN] = {'1','2','3','4','5','6'};

/* ── 小工具：hex 互转 ── */
static void bin2hex(const uint8_t *bin, uint8_t n, char *out)
{
    static const char h[] = "0123456789ABCDEF";
    for (uint8_t i = 0; i < n; i++) {
        out[i * 2]     = h[(bin[i] >> 4) & 0xF];
        out[i * 2 + 1] = h[bin[i] & 0xF];
    }
    out[n * 2] = '\0';
}
static uint8_t hex2bin_char(char c)
{
    if (c >= '0' && c <= '9') return (uint8_t)(c - '0');
    if (c >= 'A' && c <= 'F') return (uint8_t)(c - 'A' + 10);
    if (c >= 'a' && c <= 'f') return (uint8_t)(c - 'a' + 10);
    return 0xFF;
}
/* 解析 len 个 hex 字符（须为偶数长度）到 bin；返回字节数或 0=失败 */
static uint8_t hex2bin(const char *hex, uint8_t len, uint8_t *bin)
{
    if (len == 0 || (len & 1)) return 0;
    uint8_t n = len / 2;
    for (uint8_t i = 0; i < n; i++) {
        uint8_t hi = hex2bin_char(hex[i * 2]);
        uint8_t lo = hex2bin_char(hex[i * 2 + 1]);
        if (hi == 0xFF || lo == 0xFF) return 0;
        bin[i] = (hi << 4) | lo;
    }
    return n;
}

/* 前向声明（供 Bonding_BondCBs 初始化器引用） */
static void Bonding_PasscodeCB(uint8_t *deviceAddr, uint16_t connectionHandle,
                                uint8_t uiInputs, uint8_t uiOutputs);
static void Bonding_PairStateCB(uint16_t connectionHandle, uint8_t state, uint8_t status);

/* 对外暴露的 Bond Manager 回调表 —— peripheral.c 第二参传入即可启用。 */
gapBondCBs_t Bonding_BondCBs = {
    Bonding_PasscodeCB,
    Bonding_PairStateCB,
    NULL   // oobCB
};

/*********************************************************************
 * @fn      Bonding_Init
 * @brief   密码学自测 + 载入信任列表 + 配置 Bond Manager（链路加密层）
 *********************************************************************/
void Bonding_Init(void)
{
    /* 上电先验证 SHA-256 / HMAC 实现正确性（标准向量），失败会在串口报警 */
    uint8_t st = sha256_self_test();
    PRINT("[CRYPTO] sha256 self-test: %s\n", st == 0 ? "PASS" : "FAIL!!");

    Bonding_Load();

    /* 配置外围 Bond Manager（方案 B 的链路加密层）。
     * 无头设备无显示/键盘 → NO_INPUT_NO_OUTPUT（Just Works / LESC）仅做链路加密；
     * 真正的所有者鉴权在应用层 BIND 指令 + AUTH challenge-response 完成。 */
    uint8_t pairingMode = GAPBOND_PAIRING_MODE_WAIT_FOR_REQ;
    uint8_t ioCap       = GAPBOND_IO_CAP_NO_INPUT_NO_OUTPUT;
    uint8_t mitm        = 0;

    GAPBondMgr_SetParameter(GAPBOND_PERI_PAIRING_MODE, sizeof(uint8_t), &pairingMode);
    GAPBondMgr_SetParameter(GAPBOND_PERI_IO_CAPABILITIES, sizeof(uint8_t), &ioCap);
    GAPBondMgr_SetParameter(GAPBOND_PERI_MITM_PROTECTION, sizeof(uint8_t), &mitm);

    PRINT("[BOND] init done, owners=%d\n", s_bondCount);
}

/*********************************************************************
 * @fn      Bonding_Load / Bonding_Save
 *********************************************************************/
uint8_t Bonding_Load(void)
{
    uint8_t buf[BOND_IO_BYTES];
    if (EEPROM_READ(KEYGO_BOND_ADDR, buf, BOND_IO_BYTES) != 0) {
        s_bondCount = 0;
        return 1;
    }
    s_bondCount = 0;
    for (uint8_t i = 0; i < BOND_ENTRY_MAX; i++) {
        bondEntry_t *e = (bondEntry_t *)(buf + i * BOND_ENTRY_SIZE);
        uint8_t allFF = 1;
        for (uint8_t j = 0; j < 6; j++) {
            if (e->peerAddr[j] != 0xFF) { allFF = 0; break; }
        }
        if (allFF) continue; /* 空槽 */
        tmos_memcpy(&s_bondTbl[s_bondCount], e, BOND_ENTRY_SIZE);
        s_bondCount++;
    }
    return 0;
}

uint8_t Bonding_Save(void)
{
    uint8_t buf[BOND_IO_BYTES];
    tmos_memset(buf, 0xFF, BOND_IO_BYTES);
    for (uint8_t i = 0; i < s_bondCount && i < BOND_ENTRY_MAX; i++) {
        tmos_memcpy(buf + i * BOND_ENTRY_SIZE, &s_bondTbl[i], BOND_ENTRY_SIZE);
    }
    for (uint8_t p = 0; p < BOND_PAGES; p++) {
        EEPROM_ERASE(KEYGO_BOND_ADDR + p * BOND_PAGE_SIZE, BOND_PAGE_SIZE);
    }
    return (EEPROM_WRITE(KEYGO_BOND_ADDR, buf, BOND_IO_BYTES) == 0) ? 0 : 1;
}

/*********************************************************************
 * @fn      Bonding_Find / Bonding_IsOwner / Bonding_Count
 *********************************************************************/
int8_t Bonding_Find(const uint8_t *peerAddr)
{
    for (uint8_t i = 0; i < s_bondCount; i++) {
        if (tmos_memcmp(s_bondTbl[i].peerAddr, peerAddr, 6) == 0) {
            return (int8_t)i;
        }
    }
    return -1;
}

uint8_t Bonding_IsOwner(const uint8_t *peerAddr)
{
    return (Bonding_Find(peerAddr) >= 0) ? 1 : 0;
}

uint8_t Bonding_Count(void)
{
    return s_bondCount;
}

/*********************************************************************
 * @fn      Bonding_AddOwner / Bonding_RemoveOwner / Bonding_EraseAll
 *********************************************************************/
uint8_t Bonding_AddOwner(const uint8_t *peerAddr, uint8_t addrType, const uint8_t *bindKey)
{
    if (s_bondCount >= BOND_ENTRY_MAX) return 2; /* 信任列表已满 */

    int8_t idx = Bonding_Find(peerAddr);
    if (idx >= 0) {
        tmos_memcpy(s_bondTbl[idx].bindKey, bindKey, BOND_KEY_LEN);
        s_bondTbl[idx].peerAddrType = addrType;
        return Bonding_Save();
    }
    tmos_memcpy(s_bondTbl[s_bondCount].peerAddr, peerAddr, 6);
    s_bondTbl[s_bondCount].peerAddrType = addrType;
    s_bondTbl[s_bondCount].role         = 0; /* owner */
    tmos_memcpy(s_bondTbl[s_bondCount].bindKey, bindKey, BOND_KEY_LEN);
    s_bondTbl[s_bondCount].addedAt      = 0;
    s_bondCount++;
    return Bonding_Save();
}

uint8_t Bonding_RemoveOwner(const uint8_t *peerAddr)
{
    int8_t idx = Bonding_Find(peerAddr);
    if (idx < 0) return 1; /* 不在列表 */
    for (uint8_t i = (uint8_t)idx; i + 1 < s_bondCount; i++) {
        tmos_memcpy(&s_bondTbl[i], &s_bondTbl[i + 1], BOND_ENTRY_SIZE);
    }
    s_bondCount--;
    return Bonding_Save();
}

void Bonding_EraseAll(void)
{
    s_bondCount = 0;
    for (uint8_t p = 0; p < BOND_PAGES; p++) {
        EEPROM_ERASE(KEYGO_BOND_ADDR + p * BOND_PAGE_SIZE, BOND_PAGE_SIZE);
    }
}

/*********************************************************************
 * @fn      Bonding_DeriveKey
 * @brief   bindKey = SHA256(code || serial)[0:16]
 *          serial = FF04 的 MAC 十六进制串（12 字符，大写）。
 *          固件端与 App 端输入一致即得到相同密钥。
 *********************************************************************/
void Bonding_DeriveKey(const uint8_t *code, uint8_t codeLen,
                       const uint8_t *serial, uint8_t serialLen,
                       uint8_t outKey[BOND_KEY_LEN])
{
    uint8_t material[64];
    uint8_t total = 0;
    if (codeLen > 0 && total + codeLen <= sizeof(material))
        { tmos_memcpy(material + total, code, codeLen); total += codeLen; }
    if (serialLen > 0 && total + serialLen <= sizeof(material))
        { tmos_memcpy(material + total, serial, serialLen); total += serialLen; }

    uint8_t full[SHA256_DIGEST_LEN];
    sha256(material, total, full);
    tmos_memcpy(outKey, full, BOND_KEY_LEN);
}

/* 由本机 MAC 构造序列号串（与 FF04 上报一致：%02X 大写 12 字符） */
static void Bonding_BuildSerial(char serial[13])
{
    uint8_t mac[6];
    GetMACAddress(mac);
    snprintf(serial, 13, "%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

/*********************************************************************
 * @fn      Bonding_GenNonce / Bonding_IssueNonce
 * @brief   nonce 生成（tmos_rand + xorshift 混淆）。
 *          ★ 非密码级随机，仅作抗重放挑战值；链路已加密，威胁模型内可接受。
 *********************************************************************/
void Bonding_GenNonce(uint8_t out[BOND_NONCE_LEN])
{
    static uint32_t s_seed = 0;
    if (s_seed == 0) {
        uint32_t r0 = tmos_rand() ^ 0x9E3779B9u;
        s_seed = r0 ? r0 : 0x12345678u;
    }
    for (uint8_t i = 0; i < BOND_NONCE_LEN; i += 4) {
        s_seed ^= s_seed << 13; s_seed ^= s_seed >> 17; s_seed ^= s_seed << 5; /* xorshift32 */
        uint32_t r = s_seed ^ tmos_rand();
        out[i]     = (uint8_t)(r >> 24);
        out[i + 1] = (uint8_t)(r >> 16);
        out[i + 2] = (uint8_t)(r >> 8);
        out[i + 3] = (uint8_t)(r);
    }
}

/* 生成 nonce、存入会话态、返回 32 字符 hex（供 NONCE 指令与 DENY 内联使用） */
void Bonding_IssueNonce(char *outHex32)
{
    Bonding_GenNonce(s_nonce);
    s_nonceValid = 1;
    bin2hex(s_nonce, BOND_NONCE_LEN, outHex32);
}

/*********************************************************************
 * @fn      Bonding_ConnTerminated
 * @brief   断连：清空会话态（鉴权/nonce 一次性），下次连接需重新 AUTH。
 *********************************************************************/
void Bonding_ConnTerminated(void)
{
    s_sessionAuthed = 0;
    s_nonceValid    = 0;
    tmos_memset(s_nonce, 0, BOND_NONCE_LEN);
}

uint8_t Bonding_IsSessionAuthed(uint16_t connHandle)
{
    (void)connHandle;
    return s_sessionAuthed;
}

/*********************************************************************
 * @fn      Bonding_HandleBindCmd
 * @brief   处理 BIND 指令（payload = 绑定码明文字节）。
 *   首绑（信任列表空）：校验 == DEFAULT_BIND_CODE → 派生 key → 写入信任列表。
 *   已绑：发起方须为 owner（在信任列表）→ 重派生 key（改码）。
 *   回报文：BIND:OK / BIND:FAIL:NOT_OWNER / BIND:FAIL:CODE / BIND:FAIL:*
 *********************************************************************/
uint8_t Bonding_HandleBindCmd(uint16_t connHandle, const uint8_t *peerAddr, uint8_t peerAddrType,
                              const uint8_t *payload, uint16_t len)
{
    (void)connHandle;
    if (len < DEFAULT_BIND_CODE_LEN) {
        KeyGo_SendRawNotify("BIND:FAIL:SHORT");
        return 1;
    }

    if (s_bondCount == 0) {
        /* 首绑：校验默认码 */
        if (tmos_memcmp(payload, DEFAULT_BIND_CODE, DEFAULT_BIND_CODE_LEN) != 0) {
            PRINT("[BIND] first-bind code mismatch\n");
            KeyGo_SendRawNotify("BIND:FAIL:CODE");
            return 3;
        }
    } else {
        /* 已绑：须为 owner 才能改/重绑 */
        if (!Bonding_IsOwner(peerAddr)) {
            PRINT("[BIND] reject: requester not owner\n");
            KeyGo_SendRawNotify("BIND:FAIL:NOT_OWNER");
            return 4;
        }
    }

    /* 派生 bindKey = SHA256(code||serial)[0:16] */
    char serial[13];
    Bonding_BuildSerial(serial);
    uint8_t key[BOND_KEY_LEN];
    Bonding_DeriveKey(payload, len, (uint8_t *)serial, 12, key);

    uint8_t r = Bonding_AddOwner(peerAddr, peerAddrType, key);
    if (r != 0) {
        KeyGo_SendRawNotify("BIND:FAIL:SAVE");
        return r;
    }
    /* BIND 成功即视为本连接已会话鉴权（首绑/改码都证明了码知识） */
    s_sessionAuthed = 1;
    s_nonceValid    = 0;
    PRINT("[BIND] owner added/updated, count=%d\n", s_bondCount);
    KeyGo_SendRawNotify("BIND:OK");
    return 0;
}

/*********************************************************************
 * @fn      Bonding_HandleNonceReq
 * @brief   处理 NONCE 请求：生成并回写 NONCE:<32hex>
 *********************************************************************/
void Bonding_HandleNonceReq(uint16_t connHandle)
{
    (void)connHandle;
    char hex[33];
    Bonding_IssueNonce(hex);
    char msg[40];
    snprintf(msg, sizeof(msg), "NONCE:%s", hex);
    KeyGo_SendRawNotify(msg);
    PRINT("[AUTH] nonce issued\n");
}

/*********************************************************************
 * @fn      Bonding_HandleAuthResp
 * @brief   校验 HMAC-SHA256(nonce, peerKey) == response。
 *   payload 为 64 个 hex（HMAC 输出）。成功置会话鉴权，nonce 一次性作废。
 *   回报文：AUTH:OK / AUTH:FAIL / AUTH:FAIL:NO_NONCE / AUTH:FAIL:NO_PEER
 *********************************************************************/
uint8_t Bonding_HandleAuthResp(uint16_t connHandle, const uint8_t *peerAddr,
                               const uint8_t *payload, uint8_t len)
{
    (void)connHandle;
    if (!s_nonceValid) {
        KeyGo_SendRawNotify("AUTH:FAIL:NO_NONCE");
        return 1;
    }
    int8_t idx = Bonding_Find(peerAddr);
    if (idx < 0) {
        KeyGo_SendRawNotify("AUTH:FAIL:NO_PEER");
        return 2;
    }

    uint8_t resp[SHA256_DIGEST_LEN];
    if (hex2bin((const char *)payload, len, resp) != SHA256_DIGEST_LEN) {
        KeyGo_SendRawNotify("AUTH:FAIL:BAD_HEX");
        return 3;
    }

    uint8_t expect[SHA256_DIGEST_LEN];
    hmac_sha256(s_bondTbl[idx].bindKey, BOND_KEY_LEN, s_nonce, BOND_NONCE_LEN, expect);

    if (tmos_memcmp(expect, resp, SHA256_DIGEST_LEN) != 0) {
        PRINT("[AUTH] mismatch\n");
        KeyGo_SendRawNotify("AUTH:FAIL");
        return 4;
    }

    s_sessionAuthed = 1;
    s_nonceValid    = 0;   /* 一次性 */
    tmos_memset(s_nonce, 0, BOND_NONCE_LEN);
    PRINT("[AUTH] session authed (peer in trust list)\n");
    KeyGo_SendRawNotify("AUTH:OK");
    return 0;
}

/*********************************************************************
 * @fn      Bonding_HandleUnbindCmd
 * @brief   mode=0 解绑自己(peerAddr)；mode=1 清空全部（恢复出厂信任列表）。
 *   解绑自己须为 owner；清空全部须为 owner（且会令本连接会话失效）。
 *   回报文：UNBIND:OK / UNBIND:FAIL:NOT_OWNER
 *********************************************************************/
uint8_t Bonding_HandleUnbindCmd(uint16_t connHandle, const uint8_t *peerAddr, uint8_t mode)
{
    (void)connHandle;
    if (s_bondCount == 0) {
        KeyGo_SendRawNotify("UNBIND:OK"); /* 本来就是空的 */
        return 0;
    }
    if (!Bonding_IsOwner(peerAddr)) {
        KeyGo_SendRawNotify("UNBIND:FAIL:NOT_OWNER");
        return 1;
    }
    if (mode == 1) {
        Bonding_EraseAll();
        PRINT("[UNBIND] all owners erased (factory trust list)\n");
    } else {
        Bonding_RemoveOwner(peerAddr);
        PRINT("[UNBIND] owner removed\n");
    }
    s_sessionAuthed = 0;
    s_nonceValid    = 0;
    KeyGo_SendRawNotify("UNBIND:OK");
    return 0;
}

/*********************************************************************
 * @fn      Bonding_PairStateCB
 *********************************************************************/
static void Bonding_PairStateCB(uint16_t connectionHandle, uint8_t state, uint8_t status)
{
    switch (state) {
        case GAPBOND_PAIRING_STATE_COMPLETE:
            PRINT("[BOND] pairing complete, status=%x\n", status);
            break;
        case GAPBOND_PAIRING_STATE_BONDED:
            PRINT("[BOND] bonded, status=%x\n", status);
            break;
        case GAPBOND_PAIRING_STATE_BOND_SAVED:
            PRINT("[BOND] bond saved (LTK in SNV), status=%x\n", status);
            break;
        default:
            PRINT("[BOND] state=%x status=%x\n", state, status);
            break;
    }
    (void)connectionHandle;
}

/*********************************************************************
 * @fn      Bonding_PasscodeCB
 *********************************************************************/
static void Bonding_PasscodeCB(uint8_t *deviceAddr, uint16_t connectionHandle,
                                uint8_t uiInputs, uint8_t uiOutputs)
{
    PRINT("[BOND] passcode needed (headless, ignored) addr=%x:%x:%x:%x:%x:%x\n",
          deviceAddr[0], deviceAddr[1], deviceAddr[2],
          deviceAddr[3], deviceAddr[4], deviceAddr[5]);
    (void)connectionHandle; (void)uiInputs; (void)uiOutputs;
}

/******************************** endfile @ bonding ******************************/
