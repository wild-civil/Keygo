#include "button_ctrl.h"

/* ============================================================
 *  物理按键模块
 *  短按: 删除所有 bond (配对模式)
 *  长按 >5s: 恢复出厂设置
 * ============================================================ */

static ButtonCallback_t onShortPressCb = NULL;
static ButtonCallback_t onLongPressCb = NULL;

static uint32_t last_check_ms = 0;
static bool last_state = true;
static uint32_t press_start_ms = 0;

void Button_Init(void) {
    GPIOA_ModeCfg(PIN_BIND, GPIO_ModeIN_PU);
    last_check_ms = 0;
    last_state = true;
    press_start_ms = 0;
}

void Button_SetCallbacks(ButtonCallback_t onShortPress, ButtonCallback_t onLongPress) {
    onShortPressCb = onShortPress;
    onLongPressCb = onLongPress;
}

void Button_Process(void) {
    if (GetSysTickMs() - last_check_ms < BUTTON_DEBOUNCE_MS) return;
    last_check_ms = GetSysTickMs();

    bool current = (GPIOA_ReadPortPin(PIN_BIND) != 0);

    if (last_state && !current) {
        press_start_ms = GetSysTickMs();
    }

    if (!last_state && current) {
        uint32_t holdMs = GetSysTickMs() - press_start_ms;
        if (holdMs >= FACTORY_RESET_HOLD_MS) {
            if (onLongPressCb) {
                onLongPressCb();
            }
        } else if (holdMs > 200 && holdMs < 2000) {
            if (onShortPressCb) {
                onShortPressCb();
            }
        }
    }

    last_state = current;
}
