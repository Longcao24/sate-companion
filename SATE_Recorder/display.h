#ifndef __DISPLAY_H
#define __DISPLAY_H

#include "Arduino.h"
#include "lvgl.h"
#include "TFT_eSPI.h"

// Freenove FNK0104AB 2.8 inch 240x320 ILI9341.
#define FNK0104AB_2P8_240x320_ILI9341

#define TFT_DIRECTION 0

class Display
{
public:
    void init();
    void routine();
};

#endif
