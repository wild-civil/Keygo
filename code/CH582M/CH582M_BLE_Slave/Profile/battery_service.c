/********************************** (C) COPYRIGHT *******************************
 * File Name          : battery_service.c
 * Author             : KeyGo v3.13
 * Date               : 2026/07/03
 * Description        : BLE Battery Service (0x180F) 实现
 *                      电量默认走内部 VBAT ADC(通道14, V03 经 LDO 显示~100%)；
 *                      V04 起支持外部电池 ADC: V04=PB3 / V0.8=PB5 作 BAT_ADC_EN(闸门)+PA3/AIN6=BAT_ADC(模拟输入)，
 *                      由 BOARD_HAS_EXT_BAT_ADC 编译开关启用。
 *
 * GATT 属性表结构:
 *   [0] Service Declaration  (0x2800, UUID=0x180F)
 *   [1] Char Declaration     (0x2803, Props=Read|Notify)
 *   [2] Char Value           (0x2A19, uint8_t 0-100)
 *   [3] CCCD                 (0x2902, Client Char Config)
 *********************************************************************************/

#include "CONFIG.h"
#include "battery_service.h"
#include "CH58x_adc.h"
#include "CH58x_gpio.h"    // ★ V04: GPIOB_SetBits/ResetBits, GPIOA_ModeCfg (BAT_ADC_EN / BAT_ADC)
#include "CH583SFR.h"      // ★ V04: R16_PIN_ANALOG_IE / bAIN6 (PA3 模拟输入使能位)

#include <stdio.h>

/* ════════════════════════════════════════════════════════════════════════════
 * BLE UUID 常量
 * ════════════════════════════════════════════════════════════════════════════ */

static const uint8_t battServUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(BATT_SERV_UUID), HI_UINT16(BATT_SERV_UUID)
};

static const uint8_t battLevelUUID[ATT_BT_UUID_SIZE] = {
    LO_UINT16(BATT_LEVEL_UUID), HI_UINT16(BATT_LEVEL_UUID)
};

/* ════════════════════════════════════════════════════════════════════════════
 * 服务实例变量
 * ════════════════════════════════════════════════════════════════════════════ */

static const gattAttrType_t battService = { ATT_BT_UUID_SIZE, battServUUID };

static uint8_t battLevelProps = GATT_PROP_READ | GATT_PROP_NOTIFY;
/* Init 立即采样 → 广播前即为真实电量; 编译初值 255(不支持)，待 Battery_Init 首采覆盖：
 * V03(无分压)首采命中<100仍为255，V04首采覆盖为真实百分比，避免开机瞬态误报0% */
static uint8_t batteryLevel    = 255;

static gattCharCfg_t battLevelClientCharCfg[GATT_MAX_NUM_CONN];

/* ════════════════════════════════════════════════════════════════════════════
 * 前向声明
 * ════════════════════════════════════════════════════════════════════════════ */

static bStatus_t batt_ReadAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                  uint8_t *pValue, uint16_t *pLen,
                                  uint16_t offset, uint16_t maxLen, uint8_t method);
static bStatus_t batt_WriteAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                   uint8_t *pValue, uint16_t len,
                                   uint16_t offset, uint8_t method);

/* ════════════════════════════════════════════════════════════════════════════
 * GATT 属性表
 * ════════════════════════════════════════════════════════════════════════════ */

static gattAttribute_t battAttrTbl[] = {
    /* [0] Battery Service Declaration */
    {
        { ATT_BT_UUID_SIZE, primaryServiceUUID },
        GATT_PERMIT_READ,
        0,
        (uint8_t *)&battService
    },

    /* [1] Battery Level Channel Declaration */
    {
        { ATT_BT_UUID_SIZE, characterUUID },
        GATT_PERMIT_READ,
        0,
        &battLevelProps
    },

    /* [2] Battery Level Value */
    {
        { ATT_BT_UUID_SIZE, battLevelUUID },
        GATT_PERMIT_READ,
        0,
        &batteryLevel
    },

    /* [3] Battery Level CCCD */
    {
        { ATT_BT_UUID_SIZE, clientCharCfgUUID },
        GATT_PERMIT_READ | GATT_PERMIT_WRITE,
        0,
        (uint8_t *)&battLevelClientCharCfg
    },
};

/* ════════════════════════════════════════════════════════════════════════════
 * GATT 服务回调表
 * ════════════════════════════════════════════════════════════════════════════ */

static gattServiceCBs_t battCBs = {
    batt_ReadAttrCB,
    batt_WriteAttrCB,
    NULL   // no authorization callback
};

/* ════════════════════════════════════════════════════════════════════════════
 * Public API
 * ════════════════════════════════════════════════════════════════════════════ */

bStatus_t Battery_AddService(void)
{
    GATTServApp_InitCharCfg(INVALID_CONNHANDLE, battLevelClientCharCfg);

    return GATTServApp_RegisterService(battAttrTbl,
                                        GATT_NUM_ATTRS(battAttrTbl),
                                        GATT_MAX_ENCRYPT_KEY_SIZE,
                                        &battCBs);
}

uint8_t Battery_GetLevel(void)
{
    return batteryLevel;
}

void Battery_Notify(void)
{
    uint16_t connHandle = 0;
    uint8_t  found = 0;
    uint16_t i;

    for (i = 0; i < GATT_MAX_NUM_CONN; i++) {
        if (battLevelClientCharCfg[i].connHandle != INVALID_CONNHANDLE &&
            battLevelClientCharCfg[i].value == GATT_CLIENT_CFG_NOTIFY) {
            connHandle = battLevelClientCharCfg[i].connHandle;
            found = 1;
            break;
        }
    }

    if (!found) return;

    attHandleValueNoti_t noti;
    noti.handle = battAttrTbl[BATT_LEVEL_VALUE_POS].handle;
    noti.len    = BATT_LEVEL_LEN;
    noti.pValue = GATT_bm_alloc(connHandle, ATT_HANDLE_VALUE_NOTI, BATT_LEVEL_LEN, NULL, 0);
    if (noti.pValue) {
        noti.pValue[0] = batteryLevel;
        /* ★ v3.15-fix: GATT_Notification 失败时释放 GATT_bm_alloc 分配的内存
         *   若不释放，每次 Notify 失败泄漏 BLE 堆内存，长期运行会耗尽堆区
         *   最终导致 GATT_bm_alloc 返回 NULL → 无法发送任何通知 */
        if (GATT_Notification(connHandle, &noti, FALSE) != SUCCESS) {
            GATT_bm_free((gattMsg_t *)&noti, ATT_HANDLE_VALUE_NOTI);
        }
    }
}

#ifdef BOARD_HAS_EXT_BAT_ADC
/*******************************************************************************
 * @fn      Battery_ADC_Init
 *
 * @brief   V0.8 外部电池 ADC GPIO 初始化: PB5=BAT_ADC_EN(闸门输出, V04 为 PB3), PA3=BAT_ADC(模拟输入)
 *
 * @note    CH582M 无 GPIO_ModeAIN, 模拟输入用 GPIO_ModeIN_Floating(高阻)。
 *          闸门默认关断(省电), 采样前再打开。
 */
void Battery_ADC_Init(void)
{
    GPIOB_ModeCfg(BAT_ADC_EN_PIN, GPIO_ModeOut_PP_5mA);
#if defined(BAT_ADC_EN_ALWAYS_ON)
    /* ★ 调试常开模式: PB3 持续拉高, 分压网络一直上电, 便于万用表量 PA3 节点电压。
     *   仅用于定位, Release 必须关闭(否则分压常通漏电)。 */
#if (BAT_ADC_EN_ACTIVE_LEVEL == 1)
    GPIOB_SetBits(BAT_ADC_EN_PIN);
#else
    GPIOB_ResetBits(BAT_ADC_EN_PIN);
#endif
#else
#if (BAT_ADC_EN_ACTIVE_LEVEL == 1)
    GPIOB_ResetBits(BAT_ADC_EN_PIN);   // NMOS 默认低 = 关断分压
#else
    GPIOB_SetBits(BAT_ADC_EN_PIN);     // PMOS 默认高 = 关断分压(低有效时)
#endif
#endif
    GPIOA_ModeCfg(BAT_ADC_AIN_PIN, GPIO_ModeIN_Floating);  // PA3 → AIN6 高阻输入
    /* ★ 关键: CH582M 每个外部 ADC 通道必须在 R16_PIN_ANALOG_IE 置对应"通道使能位"来
     *   关闭数字输入 + 接通内部模拟开关到 ADC 采样电容。
     *   PA3 = AIN6, 其使能位是 RB_PIN_ADC6_7_IE(0x02, bit1) —— 注意不是 bAIN6(bit3)!
     *   bAIN6=(1<<3) 是 GPIO 模拟复用位, 置错会导致 ADC6 通道数字输入仍使能、模拟开关没接通,
     *   PA3 物理电压正确(万用表可量到~2.0V)但 ADC 采到浮空数字缓冲节点 → 饱和 → 误报100%。
     *   这正是之前"PA3=1.99V 却显示100%"未被修复的真正根因(上一版错用了 bAIN6)。
     *   用官方库 GPIOAGPPCfg(ENABLE, RB_PIN_ADC6_7_IE) 最稳妥。 */
    GPIOAGPPCfg(ENABLE, RB_PIN_ADC6_7_IE);

    /* Init 完立刻采样一次, 不等 30s 定时器——让广播数据开机就是真实电量。
     *   用纯寄存器直读(已验证可靠),
     *   ★ 两点校准 K=4242 offset=6590: 见下方换算注释 (2026-08-08 两点实测修正) */
    {
        uint8_t  savedCfg     = R8_ADC_CFG;
        uint8_t  savedChannel = R8_ADC_CHANNEL;
        uint16_t adcValIdle;   // 闸门关闭时(分压未上电)的浮空基线
        uint16_t adcVal;       // 闸门开启后(分压上电)的采样值
        uint32_t batt_mV;

        /* 纯寄存器 ADC 直读: AIN6, PGA÷4, BufEn */
        R8_ADC_CFG     = RB_ADC_POWER_ON | RB_ADC_BUF_EN | (0 << 6) | (0 << 4);
        R8_ADC_CHANNEL = BAT_ADC_CHANNEL;

        /* ★ 2026-08-09 修复(C方案 V03 误报 0%): 浮空 PA3 单次采样噪声大，开/关 PB3 前后
         *   两次采样 Δ 可能随机 ≥200 → 误判"有分压" → 两点校准算出 0%。
         *   物理事实: V03 无分压+无 100nF → PA3 纯高阻浮空, 多次平均后 Δ 趋近 0；
         *           V04 有分压+PA3 端 100nF → 开闸后迅速稳定到低阻抗 Vbat/2, 平均不改 Δ(巨大)。
         *   故改用"多次采样平均"消除浮空噪声: 平均后浮空 Δ 远小于阈值, 分压 Δ 仍巨大 → 可靠区分。 */
        uint8_t  i;
        uint32_t sumIdle = 0, sumAfter = 0;
        for (i = 0; i < 4; i++) {           // 闸门关闭: 浮空基线(平均 4 次)
            R8_ADC_CONVERT = RB_ADC_START;
            while (R8_ADC_CONVERT & RB_ADC_START);
            sumIdle += (R16_ADC_DATA & RB_ADC_DATA);
        }
        adcValIdle = (uint16_t)(sumIdle / 4);

        /* 开闸门上电分压 */
        GPIOB_SetBits(BAT_ADC_EN_PIN);
        DelayMs(BAT_ADC_EN_SETTLE_MS);

        for (i = 0; i < 4; i++) {           // 闸门开启: 分压采样(平均 4 次)
            R8_ADC_CONVERT = RB_ADC_START;
            while (R8_ADC_CONVERT & RB_ADC_START);
            sumAfter += (R16_ADC_DATA & RB_ADC_DATA);
        }
        adcVal = (uint16_t)(sumAfter / 4);

        /* 关闸门省电 */
#ifndef BAT_ADC_EN_ALWAYS_ON
        GPIOB_ResetBits(BAT_ADC_EN_PIN);
#endif

        /* ── ADC 电压两点校准 (2026-08-08 两点实测修正) ──
         * 单系数 K 无法同时校准两端: K=1627 → 4.0V报77%/4.14V报86%;
         * K=1603 → 4.0V报67%✓/4.14V报76%(偏14pp)。根因: ADC 有 DC 偏移(~1554counts),
         * 纯比例公式 batt_mV=K×adcVal 永远无法对齐两端→必须加截距 offset。
         * 两点校准 (Δadc=33, ΔmV=140):
         *   batt_mV = adcVal × K / 1000 - offset
         *   K=(4142-4002)×1000/(2530-2497)≈4242
         *   offset=2497×4242/1000-4002=6590
         * 验证: 4.002V→2497×4.242-6590=4002mV→67%✓
         *        4.142V→2530×4.242-6590=4142mV→90%✓
         *        4.200V(满电推估adc≈2544)→2544×4.242-6590=4202mV→100%✓
         *        3.600V(空电推估adc≈2403)→2403×4.242-6590=3604mV→0%✓
         * 后续若偏差 >5pp, 补采第3点验证线性度。 */
        /* ★ 2026-08-09 (C方案路线B升级): 用"开/关闸门前后 ΔadcVal"判定是否有分压电路。
         *   V03 无分压 → 开/关 PB3 前后 PA3 均浮空(纯高阻, 无 100nF) → 4 次平均后 Δ 趋近 0；
         *   V04 有分压 → 开 PB3 后 PA3=Vbat/2(adcVal~1755~2544, PA3 端 100nF 低阻抗驱动)，
         *               关前浮空 → 平均后 Δ 仍巨大(>1200)。
         *   ★ 已由"单次采样"升级为"4 次平均"消除浮空噪声(2026-08-09): 平均前浮空单次 Δ
         *     可能随机 ≥200 致 V03 误报 0%; 平均后浮空 Δ 远小于阈值, 分压 Δ 不变 → 可靠区分。
         *   阈值 300: V04 空电 adcVal≈1755 远高于平均后浮空 Δ(<50), 留足余量。 */
        if ((adcVal > adcValIdle ? adcVal - adcValIdle : adcValIdle - adcVal) < 300) {
            batteryLevel = 255;
            PRINT("[BATT] Init: no ext-battery divider (idle=%d, after=%d, Δ<%d) → 255 (unsupported)\n",
                  adcValIdle, adcVal, 300);
        } else {
        batt_mV = (uint32_t)adcVal * 4242 / 1000 - 6590;
        if (batt_mV >= BAT_ADC_FULL_MV) {
            batteryLevel = 100;
        } else if (batt_mV <= BAT_ADC_EMPTY_MV) {
            batteryLevel = 0;
        } else {
            batteryLevel = (uint8_t)((batt_mV - BAT_ADC_EMPTY_MV) * 100
                                     / (BAT_ADC_FULL_MV - BAT_ADC_EMPTY_MV));
        }
        PRINT("[BATT] Init: adcVal=%d, batt_mV=%d, level=%d%%\n", adcVal, batt_mV, batteryLevel);
        }

        R8_ADC_CFG     = savedCfg;
        R8_ADC_CHANNEL = savedChannel;
    }
}
#endif

void Battery_UpdateLevel(void)
{
#ifdef BOARD_HAS_EXT_BAT_ADC
    /* 纯寄存器 ADC 直读 + 两点校准 (K=4242, offset=6590, 2026-08-08 两点实测修正)。
     *   保留 GPIOAGPPCfg 每次重使能(防 Sleep 后 R16_PIN_ANALOG_IE 丢位),
     *   DelayMs(BAT_ADC_EN_SETTLE_MS) 等分压稳定 */
    {
        uint8_t  savedCfg     = R8_ADC_CFG;
        uint8_t  savedChannel = R8_ADC_CHANNEL;
        uint16_t adcValIdle;   // 闸门关闭时(分压未上电)的浮空基线
        uint16_t adcVal;
        uint32_t batt_mV;
        uint8_t  newLevel;

        /* 重设模拟通道(防 Sleep 丢位) + 先读"闸门关闭"浮空基线 */
        GPIOAGPPCfg(ENABLE, RB_PIN_ADC6_7_IE);
        GPIOA_ModeCfg(BAT_ADC_AIN_PIN, GPIO_ModeIN_Floating);
        R8_ADC_CFG     = RB_ADC_POWER_ON | RB_ADC_BUF_EN | (0 << 6) | (0 << 4);
        R8_ADC_CHANNEL = BAT_ADC_CHANNEL;

        /* ★ 2026-08-09 修复(C方案 V03 误报 0%): 同 Battery_Init, 多次平均消除浮空噪声。 */
        uint8_t  i;
        uint32_t sumIdle = 0, sumAfter = 0;
        for (i = 0; i < 4; i++) {
            R8_ADC_CONVERT = RB_ADC_START;
            while (R8_ADC_CONVERT & RB_ADC_START);
            sumIdle += (R16_ADC_DATA & RB_ADC_DATA);
        }
        adcValIdle = (uint16_t)(sumIdle / 4);

        /* 开闸门上电分压 */
        GPIOB_SetBits(BAT_ADC_EN_PIN);
        DelayMs(BAT_ADC_EN_SETTLE_MS);

        for (i = 0; i < 4; i++) {
            R8_ADC_CONVERT = RB_ADC_START;
            while (R8_ADC_CONVERT & RB_ADC_START);
            sumAfter += (R16_ADC_DATA & RB_ADC_DATA);
        }
        adcVal = (uint16_t)(sumAfter / 4);

        /* 关闸门 */
        GPIOB_ResetBits(BAT_ADC_EN_PIN);

        /* ★ 2026-08-09 (C方案路线B升级 + 多次平均修复): 用"开/关闸门前后 ΔadcVal(4 次平均)"判定是否有分压。
         *   V03 无分压 → 开/关 PB3 前后 PA3 均浮空(纯高阻, 无 100nF) → 平均后 Δ 趋近 0；
         *   V04 有分压 → 开闸后 PA3=Vbat/2(低阻抗 100nF 驱动, adcVal~1755~2544) → 平均后 Δ 仍巨大(>1200)。
         *   阈值 300: 平均后浮空 Δ 远小于此, 分压 Δ 不变, 留足余量防 V03 误报 0%。 */
        if ((adcVal > adcValIdle ? adcVal - adcValIdle : adcValIdle - adcVal) < 300) {
            if (batteryLevel != 255) {
                batteryLevel = 255;
                PRINT("[BATT] no ext-battery divider (idle=%d, after=%d, Δ<%d) → report 255 (unsupported)\n",
                      adcValIdle, adcVal, 200);
                Battery_Notify();
            }
            R8_ADC_CFG     = savedCfg;
            R8_ADC_CHANNEL = savedChannel;
            return;
        }
        if (adcVal >= 4000) {
            PRINT("[BATT][WARN] ADC saturated (val=%d), skip update\n", adcVal);
            R8_ADC_CFG     = savedCfg;
            R8_ADC_CHANNEL = savedChannel;
            return;
        }

        /* 校准换算 K=4242 offset=6590: 详见 Battery_Init() 同段注释 (2026-08-08 两点实测修正) */
        batt_mV = (uint32_t)adcVal * 4242 / 1000 - 6590;
        if (batt_mV >= BAT_ADC_FULL_MV) {
            newLevel = 100;
        } else if (batt_mV <= BAT_ADC_EMPTY_MV) {
            newLevel = 0;
        } else {
            newLevel = (uint8_t)((batt_mV - BAT_ADC_EMPTY_MV) * 100
                                 / (BAT_ADC_FULL_MV - BAT_ADC_EMPTY_MV));
        }

        if (newLevel != batteryLevel) {
            batteryLevel = newLevel;
            PRINT("[BATT] adcVal=%d, batt_mV=%d, level=%d%%\n", adcVal, batt_mV, batteryLevel);
            Battery_Notify();
        }

        R8_ADC_CFG     = savedCfg;
        R8_ADC_CHANNEL = savedChannel;
    }
#else
    /* ── 内部 VBAT ADC 逻辑 (V03: 经 LDO 恒 3.3V → 显示~100%) ── */
    uint16_t adcVal;
    uint16_t vdd_mV;
    uint8_t  newLevel;

    {
        uint8_t savedChannel = R8_ADC_CHANNEL;
        uint8_t savedCfg     = R8_ADC_CFG;

        /* 内部 VBAT 通道配置: 上电 + 输入缓冲 + PGA -12dB(1/4) + 采样时钟 3
         * ★ 必须用 -12dB: CH582M ADC 基准=1.05V, VBAT通道=VDD/3,
         *   若用 0dB 则 VDD≥3.15V 时输入端超量程→ADC 饱和在 4095→电压读错 */
        R8_ADC_CFG    = RB_ADC_POWER_ON | RB_ADC_BUF_EN | ADC_PGA_1_2 | (3 << 6);
        R8_ADC_CHANNEL = 14;   // CH_INTE_VBAT
        R8_ADC_CONVERT = RB_ADC_START;
        while (R8_ADC_CONVERT & RB_ADC_START);

        adcVal = R16_ADC_DATA;

        R8_ADC_CHANNEL = savedChannel;
        R8_ADC_CFG     = savedCfg;
    }

    /*
     * VBAT 内部通道: 电压 = VDD / 3，PGA = -12dB (1/4)，基准 = 1.05V bandgap
     * 所以: VDD(mV) = (adcVal * 1050 * 3 * 4) / 4096 = adcVal * 12600 / 4096
     */
    vdd_mV = (uint32_t)adcVal * 1050 * 12 / 4096;

    if (vdd_mV >= 4200) {
        newLevel = 100;
    } else if (vdd_mV <= 3000) {
        newLevel = 0;
    } else {
        newLevel = (uint8_t)((uint32_t)(vdd_mV - 3000) * 100 / 1200);
    }

    if (newLevel != batteryLevel) {
        batteryLevel = newLevel;
        PRINT("[BATT] Level updated: %d%%  (VDD=%d mV, ADC=%d)\n",
              batteryLevel, vdd_mV, adcVal);
        Battery_Notify();
    }
#endif
}

/* ════════════════════════════════════════════════════════════════════════════
 * GATT 读写回调
 * ════════════════════════════════════════════════════════════════════════════ */

static bStatus_t batt_ReadAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                  uint8_t *pValue, uint16_t *pLen,
                                  uint16_t offset, uint16_t maxLen, uint8_t method)
{
    uint16_t uuid = BUILD_UINT16(pAttr->type.uuid[0], pAttr->type.uuid[1]);

    switch (uuid) {
        case BATT_LEVEL_UUID:
            if (offset >= BATT_LEVEL_LEN) {
                return ATT_ERR_INVALID_OFFSET;
            }
            *pLen = MIN(maxLen, BATT_LEVEL_LEN - offset);
            pValue[0] = batteryLevel;
            return SUCCESS;

        default:
            *pLen = 0;
            return ATT_ERR_ATTR_NOT_FOUND;
    }
}

static bStatus_t batt_WriteAttrCB(uint16_t connHandle, gattAttribute_t *pAttr,
                                   uint8_t *pValue, uint16_t len,
                                   uint16_t offset, uint8_t method)
{
    uint16_t uuid = BUILD_UINT16(pAttr->type.uuid[0], pAttr->type.uuid[1]);

    switch (uuid) {
        case GATT_CLIENT_CHAR_CFG_UUID:
            return GATTServApp_ProcessCCCWriteReq(connHandle, pAttr,
                                                   pValue, len, offset,
                                                   GATT_CLIENT_CFG_NOTIFY);

        default:
            return ATT_ERR_ATTR_NOT_FOUND;
    }
}
