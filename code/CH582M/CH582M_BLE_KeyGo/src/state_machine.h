#ifndef __STATE_MACHINE_H__
#define __STATE_MACHINE_H__

#include "config.h"

/* ============================================================
 *  锁车/解锁状态机
 *  滞后阈值 + 连续计数防抖
 * ============================================================ */

void StateMachine_Init(void);
void StateMachine_Reset(void);
void StateMachine_Process(float filteredRssi);

const char* StateMachine_GetStateString(void);

#endif
