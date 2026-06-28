/*
 * Step 3 - Test basic BLE (no callbacks, just advertise)
 */

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

#define PIN_LED 8

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
    Serial.println("  STEP 3 - Testing BLE init...");
    Serial.println("============================================");

    Serial.print("[1] BLEDevice::init... ");
    BLEDevice::init("Test-Step3");
    Serial.println("OK");

    Serial.print("[2] createServer... ");
    BLEServer* server = BLEDevice::createServer();
    Serial.println("OK");

    Serial.print("[3] createService... ");
    BLEService* service = server->createService("0000ff00-0000-1000-8000-00805f9b34fb");
    Serial.println("OK");

    Serial.print("[4] service->start... ");
    service->start();
    Serial.println("OK");

    Serial.print("[5] startAdvertising... ");
    BLEAdvertising* adv = BLEDevice::getAdvertising();
    adv->addServiceUUID("0000ff00-0000-1000-8000-00805f9b34fb");
    BLEDevice::startAdvertising();
    Serial.println("OK");

    Serial.println();
    Serial.println("STEP 3 PASSED - BLE advertising as Test-Step3");
    Serial.println("Scan with nRF Connect to verify");
    Serial.println();
}

void loop() {
    static unsigned long last = 0;
    if (millis() - last >= 1000) {
        last = millis();
        digitalWrite(PIN_LED, !digitalRead(PIN_LED));
        Serial.print(".");
    }
    delay(10);
}
