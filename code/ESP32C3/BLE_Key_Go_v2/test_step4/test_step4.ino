/*
 * Step 4 - Test ServerCallbacks with NimBLE signature
 */

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

#define PIN_LED 8

bool deviceConnected = false;

class TestCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer* server, ble_gap_conn_desc* desc) override {
        deviceConnected = true;
        Serial.printf("[BLE] connected, conn_handle=%u\n", desc->conn_handle);
    }

    void onDisconnect(BLEServer* server, ble_gap_conn_desc* desc) override {
        deviceConnected = false;
        Serial.println("[BLE] disconnected");
        BLEDevice::startAdvertising();
    }
};

void setup() {
    pinMode(PIN_LED, OUTPUT);
    for (int i = 0; i < 3; i++) {
        digitalWrite(PIN_LED, HIGH); delay(200);
        digitalWrite(PIN_LED, LOW);  delay(200);
    }

    Serial.begin(115200);
    delay(2000);

    Serial.println();
    Serial.println("============================================");
    Serial.println("  STEP 4 - Testing ServerCallbacks (NimBLE)");
    Serial.println("============================================");

    BLEDevice::init("Test-Step4");
    BLEServer* server = BLEDevice::createServer();
    server->setCallbacks(new TestCallbacks());

    BLEService* service = server->createService("0000ff00-0000-1000-8000-00805f9b34fb");
    service->start();

    BLEAdvertising* adv = BLEDevice::getAdvertising();
    adv->addServiceUUID("0000ff00-0000-1000-8000-00805f9b34fb");
    BLEDevice::startAdvertising();

    Serial.println("[BLE] advertising as Test-Step4, connect with nRF Connect");
}

void loop() {
    digitalWrite(PIN_LED, deviceConnected ? HIGH : LOW);
    delay(100);
}
