/********************************** (C) COPYRIGHT *******************************
 * File Name          : crypto_sha256.c
 * Author             : KeyGo (CH582M) — 轻量 SHA-256 / HMAC-SHA256 实现
 * Version            : v1.0
 * Date               : 2026/07/10
 * Description        : 见 crypto_sha256.h。标准 FIPS-180-4 / FIPS-198 实现，
 *                      含 sha256_self_test() 供上电校验。
 *******************************************************************************/
#include "crypto_sha256.h"
#include "HAL.h"   // tmos_memcmp / PRINT

/* SHA-256 轮常量 K[0..63] (FIPS-180-4) */
static const uint32_t SHA_K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

static uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }

/* 处理一个 64 字节数据块 */
static void sha256_transform(uint32_t state[8], const uint8_t block[64])
{
    uint32_t w[64];
    uint32_t i;
    for (i = 0; i < 16; i++) {
        w[i] = ((uint32_t)block[i * 4]     << 24) |
               ((uint32_t)block[i * 4 + 1] << 16) |
               ((uint32_t)block[i * 4 + 2] << 8)  |
                (uint32_t)block[i * 4 + 3];
    }
    for (i = 16; i < 64; i++) {
        uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
    uint32_t e = state[4], f = state[5], g = state[6], h = state[7];

    for (i = 0; i < 64; i++) {
        uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = h + S1 + ch + SHA_K[i] + w[i];
        uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = S0 + maj;

        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }

    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
}

void sha256(const uint8_t *data, uint32_t len, uint8_t out[SHA256_DIGEST_LEN])
{
    uint32_t state[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    };

    unsigned long long totalBits = (unsigned long long)len * 8;
    uint32_t i = 0;
    while (i + 64 <= len) {
        sha256_transform(state, data + i);
        i += 64;
    }

    /* 尾部填充（0x80 + 0x00... + 64-bit 大端位长） */
    uint8_t buf[64];
    uint32_t rem = len - i;
    uint32_t j = 0;
    while (j < rem) { buf[j] = data[i + j]; j++; }
    buf[j++] = 0x80;
    if (j > 56) {
        while (j < 64) buf[j++] = 0;
        sha256_transform(state, buf);
        j = 0;
        while (j < 56) buf[j++] = 0;
    } else {
        while (j < 56) buf[j++] = 0;
    }
    for (i = 0; i < 8; i++) {
        buf[56 + i] = (uint8_t)(totalBits >> (56 - 8 * i));
    }
    sha256_transform(state, buf);

    for (i = 0; i < 8; i++) {
        out[i * 4]     = (uint8_t)(state[i] >> 24);
        out[i * 4 + 1] = (uint8_t)(state[i] >> 16);
        out[i * 4 + 2] = (uint8_t)(state[i] >> 8);
        out[i * 4 + 3] = (uint8_t)(state[i]);
    }
}

void hmac_sha256(const uint8_t *key, uint32_t keyLen,
                 const uint8_t *msg, uint32_t msgLen,
                 uint8_t out[SHA256_DIGEST_LEN])
{
    uint8_t k_ipad[64];
    uint8_t k_opad[64];
    uint8_t tk[SHA256_DIGEST_LEN];
    uint8_t blk[64 + SHA256_DIGEST_LEN];   /* 内/外层缓冲：64 + ≤32 字节 */
    uint32_t i;

    /* 密钥超长先哈希归一化到 32 字节 */
    if (keyLen > 64) {
        sha256(key, keyLen, tk);
        key = tk;
        keyLen = SHA256_DIGEST_LEN;
    }

    for (i = 0; i < 64; i++) {
        uint8_t kb = (i < keyLen) ? key[i] : 0;
        k_ipad[i] = kb ^ 0x36;
        k_opad[i] = kb ^ 0x5c;
    }

    /* 内层：H(k_ipad || msg) */
    for (i = 0; i < 64; i++) blk[i] = k_ipad[i];
    for (i = 0; i < msgLen && i < SHA256_DIGEST_LEN; i++) blk[64 + i] = msg[i];
    sha256(blk, 64 + msgLen, tk);

    /* 外层：H(k_opad || 内层哈希) */
    for (i = 0; i < 64; i++) blk[i] = k_opad[i];
    for (i = 0; i < SHA256_DIGEST_LEN; i++) blk[64 + i] = tk[i];
    sha256(blk, 64 + SHA256_DIGEST_LEN, out);
}

uint8_t sha256_self_test(void)
{
    uint8_t d[SHA256_DIGEST_LEN];
    uint8_t r = 0;

    /* 向量 1: SHA256("abc") */
    static const uint8_t exp_abc[SHA256_DIGEST_LEN] = {
        0xba,0x78,0x16,0xbf,0x8f,0x01,0xcf,0xea,0x41,0x41,0x40,0xde,0x5d,0xae,0x22,0x23,
        0xb0,0x03,0x61,0xa3,0x96,0x17,0x7a,0x9c,0xb4,0x10,0xff,0x61,0xf2,0x00,0x15,0xad
    };
    sha256((const uint8_t *)"abc", 3, d);
    if (tmos_memcmp(d, exp_abc, SHA256_DIGEST_LEN) != 0) r |= 1;

    /* 向量 2: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog") */
    static const uint8_t exp_hmac[SHA256_DIGEST_LEN] = {
        0xf7,0xbc,0x83,0xf4,0x30,0x53,0x84,0x24,0xb1,0x32,0x98,0xe6,0xaa,0x6f,0xb1,0x43,
        0xef,0x4d,0x59,0xa1,0x49,0x46,0x17,0x59,0x97,0x47,0x9d,0xbc,0x2d,0x1a,0x3c,0xd8
    };
    hmac_sha256((const uint8_t *)"key", 4,
                (const uint8_t *)"The quick brown fox jumps over the lazy dog", 43, d);
    if (tmos_memcmp(d, exp_hmac, SHA256_DIGEST_LEN) != 0) r |= 2;

    return r;
}

/******************************** endfile @ crypto_sha256 **********************/
