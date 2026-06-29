#ifndef __RELAY_CTRL_H__
#define __RELAY_CTRL_H__

#include "config.h"

/* ============================================================
 *  继电器控制模块
 *  控制解锁/锁车/后备箱 + 钥匙供电
 * ============================================================ */

void Relay_Init(void);
void Relay_ExecuteUnlock(void);
void Relay_ExecuteLock(void);
void Relay_ExecuteTrunk(void);
void Relay_AllOff(void);

#endif
