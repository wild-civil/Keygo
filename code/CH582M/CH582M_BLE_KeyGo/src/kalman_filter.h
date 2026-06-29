#ifndef __KALMAN_FILTER_H__
#define __KALMAN_FILTER_H__

#include "config.h"

/* ============================================================
 *  1D Kalman 滤波器
 *  一维随机游走模型，用于 RSSI 平滑
 * ============================================================ */

typedef struct {
    float x;        // 状态估计值
    float p;        // 估计协方差
    float q;        // 过程噪声
    float r;        // 测量噪声
    bool  initialized;
} KalmanFilter_t;

void Kalman_Init(KalmanFilter_t *kf, float q, float r);
void Kalman_Reset(KalmanFilter_t *kf);
float Kalman_Update(KalmanFilter_t *kf, float measurement);

void SpikeReject_Init(void);
bool  SpikeReject_Process(int16_t rawRssi, float filteredRssi, int16_t spikeThreshold,
                          int16_t consecutiveRequired, int16_t *outputRssi);

#endif
