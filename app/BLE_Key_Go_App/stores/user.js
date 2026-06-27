/**
 * v3.1 用户身份 Store
 *
 * 安全设计（纯本地，零服务器）：
 *   设备绑定密码 = username + ":" + password 的组合
 *   - 攻击者知道手机号但不知道密码 → 猜不出绑定密码
 *   - 本地存的是密码哈希，手机丢了也不会泄露原始密码
 *   - 换手机：输入相同用户名+密码即可恢复
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/**
 * 简单的密码哈希（uni-app 环境没有 crypto API，纯 JS 实现）
 * 目的：防止明文密码存储在本地
 */
function hashPassword(pwd) {
  // DJB2 + 追加扰动
  let h = 5381
  for (let i = 0; i < pwd.length; i++) {
    h = ((h << 5) + h) + pwd.charCodeAt(i)
    h = h >>> 0
  }
  // 转 base36 并加盐
  return 'KG2$' + h.toString(36)
}

export const useUserStore = defineStore('user', () => {
  // ============ State ============
  const username = ref('')        // 用户名（手机/邮箱/昵称）
  const passwordHash = ref('')    // 密码哈希（不存明文）
  const userType = ref('')        // 'phone' | 'email' | 'custom'
  const isLoggedIn = ref(false)
  const createdAt = ref('')

  // ============ Getters ============
  const displayName = computed(() => {
    if (!username.value) return '未登录'
    if (userType.value === 'phone') {
      const u = username.value
      if (u.length >= 11) return u.slice(0, 3) + '****' + u.slice(-4)
    }
    return username.value
  })

  const isPhone = computed(() => userType.value === 'phone')
  const isEmail = computed(() => userType.value === 'email')

  // ============ 初始化 ============
  function init() {
    try {
      const saved = uni.getStorageSync('keygo_user')
      if (saved && saved.username && saved.passwordHash) {
        username.value = saved.username
        passwordHash.value = saved.passwordHash
        userType.value = saved.userType || detectType(saved.username)
        isLoggedIn.value = true
        createdAt.value = saved.createdAt || ''
        console.log('[User] 已恢复登录:', displayName.value)
        return true
      }
    } catch (e) {
      console.warn('[User] 恢复登录失败:', e)
    }
    return false
  }

  // ============ 注册 ============
  function register(name, pwd) {
    const trimmedName = (name || '').trim()
    const trimmedPwd = (pwd || '').trim()

    // 校验用户名
    if (!trimmedName) return { ok: false, error: '用户名不能为空' }
    if (trimmedName.length < 2) return { ok: false, error: '用户名至少 2 个字符' }
    if (trimmedName.length > 36) return { ok: false, error: '用户名最长 36 个字符' }
    if (!/^[\u4e00-\u9fff\w @.+\-]+$/.test(trimmedName)) {
      return { ok: false, error: '用户名包含不允许的特殊字符' }
    }

    const type = detectType(trimmedName)
    if (type === 'phone' && !/^1[3-9]\d{9}$/.test(trimmedName)) {
      return { ok: false, error: '手机号格式不正确' }
    }
    if (type === 'email' && (!trimmedName.includes('@') || !trimmedName.includes('.'))) {
      return { ok: false, error: '邮箱格式不正确' }
    }

    // 校验密码
    if (!trimmedPwd) return { ok: false, error: '密码不能为空' }
    if (trimmedPwd.length < 4) return { ok: false, error: '密码至少 4 个字符' }
    if (trimmedPwd.length > 20) return { ok: false, error: '密码最长 20 个字符' }

    username.value = trimmedName
    passwordHash.value = hashPassword(trimmedPwd)
    userType.value = type
    isLoggedIn.value = true
    createdAt.value = new Date().toISOString()
    saveToStorage()

    console.log('[User] 注册成功:', displayName.value)
    return { ok: true }
  }

  // ============ 登录（换手机时验证密码） ============
  function login(name, pwd) {
    const trimmedName = (name || '').trim()
    const trimmedPwd = (pwd || '').trim()

    if (!trimmedName || !trimmedPwd) {
      return { ok: false, error: '用户名和密码不能为空' }
    }

    // 如果本地已有用户，直接校验
    if (username.value && passwordHash.value) {
      if (trimmedName !== username.value) {
        return { ok: false, error: '用户名与当前账号不匹配' }
      }
      if (hashPassword(trimmedPwd) !== passwordHash.value) {
        return { ok: false, error: '密码错误' }
      }
      isLoggedIn.value = true
      return { ok: true }
    }

    // 本地无数据（换手机）→ 直接注册为新账号
    // 设备端会校验绑定密码是否匹配
    return register(name, pwd)
  }

  // ============ 获取绑定密码（用户名+密码组合，发给设备） ============
  function getBindKey(pwd) {
    if (!username.value) return ''
    // 绑定密码 = 用户名 + 分隔符 + 密码
    // 设备端做完整字符串匹配，攻击者不知道密码就猜不出
    return username.value + ':' + (pwd || '').trim()
  }

  // ============ 验证密码（本地，不连设备） ============
  function verifyPassword(pwd) {
    if (!passwordHash.value) return false
    return hashPassword((pwd || '').trim()) === passwordHash.value
  }

  // ============ 登出 ============
  function logout() {
    username.value = ''
    passwordHash.value = ''
    userType.value = ''
    isLoggedIn.value = false
    createdAt.value = ''
    try { uni.removeStorageSync('keygo_user') } catch {}
    console.log('[User] 已登出')
  }

  // ============ 工具 ============
  function detectType(name) {
    if (/^1[3-9]\d{9}$/.test(name)) return 'phone'
    if (/^[\w.\-+]+@[\w.\-]+\.[\w]+$/.test(name)) return 'email'
    return 'custom'
  }

  function saveToStorage() {
    try {
      uni.setStorageSync('keygo_user', {
        username: username.value,
        passwordHash: passwordHash.value,
        userType: userType.value,
        createdAt: createdAt.value
      })
    } catch (e) {
      console.warn('[User] 存储失败:', e)
    }
  }

  return {
    // state
    username, passwordHash, userType, isLoggedIn, createdAt,
    // getters
    displayName, isPhone, isEmail,
    // actions
    init, register, login, getBindKey, verifyPassword, logout
  }
})
