#include "CH58x_common.h"

#define LED_PIN     GPIO_Pin_12
#define LED_PORT    GPIOA

int main()
{
    SetSysClock(CLK_SOURCE_PLL_60MHz);

    GPIOA_ModeCfg(LED_PIN, GPIO_ModeOut_PP_5mA);
    GPIOA_SetBits(LED_PIN);

    while(1)
    {
        GPIOA_InvertBits(LED_PIN);
        DelayMs(500);
    }
}
