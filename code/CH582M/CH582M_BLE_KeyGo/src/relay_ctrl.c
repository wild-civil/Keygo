#include "relay_ctrl.h"

/* ============================================================
 *  继电器控制模块
 *  控制解锁/锁车/后备箱 + 钥匙供电
 * ============================================================ */

void Relay_Init(void) {
    GPIOA_ModeCfg(PIN_UNLOCK, GPIO_ModeOut_PP_5mA);
    GPIOA_ModeCfg(PIN_LOCK, GPIO_ModeOut_PP_5mA);
    GPIOA_ModeCfg(PIN_TRUNK, GPIO_ModeOut_PP_5mA);
    GPIOA_ModeCfg(PIN_KEY_POWER, GPIO_ModeOut_PP_5mA);

    GPIOA_ResetBits(PIN_UNLOCK);
    GPIOA_ResetBits(PIN_LOCK);
    GPIOA_ResetBits(PIN_TRUNK);
    GPIOA_SetBits(PIN_KEY_POWER);
}

static void key_power_on(void) {
    GPIOA_ResetBits(PIN_KEY_POWER);
}

static void key_power_off(void) {
    GPIOA_SetBits(PIN_KEY_POWER);
}

void Relay_ExecuteUnlock(void) {
    key_power_on();
    Delay_Ms(DEFAULT_KEY_POWER_DELAY);
    GPIOA_SetBits(PIN_UNLOCK);
    Delay_Ms(DEFAULT_KEY_PRESS_DURATION);
    GPIOA_ResetBits(PIN_UNLOCK);
    Delay_Ms(DEFAULT_KEY_RELEASE_DELAY);
    key_power_off();
}

void Relay_ExecuteLock(void) {
    key_power_on();
    Delay_Ms(DEFAULT_KEY_POWER_DELAY);
    GPIOA_SetBits(PIN_LOCK);
    Delay_Ms(DEFAULT_KEY_PRESS_DURATION);
    GPIOA_ResetBits(PIN_LOCK);
    Delay_Ms(DEFAULT_KEY_RELEASE_DELAY);
    key_power_off();
}

void Relay_ExecuteTrunk(void) {
    key_power_on();
    Delay_Ms(DEFAULT_KEY_POWER_DELAY);
    GPIOA_SetBits(PIN_TRUNK);
    Delay_Ms(DEFAULT_KEY_PRESS_DURATION);
    GPIOA_ResetBits(PIN_TRUNK);
    Delay_Ms(DEFAULT_KEY_RELEASE_DELAY);
    key_power_off();
}

void Relay_AllOff(void) {
    GPIOA_ResetBits(PIN_UNLOCK);
    GPIOA_ResetBits(PIN_LOCK);
    GPIOA_ResetBits(PIN_TRUNK);
    GPIOA_SetBits(PIN_KEY_POWER);
}
