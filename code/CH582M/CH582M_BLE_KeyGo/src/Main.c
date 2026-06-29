/********************************** (C) COPYRIGHT *******************************
 * File Name          : Main.c
 * Author             : BLE-Key-Go Project
 * Version            : V3.5
 * Date               : 2026/06/29
 * Description        : BLE-Key-Go 智能车钥匙 - CH582M 移植版
 *                      功能与 ESP32 v3.5 版本完全兼容
 *********************************************************************************
 * 移植说明：
 *  - 本文件包含应用层主循环和 BLE 协议栈适配接口
 *  - BLE 底层协议栈使用 WCH CH58x 官方 BLE 库（需从沁恒官网获取）
 *  - GATT 服务定义、事件回调需要在 BLE 初始化时注册
 *  - 所有业务逻辑已在各模块中实现，与协议栈无关
 *******************************************************************************/

#include "config.h"
#include "config_storage.h"
#include "kalman_filter.h"
#include "state_machine.h"
#include "relay_ctrl.h"
#include "led_ctrl.h"
#include "button_ctrl.h"
#include "gatt_service.h"
#include "ble_security.h"

/* ============================================================
 *  全局变量定义
 * ============================================================ */

SystemConfig_t g_cfg;
RuntimeState_t g_st;

volatile uint32_t g_sysTickMs = 0;

static KalmanFilter_t main_kf;
static uint32_t last_rssi_read_ms = 0;
static uint32_t last_status_notify_ms = 0;

/* ============================================================
 *  SysTick 定时器初始化 (TMR0)
 * ============================================================ */

static void SysTick_Init(void) {
    TMR0_TimerInit(FREQ_SYS / 1000);   // 1ms 中断
    TMR0_ITCfg(ENABLE, TMR0_3_IT_CYC_END);
    PFIC_EnableIRQ(TMR0_IRQn);
}

__INTERRUPT
__HIGH_CODE
void TMR0_IRQHandler(void) {
    if (TMR0_GetITFlag(TMR0_3_IT_CYC_END)) {
        TMR0_ClearITFlag(TMR0_3_IT_CYC_END);
        g_sysTickMs++;
    }
}

uint32_t GetSysTickMs(void) {
    return g_sysTickMs;
}

void Delay_Ms(uint32_t ms) {
    uint32_t start = g_sysTickMs;
    while (g_sysTickMs - start < ms);
}

/* ============================================================
 *  串口初始化 (UART1)
 * ============================================================ */

static void UART_Init(void) {
    GPIOA_SetBits(GPIO_Pin_9);
    GPIOA_ModeCfg(GPIO_Pin_8, GPIO_ModeIN_PU);
    GPIOA_ModeCfg(GPIO_Pin_9, GPIO_ModeOut_PP_5mA);
    UART1_DefInit();
    UART1_BaudRateCfg(115200);
}

void uart_print(const char *s) {
    while (*s) {
        while (UART1_GetTxRoomLeft() == 0);
        UART1_SendByte(*s++);
    }
}

void uart_printf(const char *fmt, ...) {
    char buf[256];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    uart_print(buf);
}

/* ============================================================
 *  获取设备 MAC 地址
 *  CH582M 的蓝牙 MAC 地址存储在 Information Block
 * ============================================================ */

static void GetDeviceMac(uint8_t *mac) {
    uint8_t *ib_mac = (uint8_t *)0x40640;
    memcpy(mac, ib_mac, 6);
}

/* ============================================================
 *  按键回调
 * ============================================================ */

static void onButtonShortPress(void) {
    uart_print("[SEC] Short press -> pairing mode\r\n");
    BLESec_DeleteAllBonds();
    g_st.pairingModeActive = true;
    g_st.pairingModeStartMs = GetSysTickMs();
    GattSrv_NotifyStatus();
}

static void onButtonLongPress(void) {
    uart_print("[FACTORY] RESET -> clearing all\r\n");

    BLESec_DeleteAllBonds();

    strcpy(g_cfg.pairingPin, DEFAULT_PAIRING_PIN);
    g_cfg.pinDefault = true;
    g_cfg.customDeviceName[0] = '\0';

    Storage_FactoryReset();

    for (int i = 0; i < 3; i++) {
        GPIOA_SetBits(PIN_LED);
        Delay_Ms(100);
        GPIOA_ResetBits(PIN_LED);
        Delay_Ms(200);
    }

    uart_print("[FACTORY] Reset complete. Restarting...\r\n");
    Delay_Ms(1000);
    SYS_ResetExecute();
}

/* ============================================================
 *  GATT Notify 回调实现
 *  功能：通过 BLE 协议栈发送 Notify
 *  注意：需要根据 WCH BLE 库的 API 适配此函数
 * ============================================================ */

static void gattNotifyImpl(uint16_t connHandle, const uint8_t *data, uint16_t len) {
    /*
     * TODO: 根据 WCH BLE 库的 API 实现 Notify 发送
     *
     * WCH BLE 库通常的调用方式：
     *   GATT_Notify(connHandle, statusCharHandle, data, len);
     *
     *  或者通过 GATT 特征值的通知函数发送。
     *  具体函数名请参考 WCH CH58x BLE 库文档。
     *
     *  伪代码：
     *  tmos_set_event(gapRoleTaskId, SEND_NOTI_EVT);
     *  或者直接调用 GATT_Notification()
     */

    /* 调试输出 */
    uart_printf("[GATT] Notify %d bytes: %s\r\n", len, (const char *)data);
}

/* ============================================================
 *  GATT 断开连接回调实现
 * ============================================================ */

static void gattDisconnectImpl(uint16_t connHandle) {
    /*
     * TODO: 根据 WCH BLE 库的 API 实现断开连接
     *
     * 伪代码：
     *  GAP_TerminateLinkReq(connHandle, 0x13);
     */
    uart_printf("[GATT] Disconnect req: handle=%d\r\n", connHandle);
}

/* ============================================================
 *  BLE 协议栈事件回调（GAP + GATT + SM）
 *
 *  注意：以下函数需要在 BLE 初始化时注册为回调
 *  具体注册方式请参考 WCH CH58x BLE 库文档
 * ============================================================ */

/* --- GAP 连接事件 --- */
void BLE_OnConnect(uint16_t connHandle, uint8_t *peerAddr) {
    g_st.deviceConnected = true;
    g_st.encryptionEstablished = false;
    g_st.wasBondedOnConnect = g_st.hasBondedDevices;
    g_st.securityRequestPending = true;
    g_st.securityRequestAtMs = GetSysTickMs();
    g_st.connectionHandle = connHandle;
    g_st.connectStartMs = GetSysTickMs();
    memcpy(g_st.peerAddr, peerAddr, MAC_ADDR_LEN);

    g_st.latestRSSI = -999;
    g_st.filteredRSSI = -999;
    Kalman_Reset(&main_kf);
    StateMachine_Reset();

    uart_printf("[BLE] Connected, handle=%d\r\n", connHandle);
    GattSrv_NotifyStatus();
}

void BLE_OnDisconnect(uint16_t connHandle, uint8_t reason) {
    g_st.deviceConnected = false;
    g_st.encryptionEstablished = false;
    g_st.wasBondedOnConnect = false;
    g_st.securityRequestPending = false;
    g_st.latestRSSI = -999;
    g_st.disconnectTimestampMs = GetSysTickMs();
    Kalman_Reset(&main_kf);
    StateMachine_Reset();

    uart_printf("[BLE] Disconnected, reason=0x%02X\r\n", reason);

    /* 重新开始广播 */
    /* TODO: 调用 WCH BLE 库的广播启动函数 */

    GattSrv_NotifyStatus();
}

/* --- GATT 写入事件 --- */
void BLE_OnConfigWrite(uint16_t connHandle, uint8_t *data, uint16_t len) {
    if (!g_st.encryptionEstablished) {
        uart_print("[GATT] Config write rejected (not encrypted)\r\n");
        return;
    }
    GattSrv_OnConfigWrite(data, len);
}

void BLE_OnCommandWrite(uint16_t connHandle, uint8_t *data, uint16_t len) {
    if (!g_st.encryptionEstablished) {
        uart_print("[GATT] Command write rejected (not encrypted)\r\n");
        return;
    }
    GattSrv_OnCommandWrite(data, len);
}

uint16_t BLE_OnStatusRead(uint16_t connHandle, uint8_t *buf, uint16_t bufLen) {
    if (!g_st.encryptionEstablished) {
        return 0;
    }
    return GattSrv_OnStatusRead(buf, bufLen);
}

uint16_t BLE_OnSerialRead(uint16_t connHandle, uint8_t *buf, uint16_t bufLen) {
    if (!g_st.encryptionEstablished) {
        return 0;
    }
    return GattSrv_OnSerialRead(buf, bufLen);
}

/* --- SM (Security Manager) 事件 --- */
uint32_t BLE_OnPassKeyRequest(void) {
    BLESec_OnPassKeyRequest();
    return BLESec_GetPinCode();
}

void BLE_OnAuthComplete(bool success) {
    BLESec_OnAuthComplete(success);
}

/* ============================================================
 *  BLE 初始化
 *
 *  TODO: 根据 WCH CH58x BLE 库的 API 完成以下初始化
 *  1. 初始化 BLE 协议栈
 *  2. 设置设备名称
 *  3. 注册 GAP 事件回调
 *  4. 添加 GATT 服务 (FF00) 和特征值 (FF01-FF04)
 *  5. 设置特征值权限（加密读写）
 *  6. 配置 SM (Security Manager)
 *  7. 开始广播
 * ============================================================ */

static void BLE_Init(void) {
    /*
     * TODO: 使用 WCH BLE 库完成以下初始化
     *
     * 参考步骤（以 WCH 典型 BLE 库为例）：
     *
     * 1. 初始化协议栈
     *    CH58xBLE_Init();
     *
     * 2. 设置设备名称
     *    GAP_SetDeviceName(g_cfg.deviceName);
     *
     * 3. 注册 GAP 回调
     *    GAP_RegisterAppCB(BLE_OnConnect, BLE_OnDisconnect);
     *
     * 4. 添加 GATT 服务和特征值
     *    GATT_AddService(serviceUUID);
     *    GATT_AddCharacteristic(FF01, GATT_PERM_WRITE_ENCRYPTED, BLE_OnConfigWrite);
     *    GATT_AddCharacteristic(FF02, GATT_PERM_READ_ENCRYPTED | GATT_PERM_NOTIFY, BLE_OnStatusRead);
     *    GATT_AddCharacteristic(FF03, GATT_PERM_WRITE_ENCRYPTED, BLE_OnCommandWrite);
     *    GATT_AddCharacteristic(FF04, GATT_PERM_READ_ENCRYPTED, BLE_OnSerialRead);
     *
     * 5. 配置 SM
     *    SM_SetIOCapability(SM_IO_CAP_DISPLAY_ONLY);
     *    SM_SetAuthReq(SM_AUTH_REQ_SC_BOND);
     *    SM_SetPassKeyCallback(BLE_OnPassKeyRequest);
     *    SM_SetAuthCompleteCallback(BLE_OnAuthComplete);
     *
     * 6. 设置广播数据
     *    广播包: 设备名称 "KeyGo-XXXXXX"
     *    扫描响应: Service UUID FF00 + Manufacturer Data
     *
     * 7. 开始广播
     *    GAP_StartAdvertising();
     */

    /* 注册应用层回调 */
    gattNotifyCallback = gattNotifyImpl;
    gattDisconnectCallback = gattDisconnectImpl;

    uart_print("[BLE] BLE init (WCH stack integration required)\r\n");
}

/* ============================================================
 *  RSSI 读取
 * ============================================================ */

static void ReadConnectionRSSI(void) {
    if (!g_st.deviceConnected) return;

    /*
     * TODO: 根据 WCH BLE 库的 API 读取连接 RSSI
     *
     * 伪代码：
     *  int8_t rssi = 0;
     *  if (GAP_ReadRSSI(g_st.connectionHandle, &rssi) == SUCCESS) {
     *      // RSSI 读取结果会通过事件回调返回
     *  }
     *
     *  或者某些库直接返回 RSSI 值
     */

    /* 调试占位：实际使用时删除以下手动注入逻辑 */
    if (g_st.rssiInitialized) {
        /* 这里应该从 BLE 协议栈获取 RSSI */
    }
}

/* RSSI 结果回调 - 在 BLE GAP 事件中调用 */
void BLE_OnRSSIRead(int8_t rssi) {
    g_st.latestRSSI = rssi;

    int16_t outRssi;
    if (!SpikeReject_Process(rssi, g_st.filteredRSSI,
                             g_cfg.rssiSpikeRejectDb,
                             SPIKE_CONSECUTIVE_REQUIRED, &outRssi)) {
        g_st.filteredRSSI = Kalman_Update(&main_kf, (float)outRssi);
        g_st.rssiInitialized = true;
    }
}

/* ============================================================
 *  主循环
 * ============================================================ */

int main(void) {
    SetSysClock(CLK_SOURCE_PLL_60MHz);

    /* 早期 LED 闪烁 */
    GPIOA_ModeCfg(PIN_LED, GPIO_ModeOut_PP_5mA);
    for (int i = 0; i < 3; i++) {
        GPIOA_SetBits(PIN_LED);
        Delay_Ms(150);
        GPIOA_ResetBits(PIN_LED);
        Delay_Ms(150);
    }

    /* 初始化 SysTick */
    SysTick_Init();

    /* 初始化串口 */
    UART_Init();
    uart_print("\r\n============================================\r\n");
    uart_print("  BLE-Key-Go v3.5 (CH582M)\r\n");
    uart_print("============================================\r\n");

    /* 获取设备 MAC，生成唯一名 */
    GetDeviceMac(g_cfg.deviceMac);
    snprintf(g_cfg.deviceName, sizeof(g_cfg.deviceName), "%s-%02X%02X%02X",
             DEVICE_NAME_PREFIX,
             g_cfg.deviceMac[3], g_cfg.deviceMac[4], g_cfg.deviceMac[5]);
    snprintf(g_cfg.serialNumber, sizeof(g_cfg.serialNumber),
             "%02X%02X%02X%02X%02X%02X",
             g_cfg.deviceMac[0], g_cfg.deviceMac[1], g_cfg.deviceMac[2],
             g_cfg.deviceMac[3], g_cfg.deviceMac[4], g_cfg.deviceMac[5]);

    uart_printf("  Device: %s\r\n", g_cfg.deviceName);
    uart_printf("  Serial: %s\r\n", g_cfg.serialNumber);

    /* 初始化 Flash 存储，加载配置 */
    Storage_Init();
    Storage_LoadToGlobal();

    /* 初始化继电器 */
    Relay_Init();
    Relay_AllOff();

    /* 初始化 LED */
    LED_Init();

    /* 初始化按键 */
    Button_Init();
    Button_SetCallbacks(onButtonShortPress, onButtonLongPress);

    /* 初始化 Kalman 滤波器 */
    Kalman_Init(&main_kf, g_cfg.kf_q, g_cfg.kf_r);
    g_st.filteredRSSI = -999;
    g_st.latestRSSI = -999;
    g_st.rssiInitialized = false;

    /* 初始化状态机 */
    StateMachine_Init();
    g_st.currentState = STATE_LOCKED;

    /* 初始化 BLE 安全模块 */
    BLESec_Init();

    /* 初始化 GATT 服务应用层 */
    GattSrv_Init();

    /* 检查已绑定设备数 */
    g_st.hasBondedDevices = (BLESec_CountBondedDevices() > 0);

    /* 初始化 BLE 协议栈 */
    BLE_Init();

    uart_printf("[CFG] unlock=%d lock=%d hyst=%d spike=%d uc=%d lc=%d\r\n",
                g_cfg.rssiUnlockThreshold, g_cfg.rssiLockThreshold,
                g_cfg.rssiHysteresisDb, g_cfg.rssiSpikeRejectDb,
                g_cfg.unlockCountRequired, g_cfg.lockCountRequired);
    uart_printf("[SEC] PIN: %s (default: %s)\r\n",
                g_cfg.pinDefault ? "DEFAULT" : "custom",
                g_cfg.pinDefault ? "yes" : "no");
    uart_printf("[SEC] Bonded devices: %d\r\n", BLESec_CountBondedDevices());

    last_rssi_read_ms = GetSysTickMs();
    last_status_notify_ms = GetSysTickMs();

    /* 主循环 */
    while (1) {
        /* 处理按键 */
        Button_Process();

        /* --- 安全请求延迟发起 --- */
        if (g_st.securityRequestPending && g_st.deviceConnected && !g_st.encryptionEstablished) {
            if (GetSysTickMs() - g_st.securityRequestAtMs >= SECURITY_REQUEST_DELAY_MS) {
                g_st.securityRequestPending = false;
                uart_print("[SEC] Requesting encryption...\r\n");
                /*
                 * TODO: 调用 WCH BLE 库发起加密请求
                 * 伪代码：
                 * SM_InitiateSecurity(g_st.connectionHandle);
                 */
            }
        }

        /* --- Bonding 超时检测 --- */
        if (g_st.deviceConnected) {
            static bool timeoutWarned = false;
            uint32_t elapsed = GetSysTickMs() - g_st.connectStartMs;
            if (elapsed > BONDING_TIMEOUT_MS && !timeoutWarned) {
                if (!g_st.encryptionEstablished) {
                    if (g_st.wasBondedOnConnect) {
                        uart_print("[SEC] Bonding timeout with stale bond -> clearing\r\n");
                        BLESec_DeleteAllBonds();
                    } else if (!g_st.hasBondedDevices) {
                        uart_print("[SEC] Bonding timeout -> disconnecting\r\n");
                        if (gattDisconnectCallback) {
                            gattDisconnectCallback(g_st.connectionHandle);
                        }
                    }
                }
                timeoutWarned = true;
            }
            if (!g_st.deviceConnected) {
                timeoutWarned = false;
            }
        }

        /* --- 配对模式超时 --- */
        if (g_st.pairingModeActive &&
            GetSysTickMs() - g_st.pairingModeStartMs >= DEFAULT_PAIRING_TIMEOUT) {
            g_st.pairingModeActive = false;
            uart_print("[SEC] pairing mode timeout\r\n");
            GattSrv_NotifyStatus();
        }

        /* --- RSSI 采样 --- */
        if (g_st.deviceConnected &&
            GetSysTickMs() - last_rssi_read_ms >= g_cfg.rssiSampleIntervalMs) {
            last_rssi_read_ms = GetSysTickMs();
            ReadConnectionRSSI();
        }

        /* --- 状态机处理 --- */
        if (g_st.deviceConnected && g_st.rssiInitialized) {
            StateMachine_Process(g_st.filteredRSSI);
        } else if (!g_st.deviceConnected &&
                   g_st.currentState == STATE_UNLOCKED &&
                   g_cfg.disconnectLockDelayMs > 0 &&
                   GetSysTickMs() - g_st.disconnectTimestampMs >= g_cfg.disconnectLockDelayMs) {
            uart_print("[SAFETY] disconnected while unlocked, auto lock\r\n");
            g_st.currentState = STATE_ACTION;
            Relay_ExecuteLock();
            g_st.currentState = STATE_LOCKED;
            GattSrv_NotifyStatus();
        }

        /* --- 状态 Notify --- */
        if (GetSysTickMs() - last_status_notify_ms >= STATUS_NOTIFY_INTERVAL) {
            last_status_notify_ms = GetSysTickMs();
            GattSrv_NotifyStatus();
        }

        /* --- LED 更新 --- */
        LED_Update();

        /*
         * TODO: 调用 WCH BLE 库的事件处理函数
         * 例如：TMOS_SystemProcess();
         * 或者其他协议栈轮询函数
         */

        Delay_Ms(10);
    }
}
