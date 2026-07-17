/********************************** (C) COPYRIGHT *******************************
 * File Name          : bonding.h
 * Author             : KeyGo (CH582M) — 绑定/授权模块头文件
 * Version            : v1.0 (Phase 1: 真实密码学 + challenge-response)
 * Date               : 2026/07/10
 * Description        : 所有者绑定（owner）信任列表管理 + GAP Bond Manager 回调
 *                      + 应用层 bindKey 派生(KDF) + HMAC challenge-response 会话鉴权。
 *                      设计见 docs/02-技术方案与专项设计/KeyGo_本地化绑定与临时授权方案_v1.0.0.md
 *                      Phase 0/1 验证清单见 KeyGo_CH582M_Bonding_Phase0与API清单_v1.0.0.md
 *
 * ★ Phase 1 落地内容：
 *   - 真实密码学：crypto_sha256.c 的 SHA-256 / HMAC-SHA256。
 *   - bindKey = SHA256(绑定码 || 序列号)[0:16]（序列号 = FF04 的 MAC 十六进制串；
 *     固件端与 App 端用相同输入推导，得到一致密钥）。
 *   - 控制前 challenge-response：设备发 NONCE，手机回 HMAC(NONCE, bindKey)，防重放/明文泄露。
 *   - FF03 命令通道新增 BIND / NONCE / AUTH / UNBIND 指令；其余控制指令须经会话鉴权。
 *******************************************************************************/
#ifndef KEYGO_BONDING_H
#define KEYGO_BONDING_H

#include "CONFIG.h"
#include "peripheral.h"    // gapBondCBs_t, GAPBOND_* 常量, LINK_* 标志, peripheralConnItem_t
#include "CH58x_common.h"  // EEPROM_READ / EEPROM_ERASE / EEPROM_WRITE

#include "crypto_sha256.h" // SHA-256 / HMAC-SHA256

/* ── 密钥/nonce 长度 ── */
#define BOND_KEY_LEN       16   /* gk(组密钥) 与 phoneKey(每手机密钥) 均取 16 字节 */
#define BOND_NONCE_LEN     16   /* challenge-response 一次性 nonce 长度 */
#define BOND_PHONE_ID_LEN  8    /* ★ v3.36: 每手机稳定 id 长度（App 生成 8 字节随机，hex 16 字符）*/

/* ★ v3.36: 信任表存储格式魔数（DataFlash BOND 页首 4 字节）。
 *   旧固件(≤3.35) 写入的是 28B/条无魔数格式；新固件 Load 读到非本魔数即判定为旧格式 → 清空重绑。
 *   "KGNT" = 0x4B 0x47 0x4E 0x54。 */
#define BOND_MAGIC         0x4B474E54u

/* ── 自定义绑定码最大长度 ── */
#define BOND_CODE_MAXLEN  32  /* 支持用户把绑定码改成自己的任意串（≤32 字节） */

/* ── 自定义绑定码最小长度（首绑 / 改码强度下限，P1-1）── */
#define BOND_CODE_MINLEN  6   /* 绑定码至少 6 字节，避免弱码 */

/* ── 信任列表存储布局（DataFlash，复用 keygo_core 的 EEPROM_* 原语）──
 *   keygo_core 配置区: 偏移 0x7000 (物理 0x77000, 256B 页)
 *   BLE SNV (LTK):     偏移 0x7700 (物理 0x77700, 2026-07-17 由 0x07E00 下移以扩容至 8 绑定; 协议栈自管，勿碰)
 *   本模块信任列表:     偏移 0x7100 (物理 0x77100, 256B 页；首 4B=格式魔数 BOND_MAGIC，其后 8×29B=232B 条目；
 *                        ★ v3.36 起单页仍够，因条目由 28B 重构为 29B 并去掉无用的 RPA peerAddr，详见 §2)
 *   当前有效绑定码:     偏移 0x7200 (物理 0x77200, 独立 256B 页，首字节=长度，后续=码明文；与 0x7100 不重叠)
 *   ⚠ 上述地址为【相对 DataFlash 基地址 0x70000 的偏移】，非物理地址；且不得相互重叠。
 */
#ifndef KEYGO_BOND_ADDR
#define KEYGO_BOND_ADDR   0x7100   /* 物理 0x77100 = DATA_FLASH_ADDR(0x70000) + 偏移 0x7100 */
#endif
#ifndef KEYGO_BINDCODE_ADDR
#define KEYGO_BINDCODE_ADDR  0x7200   /* 物理 0x77200, ★ 自定义绑定码持久化页 */
#endif
#ifndef KEYGO_SECEP_ADDR
#define KEYGO_SECEP_ADDR   0x7400   /* 物理 0x77400, ★ Phase 2 安全迁移标记页(升级到 passkey 时代清旧 Just-Works bond); < SNV(偏移 0x7700) 独占 1 页 */
#endif
#define KEYGO_SECEP_VALUE 0x01      /* 已迁移到 passkey 时代的标记值 */
#define BOND_PAGE_SIZE    256

/* 单条信任记录（★ v3.36 授权体系 v1：per-phone 身份 + 每 owner RSSI 阈值）
 *   ★ 删除旧 peerAddr[6]：随机私有地址(RPA)每次连接都变，本就不能做身份锚，留着徒占空间。
 *   ★ phoneId 取代 MAC 成为 owner 身份锚（App 生成、持久化、稳定）；phoneKey 为每手机独立密钥。
 *   ★ rssiUnlock/rssiLock 为本 owner 的 RSSI 解锁/锁车阈值（绑定初始化=全局配置；RSSISET 可覆写）。
 *   ★ packed：避免 int16 字段对齐插入 padding，保证 sizeof==BOND_ENTRY_SIZE（手工 memcpy 一致）。
 *   详见 docs/授权体系v1_per-phone与RSSI阈值跟随.md §2。 */
typedef struct __attribute__((packed)) {
    uint8_t  phoneId[BOND_PHONE_ID_LEN]; // 8  稳定每手机 id（全 0xFF=空槽；全 0x00=遗留 gk 条目）
    uint8_t  phoneKey[BOND_KEY_LEN];     // 16 per-phone 密钥 = HMAC-SHA256(gk, phoneId)[0:16]
    int16_t  rssiUnlock;                 // 2  本 owner 解锁 RSSI 阈值（绑定初始化=全局配置值）
    int16_t  rssiLock;                   // 2  本 owner 锁车 RSSI 阈值
    uint8_t  role;                       // 1  0=owner（管理员/guest 预留）
} bondEntry_t;                           // packed = 8+16+2+2+1 = 29 字节

#define BOND_ENTRY_MAX    8      /* D6: 容量 8（已确认）。改 16 时 BOND_PAGES 自动变 2。 */
#define BOND_ENTRY_SIZE  29  /* = sizeof(bondEntry_t) packed；★ 不能用 sizeof()（预处理器 #if 不认识），用字面值保持编译护栏可用 */
#define BOND_TABLE_BYTES (BOND_ENTRY_MAX * BOND_ENTRY_SIZE)    /* 8*29=232B */
/* ★ v3.36: 存储缓冲 = 4 字节格式魔数 + 表体；EEPROM 按 4 字节对齐。4+232=236 ≤ 256(单页)。 */
#define BOND_IO_BYTES    ((4 + BOND_TABLE_BYTES + 3) & ~3)     /* = 236 */
#define BOND_PAGES       ((BOND_TABLE_BYTES + (BOND_PAGE_SIZE-1)) / BOND_PAGE_SIZE)

/* ── ★ 编译期区域护栏：任何布局改动若导致区域重叠/越界，立即编译失败而非静默损坏 ──
 *   地址均为「相对 DataFlash 基址 0x70000 的偏移」。
 *   - CFG(0x7000) / BOND(0x7100) / BINDCODE(0x7200) 各占独立 256B 页，互不重叠。
 *   - BOND 区域右界不得触及 BINDCODE（当前 BOND_PAGES=1 恰好相邻 0x7200；若扩到 16 条
 *     BOND_PAGES=2 会越界擦到绑定码页 → 这里直接 #error 拦死）。
 *   - BINDCODE 右界不得触及 BLE SNV(偏移 0x7700)。 */
#if (KEYGO_CFG_ADDR + BOND_PAGE_SIZE) > KEYGO_BOND_ADDR
#error "KEYGO_CFG region overlaps BOND region! Adjust offsets in bonding.h / keygo_core.h."
#endif
#if (KEYGO_BOND_ADDR + BOND_PAGES * BOND_PAGE_SIZE) > KEYGO_BINDCODE_ADDR
#error "BOND region overlaps BINDCODE region! Increase KEYGO_BINDCODE_ADDR or reduce BOND_ENTRY_MAX."
#endif
#if (KEYGO_BINDCODE_ADDR + BOND_PAGE_SIZE) > 0x7700
#error "BINDCODE region overlaps BLE SNV (offset 0x7700)! Move KEYGO_BINDCODE_ADDR lower."
#endif
#if (KEYGO_SECEP_ADDR + BOND_PAGE_SIZE) > 0x7700
#error "SECEP region overlaps BLE SNV (offset 0x7700)! Move KEYGO_SECEP_ADDR lower."
#endif

/* ── 生命周期 ── */
void    Bonding_Init(void);                       /* 载入信任列表 + 配置 Bond Manager + 注册回调 + 跑密码学自测 */
void    Bonding_ApplyPairingMode(void);           /* ★ 方案1: 根据 g_encRequired 切换配对模式(INITIATE/WAIT_FOR_REQ) */
uint8_t Bonding_Load(void);                        /* 从 DataFlash 读入 RAM 表 */
uint8_t Bonding_Save(void);                        /* RAM 表写回 DataFlash（擦+写） */

/* ── 当前有效绑定码持久化（独立页 KEYGO_BINDCODE_ADDR）── */
uint8_t Bonding_LoadBindCode(void);   /* 载入已存自定义码（无则回退默认 123456） */
uint8_t Bonding_SaveBindCode(void);   /* 当前码落盘 */
void    Bonding_ResetBindCode(void);  /* 重置为默认 123456（UNBIND:ALL 恢复出厂时调用） */

/* ── 信任列表 CRUD（★ v3.36：身份锚由 MAC 改为 phoneId）── */
int8_t  Bonding_FindByPhoneId(const uint8_t *phoneId);  /* 按 phoneId 查 owner 下标, 找不到返回 -1 */
uint8_t Bonding_AddOwner(const uint8_t *phoneId, const uint8_t *phoneKey); /* 新增/刷新 owner（phoneKey=HMAC(gk,phoneId)）*/
uint8_t Bonding_RemoveOwner(const uint8_t *phoneId);    /* 按 phoneId 删 owner（兼容保留，UNBIND:0 实际走 RemoveOwnerByIndex）*/
void    Bonding_EraseAll(void);                    /* 清整个信任列表（丢机/恢复出厂） */
uint8_t Bonding_Count(void);

/* ★ 2026-07-17 诊断埋点：打印应用层 owner 数 + 协议栈 SNV bond 数（GAPBOND_BOND_COUNT）。
 *   排查「B 配对后 A 被迫重配」——观察 SNV bond 是否在多手机配对时被淘汰。tag 标注调用点。 */
void    Bonding_DumpStatus(const char *tag);

/* ── 密码学原语 ── */
/* 由 绑定码(code) + 序列号(serial) 派生 gk(组密钥)：SHA256(code||serial)[0:16]。
 * 固件端与 App 端输入一致即得到相同密钥。serial = FF04 的 MAC 十六进制串（12 字符，大写）。
 * ★ v3.36: gk 不落盘，可随时由「当前有效码+序列号」重算。 */
void Bonding_DeriveKey(const uint8_t *code, uint8_t codeLen,
                       const uint8_t *serial, uint8_t serialLen,
                       uint8_t outKey[BOND_KEY_LEN]);

/* ★ v3.36: 由 gk + phoneId 派生 per-phone 密钥：phoneKey = HMAC-SHA256(gk, phoneId)[0:16]。
 *   每手机输入(phoneId)不同 → 输出不同 → 真正实现 per-phone 身份。详见设计文档 §1。 */
void Bonding_DerivePhoneKey(const uint8_t *gk, const uint8_t *phoneId,
                            uint8_t outKey[BOND_KEY_LEN]);

/* 生成一次性 nonce（tmos_rand + xorshift 混淆；★非密码级随机，仅作抗重放挑战值，链路已加密） */
void Bonding_GenNonce(uint8_t out[BOND_NONCE_LEN]);

/* 生成一次性 nonce 并输出为 32 字符十六进制串（outHex32 至少 33 字节）。供 Peripheral_HandleFF03 内联下发 AUTH_REQ 用。 */
void Bonding_IssueNonce(char *outHex32);

/* ── 会话鉴权 ── */
void    Bonding_ConnTerminated(void);             /* 断连：清空会话态（鉴权/nonce 一次性） */
uint8_t Bonding_IsSessionAuthed(uint16_t connHandle); /* 当前连接是否已会话鉴权 */

/* ── FF03 指令处理（回报文经 KeyGo_SendRawNotify 走 FF02）── */
uint8_t Bonding_HandleBindCmd(uint16_t connHandle, const uint8_t *peerAddr, uint8_t peerAddrType,
                              const uint8_t *payload, uint16_t len);
void    Bonding_HandleNonceReq(uint16_t connHandle);
uint8_t Bonding_HandleAuthResp(uint16_t connHandle, const uint8_t *peerAddr,
                               const uint8_t *payload, uint8_t len);
uint8_t Bonding_HandleUnbindCmd(uint16_t connHandle, const uint8_t *peerAddr, uint8_t mode);
/* ★ 自定义绑定码：已绑定且已会话鉴权时，将当前有效绑定码改为 payload，
 *   并用新码重新派生 bindKey 覆盖信任列表 slot0。回报 SETCODE:OK / SETCODE:FAIL:* */
uint8_t Bonding_HandleSetCodeCmd(uint16_t connHandle, const uint8_t *payload, uint16_t len);

/* ★ v3.36: per-phone RSSI 阈值校准命令 RSSISET:<unlock>:<lock>（有符号十进制 RSSI）。
 *   前置：已会话鉴权且 s_authedOwnerIdx≥0（本机知道自己是谁）。改写当前 owner 的
 *   rssiUnlock/rssiLock 并落盘。回报 RSSISET:OK / RSSISET:FAIL:*。 */
uint8_t Bonding_HandleRssiSetCmd(uint16_t connHandle, const uint8_t *payload, uint16_t len);

/* ★ v3.36: 取「当前已鉴权 owner」的 RSSI 阈值，供状态机/上报使用。
 *   返回 1 = 使用了 owner 专属阈值（*unlock/*lock 已填）；返回 0 = 无 owner 身份（调用方应使用全局配置）。 */
uint8_t Bonding_GetActiveOwnerRssi(int16_t *unlock, int16_t *lock);

/* ★ P0-2：校验 C1 签名控制命令（C1:<body>:<seq>:<hmacHex64>），详见 bonding.c。
 *   通过返回 0 并回写 body；失败返回非 0 错误码。 */
uint8_t Bonding_VerifySignedCmd(const char *tail, uint16_t len, char *outBody, uint16_t *outBodyLen);

/* 对外暴露的 Bond Manager 回调表。
 * 接线：peripheral.c 的 GAPRole_PeripheralStartDevice(Peripheral_TaskID, &Bonding_BondCBs, &Peripheral_PeripheralCBs) */
extern gapBondCBs_t Bonding_BondCBs;

/* bonding.c 用来回报文（FF02 Notify）的钩子，实现见 keygo_core.c */
extern void KeyGo_SendRawNotify(const char *msg);

#endif /* KEYGO_BONDING_H */
