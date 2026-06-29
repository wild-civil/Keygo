#ifndef __LED_CTRL_H__
#define __LED_CTRL_H__

#include "config.h"

/* ============================================================
 *  LED 状态指示模块
 *  已连接: 常亮
 *  配对模式: 200ms 快闪
 *  未绑定: 1s 慢闪
 *  已绑定待连接: 2s 闪烁
 * ============================================================ */

void LED_Init(void);
void LED_Update(void);
void LED_SetOn(bool on);
void LED_BlinkPattern(uint32_t intervalMs);

#endif
