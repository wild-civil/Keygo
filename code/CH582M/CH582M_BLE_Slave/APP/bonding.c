/********************************** (C) COPYRIGHT *******************************
 * File Name          : bonding.c
 * Author             : KeyGo (CH582M) — 绑定/授权模块
 * Version            : v3.30-fix (Phase 1: 真实密码学 + challenge-response)
 * Date               : 2026/07/10
 * Description        : 所有者绑定信任列表 + GAP Bond Manager 回调 + 应用层
 *                      bindKey 派生(KDF=SHA256) + HMAC challenge-response 会话鉴权。
 *                      ★ 信任模型 = 基于共享密钥(bindKey)，NOT 对端 MAC：Android/iOS BLE
 *                        地址随机化，每次连接都变，用 MAC 做 owner 身份会导致同一手机二次
 *                        连接也 NOT_OWNER/AUTH:FAIL。默认绑定码(贴机身)即恢复凭证，可覆盖重绑。
 *                      详见 bonding.h 顶部说明与 docs 对应方案文档。
 *******************************************************************************/
#include "bonding.h"
#include "HAL.h"   // PRINT / tmos_mem*
#include "keygo_core.h"  // ★ 方案A：KeyGo_CancelUnauthTimer / KeyGo_SendRawNotify 声明

/* GetMACAddress 是 ISP583.h 提供的宏（FLASH_EEPROM_CMD 封装），经 CONFIG.h 已可见，
 * 直接调用即可，无需也不能做函数前向声明（否则宏展开成非法语法）。 */

/* RAM 镜像：信任列表（掉电由 DataFlash KEYGO_BOND_ADDR 持久化） */
static bondEntry_t s_bondTbl[BOND_ENTRY_MAX];
static uint8_t     s_bondCount = 0;

/* 会话态（单连接）：nonce 一次性 + 会话鉴权标记 */
static uint8_t s_nonce[BOND_NONCE_LEN];
static uint8_t s_nonceValid   = 0;
static uint8_t s_sessionAuthed = 0;
static uint8_t g_cryptoOk     = 0;   /* 1 = SHA256/HMAC 自测通过；0 = 失败(降级鉴权) */

/* ★ P0-2（§15.3 修订）：C1 命令签名会话盐 + 同连接重放计数器。
 *   s_sessionSalt 在 AUTH/BIND 成功后建立（= 本次握手 nonce，App 已知），
 *   用于把 HMAC 绑定到「每连接随机量」，堵住「跨连接重放」洞；
 *   s_lastCmdSeq 防同连接内重放（seq 必须严格递增）。两者在断连时清零。 */
static uint8_t  s_sessionSalt[BOND_NONCE_LEN];
static uint8_t  s_sessionSaltValid = 0;
static uint32_t s_lastCmdSeq = 0;

/* 默认绑定码（出厂，贴于设备/说明书）。首绑校验；owner 重绑可改码。
 * O5 待定：每颗芯片烧不同码 / 二维码标签，Phase 1 先用统一占位码。 */
#define DEFAULT_BIND_CODE_LEN  6
static const uint8_t DEFAULT_BIND_CODE[DEFAULT_BIND_CODE_LEN] = {'1','2','3','4','5','6'};

/* ★ 当前有效绑定码（运行时镜像）。
 *   - 初始 = DEFAULT_BIND_CODE（123456）。
 *   - 用户通过 SETCODE 改为自己的码后，此处随之更新并持久化到 KEYGO_BINDCODE_ADDR。
 *   - BIND 指令校验即对比本变量（而非固定常量），从而支持任意自定义码。
 *   - UNBIND:ALL（恢复出厂）时重置回 DEFAULT_BIND_CODE。 */
static char    g_curBindCode[BOND_CODE_MAXLEN + 1];
static uint8_t g_curBindCodeLen = 0;

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

/* ★ 常量时间比较：相等返回 1，不等返回 0（diff 累计，无早退）。
 *   安全关键路径(HMAC 校验)用本函数而非 tmos_memcmp，
 *   彻底规避 tmos_memcmp 返回值语义(TRUE=相等)在不同 SDK 版本间可能变化的隐患
 *   —— crypto_sha256.c 已因同一原因改用本地 bytes_eq，此处保持一致。 */
static uint8_t ct_eq(const uint8_t *a, const uint8_t *b, uint16_t n)
{
    uint8_t diff = 0;
    for (uint16_t i = 0; i < n; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    return (diff == 0) ? 1 : 0;
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
    /* 上电先验证 SHA-256 / HMAC 实现正确性（标准向量），失败会在串口报警。
     * sha256_self_test() 现返回 1=全部通过 / 0=失败（见 crypto_sha256.c），
     * 直接作为 g_cryptoOk，避免旧版位掩码判定写反（把通过的 0x03 误判成失败）。 */
    uint8_t st = sha256_self_test();
    g_cryptoOk = st;
    PRINT("[CRYPTO] sha256 self-test: %s (g_cryptoOk=%d)\n", st ? "PASS" : "FAIL!!", g_cryptoOk);

    Bonding_Load();
    Bonding_LoadBindCode();   /* 载入已存自定义码（无则回退默认 123456） */

    /* 配置外围 Bond Manager（方案 B 的链路加密层）。
     * 无头设备无显示/键盘 → NO_INPUT_NO_OUTPUT（Just Works / LESC）仅做链路加密；
     * 真正的所有者鉴权在应用层 BIND 指令 + AUTH challenge-response 完成。 */
    uint8_t pairingMode = GAPBOND_PAIRING_MODE_WAIT_FOR_REQ;
    uint8_t ioCap       = GAPBOND_IO_CAP_NO_INPUT_NO_OUTPUT;
    uint8_t mitm        = 0;

    GAPBondMgr_SetParameter(GAPBOND_PERI_PAIRING_MODE, sizeof(uint8_t), &pairingMode);
    GAPBondMgr_SetParameter(GAPBOND_PERI_IO_CAPABILITIES, sizeof(uint8_t), &ioCap);
    GAPBondMgr_SetParameter(GAPBOND_PERI_MITM_PROTECTION, sizeof(uint8_t), &mitm);

    /* ★ 方案A：启用 peri bonding 持久化。
     *   配对完成后 LTK 写入 SNV（协议栈自动管理），断连重连后 OS 可自动恢复加密链路。
     *   此前只配了配对参数但没 ENABLE，pairing 虽完成但 LTK 不持久→每次重连需重新配对。 */
    uint8_t bondingEnabled = 1;
    GAPBondMgr_SetParameter(GAPBOND_PERI_BONDING_ENABLED, sizeof(uint8_t), &bondingEnabled);

    PRINT("[BOND] init done, owners=%d, bonding=%d\n", s_bondCount, bondingEnabled);
}

/*********************************************************************
 * @fn      Bonding_Load / Bonding_Save
 *********************************************************************/
uint8_t Bonding_Load(void)
{
    __attribute__((aligned(4))) uint8_t buf[BOND_IO_BYTES];
    int rc = EEPROM_READ(KEYGO_BOND_ADDR, buf, BOND_IO_BYTES);
    if (rc != 0) {
        PRINT("[BOND] Load failed (rc=%d); owners=0\n", rc);
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
    __attribute__((aligned(4))) uint8_t buf[BOND_IO_BYTES];
    __attribute__((aligned(4))) uint8_t chk[BOND_IO_BYTES];
    tmos_memset(buf, 0xFF, BOND_IO_BYTES);
    for (uint8_t i = 0; i < s_bondCount && i < BOND_ENTRY_MAX; i++) {
        tmos_memcpy(buf + i * BOND_ENTRY_SIZE, &s_bondTbl[i], BOND_ENTRY_SIZE);
    }
    for (uint8_t p = 0; p < BOND_PAGES; p++) {
        EEPROM_ERASE(KEYGO_BOND_ADDR + p * BOND_PAGE_SIZE, BOND_PAGE_SIZE);
    }
    if (EEPROM_WRITE(KEYGO_BOND_ADDR, buf, BOND_IO_BYTES) != 0) {
        PRINT("[BIND] WARNING: Bonding_Save write failed (not persisted)\n");
        return 1;
    }
    /* 写后读回校验, 确保真正落盘, 避免「RAM 生效但掉电即丢」 */
    if (EEPROM_READ(KEYGO_BOND_ADDR, chk, BOND_IO_BYTES) != 0 ||
        tmos_memcmp(chk, buf, BOND_IO_BYTES) == 0) {   /* tmos_memcmp: 0=不同 → 校验失败 */
        PRINT("[BIND] WARNING: Bonding_Save verify FAILED (not persisted)\n");
        return 1;
    }
    PRINT("[BIND] Bonding_Save OK (persisted, owners=%d)\n", s_bondCount);
    return 0;
}

/*********************************************************************
 * @fn      Bonding_LoadBindCode / Bonding_SaveBindCode / Bonding_ResetBindCode
 * @brief   当前有效绑定码的持久化（独立页 KEYGO_BINDCODE_ADDR）。
 *   存储格式：buf[0]=长度，buf[1..len]=码明文。读出时长度不合法则回退默认 123456。
 *********************************************************************/
uint8_t Bonding_LoadBindCode(void)
{
    __attribute__((aligned(4))) uint8_t buf[BOND_CODE_MAXLEN + 1];
    if (EEPROM_READ(KEYGO_BINDCODE_ADDR, buf, sizeof(buf)) == 0) {
        uint8_t len = buf[0];
        if (len >= 1 && len <= BOND_CODE_MAXLEN) {
            tmos_memcpy(g_curBindCode, buf + 1, len);
            g_curBindCode[len] = 0;
            g_curBindCodeLen = len;
            PRINT("[BIND] loaded custom code len=%d\n", len);
            return 0;
        }
    }
    /* 无有效自定义码 → 默认 123456 */
    tmos_memcpy(g_curBindCode, DEFAULT_BIND_CODE, DEFAULT_BIND_CODE_LEN);
    g_curBindCode[DEFAULT_BIND_CODE_LEN] = 0;
    g_curBindCodeLen = DEFAULT_BIND_CODE_LEN;
    return 1;
}

uint8_t Bonding_SaveBindCode(void)
{
    __attribute__((aligned(4))) uint8_t buf[BOND_CODE_MAXLEN + 1];
    __attribute__((aligned(4))) uint8_t chk[BOND_CODE_MAXLEN + 1];
    tmos_memset(buf, 0xFF, sizeof(buf));
    buf[0] = g_curBindCodeLen;
    tmos_memcpy(buf + 1, g_curBindCode, g_curBindCodeLen);
    EEPROM_ERASE(KEYGO_BINDCODE_ADDR, BOND_PAGE_SIZE);
    if (EEPROM_WRITE(KEYGO_BINDCODE_ADDR, buf, sizeof(buf)) != 0) {
        PRINT("[BIND] WARNING: SaveBindCode write failed (not persisted)\n");
        return 1;
    }
    if (EEPROM_READ(KEYGO_BINDCODE_ADDR, chk, sizeof(buf)) != 0 ||
        tmos_memcmp(chk, buf, sizeof(buf)) == 0) {   /* tmos_memcmp: 0=不同 → 校验失败 */
        PRINT("[BIND] WARNING: SaveBindCode verify FAILED (not persisted)\n");
        return 1;
    }
    return 0;
}

void Bonding_ResetBindCode(void)
{
    tmos_memcpy(g_curBindCode, DEFAULT_BIND_CODE, DEFAULT_BIND_CODE_LEN);
    g_curBindCode[DEFAULT_BIND_CODE_LEN] = 0;
    g_curBindCodeLen = DEFAULT_BIND_CODE_LEN;
    Bonding_SaveBindCode();
    PRINT("[BIND] bind code reset to default (factory)\n");
}

/*********************************************************************
 * @fn      Bonding_Find / Bonding_IsOwner / Bonding_Count
 *********************************************************************/
int8_t Bonding_Find(const uint8_t *peerAddr)
{
    for (uint8_t i = 0; i < s_bondCount; i++) {
        if (tmos_memcmp(s_bondTbl[i].peerAddr, peerAddr, 6) != 0) {   /* tmos_memcmp: TRUE=相等，故 !=0 表示匹配 */
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
    s_sessionSaltValid = 0;
    tmos_memset(s_sessionSalt, 0, BOND_NONCE_LEN);
    s_lastCmdSeq = 0;
}

uint8_t Bonding_IsSessionAuthed(uint16_t connHandle)
{
    (void)connHandle;
    return s_sessionAuthed;
}

/*********************************************************************
 * @fn      Bonding_HandleBindCmd
 * @brief   处理 BIND 指令（payload = 绑定码明文字节）。
 *   ★ v3.30-fix：改为「基于共享密钥」的信任模型，不再依赖对端 MAC 做 owner 判定。
 *     原因：Android/iOS 的 BLE 地址是随机化私有地址，每次连接都变，
 *           用 peerAddr 做 owner 会导致「同一台手机二次连接也 NOT_OWNER」的死锁。
 *   默认绑定码（贴于机身）= 物理持有即视为可恢复。已知默认码即可：
 *     - 首绑：校验 == DEFAULT_BIND_CODE → 派生 key 写入信任列表。
 *     - 已绑：用默认码覆盖重绑（takeover/恢复出厂信任），彻底消除 NOT_OWNER 死锁。
 *   回报文：BIND:OK / BIND:FAIL:SHORT / BIND:FAIL:CODE / BIND:FAIL:SAVE
 *********************************************************************/
uint8_t Bonding_HandleBindCmd(uint16_t connHandle, const uint8_t *peerAddr, uint8_t peerAddrType,
                              const uint8_t *payload, uint16_t len)
{
    (void)connHandle; (void)peerAddr; (void)peerAddrType;  /* ★ 不再使用 MAC 做身份判定 */

    /* ★ 首绑即「自定码」模型（业界常见：出厂/恢复出厂后的首次配对即确立 owner 凭证）：
     *   - 设备未绑定(Bonding_Count()==0)：用户提供的任意非空码直接成为本机绑定码，
     *     并持久化到 KEYGO_BINDCODE_ADDR（否则重启后 g_curBindCode 回退默认，重绑会 FAIL:CODE）。
     *     这样用户无需先输 123456 再改码，开箱即可用自己设定的码绑定。
     *   - 设备已绑定（覆盖/接管重绑）：必须匹配当前有效码 g_curBindCode，否则 FAIL:CODE。
     *   tmos_memcmp 返回 TRUE(非零)=相等(见 CH58xBLE_ROM.h)，故「不相等」写成 == 0 → FAIL。 */
    const uint8_t *effCode = (const uint8_t *)g_curBindCode;
    uint8_t        effLen  = g_curBindCodeLen;

    if (Bonding_Count() == 0) {
        /* ★ 首次绑定（选项① 先到先绑）：接受任意 BOND_CODE_MINLEN..BOND_CODE_MAXLEN 字节作为新码。
         *   即用户当场输入的自定义码直接成为绑定码（P1-1 强度下限 ≥6），无「先绑默认码再强制改码」。 */
        if (len < BOND_CODE_MINLEN || len > BOND_CODE_MAXLEN) {
            KeyGo_SendRawNotify("BIND:FAIL:SHORT");
            return 1;
        }
        tmos_memcpy(g_curBindCode, payload, len);
        g_curBindCode[len] = 0;
        g_curBindCodeLen   = (uint8_t)len;
        Bonding_SaveBindCode();   /* ★ 关键：首绑的自定义码须跨重启保留 */
        effCode = (const uint8_t *)g_curBindCode;
        effLen  = g_curBindCodeLen;
    } else {
        /* 已绑定：必须匹配当前有效码（覆盖/接管重绑） */
        if (len != g_curBindCodeLen ||
            tmos_memcmp(payload, (const uint8_t *)g_curBindCode, g_curBindCodeLen) == 0) {
            PRINT("[BIND] code mismatch (want len=%d)\n", g_curBindCodeLen);
            /* ★ 区分「设备已有人绑定」与「纯码错误」：返回 ALREADY_BOUND，
             *   让 App 给出精确指引（先接管/解绑，再改用『修改绑定码』切换成自定义码），
             *   避免用户误以为「自定义码功能坏了」。 */
            KeyGo_SendRawNotify("BIND:FAIL:ALREADY_BOUND");
            return 3;
        }
    }

    /* 派生 bindKey = SHA256(code||serial)[0:16]（与 App 端同输入 → 同密钥） */
    char serial[13];
    Bonding_BuildSerial(serial);
    uint8_t key[BOND_KEY_LEN];
    Bonding_DeriveKey(effCode, effLen, (uint8_t *)serial, 12, key);

    /* 单 owner：覆盖写入 slot0（MAC 无关，密钥即身份）。
     * 仍写入 peerAddr 仅作「非空槽」标记（Bonding_Load 靠 peerAddr 全 0xFF 判空），
     * 该地址不再参与鉴权逻辑。 */
    tmos_memcpy(s_bondTbl[0].peerAddr, peerAddr, 6);
    s_bondTbl[0].peerAddrType = peerAddrType;
    tmos_memcpy(s_bondTbl[0].bindKey, key, BOND_KEY_LEN);
    s_bondCount = 1;
    /* BIND 成功即视为本连接已会话鉴权（证明了码知识） */
    s_sessionAuthed = 1;
    /* ★ 方案A（2026-07-12）：BIND 成功 → 取消未鉴权计时（合法用户长连不受限） */
    KeyGo_CancelUnauthTimer();
    s_nonceValid    = 0;
    /* ★ P0-2：BIND 成功后建立 C1 会话盐（= 新生成 nonce，App 经 BIND:OK:<32hex> 取得），
     *   供后续控制命令签名。首次绑定无 AUTH 握手，故在此单独发盐。 */
    Bonding_GenNonce(s_sessionSalt);
    s_sessionSaltValid = 1;
    s_lastCmdSeq = 0;
    if (Bonding_Save() != 0) {
        /* ★ 持久化失败（多为首次设备上电 DataFlash 尚未就绪/未初始化）不阻断本次绑定：
         *   密钥已在 RAM 生效，本连接可正常鉴权控制；掉电后需重新绑定。
         *   若每次都出现，需排查 DataFlash 初始化(FLASH_ROM_START_IO)。 */
        PRINT("[BIND] WARNING: Bonding_Save failed; key kept in RAM only (not persisted)\n");
    }
    PRINT("[BIND] owner set (key-based, MAC-independent), count=%d\n", s_bondCount);
    /* ★ P0-2：BIND:OK 内联 C1 会话盐，App 据此对后续控制命令签名 */
    char _bok[48];
    tmos_memcpy(_bok, "BIND:OK:", 8);
    bin2hex(s_sessionSalt, BOND_NONCE_LEN, _bok + 8);
    KeyGo_SendRawNotify(_bok);
    return 0;
}

/*********************************************************************
 * @fn      Bonding_HandleSetCodeCmd
 * @brief   修改当前有效绑定码（SETCODE:<newcode>）。
 *   前置：① 设备已绑定（Bonding_Count>0）；② 当前连接已会话鉴权（s_sessionAuthed，
 *         即持有旧密钥完成过 AUTH —— 改码即「证明知道旧码」）。
 *   成功后：更新 g_curBindCode + 用新码重派生 bindKey 覆盖 slot0 + 持久化（码页 + 信任列表）。
 *   回报文：SETCODE:OK / SETCODE:FAIL:NOT_BOUND / SETCODE:FAIL:NO_AUTH / SETCODE:FAIL:SHORT
 *   ★ 注意：改码后旧 key 在信任列表被覆盖，旧手机（持旧码派生 key）将无法再 AUTH；
 *     本连接会话态保留（s_sessionAuthed 不变），改码后立即可继续控车。
 *********************************************************************/
uint8_t Bonding_HandleSetCodeCmd(uint16_t connHandle, const uint8_t *payload, uint16_t len)
{
    (void)connHandle;
    if (Bonding_Count() == 0) {
        KeyGo_SendRawNotify("SETCODE:FAIL:NOT_BOUND");
        return 1;
    }
    if (!s_sessionAuthed) {
        KeyGo_SendRawNotify("SETCODE:FAIL:NO_AUTH");
        return 2;
    }
    if (len < BOND_CODE_MINLEN || len > BOND_CODE_MAXLEN) {
        KeyGo_SendRawNotify("SETCODE:FAIL:SHORT");
        return 3;
    }

    /* 更新当前有效绑定码 */
    tmos_memcpy(g_curBindCode, payload, len);
    g_curBindCode[len] = 0;
    g_curBindCodeLen = (uint8_t)len;

    /* 用新码重新派生 bindKey，覆盖信任列表 slot0（密钥即身份） */
    char serial[13];
    Bonding_BuildSerial(serial);
    uint8_t key[BOND_KEY_LEN];
    Bonding_DeriveKey((const uint8_t *)g_curBindCode, g_curBindCodeLen, (uint8_t *)serial, 12, key);
    tmos_memcpy(s_bondTbl[0].bindKey, key, BOND_KEY_LEN);

    /* 持久化：绑定码页 + 信任列表（含新 key） */
    Bonding_SaveBindCode();
    Bonding_Save();

    /* ★ 2026-07-11: SETCODE 完成后强制让外层在下一个任务 tick 推一次 status，
     *   确保 App 收到的最新 status.bn=1、key 已用新码派生（与新 session 一致），
     *   避免 App 端基于旧 bn/旧 key 误判"未绑定"。 */
    tmos_set_event(Peripheral_TaskID, SBP_DEFERRED_STATUS_EVT);

    PRINT("[SETCODE] code updated len=%d, key rederived\n", len);
    KeyGo_SendRawNotify("SETCODE:OK");
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
 *   回报文：AUTH:OK / AUTH:FAIL / AUTH:FAIL:NO_NONCE / AUTH:FAIL:NO_PEER / AUTH:FAIL:CRYPTO
 *********************************************************************/
uint8_t Bonding_HandleAuthResp(uint16_t connHandle, const uint8_t *peerAddr,
                               const uint8_t *payload, uint8_t len)
{
    (void)connHandle; (void)peerAddr;  /* ★ 不再用 MAC 查找 owner，改用密钥本身校验 */
    /* ★ 2026-07-12 P0-1（§14.3.1）：删除「crypto 自测失败即降级放行」后门，改为 fail-closed。
     *   旧逻辑在 g_cryptoOk=0 时「已绑定即视为已鉴权」——一旦某天自测偶发失败，绑定设备会
     *   被无条件放行，是潜在后门。现改为：crypto 不可信时一律拒绝鉴权，绝不降级放行。
     *   当前 g_cryptoOk=1（AUTH:OK 实证），此分支为兜底防御；真出现应修 crypto 而非放行。 */
    if (!g_cryptoOk) {
        KeyGo_SendRawNotify("AUTH:FAIL:CRYPTO");
        PRINT("[AUTH] crypto self-test failed, refuse all auth (fail-closed)\n");
        return 4;
    }
    if (s_bondCount == 0) {
        KeyGo_SendRawNotify("AUTH:FAIL:NO_PEER");  /* 设备尚未绑定 */
        return 2;
    }
    if (!s_nonceValid) {
        KeyGo_SendRawNotify("AUTH:FAIL:NO_NONCE");
        return 1;
    }

    uint8_t resp[SHA256_DIGEST_LEN];
    if (hex2bin((const char *)payload, len, resp) != SHA256_DIGEST_LEN) {
        KeyGo_SendRawNotify("AUTH:FAIL:BAD_HEX");
        return 3;
    }

    /* ★ 密钥即身份：用存储的 bindKey 校验 HMAC(nonce, bindKey)，与对端 MAC 无关 */
    uint8_t expect[SHA256_DIGEST_LEN];
    hmac_sha256(s_bondTbl[0].bindKey, BOND_KEY_LEN, s_nonce, BOND_NONCE_LEN, expect);

    /* ★ 2026-07-12 加固：用自包含 ct_eq 替代 tmos_memcmp，语义自主、不依赖 SDK 版本。
     *   ct_eq(相等)=1，故「不相等」写成 !ct_eq → mismatch。与旧逻辑（tmos_memcmp==0 判不同）等价，
     *   但彻底消除「未来 SDK 改 tmos_memcmp 返回值语义导致鉴权被绕过/误拒」的隐患。 */
    if (!ct_eq(expect, resp, SHA256_DIGEST_LEN)) {
        PRINT("[AUTH] mismatch\n");
        KeyGo_SendRawNotify("AUTH:FAIL");
        return 4;
    }

    s_sessionAuthed = 1;
    /* ★ 方案A（2026-07-12）：AUTH 成功 → 取消未鉴权计时（车主重连照常长连） */
    KeyGo_CancelUnauthTimer();
    s_nonceValid    = 0;   /* 一次性 */
    /* ★ P0-2：复用本次 AUTH 握手的 nonce 作为 C1 会话盐（App 已知该 nonce），建立签名会话。 */
    tmos_memcpy(s_sessionSalt, s_nonce, BOND_NONCE_LEN);
    s_sessionSaltValid = 1;
    s_lastCmdSeq = 0;
    tmos_memset(s_nonce, 0, BOND_NONCE_LEN);
    PRINT("[AUTH] session authed (key-based, MAC-independent)\n");
    KeyGo_SendRawNotify("AUTH:OK");
    return 0;
}

/*********************************************************************
 * @fn      Bonding_HandleUnbindCmd
 * @brief   mode=0 解绑自己；mode=1 清空全部（恢复出厂信任列表）。
 *   解绑须先经 AUTH 会话鉴权（证明持有密钥），MAC 不可靠故不依赖地址。
 *   回报文：UNBIND:OK / UNBIND:FAIL:NO_AUTH
 *********************************************************************/
uint8_t Bonding_HandleUnbindCmd(uint16_t connHandle, const uint8_t *peerAddr, uint8_t mode)
{
    (void)connHandle; (void)peerAddr;  /* peerAddr 不再用于身份判定 */
    if (s_bondCount == 0) {
        KeyGo_SendRawNotify("UNBIND:OK"); /* 本来就是空的 */
        return 0;
    }
    /* ★ 解绑须先经 AUTH 会话鉴权（证明持有密钥），MAC 不可靠故不依赖地址。
     *   若尚未鉴权，App 会先走 NONCE/AUTH 握手再发 UNBIND。 */
    if (!s_sessionAuthed) {
        KeyGo_SendRawNotify("UNBIND:FAIL:NO_AUTH");
        return 1;
    }
    if (mode == 1) {
        Bonding_EraseAll();
        Bonding_ResetBindCode();   /* ★ 恢复出厂：绑定码重置为默认 123456，保证可重新首绑 */
        PRINT("[UNBIND] all owners erased (factory trust list)\n");
    } else {
        s_bondCount = 0;
        Bonding_Save();
        PRINT("[UNBIND] owner removed\n");
    }
    s_sessionAuthed = 0;
    s_nonceValid    = 0;
    s_sessionSaltValid = 0;
    tmos_memset(s_sessionSalt, 0, BOND_NONCE_LEN);
    s_lastCmdSeq = 0;
    KeyGo_SendRawNotify("UNBIND:OK");
    return 0;
}

/*********************************************************************
 * @fn      Bonding_VerifySignedCmd
 * @brief   校验 C1 签名控制命令（在 Peripheral_HandleFF03 的 else 分支调用）。
 *   输入 tail = 去掉 "C1:" 前缀后的剩余串，格式：<body>:<seq>:<hmacHex64>
 *     - body：原控制命令（如 UNLOCK / LOCK / TRUNK / NAME:xxx），可含 ':'。
 *     - seq ：十进制序号（防同连接重放）。
 *     - hmac：HMAC-SHA256(bindKey, s_sessionSalt || "<body>:<seq>") 的 64 hex。
 *   校验：① 会话盐已建立；② seq > s_lastCmdSeq；③ HMAC 匹配。
 *   通过返回 0，并把 body 写入 outBody（供 KeyGo_HandleCommand 执行）；失败返回非 0 错误码。
 *   ★ 防跨连接重放：s_sessionSalt 每连接由 AUTH/BIND 重建（= 新随机 nonce），
 *     旧连接的签名在新连接下因 salt 不同而必然 HMAC 校验失败。
 *********************************************************************/
uint8_t Bonding_VerifySignedCmd(const char *tail, uint16_t len, char *outBody, uint16_t *outBodyLen)
{
    if (!s_sessionSaltValid) return 1;          /* 会话盐未建立（未 AUTH/BIND） */
    if (len < 67) return 2;                      /* 至少 "X:1:" + 64hex = 67 */
    if (tail[len - 65] != ':') return 3;         /* hmac 前必须是 ':' 分隔 */
    const char *hmacHex = tail + len - 64;

    /* head = tail[0 .. len-66] = "<body>:<seq>" */
    uint16_t headLen = len - 65;
    if (headLen > 64) return 10;                 /* head 超长保护 */
    int idx = -1;
    for (uint16_t i = 0; i < headLen; i++) {
        if (tail[i] == ':') idx = (int)i;
    }
    if (idx < 0) return 4;                       /* 找不到 seq 分隔 */
    uint16_t bodyLen = (uint16_t)idx;
    uint16_t seqLen  = headLen - (uint16_t)idx - 1;
    if (seqLen == 0 || seqLen > 10) return 5;    /* seq 长度异常 */
    if (bodyLen >= 64) return 10;                /* body 超长保护 */

    /* 解析 seq 十进制 */
    uint32_t seq = 0;
    for (uint16_t i = (uint16_t)idx + 1; i < headLen; i++) {
        char c = tail[i];
        if (c < '0' || c > '9') return 6;        /* 非数字 */
        seq = seq * 10u + (uint32_t)(c - '0');
    }
    if (seq <= s_lastCmdSeq) return 7;           /* 重放/乱序 */

    /* 校验 HMAC：msg = s_sessionSalt || "<body>:<seq>" */
    uint8_t resp[SHA256_DIGEST_LEN];
    if (hex2bin(hmacHex, 64, resp) != SHA256_DIGEST_LEN) return 8;  /* hmac 非法 hex */

    uint8_t material[BOND_NONCE_LEN + 64];
    uint16_t mlen = 0;
    tmos_memcpy(material, s_sessionSalt, BOND_NONCE_LEN); mlen += BOND_NONCE_LEN;
    tmos_memcpy(material + mlen, tail, headLen);          mlen += headLen;
    uint8_t expect[SHA256_DIGEST_LEN];
    hmac_sha256(s_bondTbl[0].bindKey, BOND_KEY_LEN, material, mlen, expect);

    if (!ct_eq(expect, resp, SHA256_DIGEST_LEN)) return 9;  /* 签名不匹配 */

    /* 通过：更新重放计数器并回写 body */
    s_lastCmdSeq = seq;
    tmos_memcpy(outBody, tail, bodyLen);
    outBody[bodyLen] = 0;
    *outBodyLen = bodyLen;
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
