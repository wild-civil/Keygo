/**
 * ★ ②: 绑定层模块级状态（从 ble.js 拆出的可变命名空间对象）
 *
 *   使用 B.xxx 可变对象模式（非 ES module export let，避免只读导入限制）。
 *   ble.js 中所有原 _bindKey / _sessionSalt / _cmdSeq 等引用统一改为 B._bindKey 等。
 *
 *   注意：这些变量是非响应式的——Pinia 的响应式状态在 store state 里（isBound/sessionAuthed 等）。
 */

export const B = {
  /** ★ v3.36(2026-07-17): 本机持有的 phoneKey（Uint8Array(16)）= HMAC-SHA256(gk, phoneId)[0:16]，
   *   本地持久化于 uni storage（按序列号）。语义由旧版「gk 组密钥」升级为「per-phone 密钥」，
   *   变量名沿用 _bindKey 以最小化改动面（AUTH/C1 签名逻辑不变，只是密钥来源变 per-phone）。 */
  _bindKey: null,

  /** ★ v3.36: 本机稳定身份 phoneId 缓存 { hex:'16字符', bytes:Uint8Array(8) }。
   *   懒生成 + 持久化于 uni storage key `keygo_phone_id`（见 ble.js _getPhoneId）。 */
  _phoneId: null,

  /** 绑定进行中标志——防止连接时自动 ensureSession 的并发 AUTH 干扰 BIND 流程 */
  _bindInProgress: false,

  /** ★ 自动 AUTH（重连恢复会话）进行中标志——防止 _maybeAutoAuth 被多路径并发触发导致重复 NONCE */
  _autoAuthRunning: false,

  /** ★ P0-2: C1 命令签名会话态（每连接） */
  _sessionSalt: null,   // 当前会话盐（AUTH/BIND 握手 nonce 的 hex），C1 命令签名用
  _cmdSeq: 0,           // 当前连接 C1 命令序号（防重放），每连接递增
  _lastNonce: null,     // 最近一次 NONCE 请求的 hex，AUTH:OK 时作为会话盐来源

  /** 绑定指令的异步等待器（NONCE/AUTH/BIND/UNBIND/SETCODE 的回应经 FF02 通知解析后 resolve） */
  _bindWaiters: { NONCE: null, AUTH: null, BIND: null, UNBIND: null, SETCODE: null },

  /**
   * ★ 命令回包等待器：控制命令（UNLOCK/LOCK/TRUNK 等）发出后，等待固件经 FF02 回的
   *   CMD:FAIL:* / DENY:NOT_BOUND / DENY:AUTH_REQ:*（成功固件只刷 status，不发 CMD:OK）。
   *   收到失败回包 → 回调 (errObj)；超时窗口内无失败 → 视为成功（回调 undefined）。
   */
  _cmdWaiter: null,


  /** 记录 BIND 流程中固件最后回包原文，便于失败时给出确切原因 */
  _lastBindRaw: '',

  /**
   * ★ 本次 BIND 是否为「未绑定→已绑定」的跃迁。
   *   仅在此跃迁下，才允许 status.bn=1 兜底确认 BIND 成功（应对旧固件 BIND:OK 被浅通知队列丢弃）。
   *   设备本就绑定时，status.bn=1 只反映既有状态，不能证明「本次用某特定码验证成功」。
   */
  _bindConfirmByStatus: false,

  /** ★ 绑定/解绑互斥锁 */
  _bindMutex: Promise.resolve(),

  /**
   * ★ 2026-07-14 修复「刚绑定显示『无法验证』又自愈」：
   *   自动 AUTH（_maybeAutoAuth）与绑定 AUTH 兜底（_authWithKey）都各自发 NONCE→AUTH，
   *   而 NONCE/AUTH waiter 是单槽的（后注册覆盖先注册）。两路并发会互相覆盖 waiter →
   *   一条收不到 NONCE/对已被消费的 nonce 回 AUTH → 固件回 AUTH:FAIL → 假「验证失败」。
   *   本锁确保同时刻只有一个 NONCE→AUTH 流程在跑，彻底消除串扰（绑定成功后会复位状态自愈）。
   */
  _authMutex: Promise.resolve(),
}

/** 注册等待某类绑定义务回包（NONCE/AUTH/BIND/UNBIND/SETCODE） */
export function _waitFor(type) {
  return new Promise((resolve) => { B._bindWaiters[type] = resolve })
}

/** 解析绑定义务回包，通知等待方 */
export function _resolveWaiter(type, val) {
  const r = B._bindWaiters[type]
  B._bindWaiters[type] = null
  if (r) r(val)
}

/** 获取绑定/解绑互斥锁 */
export function _acquireBindLock() {
  let _rel
  const _prev = B._bindMutex
  B._bindMutex = new Promise(r => { _rel = r })
  return _prev.then(() => _rel)
}

/** ★ 2026-07-14: 获取 AUTH 握手互斥锁（与 _acquireBindLock 顺序无关，避免死锁：绑定先拿 bind 锁再拿 auth 锁，自动 AUTH 只拿 auth 锁） */
export function _acquireAuthLock() {
  let _rel
  const _prev = B._authMutex
  B._authMutex = new Promise(r => { _rel = r })
  return _prev.then(() => _rel)
}

/** ★ 2026-07-19: 断连标记——waiter 被 resolve 为此值即表示连接已断开 */
export const BIND_DISCONNECTED = Symbol('BIND_DISCONNECTED')

/**
 * ★ 2026-07-19: 断连时 flush 所有绑定义务 waiter，让 bindDevice/_authWithKey 快速失败。
 *   否则 _handleDisconnect 不会 resolve 任何 waiter，导致 bindDevice 里的 _waitBind(2500)
 *   和 _requestNonce(4000) 都要硬等到超时，合计浪费 ~6.5s 才报错。
 *
 *   @param {boolean} connected 当前连接状态（false=断连，调用方传入 this.connected）
 */
export function _flushBindWaiters(connected) {
  const sentinel = connected ? undefined : BIND_DISCONNECTED
  // 所有注册过的绑定 waiter 类型
  for (const type of ['NONCE', 'AUTH', 'BIND', 'UNBIND', 'SETCODE']) {
    const r = B._bindWaiters[type]
    if (r) {
      if (!connected) {
        // 断开：resolve 为 BIND_DISCONNECTED 标记
        r(BIND_DISCONNECTED)
      }
      // ★ connected=true 时不 resolve（由上层自行处理），仅清空
      B._bindWaiters[type] = null
    }
  }
}

/** 等待 BIND:OK，超时(ms)返回 false 但不阻塞后续兜底 */
export function _waitBind(ms) {
  return new Promise((resolve) => {
    let done = false
    const t = setTimeout(() => {
      if (!done) { done = true; resolve(false) }
    }, ms)
    _waitFor('BIND').then((v) => {
      if (!done) { done = true; clearTimeout(t); resolve(v === true) }
    })
  })
}
