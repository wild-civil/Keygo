#ifndef __BUTTON_CTRL_H__
#define __BUTTON_CTRL_H__

#include "config.h"

/* ============================================================
 *  物理按键模块
 *  短按: 删除所有 bond (配对模式)
 *  长按 >5s: 恢复出厂设置
 * ============================================================ */

void Button_Init(void);
void Button_Process(void);

typedef void (*ButtonCallback_t)(void);
void Button_SetCallbacks(ButtonCallback_t onShortPress, ButtonCallback_t onLongPress);

#endif
