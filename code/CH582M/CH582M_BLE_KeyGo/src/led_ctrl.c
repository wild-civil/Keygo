#include "led_ctrl.h"

/* ============================================================
 *  LED 状态指示模块
 * ============================================================ */

static uint32_t last_blink_ms = 0;
static bool     led_state = false;
static uint32_t blink_interval = 0;
static bool     force_on = false;

void LED_Init(void) {
    GPIOA_ModeCfg(PIN_LED, GPIO_ModeOut_PP_5mA);
    GPIOA_ResetBits(PIN_LED);
    last_blink_ms = 0;
    led_state = false;
    blink_interval = 0;
    force_on = false;
}

void LED_SetOn(bool on) {
    force_on = on;
    if (on) {
        GPIOA_SetBits(PIN_LED);
    } else {
        GPIOA_ResetBits(PIN_LED);
    }
}

void LED_BlinkPattern(uint32_t intervalMs) {
    blink_interval = intervalMs;
    force_on = false;
}

void LED_Update(void) {
    if (g_st.deviceConnected) {
        GPIOA_SetBits(PIN_LED);
        return;
    }

    if (g_st.pairingModeActive) {
        if (GetSysTickMs() - last_blink_ms >= 200) {
            last_blink_ms = GetSysTickMs();
            led_state = !led_state;
            if (led_state) {
                GPIOA_SetBits(PIN_LED);
            } else {
                GPIOA_ResetBits(PIN_LED);
            }
        }
        return;
    }

    if (!g_st.hasBondedDevices) {
        if (GetSysTickMs() - last_blink_ms >= 1000) {
            last_blink_ms = GetSysTickMs();
            led_state = !led_state;
            if (led_state) {
                GPIOA_SetBits(PIN_LED);
            } else {
                GPIOA_ResetBits(PIN_LED);
            }
        }
        return;
    }

    if (GetSysTickMs() - last_blink_ms >= 2000) {
        last_blink_ms = GetSysTickMs();
        led_state = !led_state;
        if (led_state) {
            GPIOA_SetBits(PIN_LED);
        } else {
            GPIOA_ResetBits(PIN_LED);
        }
    }
}
