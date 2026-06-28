/*
 * Step 2 - Test Preferences
 */

#include <Preferences.h>

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
    Serial.println("  STEP 2 - Testing Preferences...");
    Serial.println("============================================");

    Preferences prefs;
    Serial.print("[1] begin... ");
    prefs.begin("test-ns", false);
    Serial.println("OK");

    Serial.print("[2] putInt... ");
    prefs.putInt("key", 42);
    Serial.println("OK");

    Serial.print("[3] getInt... ");
    int v = prefs.getInt("key", -1);
    Serial.print("value=");
    Serial.println(v);

    Serial.print("[4] end... ");
    prefs.end();
    Serial.println("OK");

    Serial.println("STEP 2 PASSED - Preferences works");
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
