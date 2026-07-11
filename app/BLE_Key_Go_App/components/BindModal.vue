<template>
  <!-- ★ 绑定弹窗：position:fixed 全屏覆盖层，脱离 main.vue 的 swiper/scroll-view 文档流。
       与 index.vue 的 PIN 弹窗同机制（fixed + 高 z-index）。
       ★ 输入框方案（2026-07-11 修正）：该自定义 Android 基座上 webview <input> 弹不出键盘，
       故字段不再用 <input>，而是「点一下弹 uni.showModal({editable:true}) 系统原生输入框」
       （字段即触发器，键盘 100% 可靠），不堆独立按钮。 -->
  <view v-if="visible" class="bind-overlay" @tap.stop>
    <view class="bind-dialog" @tap.stop>
      <view class="bind-head">
        <text class="bind-title">🔐 设备绑定</text>
        <text class="bind-close" @tap="close">✕</text>
      </view>

      <text class="bind-fw">已连接设备固件版本：<text class="fw-ver">{{ bleStore.fwVersion || '未知' }}</text>
        <text v-if="bleStore.fwVersion && bleStore.fwVersion !== '3.30.1'">（旧版本→烧录未生效）</text></text>

      <view class="bind-status" :class="bindStatusClass">
        <text class="bind-dot">●</text>
        <text class="bind-text">{{ bindStatusText }}</text>
      </view>

      <!-- 未绑定：输入绑定码 -->
      <block v-if="!bleStore.isBound">
        <text class="bind-desc">首次绑定请输入设备默认绑定码（机身标签）。绑定成功后本机将持有该设备的密钥，可正常控车；其他手机需先解绑才能绑定本机。</text>
        <!-- ★ 字段即触发器：点一下弹出系统原生输入框（webview input 在该基座弹不出键盘，故不用 <input>） -->
        <view class="bind-input bind-tap" @tap.stop="promptField('bindCode','请输入绑定码')">
          <text v-if="fields.bindCode">{{ fields.bindCode }}</text>
          <text v-else class="bind-ph">请输入绑定码</text>
        </view>
        <button class="btn-bind" :disabled="!fields.bindCode || binding" @tap="handleBind">
          {{ binding ? '绑定中...' : '绑定设备' }}
        </button>
        <!-- ★ 一键默认码：绕过输入直接首绑（基座上最省事） -->
        <button class="btn-bind-default" :disabled="binding" @tap="handleBindDefault">
          {{ binding ? '绑定中...' : '使用默认码 123456 绑定' }}
        </button>
      </block>

      <!-- 已绑定：解绑 / 重新绑定 / 修改绑定码 -->
      <block v-else>
        <text class="bind-desc">本机已持有该设备的绑定密钥。解绑后需重新输入绑定码才能控车。</text>
        <view class="bind-actions">
          <button class="btn-unbind" :disabled="unbinding" @tap="handleUnbind(false)">
            {{ unbinding && !unbindAll ? '解绑中...' : '解绑本机' }}
          </button>
          <button class="btn-unbind-all" :disabled="unbinding" @tap="handleUnbind(true)">
            {{ unbinding && !unbindAll ? '清空中...' : '恢复出厂(清空所有)' }}
          </button>
        </view>

        <!-- ★ 始终提供「重新绑定」入口，避免本地有密钥但设备端因 MAC 变化拒连时无处可重绑 -->
        <text class="bind-desc bind-mt">若控车提示「未绑定/验证失败」，可重新输入默认绑定码恢复绑定：</text>
        <view class="bind-input bind-tap" @tap.stop="promptField('bindCode','重新绑定：请输入绑定码')">
          <text v-if="fields.bindCode">{{ fields.bindCode }}</text>
          <text v-else class="bind-ph">重新绑定：请输入绑定码</text>
        </view>
        <button class="btn-bind" :disabled="!fields.bindCode || binding" @tap="handleBind">
          {{ binding ? '绑定中...' : '重新绑定' }}
        </button>

        <!-- ★ 修改绑定码（SETCODE 指令，已绑定且已验证时可用） -->
        <text class="bind-desc bind-mt">🔑 <text class="hl">修改绑定码</text>：可把绑定码改成你自己的码。修改后须用<text class="hl">新码</text>重新绑定/验证；旧码（含默认 123456）将失效。忘记新码可执行「恢复出厂」重置回 123456。</text>
        <view class="bind-input bind-tap bind-mt" @tap.stop="promptField('newBindCode','请输入新绑定码')">
          <text v-if="fields.newBindCode">{{ fields.newBindCode }}</text>
          <text v-else class="bind-ph">请输入新绑定码</text>
        </view>
        <view class="bind-input bind-tap bind-mt" @tap.stop="promptField('confirmBindCode','请再次输入新绑定码')">
          <text v-if="fields.confirmBindCode">{{ fields.confirmBindCode }}</text>
          <text v-else class="bind-ph">请再次输入新绑定码</text>
        </view>
        <button class="btn-bind" :disabled="!fields.newBindCode || fields.newBindCode !== fields.confirmBindCode || changing" @tap="handleChangeBindCode">
          {{ changing ? '修改中...' : '修改绑定码' }}
        </button>
      </block>

      <text class="bind-hint" v-if="bleStore.bindHint">{{ bleStore.bindHint }}</text>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, reactive } from 'vue'
import { useBleStore } from '@/stores/ble.js'
import { toast } from '@/utils/toast.js'

const props = defineProps({ visible: { type: Boolean, default: false } })
const emit = defineEmits(['close'])

const bleStore = useBleStore()

// ★ 字段值统一放 reactive。模板里输入框改为「点一下弹系统原生输入框」(见 promptField)。
//   原因：该自定义 Android 基座上 webview <input> 弹不出键盘（与之前 config 页同病），
//   而 uni.showModal({editable:true}) 是系统原生对话框，键盘 100% 可靠。字段即触发器，不堆按钮。
const fields = reactive({ bindCode: '', newBindCode: '', confirmBindCode: '' })

const binding = ref(false)
const unbinding = ref(false)
const unbindAll = ref(false)
const changing = ref(false)

// ★ 点字段 → 弹系统原生输入框。editable 弹窗的 content 作初值，确认后写回 fields[key]。
function promptField(key, placeholder) {
  if (binding.value || changing.value) return
  uni.showModal({
    title: '输入绑定码',
    editable: true,
    placeholderText: placeholder || '请输入绑定码',
    content: fields[key] || '',
    success: (res) => {
      if (res.confirm) fields[key] = (res.content || '').trim()
    }
  })
}

const bindStatusText = computed(() => {
  if (!bleStore.isBound) return '未绑定'
  return bleStore.sessionAuthed ? '已绑定 · 本连接已验证' : '已绑定 · 连接待验证'
})
const bindStatusClass = computed(() => {
  if (!bleStore.isBound) return 'unbound'
  return bleStore.sessionAuthed ? 'authed' : 'bound'
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

async function handleChangeBindCode() {
  if (!fields.newBindCode || fields.newBindCode !== fields.confirmBindCode || changing.value) return
  changing.value = true
  try {
    const ok = await bleStore.changeBindCode(fields.newBindCode)
    if (ok) {
      toast.success('绑定码已修改，请牢记新码')
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
      ? '将清除设备的全部绑定记录，所有手机都需重新绑定后才能控车。'
      : '本机将失去对该设备的控制权，之后需重新输入绑定码才能控车。',
    confirmText: '确认',
    success: async (res) => {
      if (!res.confirm) { unbindAll.value = false; return }
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
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.bind-dialog {
  width: 600rpx;
  max-height: 86vh;
  overflow-y: auto;
  background: var(--bg-card);
  border-radius: 24rpx;
  padding: 40rpx 36rpx;
  border: 1rpx solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 18rpx;
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
.fw-ver { color: var(--accent); }

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

/* ★ 字段即触发器：外观仍是输入框，但点一下弹系统原生输入框（见 promptField） */
.bind-input {
  width: 100%;
  min-height: 80rpx;
  display: flex;
  align-items: center;
  background: var(--bg-card-alt, var(--bg-card));
  border: 2rpx solid var(--border);
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  font-size: 28rpx;
  color: var(--text-primary);
  box-sizing: border-box;
}
.bind-input.bind-tap { cursor: pointer; }
.bind-input.bind-tap:active { opacity: 0.7; }
.bind-ph { color: var(--text-muted); }

.btn-bind {
  width: 100%;
  background: var(--gradient-accent);
  color: #fff;
  font-size: 28rpx;
  font-weight: 600;
  padding: 24rpx 0;
  border-radius: 14rpx;
}
.btn-bind:active { opacity: 0.8; }
.btn-bind[disabled] { opacity: 0.3; }

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
