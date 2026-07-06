/**
 * ★ v3.23 Phase 3: 地理围栏工具
 *
 * 用于极速模式（Geofence Speed Mode）：
 *   1. 停车时保存 GPS 位置（仅前台获取一次）
 *   2. App 回到前台时计算距离
 *   3. 距离 < 半径 → 触发 BLE 扫描秒连
 *
 * 不依赖后台定位权限，只在前台时获取位置，极致省电。
 *
 * @module geofence
 */

// #ifdef APP-PLUS

const TAG = '[Geofence]'

/** 围栏半径（米），可配置 */
export const GEOFENCE_RADIUS = 100

/** 存储 key */
const STORAGE_KEY = 'geofence_parking_location'

/** GPS 获取超时（秒） */
const GPS_TIMEOUT = 15

// ==================== Haversine 距离计算 ====================

/**
 * 计算两个 GPS 坐标之间的直线距离（米）
 * 使用 Haversine 公式，精度 ~0.5%
 *
 * @param {number} lat1 纬度1
 * @param {number} lng1 经度1
 * @param {number} lat2 纬度2
 * @param {number} lng2 经度2
 * @returns {number} 距离（米）
 */
export function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000 // 地球半径（米）
  const toRad = (deg) => deg * Math.PI / 180

  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return Math.round(R * c)
}

// ==================== GPS 位置获取 ====================

/**
 * 获取当前位置（Promise，超时 15 秒）
 * @returns {Promise<{lat: number, lng: number}|null>}
 */
export function getCurrentPosition() {
  return new Promise((resolve) => {
    let done = false

    uni.getLocation({
      type: 'gcj02',   // 国测局坐标（国内地图一致）
      geocode: false,
      isHighAccuracy: true,  // 使用 GPS 精确定位
      timeout: GPS_TIMEOUT * 1000,
      success: (res) => {
        if (done) return
        done = true
        console.log(`${TAG} ✅ GPS 获取成功: ${res.latitude}, ${res.longitude} (精度 ${res.accuracy}m)`)
        resolve({ lat: res.latitude, lng: res.longitude, accuracy: res.accuracy })
      },
      fail: (err) => {
        if (done) return
        done = true
        console.warn(`${TAG} ❌ GPS 获取失败:`, err?.errMsg || err)
        resolve(null)
      },
      complete: () => {
        if (!done) { done = true; resolve(null) }
      }
    })
  })
}

/**
 * 获取当前位置（低精度，快速，用于粗略检测）
 * @returns {Promise<{lat: number, lng: number}|null>}
 */
export function getCurrentPositionCoarse() {
  return new Promise((resolve) => {
    let done = false
    uni.getLocation({
      type: 'gcj02',
      geocode: false,
      isHighAccuracy: false, // ★ 低功耗模式
      timeout: 5000,          // 5 秒超时
      success: (res) => {
        if (done) return
        done = true
        resolve({ lat: res.latitude, lng: res.longitude })
      },
      fail: () => {
        if (done) return
        done = true
        resolve(null)
      },
      complete: () => {
        if (!done) { done = true; resolve(null) }
      }
    })
  })
}

// ==================== 停车位置持久化 ====================

/**
 * 保存停车位置到本地存储
 * @param {number} lat 纬度
 * @param {number} lng 经度
 */
export function saveParkingLocation(lat, lng) {
  try {
    const data = {
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
      savedAt: Date.now()
    }
    uni.setStorageSync(STORAGE_KEY, JSON.stringify(data))
    console.log(`${TAG} 💾 停车位置已保存: ${data.lat}, ${data.lng}`)
    return data
  } catch (e) {
    console.error(`${TAG} ❌ 保存停车位置失败:`, e)
    return null
  }
}

/**
 * 读取停车位置
 * @returns {{lat: number, lng: number, savedAt: number}|null}
 */
export function getParkingLocation() {
  try {
    const raw = uni.getStorageSync(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (typeof data.lat !== 'number' || typeof data.lng !== 'number') return null
    return data
  } catch (e) {
    return null
  }
}

/**
 * 清除停车位置
 */
export function clearParkingLocation() {
  try {
    uni.removeStorageSync(STORAGE_KEY)
    console.log(`${TAG} 🗑 停车位置已清除`)
  } catch {}
}

// ==================== 地理围栏判断 ====================

/**
 * 检查当前位置是否在围栏半径内
 *
 * @param {number} currentLat 当前纬度
 * @param {number} currentLng 当前经度
 * @returns {{ inside: boolean, distance: number, parking: object|null }}
 */
export function checkGeofence(currentLat, currentLng) {
  const parking = getParkingLocation()
  if (!parking) {
    return { inside: false, distance: -1, parking: null, reason: 'no_parking_location' }
  }

  const distance = calculateDistance(currentLat, currentLng, parking.lat, parking.lng)
  const inside = distance <= GEOFENCE_RADIUS

  console.log(`${TAG} 📍 围栏检测: 距离 ${distance}m (半径 ${GEOFENCE_RADIUS}m) → ${inside ? '✅ 在围栏内' : '❌ 在围栏外'}`)
  return { inside, distance, parking }
}

// #endif
