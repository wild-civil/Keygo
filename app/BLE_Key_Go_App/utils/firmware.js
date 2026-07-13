/**
 * 固件版本比较工具
 *
 * 关键修复落地版本：3.30.2
 *   - 该版起固件支持「延迟发送回包」（BIND:OK / NONCE / AUTH 回包不再被并发写覆盖、
 *     也不被浅通知队列丢弃），绑定 / 自动 AUTH 会话恢复才能稳定成功。
 *   - 早于 3.30.2 的固件（含 3.30.0 / 3.30.1）绑定时回包易丢失，建议升级。
 *
 * 解析规则：取「主.次.修订」三段整数，忽略 -rc / 预发布后缀。
 *   例："3.32.2" → [3,32,2]；"3.30.4-rc5" → [3,30,4]。
 */

// ★ 支持「延迟发送回包」的最低固件版本（绑定可用的关键修复）
export const MIN_BIND_FRIENDLY_FW = [3, 30, 2]

/** 解析固件版本串为 [major, minor, patch]，失败返回 null */
export function parseFirmwareVersion(v) {
  if (!v || typeof v !== 'string') return null
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

/**
 * 当前固件版本是否 ≥ 指定最低版本（默认 3.30.2）
 * @param {string} v   固件版本串（bleStore.fwVersion）
 * @param {number[]} min 最低版本三元组，默认 MIN_BIND_FRIENDLY_FW
 * @returns {boolean} true=达到/超过最低版本
 */
export function isFirmwareAtLeast(v, min = MIN_BIND_FRIENDLY_FW) {
  const cur = parseFirmwareVersion(v)
  if (!cur) return false
  for (let i = 0; i < 3; i++) {
    if (cur[i] !== min[i]) return cur[i] > min[i]
  }
  return true
}
