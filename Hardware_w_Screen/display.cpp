#include "display.h"
#include "Wire.h"
#include "esp_heap_caps.h"

static const uint16_t screenWidth  = 240;
static const uint16_t screenHeight = 320;

// LVGL draw buffers.
// v2: double-buffered, allocated from DMA-capable internal RAM at init.
// Double buffering lets LVGL render the next strip while the previous one
// is still being pushed to the TFT -> visibly smoother animations.
// If the allocation ever fails we fall back to a small static buffer, so
// the device always boots.
static const uint32_t DRAW_BUF_PIXELS = screenWidth * 24;   // 24 lines per strip

static lv_disp_draw_buf_t draw_buf;
static lv_color_t *draw_buf_1 = nullptr;
static lv_color_t *draw_buf_2 = nullptr;
static lv_color_t  draw_buf_fallback[screenWidth * 10];

TFT_eSPI tft = TFT_eSPI(screenWidth, screenHeight);

// FNK0104AB touch pins/chip.
// Uses Arduino Wire only, not Freenove FT6336U old I2C driver.
#define TOUCH_ADDR 0x38
#define TOUCH_INT_PIN 17
#define TOUCH_RST_PIN 18

#if LV_USE_LOG != 0
void my_print(const char *buf)
{
    Serial.print(buf);
    Serial.flush();
}
#endif

static bool touch_read_raw(uint16_t *x, uint16_t *y)
{
    Wire.beginTransmission(TOUCH_ADDR);
    Wire.write(0x02); // TD_STATUS
    if (Wire.endTransmission(false) != 0) {
        return false;
    }

    uint8_t count = Wire.requestFrom((uint8_t)TOUCH_ADDR, (uint8_t)5, (uint8_t)true);
    if (count < 5) {
        return false;
    }

    uint8_t points = Wire.read() & 0x0F;
    if (points == 0) {
        return false;
    }

    uint8_t xh = Wire.read();
    uint8_t xl = Wire.read();
    uint8_t yh = Wire.read();
    uint8_t yl = Wire.read();

    uint16_t rawX = ((xh & 0x0F) << 8) | xl;
    uint16_t rawY = ((yh & 0x0F) << 8) | yl;

    // Clamp to panel bounds.
    if (rawX >= screenWidth) rawX = screenWidth - 1;
    if (rawY >= screenHeight) rawY = screenHeight - 1;

    // TFT_DIRECTION 2 = display rotated 180 deg. Invert both axes so touch
    // stays aligned with the flipped UI.
    *x = (screenWidth - 1) - rawX;
    *y = (screenHeight - 1) - rawY;
    return true;
}

void my_touchpad_read(lv_indev_drv_t *indev_driver, lv_indev_data_t *data)
{
    static uint16_t lastX = 0;
    static uint16_t lastY = 0;

    uint16_t x = 0;
    uint16_t y = 0;

    if (touch_read_raw(&x, &y)) {
        lastX = x;
        lastY = y;
        data->state = LV_INDEV_STATE_PR;
        data->point.x = lastX;
        data->point.y = lastY;
    } else {
        data->state = LV_INDEV_STATE_REL;
        data->point.x = lastX;
        data->point.y = lastY;
    }
}

void my_disp_flush(lv_disp_drv_t *disp, const lv_area_t *area, lv_color_t *color_p)
{
    uint32_t w = area->x2 - area->x1 + 1;
    uint32_t h = area->y2 - area->y1 + 1;

    tft.startWrite();
    tft.setAddrWindow(area->x1, area->y1, w, h);
    tft.pushColors((uint16_t *)&color_p->full, w * h, true);
    tft.endWrite();

    lv_disp_flush_ready(disp);
}

void Display::init(void)
{
#if LV_USE_LOG != 0
    lv_log_register_print_cb(my_print);
#endif

    pinMode(TOUCH_RST_PIN, OUTPUT);
    digitalWrite(TOUCH_RST_PIN, LOW);
    delay(8);
    digitalWrite(TOUCH_RST_PIN, HIGH);
    delay(50);
    pinMode(TOUCH_INT_PIN, INPUT);

    lv_init();

    tft.begin();
    tft.setRotation(TFT_DIRECTION);

    // Allocate LVGL draw buffers from internal DMA-capable RAM.
    draw_buf_1 = (lv_color_t *)heap_caps_malloc(
        DRAW_BUF_PIXELS * sizeof(lv_color_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    draw_buf_2 = (lv_color_t *)heap_caps_malloc(
        DRAW_BUF_PIXELS * sizeof(lv_color_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);

    if (draw_buf_1 && draw_buf_2) {
        lv_disp_draw_buf_init(&draw_buf, draw_buf_1, draw_buf_2, DRAW_BUF_PIXELS);
        Serial.println("[DISPLAY] Double-buffered LVGL draw buffers (DMA RAM).");
    } else {
        // Free whichever half succeeded and use the static fallback.
        if (draw_buf_1) { heap_caps_free(draw_buf_1); draw_buf_1 = nullptr; }
        if (draw_buf_2) { heap_caps_free(draw_buf_2); draw_buf_2 = nullptr; }
        lv_disp_draw_buf_init(&draw_buf, draw_buf_fallback, NULL, screenWidth * 10);
        Serial.println("[DISPLAY] Fallback single LVGL draw buffer.");
    }

    static lv_disp_drv_t disp_drv;
    lv_disp_drv_init(&disp_drv);

    disp_drv.hor_res = screenWidth;
    disp_drv.ver_res = screenHeight;
    disp_drv.flush_cb = my_disp_flush;
    disp_drv.draw_buf = &draw_buf;

    lv_disp_drv_register(&disp_drv);

    static lv_indev_drv_t indev_drv;
    lv_indev_drv_init(&indev_drv);
    indev_drv.type = LV_INDEV_TYPE_POINTER;
    indev_drv.read_cb = my_touchpad_read;
    lv_indev_drv_register(&indev_drv);
}

void Display::routine(void)
{
    lv_timer_handler();
}
