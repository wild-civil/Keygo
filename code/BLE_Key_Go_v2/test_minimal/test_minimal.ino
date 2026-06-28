/*
 * Minimal test - verify ESP32-C3 serial output works
 * No BLE, no Preferences, just Serial + LED blink
 */

#define PIN_LED 8

void setup() {
    // LED blink 3 times
    pinMode(PIN_LED, OUTPUT);
    for (int i = 0; i < 3; i++) {
        digitalWrite(PIN_LED, HIGH);
        delay(200);
        digitalWrite(PIN_LED, LOW);
        delay(200);
    }

    // Try Serial
    Serial.begin(115200);
    delay(2000);  // wait for USB CDC

    Serial.println();
    Serial.println("============================================");
    Serial.println("  MINIMAL TEST - Serial OK");
    Serial.println("============================================");
    Serial.print("Chip: ");
    Serial.println(ESP.getChipModel());
    Serial.print("Cores: ");
    Serial.println(ESP.getChipCores());
    Serial.print("Flash: ");
    Serial.print(ESP.getFlashChipSize() / (1024 * 1024));
    Serial.println(" MB");
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
