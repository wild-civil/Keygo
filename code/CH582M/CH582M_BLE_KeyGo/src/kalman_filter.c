#include "kalman_filter.h"

/* ============================================================
 *  1D Kalman 滤波器
 *  一维随机游走模型
 * ============================================================ */

static int16_t spike_consecutive_count = 0;

void Kalman_Init(KalmanFilter_t *kf, float q, float r) {
    if (!kf) return;
    kf->q = q;
    kf->r = r;
    kf->x = -999.0f;
    kf->p = 1.0f;
    kf->initialized = false;
}

void Kalman_Reset(KalmanFilter_t *kf) {
    if (!kf) return;
    kf->x = -999.0f;
    kf->p = 1.0f;
    kf->initialized = false;
    spike_consecutive_count = 0;
}

float Kalman_Update(KalmanFilter_t *kf, float measurement) {
    if (!kf) return measurement;

    if (!kf->initialized) {
        kf->x = measurement;
        kf->p = kf->r;
        kf->initialized = true;
        return measurement;
    }

    kf->p = kf->p + kf->q;
    float k = kf->p / (kf->p + kf->r);
    kf->x = kf->x + k * (measurement - kf->x);
    kf->p = (1.0f - k) * kf->p;

    return kf->x;
}

void SpikeReject_Init(void) {
    spike_consecutive_count = 0;
}

bool SpikeReject_Process(int16_t rawRssi, float filteredRssi, int16_t spikeThreshold,
                          int16_t consecutiveRequired, int16_t *outputRssi) {
    if (outputRssi == NULL) return false;

    bool isSpike = (filteredRssi > -990.0f) &&
                   (abs(rawRssi - (int16_t)filteredRssi) > spikeThreshold);

    if (isSpike) {
        spike_consecutive_count++;
        if (spike_consecutive_count >= consecutiveRequired) {
            *outputRssi = rawRssi;
            spike_consecutive_count = 0;
            return false;
        } else {
            return true;
        }
    } else {
        spike_consecutive_count = 0;
        *outputRssi = rawRssi;
        return false;
    }
}
