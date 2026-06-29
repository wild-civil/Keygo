#include "state_machine.h"
#include "relay_ctrl.h"
#include "gatt_service.h"

/* ============================================================
 *  锁车/解锁状态机
 *  滞后阈值 + 连续计数防抖
 * ============================================================ */

static KeyState_t local_state = STATE_LOCKED;
static uint16_t  local_unlock_counter = 0;
static uint16_t  local_lock_counter = 0;

void StateMachine_Init(void) {
    local_state = STATE_LOCKED;
    local_unlock_counter = 0;
    local_lock_counter = 0;
}

void StateMachine_Reset(void) {
    local_unlock_counter = 0;
    local_lock_counter = 0;
}

void StateMachine_Process(float filteredRssi) {
    if (filteredRssi < -990.0f) return;
    if (g_st.manualCommandCooldown) {
        if (GetSysTickMs() - g_st.manualCommandTimestampMs >= MANUAL_COOLDOWN_MS) {
            g_st.manualCommandCooldown = false;
        } else {
            return;
        }
    }

    if (local_state == STATE_LOCKED) {
        if (filteredRssi >= g_cfg.rssiUnlockThreshold) {
            local_unlock_counter++;
            local_lock_counter = 0;
            if (local_unlock_counter >= g_cfg.unlockCountRequired) {
                local_state = STATE_ACTION;
                g_st.currentState = STATE_ACTION;
                Relay_ExecuteUnlock();
                local_state = STATE_UNLOCKED;
                g_st.currentState = STATE_UNLOCKED;
                local_unlock_counter = 0;
                local_lock_counter = 0;
                GattSrv_NotifyStatus();
            }
        } else {
            local_unlock_counter = 0;
        }
    } else if (local_state == STATE_UNLOCKED) {
        int16_t effectiveLock = g_cfg.rssiLockThreshold - g_cfg.rssiHysteresisDb;
        if (filteredRssi <= effectiveLock) {
            local_lock_counter++;
            local_unlock_counter = 0;
            if (local_lock_counter >= g_cfg.lockCountRequired) {
                local_state = STATE_ACTION;
                g_st.currentState = STATE_ACTION;
                Relay_ExecuteLock();
                local_state = STATE_LOCKED;
                g_st.currentState = STATE_LOCKED;
                local_unlock_counter = 0;
                local_lock_counter = 0;
                GattSrv_NotifyStatus();
            }
        } else {
            local_lock_counter = 0;
        }
    }
}

const char* StateMachine_GetStateString(void) {
    switch (local_state) {
        case STATE_LOCKED:   return "LOCKED";
        case STATE_UNLOCKED: return "UNLOCKED";
        case STATE_ACTION:   return "ACTION";
        default:             return "UNKNOWN";
    }
}
