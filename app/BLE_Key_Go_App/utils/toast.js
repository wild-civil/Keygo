/**
 * 全局 Toast — 直接用 uni.showToast，稳定可靠
 * icon:'none' 可显示完整文字，避免截断
 */
export const toast = {
  success: (msg) => {
    uni.showToast({ title: msg, icon: 'none', duration: 2500 })
  },
  error: (msg) => {
    uni.showToast({ title: msg, icon: 'none', duration: 3000 })
  },
  info: (msg) => {
    uni.showToast({ title: msg, icon: 'none', duration: 2500 })
  },
}
