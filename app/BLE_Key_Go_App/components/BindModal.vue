<template>
  <!-- ★ 绑定弹窗：position:fixed 全屏覆盖层，脱离 main.vue 的 swiper/scroll-view 文档流。
       与 index.vue 的 PIN 弹窗同机制（fixed + 高 z-index）。
       字段用 webview <input>（与 index.vue 自定义名称同源）。用户在自定义基座上实测 <input> 键盘可用，
       故恢复为 <input> 直输，不弹系统原生框。 -->
  <view v-if="visible" class="bind-overlay" @tap.stop>
    <view class="bind-dialog" @tap.stop>
      <view class="bind-head">
        <text class="bind-title">🔐 设备绑定</text>
        <text class="bind-close" @tap="close">✕</text>
      </view>

      <!-- ★ 固件版本徽标：判定逻辑已更新为「≥3.30.2 即含延迟发送回包修复，可绑定」 -->
      <view class="fw-badge" :class="fwBadge.cls">
        <text class="fw-badge-ver">固件版本：{{ bleStore.fwVersion || '未知' }}</text>
        <text class="fw-badge-tip">{{ fwBadge.text }}</text>
      </view>

      <view class="bind-status" :class="bindStatusClass">
        <text class="bind-dot">●</text>
        <text class="bind-text">{{ bindStatusText }}</text>
      </view>

      <!-- ★ 诊断区：真机验证用（版本状态 / 绑定态 / 验证态 / 最近回包）。始终可见。 -->
      <view class="diag">
        <text class="diag-row">绑定态：{{ bleStore.isBound ? '已持有密钥' : '未绑定' }} | 设备端：{{ bleStore.deviceBound ? '已绑' : '未绑' }}</text>
        <text class="diag-row">本连接验证：{{ bleStore.sessionAuthed ? '已通过 AUTH' : (bleStore._autoAuthState === 'running' ? '自动验证中…' : (bleStore._autoAuthState === 'failed' ? '失败·需手动验证' : '待验证')) }}</text>
        <text class="diag-row diag-result" v-if="bleStore.bindHint">最近结果：{{ bleStore.bindHint }}</text>
      </view>


      <!-- 设备无 owner（全新 / 已恢复出厂）：首绑，仅允许默认码（安全：堵住未绑定窗口抢绑） -->
      <block v-if="!showBoundMode">
        <text class="bind-desc">⚠ 设备处于「未绑定」状态。出于安全，首次绑定必须使用<text class="hl">当前有效绑定码</text>（全新/恢复出厂设备为默认码 123456，贴于机身/说明书）。注意：若设备此前只是「解绑本机」而未「恢复出厂」，绑定码<text class="hl">不会重置</text>，仍需用当时的自定义码；输 123456 会被拒。绑定后到『修改绑定码』即可换码。</text>
        <!-- 绑定码输入框：与 index.vue 自定义名称同源的 <input> 方式 -->
        <input class="bind-input" v-model="fields.bindCode" type="text"
               :maxlength="16" placeholder="请输入绑定码" />
        <button class="btn-bind" :disabled="!fields.bindCode || binding" @tap="handleBind">
          {{ binding ? '绑定中...' : '绑定设备' }}
        </button>
        <!-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        ★ [已隐藏] 一键默认码按钮（v3.33.2 方案 A）
        ──────────────────────────────────────────────────────────────────────────────
        隐藏原因：设备被「解绑本机」后 Count=0 进入首绑分支，但 g_curBindCode 仍是旧自定义码
        （UNBIND:0 不重置绑码）。此时点此按钮硬编码发 BIND:123456 → BIND:FAIL:CODE，体验很差。
        「仅恢复出厂」才会重置为 123456——但恢复出厂是破坏性操作（清空全部信任列表），
        不可频繁执行。

        替代方案：
        (A) 首绑直接手输绑定码 → 零误导、零风险，输入成本 = 6 键（123456）。
        (B) [未实现] App 持久化 _hadCustomCode 标记（SETCODE 成功后置 true），
            有此标记的首绑不显示该按钮 → 精准但需跨会话状态管理。

        当前选择 A。若日后实现 B，可取消注释恢复按钮。
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ -->
        <!--
        <button class="btn-bind-default" :disabled="binding" @tap="handleBindDefault">
          {{ binding ? '绑定中...' : '或：使用默认码 123456 绑定' }}
        </button>
        -->
        <text class="bind-warn">⚠ 若提示「设备已绑定」，说明该设备此前已绑定过：请先用<text class="hl">当前绑定码</text>(默认123456，若改过则用改后的码) 绑定以接管，再到『修改绑定码』换成自定义码。注意：『解绑本机』只让本手机忘记设备、<text class="hl">不会重置绑定码</text>；要彻底清空并重新设定绑定码，须用『恢复出厂』（同样需当前码）。</text>
      </block>

      <!-- 设备有 owner -->
      <block v-else>
        <!-- 本机持有密钥：完整主人界面 -->
        <block v-if="hasLocalKey">
          <text class="bind-desc">本机已持有该设备的绑定密钥。解绑后需重新输入绑定码才能控车。</text>
          <view class="bind-actions">
            <button class="btn-unbind" :disabled="unbinding" @tap="handleUnbind(false)">
              {{ unbinding && !unbindAll ? '解绑中...' : '解绑本机' }}
            </button>
            <button class="btn-unbind-all" :disabled="unbinding" @tap="handleUnbind(true)">
              {{ unbinding && !unbindAll ? '清空中...' : '恢复出厂(清空所有)' }}
            </button>
          </view>

          <!-- ★ 重新验证：用当前码重建会话（应对持久化丢失/换机后本地无 key 的兜底） -->
          <text class="bind-desc bind-mt">若控车提示「未绑定/验证失败」，可重新输入<text class="hl">当前绑定码</text>恢复绑定：</text>
          <input class="bind-input" v-model="fields.bindCode" type="text"
                 :maxlength="16" placeholder="重新验证：请输入当前绑定码" />
          <button class="btn-bind" :disabled="!fields.bindCode || binding" @tap="handleBind">
            {{ binding ? '绑定中...' : '重新绑定' }}
          </button>

          <view class="bind-divider"></view>

          <!-- ★ 修改绑定码（SETCODE 指令）：切换成「你的自定义码」的主路径 -->
          <text class="bind-desc bind-mt">🔑 <text class="hl">修改绑定码（换成你的自定义码）</text>：为安全起见，须先输入<text class="hl">当前绑定码</text>核对身份。改完后须用<text class="hl">新码</text>控车；旧码（含默认 123456）将失效。忘记新码可执行「恢复出厂」重置回 123456。</text>
          <input class="bind-input bind-mt" v-model="fields.oldBindCode" type="text"
                 :maxlength="16" placeholder="请输入当前绑定码（验证身份）" />
          <input class="bind-input bind-mt" v-model="fields.newBindCode" type="text"
                 :maxlength="16" placeholder="请输入新绑定码" />
          <input class="bind-input bind-mt" v-model="fields.confirmBindCode" type="text"
                 :maxlength="16" placeholder="请再次输入新绑定码" />
          <text class="bind-warn">⚠ 提交时会先用「当前绑定码」自动完成一次验证，再将绑定码切换为新码；验证失败则说明当前码输错。</text>
          <text class="bind-warn" v-if="fields.newBindCode && fields.confirmBindCode && fields.newBindCode !== fields.confirmBindCode">⚠ 两次输入的新绑定码不一致</text>
          <text class="bind-warn" v-if="fields.oldBindCode && fields.newBindCode && fields.newBindCode === fields.oldBindCode">⚠ 新绑定码不能与当前绑定码相同</text>
          <button class="btn-bind" :disabled="!fields.oldBindCode || !fields.newBindCode || !fields.confirmBindCode || fields.newBindCode !== fields.confirmBindCode || changing" @tap="handleChangeBindCode">
            {{ changing ? '修改中...' : '修改绑定码' }}
          </button>
        </block>

        <!-- 设备已绑但本机无密钥：先接管，再切换自定义码 -->
        <block v-else>
          <text class="bind-desc">此设备<text class="hl">已被绑定</text>（当前手机未持有密钥）。若你就是主人：请输入<text class="hl">当前绑定码</text>(默认123456，若改过则用改后的码) 绑定以接管，接管后便可在『修改绑定码』换成你的自定义码。若不是主人/忘了当前码：<text class="hl">『解绑本机』救不了你</text>（它不重置绑定码）；须由持有当前码的一方在『恢复出厂』里清空，或用机身 BOOT 键长按恢复出厂，码才会回到 123456。</text>
          <input class="bind-input" v-model="fields.bindCode" type="text"
                 :maxlength="16" placeholder="接管：请输入当前绑定码" />
          <button class="btn-bind" :disabled="!fields.bindCode || binding" @tap="handleBind">
            {{ binding ? '绑定中...' : '用当前码接管绑定' }}
          </button>
        </block>
      </block>

      <text class="bind-hint" v-if="bleStore.bindHint">{{ bleStore.bindHint }}</text>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, reactive } from 'vue'
import { useBleStore } from '@/stores/ble.js'
import { toast } from '@/utils/toast.js'
import { isFirmwareAtLeast } from '@/utils/firmware.js'

const props = defineProps({ visible: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const bleStore = useBleStore()

// 字段值统一放 reactive；模板里直接 <input> 绑定（用户在自定义基座实测键盘可用）。
const fields = reactive({ bindCode: '', newBindCode: '', confirmBindCode: '', oldBindCode: '' })

const binding = ref(false)
const unbinding = ref(false)
const unbindAll = ref(false)
const changing = ref(false)

const bindStatusText = computed(() => {
  if (!bleStore.isBound) return '未绑定'
  if (bleStore.sessionAuthed) return '已绑定 · 本连接已验证'
  if (bleStore._autoAuthState === 'running') return '已绑定 · 自动验证中…'
  if (bleStore._autoAuthState === 'failed') return '已绑定 · 验证失败，请重绑'
  return '已绑定 · 连接待验证'
})
const bindStatusClass = computed(() => {
  if (!bleStore.isBound) return 'unbound'
  if (bleStore.sessionAuthed) return 'authed'
  if (bleStore._autoAuthState === 'failed') return 'bound-failed'
  return 'bound'
})

// ★ 三态判定：设备端是否已有 owner（deviceBound，设备权威）或本机已持密钥 → 进入「已绑定」分支。
//   这样即便本机清过缓存/换手机（无本地 key），只要设备端仍绑定，也能看到『修改绑定码/解绑』入口，
//   不再卡在首绑分支反复输自定义码 FAIL。
const showBoundMode = computed(() => bleStore.isBound || bleStore.deviceBound)
const hasLocalKey   = computed(() => bleStore.isBound)

// ★ 固件版本判定：支持「延迟发送回包」(绑定可用的关键修复) 的最低版本是 3.30.2。
//   用真正的版本比较（isFirmwareAtLeast），覆盖 3.30.2 / 3.31.x / 3.32.x 等所有新固件，
//   不再写死 3.30.x 正则（旧正则对 3.31+ 不匹配 → 误报"旧固件"）。
const fwBadge = computed(() => {
  const v = bleStore.fwVersion || ''
  if (!v) return { text: '未知（未读到版本，先连接设备）', cls: 'unknown' }
  if (isFirmwareAtLeast(v)) {
    return { text: '✅ 新固件（支持延迟发送回包，可正常绑定）', cls: 'ok' }
  }
  return { text: '⚠️ 旧固件（BIND:OK/NONCE/AUTH 回包易丢失，绑定多半失败，请烧录 ≥3.30.2）', cls: 'old' }
})

function close() {
  emit('close')
}

async function handleBind() {
  if (!fields.bindCode || binding.value) return
  binding.value = true
  try {
    const ok = await bleStore.bindDevice(fields.bindCode)
    if (ok) {
      toast.success('绑定成功')
      fields.bindCode = ''
    } else {
      toast.error(bleStore.bindHint || '绑定失败')
    }
  } catch (e) {
    toast.error(e && e.message ? e.message : '绑定失败')
  } finally {
    binding.value = false
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * [已隐藏] 一键默认码 123456 绑定（v3.33.2 方案 A）
 * ──────────────────────────────────────────────────────────────────────────────
 * 此函数硬编码发送 BIND:123456，仅在「设备当前有效码确实为 123456」时成功。
 * 设备经 UNBIND:0（解绑本机）后 g_curBindCode 仍是旧自定义码 → 此函数必 FAIL。
 * 只有 UNBIND:1（恢复出厂）重置绑码后 123456 才有效，但恢复出厂是破坏性操作。
 *
 * 当前策略（方案 A）：首绑分支隐藏一键按钮，用户手输绑定码（最多 6 键），
 * 彻底消除「点了报 BIND:FAIL:CODE → 困惑」的用户体验问题。
 *
 * 若日后实现方案 B（App 持久化 _hadCustomCode，SETCODE 成功后置 true → 智能隐藏），
 * 可取消注释恢复此函数及模板按钮。
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleBindDefault() {
  if (binding.value) return
  binding.value = true
  try {
    const ok = await bleStore.bindDevice('123456')
    if (ok) {
      toast.success('绑定成功（默认码）')
      fields.bindCode = ''
    } else {
      toast.error(bleStore.bindHint || '绑定失败')
    }
  } catch (e) {
    toast.error(e && e.message ? e.message : '绑定失败')
  } finally {
    binding.value = false
  }
}
*/

async function handleChangeBindCode() {
  // ★ 前置校验：所有失败都要给用户准确 toast，不能静默 return
  //   （之前静默 return 会被陈旧 bindHint「BIND:OK」误导成"固件拒答"）
  if (changing.value) return
  // ★ 2026-07-14 修复：复位/未绑定态（本地密钥已清空）无法走 AUTH→SETCODE 改码，
  //   固件 SETCODE 要求设备已绑定。此时应引导先「绑定」设码，而非神秘失败。
  if (!bleStore.isBound && !bleStore.deviceBound) {
    toast.error('设备未绑定（可能已恢复出厂），请先关闭本弹窗，在上方「绑定」处输入您的绑定码完成首次设置')
    return
  }
  if (!fields.oldBindCode) { toast.error('请输入当前绑定码'); return }
  if (!fields.newBindCode) { toast.error('请输入新绑定码'); return }
  if (fields.newBindCode !== fields.confirmBindCode) {
    toast.error('两次输入的新绑定码不一致')
    return
  }
  if (fields.newBindCode === fields.oldBindCode) {
    toast.error('新绑定码不能与当前绑定码相同')
    return
  }
  if (!bleStore.sessionAuthed) {
    toast.error('请先在「重新验证」区域用当前绑定码完成 AUTH，再改码')
    return
  }
  // ★ 安全验证：本地比对「旧码派生的 key」是否等于本机 _bindKey（瞬时，无需 BLE 往返）。
  //   证明持有旧码后直接 SETCODE；避免先走 bindDevice 导致 isBound 抖动 → UI 分支切换 → 按钮消失。
  const verified = await bleStore.verifyBindCode(fields.oldBindCode)
  if (!verified) {
    toast.error('当前绑定码错误，无法改码')
    return
  }
  // ★ 进入 store 操作前清空 bindHint，避免「BIND:OK」陈旧回显误导
  bleStore.bindHint = ''
  changing.value = true
  try {
    const ok = await bleStore.changeBindCode(fields.newBindCode)
    if (ok) {
      toast.success('绑定码已修改，请牢记新码')
      fields.oldBindCode = ''
      fields.newBindCode = ''
      fields.confirmBindCode = ''
    } else {
      toast.error(bleStore.bindHint || '修改失败')
    }
  } catch (e) {
    toast.error(e && e.message ? e.message : '修改失败')
  } finally {
    changing.value = false
  }
}

async function handleUnbind(all) {
  unbindAll.value = !!all
  uni.showModal({
    title: all ? '恢复出厂设置？' : '解绑本机？',
    content: all
      ? '将清除设备的全部绑定记录，所有手机都需重新绑定后才能控车。此操作需验证当前绑定码。'
      : '本机将失去对该设备的控制权，之后需重新输入绑定码才能控车。',
    confirmText: '确认',
    success: async (res) => {
      if (!res.confirm) { unbindAll.value = false; return }
      // ★ 2026-07-14 安全：恢复出厂(UNBIND:ALL)是破坏性操作，强制先输入当前绑定码，
      //   即使本机已持有密钥（如他人临时拿到手机）也无法直接清空信任列表，
      //   须与「修改绑定码」同级身份核验。仅恢复出厂需要；解绑本机沿用既有 AUTH 即可。
      if (all) {
        const entered = await new Promise((resolve) => {
          uni.showModal({
            title: '验证绑定码',
            content: '请输入当前绑定码以确认恢复出厂',
            editable: true,
            placeholderText: '当前绑定码',
            confirmText: '确认',
            success: (r) => resolve(r.confirm ? (r.content || '').trim() : null)
          })
        })
        if (entered === null) { unbindAll.value = false; return }   // 取消
        if (!entered) { toast.error('请输入绑定码'); unbindAll.value = false; return }
        const verified = await bleStore.verifyBindCode(entered)
        if (!verified) { toast.error('绑定码错误，无法恢复出厂'); unbindAll.value = false; return }
      }
      unbinding.value = true
      try {
        const ok = await bleStore.unbindDevice(all)
        if (ok) toast.success(all ? '已恢复出厂' : '已解绑')
        else toast.error(bleStore.bindHint || '解绑失败')
      } catch (e) {
        toast.error(e && e.message ? e.message : '解绑失败')
      } finally {
        unbinding.value = false
        unbindAll.value = false
      }
    },
    fail: () => { unbindAll.value = false },
  })
}
</script>

<style scoped>
.bind-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: var(--bg-overlay);
  overflow-y: auto;                    /* ★ 外层滚动，不依赖 flex 子元素 overflow */
  -webkit-overflow-scrolling: touch;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4vh 0 6vh;                  /* ★ 上下留白，底部 6vh 确保最后一个按钮完整可见 */
  z-index: 1000;
}

.bind-dialog {
  width: 600rpx;
  flex-shrink: 0;                      /* ★ 不被父 flex 压缩 */
  background: var(--bg-card);
  border-radius: 24rpx;
  padding: 32rpx 30rpx;
  border: 1rpx solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 14rpx;
}

.bind-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.bind-title {
  font-size: 32rpx;
  font-weight: 600;
  color: var(--text-primary);
}

.bind-close {
  font-size: 36rpx;
  color: var(--text-muted);
  padding: 0 8rpx;
}

.bind-fw {
  font-size: 22rpx;
  color: var(--text-muted);
  line-height: 1.5;
}
/* ★ 固件版本徽标 */
.fw-badge {
  display: flex;
  flex-direction: column;
  gap: 4rpx;
  border-radius: 12rpx;
  padding: 16rpx 22rpx;
  background: var(--alpha-06);
  border: 1rpx solid var(--border);
}
.fw-badge-ver { font-size: 24rpx; font-weight: 600; color: var(--text-primary); }
.fw-badge-tip { font-size: 20rpx; line-height: 1.5; }
.fw-badge.ok .fw-badge-tip { color: #2ecc71; }
.fw-badge.old .fw-badge-tip { color: #e74c3c; }
.fw-badge.unknown .fw-badge-tip { color: var(--text-muted); }

/* ★ 诊断区 */
.diag {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
  background: var(--alpha-06);
  border: 1rpx solid var(--border);
  border-radius: 12rpx;
  padding: 16rpx 22rpx;
}
.diag-row { font-size: 22rpx; color: var(--text-secondary); line-height: 1.5; }
.diag-result { color: var(--accent-orange); font-weight: 600; }

.bind-status {
  display: flex;
  align-items: center;
  gap: 12rpx;
  background: var(--alpha-06);
  border: 1rpx solid var(--border);
  border-radius: 12rpx;
  padding: 18rpx 22rpx;
}
.bind-dot { font-size: 22rpx; }
.bind-text { font-size: 26rpx; font-weight: 600; }
.bind-status.unbound .bind-dot { color: var(--text-muted); }
.bind-status.unbound .bind-text { color: var(--text-secondary); }
.bind-status.bound .bind-dot { color: #e67e22; }
.bind-status.bound .bind-text { color: #e67e22; }
.bind-status.authed .bind-dot { color: #2ecc71; }
.bind-status.authed .bind-text { color: #2ecc71; }

.bind-desc {
  font-size: 22rpx;
  color: var(--text-muted);
  line-height: 1.6;
}
.bind-desc .hl { color: var(--text-primary); font-weight: 600; }
.bind-desc.bind-mt { margin-top: 16rpx; }

/* ★ 警告提示（易踩坑说明） */
.bind-warn {
  font-size: 21rpx;
  color: #e67e22;
  line-height: 1.6;
  background: rgba(230, 126, 34, 0.08);
  border: 1rpx solid rgba(230, 126, 34, 0.25);
  border-radius: 10rpx;
  padding: 14rpx 18rpx;
}
.bind-warn .hl { color: #e67e22; font-weight: 700; }

/* ★ 遮罩显示（如当前绑定码已输入但不应明文呈现） */
.secure { letter-spacing: 4rpx; color: var(--text-primary); }

/* ★ 分隔线（"重新验证" 与 "修改绑定码" 之间） */
.bind-divider {
  height: 1rpx;
  background: var(--border);
  margin: 10rpx 0 4rpx;
}

/* 绑定码输入框：直接用 webview <input> */
.bind-input {
  width: 100%;
  height: 80rpx;
  background: var(--bg-card-alt, var(--bg-card));
  border: 2rpx solid var(--border);
  border-radius: 12rpx;
  padding: 0 24rpx;
  font-size: 28rpx;
  color: var(--text-primary);
  box-sizing: border-box;
}

/* 主按钮：绑定设备 / 重新绑定 / 修改绑定码（蓝色渐变实心按钮）
   用法：在模板里加 :disabled="!fields.bindCode || binding" 即可触发下方 [disabled] 样式。
   调颜色：修改 background 即可；禁用态目前用浅灰底，如果想保持蓝色系，看 [disabled] 注释。 */
.btn-bind {
  width: 100%;
  background: var(--gradient-accent);
  color: #fff;
  font-size: 28rpx;
  font-weight: 600;
  padding: 24rpx 0;
  border-radius: 14rpx;
  /* 状态切换（disabled/按下）带 0.18s 过渡，避免截图里那种生硬的惨白跳变 */
  transition: opacity 0.18s, filter 0.18s, transform 0.1s;
}

/* 按下反馈：轻微压暗 + 降低亮度，给用户“按下去”的触觉感，不破坏渐变配色 */
.btn-bind:active {
  opacity: 0.85;
  filter: brightness(0.92);
}

/* 禁用态（未输入绑定码或处理中）：
   原来只有 opacity: 0.3，会把蓝色渐变洗成很淡的蓝色水印，像截图里那样发虚。
   这里单独给禁用态一套配色：浅灰底 + 灰字，轮廓清晰，一看就是“不可点”。
   如果你想改成蓝色系禁用态，把 background 改成 #a7c3e8（浅蓝）、color 保持 #fff 即可。 */
.btn-bind[disabled] {
  opacity: 0.6;                              /* 比 0.3 更饱满，不发虚 */
  background: var(--bg-disabled, #e5e7eb); /* 覆盖渐变，使用浅灰底色 */
  color: var(--text-disabled, #9ca3af);      /* 灰字，fallback 为 #9ca3af */
  filter: grayscale(0.25);                   /* 轻微去饱和，让禁用感更明确 */
}

.btn-bind-default {
  width: 100%;
  background: transparent;
  color: var(--accent);
  border: 2rpx solid var(--accent);
  font-size: 26rpx;
  font-weight: 600;
  padding: 22rpx 0;
  border-radius: 14rpx;
}
.btn-bind-default:active { opacity: 0.7; }
.btn-bind-default[disabled] { opacity: 0.3; }

.bind-actions { display: flex; gap: 20rpx; }
.btn-unbind,
.btn-unbind-all {
  flex: 1;
  font-size: 26rpx;
  font-weight: 600;
  padding: 22rpx 0;
  border-radius: 14rpx;
  border: 2rpx solid;
}
.btn-unbind { background: transparent; color: var(--accent-orange); border-color: var(--accent-orange); }
.btn-unbind-all { background: transparent; color: #e74c3c; border-color: #e74c3c; }
.btn-unbind:active, .btn-unbind-all:active { opacity: 0.7; }
.btn-unbind[disabled], .btn-unbind-all[disabled] { opacity: 0.3; }

.bind-hint {
  font-size: 22rpx;
  color: var(--accent-orange);
  background: rgba(230, 126, 34, 0.1);
  border: 1rpx solid rgba(230, 126, 34, 0.3);
  border-radius: 10rpx;
  padding: 14rpx 18rpx;
  line-height: 1.5;
}
</style>
