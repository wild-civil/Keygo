/********************************** (C) COPYRIGHT *******************************
 * File Name          : crypto_sha256.h
 * Author             : KeyGo (CH582M) — 轻量 SHA-256 / HMAC-SHA256 实现
 * Version            : v1.0
 * Date               : 2026/07/10
 * Description        : KeyGo 绑定层密码学原语。
 *                      用于：① 由绑定码派生 bindKey（KDF = SHA256(code||serial) 取前16B）
 *                            ② 控制指令前的 challenge-response（HMAC-SHA256(nonce, bindKey)）
 *                      实现取自 FIPS-180-4 标准流程（公开领域算法，非第三方专有）。
 *                      含 sha256_self_test()，上电跑一次即可在串口确认实现正确性。
 *******************************************************************************/
#ifndef KEYGO_CRYPTO_SHA256_H
#define KEYGO_CRYPTO_SHA256_H

#include "CH58x_common.h"   // uint8_t 等基础类型

/* SHA-256 输出长度（字节） */
#define SHA256_DIGEST_LEN   32
/* HMAC-SHA256 使用的块大小（字节，FIPS-198） */
#define SHA256_BLOCK_LEN    64

/* 计算 SHA-256(data[len]) -> out[32] */
void sha256(const uint8_t *data, uint32_t len, uint8_t out[SHA256_DIGEST_LEN]);

/* 计算 HMAC-SHA256(key[keyLen], msg[msgLen]) -> out[32]
 * keyLen 可为任意长度（内部按 SHA256_BLOCK_LEN 归一化）。 */
void hmac_sha256(const uint8_t *key, uint32_t keyLen,
                 const uint8_t *msg, uint32_t msgLen,
                 uint8_t out[SHA256_DIGEST_LEN]);

/* 自测：用标准向量校验 SHA-256 / HMAC-SHA256。
 * 返回 0 = 全部通过；非 0 = 失败（含具体位掩码）。 */
uint8_t sha256_self_test(void);

#endif /* KEYGO_CRYPTO_SHA256_H */
