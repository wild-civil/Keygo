/********************************** (C) COPYRIGHT *******************************
 * File Name          : appearance.h
 * Author             : KeyGo v3.13
 * Date               : 2026/07/03
 * Description        : BLE SIG GAP Appearance Values 完整宏定义
 *                      来源: Bluetooth SIG Assigned Numbers (2026版)
 *                      用法: #include "appearance.h"
 *                            advertData 里用 LO_UINT16(GAP_APPEARANCE_xxx)
 *
 * 注: CH58xBLE_ROM.h 已包含 0x0000~0x03C8 的常用值，
 *     本文件补充 0x03C9 起的新增类别（不重复定义已有的）。
 *********************************************************************************/

#ifndef __APPEARANCE_H__
#define __APPEARANCE_H__

/* ════════════════════════════════════════════════════════════════════════════
 * 0x0000 Unknown（未知，已有: CH58xBLE_ROM.h）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_UNKNOWN  0x0000 (已在 CH58xBLE_ROM.h)


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0010 Phone（电话，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_PHONE  0x0040


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0020 Computer（电脑，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_COMPUTER  0x0080


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0030 Watch（手表，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_WATCH   0x00C0
// GAP_APPEARE_WATCH_SPORTS    0x00C1
// GAP_APPEARE_WATCH_SMART     0x00C2 (新增)
#define GAP_APPEARE_WATCH_SMART              0x00C2  // Smartwatch


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0040 Clock（时钟，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_CLOCK  0x0100


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0050 Display（显示器，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_DISPLAY  0x0140


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0060 Remote Control（遥控器，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_RC  0x0180


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0070 Eye-glasses（眼镜，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_EYE_GALSSES  0x01C0


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0080 Tag（标签，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_TAG  0x0200


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0090 Keyring（钥匙扣，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_KEYRING  0x0240


/* ════════════════════════════════════════════════════════════════════════════
 * 0x00A0 Media Player（已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_MEDIA_PLAYER  0x0280


/* ════════════════════════════════════════════════════════════════════════════
 * 0x00B0 Barcode Scanner（已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_BARCODE_SCANNER  0x02C0


/* ════════════════════════════════════════════════════════════════════════════
 * 0x00C0 Thermometer（温度计，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_THERMOMETER  0x0300
// GAP_APPEARE_GENERIC_THERMO_EAR   0x0301


/* ════════════════════════════════════════════════════════════════════════════
 * 0x00D0 Heart Rate Sensor（心率，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_HR_SENSOR  0x0340
// GAP_APPEARE_GENERIC_HRS_BELT   0x0341


/* ════════════════════════════════════════════════════════════════════════════
 * 0x00E0 Blood Pressure（血压，已有）
 * ════════════════════════════════════════════════════════════════════════════ */
// GAP_APPEARE_GENERIC_BLOOD_PRESSURE  0x0380
// GAP_APPEARE_GENERIC_BP_ARM          0x0381
// GAP_APPEARE_GENERIC_BP_WRIST        0x0382


/* ════════════════════════════════════════════════════════════════════════════
 * 0x00F0 HID（人机接口设备，已有 0x03C0-0x03C8, 新增 0x03C9-0x03CA）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_HID_TOUCHPAD              0x03C9  // HID Touchpad
#define GAP_APPEARE_HID_PRESENTATION_REMOTE   0x03CA  // HID Presentation Remote


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0100 Glucose Meter（血糖仪）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_GLUCOSE_METER     0x0400  // Generic Glucose Meter


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0110 Running/Walking Sensor（跑步/步行传感器）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_RUNNING_WALKING    0x0440  // Generic Running/Walking Sensor
#define GAP_APPEARE_IN_SHOE_RUNNING_WALKING    0x0441  // In-Shoe
#define GAP_APPEARE_ON_SHOE_RUNNING_WALKING    0x0442  // On-Shoe
#define GAP_APPEARE_ON_HIP_RUNNING_WALKING     0x0443  // On-Hip


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0120 Cycling（骑行）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_CYCLING           0x0480  // Generic Cycling
#define GAP_APPEARE_CYCLING_COMPUTER          0x0481  // Cycling Computer
#define GAP_APPEARE_CYCLING_SPEED_SENSOR      0x0482  // Speed Sensor
#define GAP_APPEARE_CYCLING_CADENCE_SENSOR    0x0483  // Cadence Sensor
#define GAP_APPEARE_CYCLING_POWER_SENSOR      0x0484  // Power Sensor
#define GAP_APPEARE_CYCLING_SPEED_CADENCE     0x0485  // Speed and Cadence Sensor


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0130 Control Device（控制设备）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_CONTROL_DEVICE    0x04C0  // Generic Control Device
#define GAP_APPEARE_CONTROL_SWITCH            0x04C1  // Switch
#define GAP_APPEARE_CONTROL_MULTI_SWITCH      0x04C2  // Multi-switch
#define GAP_APPEARE_CONTROL_BUTTON            0x04C3  // Button
#define GAP_APPEARE_CONTROL_SLIDER            0x04C4  // Slider
#define GAP_APPEARE_CONTROL_ROTARY            0x04C5  // Rotary Switch
#define GAP_APPEARE_CONTROL_TOUCH_PANEL       0x04C6  // Touch Panel
#define GAP_APPEARE_CONTROL_SINGLE_SWITCH     0x04C7  // Single Switch
#define GAP_APPEARE_CONTROL_DOUBLE_SWITCH     0x04C8  // Double Switch
#define GAP_APPEARE_CONTROL_TRIPLE_SWITCH     0x04C9  // Triple Switch
#define GAP_APPEARE_CONTROL_BATTERY_SWITCH    0x04CA  // Battery Switch
#define GAP_APPEARE_CONTROL_ENERGY_HARVEST    0x04CB  // Energy Harvesting Switch
#define GAP_APPEARE_CONTROL_PUSH_BUTTON       0x04CC  // Push Button
#define GAP_APPEARE_CONTROL_DIAL              0x04CD  // Dial


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0140 Network Device（网络设备）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_NETWORK_DEVICE    0x0500  // Generic Network Device
#define GAP_APPEARE_NETWORK_ACCESS_POINT      0x0501  // Access Point
#define GAP_APPEARE_NETWORK_MESH              0x0502  // Mesh Device
#define GAP_APPEARE_NETWORK_PROXY             0x0503  // Mesh Network Proxy


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0150 Sensor（传感器）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_SENSOR            0x0540  // Generic Sensor
#define GAP_APPEARE_SENSOR_MOTION             0x0541  // Motion Sensor
#define GAP_APPEARE_SENSOR_AIR_QUALITY        0x0542  // Air Quality Sensor
#define GAP_APPEARE_SENSOR_TEMPERATURE        0x0543  // Temperature Sensor
#define GAP_APPEARE_SENSOR_HUMIDITY           0x0544  // Humidity Sensor
#define GAP_APPEARE_SENSOR_LEAK               0x0545  // Leak Sensor
#define GAP_APPEARE_SENSOR_SMOKE              0x0546  // Smoke Sensor
#define GAP_APPEARE_SENSOR_OCCUPANCY          0x0547  // Occupancy Sensor
#define GAP_APPEARE_SENSOR_CONTACT            0x0548  // Contact Sensor
#define GAP_APPEARE_SENSOR_CO                 0x0549  // Carbon Monoxide
#define GAP_APPEARE_SENSOR_CO2                0x054A  // Carbon Dioxide
#define GAP_APPEARE_SENSOR_AMBIENT_LIGHT      0x054B  // Ambient Light
#define GAP_APPEARE_SENSOR_ENERGY             0x054C  // Energy Sensor
#define GAP_APPEARE_SENSOR_COLOR_LIGHT        0x054D  // Color Light Sensor
#define GAP_APPEARE_SENSOR_RAIN               0x054E  // Rain Sensor
#define GAP_APPEARE_SENSOR_FIRE               0x054F  // Fire Sensor
#define GAP_APPEARE_SENSOR_WIND               0x0550  // Wind Sensor
#define GAP_APPEARE_SENSOR_PROXIMITY          0x0551  // Proximity Sensor
#define GAP_APPEARE_SENSOR_MULTI              0x0552  // Multi-Sensor
#define GAP_APPEARE_SENSOR_TIRE_PRESSURE      0x0559  // Vehicle Tire Pressure Sensor


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0160 Light Fixtures（灯具）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_LIGHT             0x0580  // Generic Light


/* ════════════════════════════════════════════════════════════════════════════
 * 0x01C0 Access Control（门禁/安防 —— 可能与 KeyGo 最相关的类别之一）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_ACCESS_CONTROL    0x0700  // Generic Access Control
#define GAP_APPEARE_ACCESS_DOOR               0x0701  // Access Door
#define GAP_APPEARE_ACCESS_GARAGE_DOOR        0x0702  // Garage Door
#define GAP_APPEARE_ACCESS_LOCK               0x0704  // Access Lock
#define GAP_APPEARE_ACCESS_DOOR_LOCK          0x0708  // Door Lock
#define GAP_APPEARE_ACCESS_LOCKER             0x0709  // Locker


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0230 Motorized Vehicle（机动车辆 —— ★ KeyGo 最匹配的类别！）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_VEHICLE           0x08C0  // Generic Motorized Vehicle
#define GAP_APPEARE_VEHICLE_CAR               0x08C1  // Car ★
#define GAP_APPEARE_VEHICLE_LGV               0x08C2  // Large Goods Vehicle
#define GAP_APPEARE_VEHICLE_2_WHEEL           0x08C3  // 2-Wheeled Vehicle
#define GAP_APPEARE_VEHICLE_MOTORBIKE         0x08C4  // Motorbike
#define GAP_APPEARE_VEHICLE_SCOOTER           0x08C5  // Scooter
#define GAP_APPEARE_VEHICLE_MOPED             0x08C6  // Moped
#define GAP_APPEARE_VEHICLE_3_WHEEL           0x08C7  // 3-Wheeled Vehicle
#define GAP_APPEARE_VEHICLE_LIGHT             0x08C8  // Light Vehicle
#define GAP_APPEARE_VEHICLE_QUAD_BIKE         0x08C9  // Quad Bike
#define GAP_APPEARE_VEHICLE_MINIBUS           0x08CA  // Minibus
#define GAP_APPEARE_VEHICLE_BUS               0x08CB  // Bus
#define GAP_APPEARE_VEHICLE_AGRICULTURAL      0x08CD  // Agricultural Vehicle
#define GAP_APPEARE_VEHICLE_CAMPER            0x08CE  // Camper / Caravan
#define GAP_APPEARE_VEHICLE_RV                0x08CF  // Recreational Vehicle


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0250 Wearable Audio（可穿戴音频）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_WEARABLE_AUDIO    0x0940  // Generic Wearable Audio
#define GAP_APPEARE_WEARABLE_EARBUD           0x0941  // Earbud
#define GAP_APPEARE_WEARABLE_HEADSET          0x0942  // Headset
#define GAP_APPEARE_WEARABLE_HEADPHONES       0x0943  // Headphones
#define GAP_APPEARE_WEARABLE_NECK_BAND        0x0944  // Neck Band


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0280 Display Equipment（显示设备）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_DISPLAY_EQUIP     0x0A00  // Generic Display Equipment
#define GAP_APPEARE_DISPLAY_TV                0x0A01  // Television
#define GAP_APPEARE_DISPLAY_MONITOR           0x0A02  // Monitor
#define GAP_APPEARE_DISPLAY_PROJECTOR         0x0A03  // Projector


/* ════════════════════════════════════════════════════════════════════════════
 * 0x02A0 Gaming（游戏）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_GAMING            0x0A80  // Generic Gaming
#define GAP_APPEARE_GAMING_HOME_CONSOLE       0x0A81  // Home Video Game Console
#define GAP_APPEARE_GAMING_PORTABLE           0x0A82  // Portable Handheld Console


/* ════════════════════════════════════════════════════════════════════════════
 * 0x0510 Outdoor Sports Activity（户外运动 / 位置导航）
 * ════════════════════════════════════════════════════════════════════════════ */
#define GAP_APPEARE_GENERIC_OUTDOOR_SPORTS    0x1440  // Generic Outdoor Sports Activity
#define GAP_APPEARE_OUTDOOR_LOCATION_DISPLAY  0x1441  // Location Display
#define GAP_APPEARE_OUTDOOR_LOCATION_NAV      0x1442  // Location and Navigation Display
#define GAP_APPEARE_OUTDOOR_LOCATION_POD      0x1443  // Location Pod
#define GAP_APPEARE_OUTDOOR_LOCATION_NAV_POD  0x1444  // Location and Navigation Pod


#endif /* __APPEARANCE_H__ */
