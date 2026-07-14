/**
 * 用户可读错误文案集中管理
 *
 * ble.js 中所有 throw 的 e.code 与 UI 层的用户提示集中于此。
 * 避免硬编码散落在 store 和 vue 之间的不一致。
 */

/** 错误码 → 用户可读文案 */
export const ERROR_MSGS = {
  /** 未连接设备 */
  NO_CONN:       '未连接，请先连接设备',
  /** 操作过于频繁 */
  TOO_FAST:      '操作太频繁，请稍候',
  /** GATT 瞬时写冲突 */
  CONFLICT:      '指令冲突，请重试',
  /** 设备未绑定 */
  NOT_BOUND:     '设备未绑定，请先使用「绑定」功能设置绑定码',
  /** 设备验证失败 */
  AUTH_FAIL:     '设备验证失败，请重新绑定',
  /** 无法读取序列号 */
  NO_SERIAL:     '无法读取序列号',
  /** 缺少签名盐 */
  NO_SALT:       '会话未就绪，请重新验证绑定',
  /** 控制命令被固件拒绝（签名校验失败） */
  CMD_FAIL:      '指令校验失败，请重新连接设备',
  /** 控制命令缺少 C1 签名（会话盐失效） */
  NO_SIG:        '设备验证已失效，请重新连接',
  /** 控制命令触发会话重认证握手（本次未执行，需重试） */
  AUTH_REQ:      '设备验证中，请稍候再试',
  /** 通用发送失败 */
  FAIL:          '发送失败，请检查连接',
  /** 绑定失败 */
  BIND_FAIL:     '绑定失败，请确认绑定码或重试',
  /** 需要系统配对 */
  PAIR_REQUIRED: '请先在系统蓝牙中完成配对',
  /** 模式切换失败 */
  MODE_SET_FAIL: '模式切换失败，请重试',
  /** 当前模式不支持该操作 */
  NOT_SUPPORTED: '当前模式不支持该操作',
}

/**
 * 根据错误码获取用户可读文案（UI 层使用）。
 * @param {Error|{code?: string}} err
 * @returns {string} 用户可见的提示文案
 */
export function cmdErrorMsg(err) {
  const code = err && err.code
  if (code && ERROR_MSGS[code]) return ERROR_MSGS[code]
  return ERROR_MSGS.FAIL
}

/**
 * 创建一个带错误码的 Error 对象（ble.js 层使用，统一格式）。
 * @param {string} code    错误码（ERROR_MSGS 的 key）
 * @param {string} [msg]   可选覆盖消息（不提供则从 ERROR_MSGS 取值）
 * @param {Error}  [cause] 可选原始错误
 * @returns {Error}
 */
export function throwError(code, msg, cause) {
  const e = new Error(msg || ERROR_MSGS[code] || code)
  e.code = code
  if (cause) e.cause = cause
  throw e
}
