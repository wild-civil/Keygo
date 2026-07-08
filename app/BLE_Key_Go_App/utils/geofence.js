/**
 * ★ v3.23 Phase 3: 地理围栏工具（v2 — 真后台 GPS 监控）
 *
 * 用于极速模式（Geofence Speed Mode）：
 *   1. 停车时保存 GPS 位置
 *   2. 启动 plus.geolocation.watchPosition() 后台低功耗 GPS 监控
 *   3. 进入 100m 围栏 → 回调触发 BLE 扫描 → 走到车边就已连好
 *
 * GPS 策略：
 *   - enableHighAccuracy: false → 网络/基站定位为主 (~15mAh/天)
 *   - maximumAge: 15s → 平衡缓存复用与响应速度（v3.25.1 优化）
 *   - provider: 'system' → 系统自动选择最优定位源
 *
 * 生命周期：
 *   speed 模式 + 未连接 → startGeofenceMonitor(onEnter)
 *   BLE 连接成功 → stopGeofenceMonitor()
 *   退出 speed 模式 → stopGeofenceMonitor()
 *
 * @module geofence
 */

// #ifdef APP-PLUS

const TAG = '[Geofence]'

/** 围栏半径（米），可配置 */
export const GEOFENCE_RADIUS = 100

/**
 * ★ v3.25-fix: 围栏触发 BLE 重连后的「防抖闩锁」超时（毫秒）。
 * 之前 _geofenceBleTriggered 是永久闩锁：一旦在围栏内触发过重连，
 * 只要不走出围栏就永远不再重试（心跳被拦截），导致「通知在、连不上」的死锁。
 * 改为带超时的防抖：触发后保留 LATCH_MS 防止同一进入事件被重复点火，
 * 超时后自动解锁，让后续心跳能继续重试重连。
 */
export const GEOFENCE_BLE_LATCH_MS = 20000

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
      type: 'wgs84',   // WGS-84 全球通用坐标（部分设备不支持 gcj02）
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
      type: 'wgs84',
      geocode: false,
      isHighAccuracy: false, // ★ 低功耗模式
      timeout: 5000,          // 5 秒超时
      success: (res) => {
        if (done) return
        done = true
        // ★ v3.25.2: 补上 accuracy 字段，供 saveParkingLocation 记录
        resolve({ lat: res.latitude, lng: res.longitude, accuracy: res.accuracy })
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
 *
 * ★ v3.25.2: 新增 accuracy 字段，记录该次 GPS 定位的精度（1σ 半径，米）。
 *   - 用途：将来可据此过滤低精度停车记录（如 accuracy > 100m 时警告用户）
 *   - 不影响现有逻辑：旧数据无 accuracy 字段，读取时返回 undefined（兼容）
 *   - 不传 accuracy → 保存 -1 表示"精度未知"（如 getCurrentPositionCoarse 无精度时）
 *
 * @param {number} lat 纬度
 * @param {number} lng 经度
 * @param {number} [accuracy] GPS 精度（1σ 半径，米），可选。不传则记为 -1
 */
export function saveParkingLocation(lat, lng, accuracy) {
  try {
    // ★ toFixed(6): WGS-84 坐标精度分析
    //   1° 纬度 ≈ 111.32 km
    //   toFixed(6) → 0.000001° → ~0.11m (11 厘米)
    //   toFixed(5) → 0.00001°  → ~1.1m
    //   toFixed(4) → 0.0001°   → ~11m
    //
    // 选用 6 位小数：比民用 GPS 精度（±5-50m）高出 2 个数量级，
    // 确保 WGS-84↔GCJ-02 转换时不会因精度截断引入额外误差。
    // 虽然 GPS 芯片本身只输出 float32（~6-7 位有效数字），但
    // 保留全精度有利无害。
    const data = {
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
      savedAt: Date.now(),
      // accuracy: undefined/null/负数 → 统一记 -1（精度未知），有效值取整
      accuracy: (accuracy != null && !isNaN(accuracy) && accuracy >= 0) ? Math.round(accuracy) : -1,
    }
    uni.setStorageSync(STORAGE_KEY, JSON.stringify(data))
    const accStr = data.accuracy >= 0 ? `, 精度 ±${data.accuracy}m` : ''
    console.log(`${TAG} 💾 停车位置已保存: ${data.lat}, ${data.lng}${accStr}`)
    return data
  } catch (e) {
    console.error(`${TAG} ❌ 保存停车位置失败:`, e)
    return null
  }
}

/**
 * 读取停车位置
 * @returns {{lat: number, lng: number, savedAt: number, accuracy: number}|null}
 *   accuracy: GPS 精度（1σ 半径，米），-1=未知（旧数据/粗精度定位无精度），>=0 为有效值
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

// ==================== ★ v3.23.1: 后台 GPS 围栏监控 ====================

/** watchPosition 句柄，null = 未运行 */
let _watchId = null

/** 当前围栏状态：是否在围栏内（防重复触发） */
let _isInside = false

/** 进入围栏回调 */
let _onEnterCallback = null

/** 离开围栏回调 */
let _onLeaveCallback = null

/** 位置更新回调（每次 watchPosition 回调都触发，用于实时距离显示等） */
let _onPositionCallback = null

/** 最后收到 GPS 位置的时间戳（用于诊断） */
let _lastPositionTime = 0

/** ★ v3.25: watchPosition 回调中持续更新的最近一次有效坐标 */
let _lastKnownPosition = null

/**
 * 启动后台 GPS 围栏监控
 *
 * 使用 plus.geolocation.watchPosition() 实现低功耗后台持续定位。
 * 每次收到位置更新时计算到停车点的距离，进出围栏时触发回调。
 *
 * 注意：
 *   - 需要前台服务保活，否则后台 GPS 可能被系统暂停
 *   - 荣耀/Huawei 设备无 GMS 也可使用（不依赖 Google Location API）
 *   - GPS 关闭时 watchPosition 仍返回网络定位（精度 ~50-200m）
 *
 * @param {Function} onEnter  进入围栏回调 (distance: number) => void
 * @param {Function} onLeave  离开围栏回调 (distance: number) => void（可选）
 * @param {Function} onPosition 位置更新回调 ({distance, latitude, longitude, accuracy, parking}) => void（可选）
 * @returns {boolean} 是否成功启动
 */
export function startGeofenceMonitor(onEnter, onLeave, onPosition) {
  const parking = getParkingLocation()
  if (!parking) {
    console.warn(`${TAG} ⚠ 无法启动监控：无停车位置`)
    return false
  }

  if (_watchId !== null) {
    console.log(`${TAG} ℹ Geofence 监控已在运行，跳过 (watchId=${_watchId})`)
    // ★ v3.25: 即使已运行，也更新回调（支持调用方动态更新）
    if (onPosition) _onPositionCallback = onPosition
    return true
  }

  _onEnterCallback = onEnter || null
  _onLeaveCallback = onLeave || null
  _onPositionCallback = onPosition || null
  _isInside = false
  _lastPositionTime = 0

  try {
    _watchId = plus.geolocation.watchPosition(
      (position) => {
        _lastPositionTime = Date.now()
        const coords = position.coords
        if (!coords || typeof coords.latitude !== 'number') return

        const distance = calculateDistance(
          coords.latitude, coords.longitude,
          parking.lat, parking.lng
        )

        // ★ v3.25: 持续更新最近已知坐标（供 getLastKnownPosition 读取）
        _lastKnownPosition = {
          lat: coords.latitude,
          lng: coords.longitude,
          accuracy: coords.accuracy != null ? coords.accuracy : 999,
          time: _lastPositionTime,
        }

        // ★ v3.25: 通知位置更新（供实时距离显示）
        if (_onPositionCallback) {
          try {
            _onPositionCallback({
              distance,
              latitude: coords.latitude,
              longitude: coords.longitude,
              accuracy: coords.accuracy != null ? coords.accuracy : 999,
              parking,
            })
          } catch (e) {
            console.error(`${TAG} ❌ onPosition 回调异常:`, e?.message || e)
          }
        }

        // 精度信息（用于日志）
        const acc = coords.accuracy != null ? `±${Math.round(coords.accuracy)}m` : '?'

        if (distance <= GEOFENCE_RADIUS && !_isInside) {
          // ★ 进入围栏
          _isInside = true
          console.log(`${TAG} 📍 🟢 进入围栏！距停车点 ${distance}m (${acc})`)
          if (_onEnterCallback) {
            try { _onEnterCallback(distance) } catch (e) {
              console.error(`${TAG} ❌ onEnter 回调异常:`, e?.message || e)
            }
          }
        } else if (distance > GEOFENCE_RADIUS && _isInside) {
          // ★ 离开围栏
          _isInside = false
          console.log(`${TAG} 📍 🔴 离开围栏，距停车点 ${distance}m (${acc})`)
          if (_onLeaveCallback) {
            try { _onLeaveCallback(distance) } catch (e) {
              console.error(`${TAG} ❌ onLeave 回调异常:`, e?.message || e)
            }
          }
        }
        // 仍在同状态 → 静默（不发日志，避免刷屏）
      },
      (err) => {
        // GPS 错误（定位服务关闭、权限被拒等）
        const code = err?.code
        const msg = err?.message || err?.errMsg || ''
        if (code === 1) {
          // PERMISSION_DENIED — 只打一次
          console.warn(`${TAG} ⚠ GPS 权限被拒绝`)
        } else if (code === 2) {
          // POSITION_UNAVAILABLE — 正常（室内/地下停车场）
          // 不打印，等 GPS 恢复
        } else if (code === 3) {
          // TIMEOUT — 可能 GPS 信号弱
          console.warn(`${TAG} ⚠ GPS 超时`)
        } else {
          console.warn(`${TAG} ⚠ watchPosition 错误 (${code}): ${msg}`)
        }
      },
      {
        enableHighAccuracy: false,   // ★ 低功耗：网络/基站定位为主
        timeout: 30000,              // 30 秒超时
        maximumAge: 15000,           // ★ v3.25.1: 60s → 15s 缓存（更快响应围栏变化）
        provider: 'system',          // 系统自动选择（network → gps）
        coordsType: 'wgs84',         // WGS-84 全球通用（兼容性最好）
      }
    )

    console.log(`${TAG} ✅ 后台 Geofence 监控已启动 (watchId=${_watchId})`)
    console.log(`${TAG}    停车点: ${parking.lat.toFixed(6)}, ${parking.lng.toFixed(6)}`)
    console.log(`${TAG}    围栏半径: ${GEOFENCE_RADIUS}m`)
    console.log(`${TAG}    GPS 模式: network(低功耗), 超时30s, 缓存15s`)
    return true
  } catch (e) {
    console.error(`${TAG} ❌ watchPosition 启动失败:`, e?.message || e)
    _watchId = null
    return false
  }
}

/**
 * 停止后台 GPS 围栏监控
 */
export function stopGeofenceMonitor() {
  if (_watchId === null) return
  try {
    plus.geolocation.clearWatch(_watchId)
    console.log(`${TAG} 🛑 后台 Geofence 监控已停止 (watchId=${_watchId})`)
  } catch (e) {
    console.warn(`${TAG} ⚠ clearWatch 失败:`, e?.message || e)
  }
  _watchId = null
  _isInside = false
  _onEnterCallback = null
  _onLeaveCallback = null
  _onPositionCallback = null
  _lastKnownPosition = null    // ★ v3.25: 清理缓存坐标
}

/**
 * 查询监控是否正在运行
 * @returns {boolean}
 */
export function isGeofenceMonitorActive() {
  return _watchId !== null
}

/**
 * 获取监控诊断信息
 * @returns {{ active: boolean, watchId: number|null, isInside: boolean, lastPositionAge: number }}
 */
export function getGeofenceMonitorStatus() {
  return {
    active: _watchId !== null,
    watchId: _watchId,
    isInside: _isInside,
    lastPositionAge: _lastPositionTime ? Date.now() - _lastPositionTime : -1,
  }
}

/**
 * ★ v3.24: 获取 watchPosition 缓存的最近一次有效坐标（同步，零延迟）
 *
 * 用于断连时立刻读取最近 GPS 位置，无需等待异步 GPS 请求。
 * 
 * 优先级链：
 *   Priority 1: 此缓存（watchPosition 回调中持续更新，通常 <60s 内）
 *   Priority 2: uni.getLocation({ maximumAge: INFINITY })（系统级缓存）
 *   Priority 3: localStorage 旧停车位置（兜底）
 *
 * @returns {{ lat: number, lng: number, accuracy: number, time: number, age: number } | null}
 *   age: 该位置距今多少毫秒，方便调用方判断新鲜度
 */
export function getLastKnownPosition() {
  if (!_lastKnownPosition) return null
  return {
    lat: _lastKnownPosition.lat,
    lng: _lastKnownPosition.lng,
    accuracy: _lastKnownPosition.accuracy,
    time: _lastKnownPosition.time,
    age: Date.now() - _lastKnownPosition.time,
  }
}

/**
 * ★ v3.25: 获取当前到停车点的估算距离（同步，基于 watchPosition 缓存）
 *
 * 不发起异步 GPS 请求，直接使用 watchPosition 的缓存坐标，适合 UI 实时刷新。
 * 
 * @returns {{ distance: number, parking: object|null, source: string, age: number }|null}
 *   distance: 距离（米），-1=无数据
 *   parking: 停车位置信息，null=无停车位置
 *   source: 数据来源 'watch_position'/'parking_only'
 *   age: 坐标距今毫秒数，-1=无定位数据
 */
export function getDistanceToParking() {
  const parking = getParkingLocation()
  if (!parking) return null

  const pos = getLastKnownPosition()
  if (pos) {
    return {
      distance: calculateDistance(pos.lat, pos.lng, parking.lat, parking.lng),
      parking,
      source: 'watch_position',
      age: pos.age,
    }
  }

  // 有停车位置但无实时坐标 → 无法计算距离
  return {
    distance: -1,
    parking,
    source: 'parking_only',
    age: -1,
  }
}

// #endif
