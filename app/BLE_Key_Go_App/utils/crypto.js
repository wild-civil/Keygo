/********************************** (C) COPYRIGHT *******************************
 * File Name          : crypto.js
 * Author             : KeyGo (App) — 轻量 SHA-256 / HMAC-SHA256（纯 JS 实现）
 * Date               : 2026/07/10
 * Description        : 与 CH582M 固件端 crypto_sha256.c 完全对齐的算法实现。
 *   用于：① 由绑定码 + 序列号派生 bindKey（KDF = SHA256(code||serial)[0:16]）
 *         ② 控制前 challenge-response（HMAC-SHA256(nonce, bindKey)）
 *   纯 JS、无依赖，可在 uni-app（Vue3）运行环境直接使用。
 *******************************************************************************/

/* ── UTF-8 编码（避免依赖 TextEncoder，兼容性更好）── */
function _utf8(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return new Uint8Array(out)
}

function _rotr(x, n) { return (x >>> n) | (x << (32 - n)) }

const _SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

/**
 * SHA-256(bytes) -> Uint8Array(32)
 * @param {Uint8Array} bytes
 */
export function sha256Bytes(bytes) {
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19

  const ml = bytes.length
  const bitLen = ml * 8
  const withOne = ml + 1
  const k = (56 - (withOne % 64) + 64) % 64
  const total = withOne + k + 8
  const msg = new Uint8Array(total)
  msg.set(bytes)
  msg[ml] = 0x80

  const dv = new DataView(msg.buffer)
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false)
  dv.setUint32(total - 4, bitLen >>> 0, false)

  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = _rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = _rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7
    for (let i = 0; i < 64; i++) {
      const S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + _SHA_K[i] + w[i]) | 0
      const S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0
  }

  const out = new Uint8Array(32)
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7]
  for (let i = 0; i < 8; i++) {
    out[i * 4]     = (hs[i] >>> 24) & 0xff
    out[i * 4 + 1] = (hs[i] >>> 16) & 0xff
    out[i * 4 + 2] = (hs[i] >>> 8) & 0xff
    out[i * 4 + 3] = hs[i] & 0xff
  }
  return out
}

/**
 * HMAC-SHA256(keyBytes, msgBytes) -> Uint8Array(32)
 */
export function hmacSha256Bytes(keyBytes, msgBytes) {
  const BLOCK = 64
  let key = keyBytes
  if (key.length > BLOCK) key = sha256Bytes(key)

  const k = new Uint8Array(BLOCK)
  k.set(key)

  const iKey = new Uint8Array(BLOCK)
  const oKey = new Uint8Array(BLOCK)
  for (let i = 0; i < BLOCK; i++) {
    iKey[i] = k[i] ^ 0x36
    oKey[i] = k[i] ^ 0x5c
  }

  const inner = new Uint8Array(BLOCK + msgBytes.length)
  inner.set(iKey)
  inner.set(msgBytes, BLOCK)
  const innerHash = sha256Bytes(inner)

  const outer = new Uint8Array(BLOCK + 32)
  outer.set(oKey)
  outer.set(innerHash, BLOCK)
  return sha256Bytes(outer)
}

/* ── hex 互转 ── */
export function bytesToHex(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
  return s
}

export function hexToBytes(hex) {
  const out = []
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16))
  return new Uint8Array(out)
}

/* ── 便捷封装（返回 hex 字符串）── */
export function sha256Hex(str) {
  return bytesToHex(sha256Bytes(_utf8(str)))
}

export function hmacSha256Hex(msgBytes, keyBytes) {
  return bytesToHex(hmacSha256Bytes(keyBytes, msgBytes))
}

/**
 * 派生 bindKey（与固件端 Bonding_DeriveKey 完全一致）：
 *   bindKey[16] = SHA256( utf8(code) || utf8(serial) )[0:16]
 * @param {string} code    绑定码（如 "123456"）
 * @param {string} serial 设备序列号（FF04 读取的 MAC 十六进制串，大写 12 字符）
 * @returns {Uint8Array(16)}
 */
export function deriveBindKey(code, serial) {
  const c = _utf8(code)
  const s = _utf8(serial)
  const mat = new Uint8Array(c.length + s.length)
  mat.set(c)
  mat.set(s, c.length)
  const full = sha256Bytes(mat)
  return full.slice(0, 16)
}
