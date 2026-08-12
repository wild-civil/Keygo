/**
 * GATT 事务串行队列 + 冲突检测
 *
 * v3.27-fix ②: GATT 写串行锁（模块级单例）
 *   所有写特征值操作（手动命令 / 配置下发）都经由本 Promise 链排队，保证
 *   「上一条 write 的 onCharacteristicWrite 回调真正落地后，再发下一条」。
 *   这是从源头消除 Android BLE GATT_BUSY(status 11) / write failed 的关键：
 *   此前 _cmdBusy(守护手动命令) 与 _configWriteBusy(守护配置下发) 互不协调，
 *   可能并发抢同一 GATT 通道，导致后发的写被系统/固件拒掉，误报「发送失败」。
 *
 * ★ 2026-08-13 第七刀（决定性根因修正）: 队列从「写队列」升级为「GATT 事务队列」。
 *   【真相】Android BluetoothGatt 同一时刻只允许 **一个** 未完成的 GATT 事务
 *   （read / write / descriptor 三者共用同一个事务槽）。若前一个操作尚在飞行中，
 *   后一个 writeCharacteristic()/readCharacteristic() 会被框架直接拒绝返回 false，
 *   而 uni-app / 微信 BLE 适配层把这种「提交被拒」统一映射成
 *   **errCode 10007 `property not support`** —— 这个错误码名字极具误导性，
 *   它根本不是在说「该特征没有 WRITE/READ 属性」，而是「通道忙，没排上队」。
 *
 *   【踩坑史】此前 2026-08-12 ~ 08-13 连做六刀（NONCE 提前 300ms、FF02 首帧加速、
 *   500ms→1000ms 保底、AUTH:OK 后 120ms 短延时…）全部建立在
 *   「10007 = GATT 属性缓存没刷新，等一会儿就热了」这个 **错误前提** 上，
 *   所以只能靠"错开时间窗"碰运气 → 表现为「时快时慢」两极分化。
 *   实测日志铁证：每一次 10007 都精确落在一次电池 GATT read 的飞行窗口内；
 *   电池读一结束，下一次写立刻成功。根因是并发，不是缓存。
 *
 *   【修复】读操作（如电池电量 readBatteryLevel）此前**完全绕过队列**直接调
 *   uni.readBLECharacteristicValue，与配置下发的 FF01/FF03 写并发抢同一事务槽。
 *   现新增 enqueueRead()，与 enqueueWrite() **共用同一条链** _gattChain，
 *   从此读写永不并发，10007 从源头消失。
 */

let _gattChain = Promise.resolve()

/**
 * 将一个 GATT 事务排入模块级串行队列，保证「上一条落地后再发下一条」。
 *
 * ★ 读、写共用同一条链——因为 Android 的 GATT 事务槽是读写共享的，
 *   只串行化写而放任读并发，等于没串行。
 *
 * @param {() => Promise<any>} fn GATT 操作函数（read 或 write）
 * @returns {Promise<any>} 本次操作的结果（出错会 reject，但不阻断后续排队）
 */
function _enqueueGatt(fn) {
  // 无论上一条成功或失败，都接着执行下一条（不把错误传进链里阻断后续排队）
  const run = _gattChain.then(() => fn(), () => fn())
  _gattChain = run.then(() => {}, () => {})  // 吞掉异常，避免 unhandled rejection
  return run
}

/**
 * 将 writeFn 排入 GATT 事务队列。
 * @param {() => Promise<any>} writeFn 写操作函数
 * @returns {Promise<any>}
 */
export function enqueueWrite(writeFn) {
  return _enqueueGatt(writeFn)
}

/**
 * ★ 2026-08-13 第七刀: 将 readFn 排入 **同一条** GATT 事务队列。
 *   用于电池电量等 GATT Read，避免与 FF01/FF03 写并发导致 10007。
 * @param {() => Promise<any>} readFn 读操作函数
 * @returns {Promise<any>}
 */
export function enqueueRead(readFn) {
  return _enqueueGatt(readFn)
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
