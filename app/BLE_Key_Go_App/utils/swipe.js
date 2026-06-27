/**
 * 滑动手势切换 tab 工具（v3.2）
 *
 * 用法：
 *   1. 根 view 加 @touchstart="swipeStart" @touchend="onSwipeEnd"
 *   2. script 里：const onSwipeEnd = useSwipeTab('/pages/index/index')
 */

// tab 列表顺序（必须与 pages.json 的 tabBar.list 一致）
const TAB_LIST = [
  { path: '/pages/index/index',   name: '连接' },
  { path: '/pages/control/control', name: '控制' },
  { path: '/pages/config/config',   name: '配置' },
  { path: '/pages/login/login',     name: '帮助' },
]

let _startX = 0
let _startY = 0

/**
 * 记录触摸起点 → 绑定到根元素的 @touchstart
 */
export function swipeStart(e) {
  const touch = e.touches[0]
  if (touch) {
    _startX = touch.clientX
    _startY = touch.clientY
  }
}

/**
 * 创建一个 touchend 处理器，根据当前页面自动判断左滑/右滑跳到哪个 tab
 * @param {string} currentPath 当前页面路径（如 '/pages/index/index'）
 * @param {number} threshold 最小滑动距离，默认 80px
 * @returns {Function} 可直接绑定到 @touchend 的函数
 */
export function useSwipeTab(currentPath, threshold = 80) {
  const idx = TAB_LIST.findIndex(t => t.path === currentPath)
  const prevTab = idx > 0 ? TAB_LIST[idx - 1] : null
  const nextTab = idx < TAB_LIST.length - 1 ? TAB_LIST[idx + 1] : null

  return (e) => {
    const touch = e.changedTouches[0]
    if (!touch) return
    const dx = touch.clientX - _startX
    const dy = touch.clientY - _startY
    if (Math.abs(dx) < threshold) return
    if (Math.abs(dx) < Math.abs(dy)) return  // 纵向滑动忽略

    if (dx > 0 && prevTab) {
      uni.switchTab({ url: prevTab.path })
    } else if (dx < 0 && nextTab) {
      uni.switchTab({ url: nextTab.path })
    }
  }
}
