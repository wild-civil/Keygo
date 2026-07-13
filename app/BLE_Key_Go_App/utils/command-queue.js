/**
 * GATT 写串行队列 + 冲突检测
 *
 * v3.27-fix ②: GATT 写串行锁（模块级单例）
 *   所有写特征值操作（手动命令 / 配置下发）都经由本 Promise 链排队，保证
 *   「上一条 write 的 onCharacteristicWrite 回调真正落地后，再发下一条」。
 *   这是从源头消除 Android BLE GATT_BUSY(status 11) / write failed 的关键：
 *   此前 _cmdBusy(守护手动命令) 与 _configWriteBusy(守护配置下发) 互不协调，
 *   可能并发抢同一 GATT 通道，导致后发的写被系统/固件拒掉，误报「发送失败」。
 */

let _writeChain = Promise.resolve()

/**
 * 将 writeFn 排入模块级写队列，保证「上一条落地后再发下一条」。
 * @param {() => Promise<any>} writeFn 写操作函数
 * @returns {Promise<any>} 本次写的结果（出错会 reject，但不阻断后续排队）
 */
export function enqueueWrite(writeFn) {
  // 无论上一条写成功或失败，都接着执行下一条（不把错误传进链里阻断后续排队）
  const run = _writeChain.then(() => writeFn(), () => writeFn())
  _writeChain = run.then(() => {}, () => {})  // 吞掉异常，避免 unhandled rejection
  return run
}

/**
 * v3.27-fix ①: 判定是否为 GATT 瞬时写冲突（连接其实未断，仅本次写被拒）
 *
 *   涵盖 Android 常见表现：GATT_BUSY(status 11)、系统 errCode 10008、以及
 *   含 'write fail' / 'already' / 'busy' / 'gatt' 字样的 errMsg。
 *   这类不该提示「检查连接」，而应提示「指令冲突，请重试」。
 *
 *   注意：明确是连接断开(not connected / disconnect / closed)的，不算瞬时冲突，
 *   保持 FAIL「发送失败，请检查连接」以如实反映连接问题。
 *
 * @param {Error|object} err
 * @returns {boolean} true=瞬时 GATT 冲突，false=真实错误(含断连)
 */
export function isGattConflict(err) {
  const msg = (err && (err.errMsg || err.message || String(err) || '')).toLowerCase()
  if (/not connected|disconnect|connection.*closed|closed/.test(msg)) return false
  return /gatt\s*busy|status\s*11|10008|write\s*fail|already|busy|gatt/.test(msg)
}
