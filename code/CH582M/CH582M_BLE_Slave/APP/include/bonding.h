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
#define BOND_KEY_LEN    16   /* bindKey 取 SHA256 的前 16 字节 */
#define BOND_NONCE_LEN  16   /* challenge-response 一次性 nonce 长度 */

/* ── 自定义绑定码最大长度 ── */
#define BOND_CODE_MAXLEN  32  /* 支持用户把绑定码改成自己的任意串（≤32 字节） */

/* ── 信任列表存储布局（DataFlash，复用 keygo_core 的 EEPROM_* 原语）──
 *   keygo_core 配置区: 0x77000 (256B 页)
 *   BLE SNV (LTK):     0x77E00  (协议栈自管，勿碰)
 *   本模块信任列表:     0x77100  (256B 页；8 条≈224B 单页；改 16 条≈448B 需 2 页，见 BOND_PAGES)
 *   当前有效绑定码:     0x77200  (独立 256B 页，首字节=长度，后续=码明文；与 0x77100 不重叠)
 *   ⚠ 上述地址不得相互重叠。
 */
#ifndef KEYGO_BOND_ADDR
#define KEYGO_BOND_ADDR   0x77100
#endif
#ifndef KEYGO_BINDCODE_ADDR
#define KEYGO_BINDCODE_ADDR  0x77200   /* ★ 自定义绑定码持久化页 */
#endif
#define BOND_PAGE_SIZE    256

/* 单条信任记录（与方案文档 §5.1a trustedPeer 对应） */
typedef struct {
    uint8_t  peerAddr[6];     // 对端手机 BLE MAC (小端, 与 GAP 一致)
    uint8_t  peerAddrType;    // ADDRTYPE_PUBLIC / ADDRTYPE_RANDOM
    uint8_t  role;            // 0=owner; (1=guest 后期)
    uint8_t  bindKey[BOND_KEY_LEN]; // 派生密钥（非明文密码）
    uint32_t addedAt;         // 绑定时间戳（RTC 秒，可选）
} bondEntry_t;

#define BOND_ENTRY_MAX    8      /* D6: 容量 8（已确认）。改 16 时 BOND_PAGES 自动变 2。 */
#define BOND_ENTRY_SIZE  (sizeof(bondEntry_t))                 /* 6+1+1+16+4 = 28B */
#define BOND_TABLE_BYTES (BOND_ENTRY_MAX * BOND_ENTRY_SIZE)    /* 8*28=224B */
#define BOND_IO_BYTES    ((BOND_TABLE_BYTES + 3) & ~3)         /* EEPROM 按 4 字节对齐 */
#define BOND_PAGES       ((BOND_TABLE_BYTES + (BOND_PAGE_SIZE-1)) / BOND_PAGE_SIZE)

/* ── 生命周期 ── */
void    Bonding_Init(void);                       /* 载入信任列表 + 配置 Bond Manager + 注册回调 + 跑密码学自测 */
uint8_t Bonding_Load(void);                        /* 从 DataFlash 读入 RAM 表 */
uint8_t Bonding_Save(void);                        /* RAM 表写回 DataFlash（擦+写） */

/* ── 当前有效绑定码持久化（独立页 KEYGO_BINDCODE_ADDR）── */
uint8_t Bonding_LoadBindCode(void);   /* 载入已存自定义码（无则回退默认 123456） */
uint8_t Bonding_SaveBindCode(void);   /* 当前码落盘 */
void    Bonding_ResetBindCode(void);  /* 重置为默认 123456（UNBIND:ALL 恢复出厂时调用） */

/* ── 信任列表 CRUD ── */
int8_t  Bonding_Find(const uint8_t *peerAddr);    /* 返回索引, 找不到返回 -1 */
uint8_t Bonding_IsOwner(const uint8_t *peerAddr); /* 是否在信任列表 */
uint8_t Bonding_AddOwner(const uint8_t *peerAddr, uint8_t addrType, const uint8_t *bindKey);
uint8_t Bonding_RemoveOwner(const uint8_t *peerAddr);
void    Bonding_EraseAll(void);                    /* 清整个信任列表（丢机/恢复出厂） */
uint8_t Bonding_Count(void);

/* ── 密码学原语 ── */
/* 由 绑定码(code) + 序列号(serial) 派生 bindKey：SHA256(code||serial)[0:16]。
 * 固件端与 App 端输入一致即得到相同密钥。serial = FF04 的 MAC 十六进制串（12 字符，大写）。 */
void Bonding_DeriveKey(const uint8_t *code, uint8_t codeLen,
                       const uint8_t *serial, uint8_t serialLen,
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

/* 对外暴露的 Bond Manager 回调表。
 * 接线：peripheral.c 的 GAPRole_PeripheralStartDevice(Peripheral_TaskID, &Bonding_BondCBs, &Peripheral_PeripheralCBs) */
extern gapBondCBs_t Bonding_BondCBs;

/* bonding.c 用来回报文（FF02 Notify）的钩子，实现见 keygo_core.c */
extern void KeyGo_SendRawNotify(const char *msg);

#endif /* KEYGO_BONDING_H */
