#include <string.h>
#include "es8311.h"
#include "Wire.h"
#include "esp_log.h"
#include "esp_err.h"
#include "esp_check.h"
#include "es8311_reg.h"

typedef struct {
    int port;
    uint16_t dev_addr;
} es8311_dev_t;

static const char *TAG = "ES8311";

static inline esp_err_t es8311_write_reg(es8311_handle_t dev, uint8_t reg_addr, uint8_t data)
{
    es8311_dev_t *es = (es8311_dev_t *)dev;

    Wire.beginTransmission((uint8_t)es->dev_addr);
    Wire.write(reg_addr);
    Wire.write(data);

    uint8_t err = Wire.endTransmission(true);

    if (err == 0) {
        return ESP_OK;
    }

    ESP_LOGE(TAG, "I2C write failed. dev=0x%02X reg=0x%02X err=%u", es->dev_addr, reg_addr, err);
    return ESP_FAIL;
}

static inline esp_err_t es8311_read_reg(es8311_handle_t dev, uint8_t reg_addr, uint8_t *reg_value)
{
    es8311_dev_t *es = (es8311_dev_t *)dev;

    Wire.beginTransmission((uint8_t)es->dev_addr);
    Wire.write(reg_addr);

    uint8_t err = Wire.endTransmission(false);
    if (err != 0) {
        ESP_LOGE(TAG, "I2C read address failed. dev=0x%02X reg=0x%02X err=%u", es->dev_addr, reg_addr, err);
        return ESP_FAIL;
    }

    uint8_t count = Wire.requestFrom((uint8_t)es->dev_addr, (uint8_t)1, (uint8_t)true);

    if (count != 1 || !Wire.available()) {
        ESP_LOGE(TAG, "I2C read failed. dev=0x%02X reg=0x%02X count=%u", es->dev_addr, reg_addr, count);
        return ESP_FAIL;
    }

    *reg_value = Wire.read();
    return ESP_OK;
}

esp_err_t es8311_sample_frequency_config(es8311_handle_t dev, int mclk_frequency, int sample_frequency)
{
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_CLK_MANAGER_REG02, 0x00), TAG, "reg02");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_CLK_MANAGER_REG03, 0x10), TAG, "reg03");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_CLK_MANAGER_REG04, 0x10), TAG, "reg04");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_CLK_MANAGER_REG05, 0x00), TAG, "reg05");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_CLK_MANAGER_REG06, 0x03), TAG, "reg06");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_CLK_MANAGER_REG07, 0x00), TAG, "reg07");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_CLK_MANAGER_REG08, 0xFF), TAG, "reg08");
    return ESP_OK;
}

esp_err_t es8311_init(es8311_handle_t dev, const es8311_clock_config_t *const clk_cfg, const es8311_resolution_t res_in,
                      const es8311_resolution_t res_out)
{
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_RESET_REG00, 0x1F), TAG, "reset1");
    vTaskDelay(pdMS_TO_TICKS(20));
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_RESET_REG00, 0x00), TAG, "reset2");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_RESET_REG00, 0x80), TAG, "power");

    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_CLK_MANAGER_REG01, 0x3F), TAG, "clock source");
    ESP_RETURN_ON_ERROR(es8311_sample_frequency_config(dev, clk_cfg->mclk_frequency, clk_cfg->sample_frequency), TAG, "sample freq");

    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_SDPIN_REG09, 0x0C), TAG, "sdpin");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_SDPOUT_REG0A, 0x0C), TAG, "sdpout");

    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_SYSTEM_REG0D, 0x01), TAG, "sys0d");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_SYSTEM_REG0E, 0x02), TAG, "sys0e");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_SYSTEM_REG12, 0x00), TAG, "sys12");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_SYSTEM_REG13, 0x10), TAG, "sys13");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_ADC_REG1C, 0x6A), TAG, "adc1c");
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_DAC_REG37, 0x08), TAG, "dac37");

    return ESP_OK;
}

void es8311_delete(es8311_handle_t dev)
{
    free(dev);
}

esp_err_t es8311_voice_volume_set(es8311_handle_t dev, int volume, int *volume_set)
{
    if (volume < 0) volume = 0;
    if (volume > 100) volume = 100;
    int reg32 = (volume == 0) ? 0 : ((volume * 256 / 100) - 1);
    if (volume_set) *volume_set = volume;
    return es8311_write_reg(dev, ES8311_DAC_REG32, reg32);
}

esp_err_t es8311_voice_volume_get(es8311_handle_t dev, int *volume)
{
    uint8_t reg32 = 0;
    ESP_RETURN_ON_ERROR(es8311_read_reg(dev, ES8311_DAC_REG32, &reg32), TAG, "volume get");
    *volume = (reg32 == 0) ? 0 : ((reg32 * 100) / 256) + 1;
    return ESP_OK;
}

esp_err_t es8311_voice_mute(es8311_handle_t dev, bool mute)
{
    uint8_t reg31 = 0;
    ESP_RETURN_ON_ERROR(es8311_read_reg(dev, ES8311_DAC_REG31, &reg31), TAG, "mute read");
    if (mute) reg31 |= (1 << 6) | (1 << 5);
    else reg31 &= ~((1 << 6) | (1 << 5));
    return es8311_write_reg(dev, ES8311_DAC_REG31, reg31);
}

esp_err_t es8311_microphone_gain_set(es8311_handle_t dev, es8311_mic_gain_t gain_db)
{
    return es8311_write_reg(dev, ES8311_ADC_REG16, gain_db);
}

esp_err_t es8311_microphone_config(es8311_handle_t dev, bool digital_mic)
{
    uint8_t reg14 = 0x1A;
    if (digital_mic) reg14 |= (1 << 6);
    ESP_RETURN_ON_ERROR(es8311_write_reg(dev, ES8311_ADC_REG17, 0xC8), TAG, "adc gain");
    return es8311_write_reg(dev, ES8311_SYSTEM_REG14, reg14);
}

esp_err_t es8311_voice_fade(es8311_handle_t dev, const es8311_fade_t fade) { return ESP_OK; }
esp_err_t es8311_microphone_fade(es8311_handle_t dev, const es8311_fade_t fade) { return ESP_OK; }

void es8311_register_dump(es8311_handle_t dev)
{
    for (int reg = 0; reg < 0x4A; reg++) {
        uint8_t value = 0;
        if (es8311_read_reg(dev, reg, &value) == ESP_OK) {
            printf("REG:%02x: %02x\n", reg, value);
        }
    }
}

es8311_handle_t es8311_create(const int port, const uint16_t dev_addr)
{
    es8311_dev_t *sensor = (es8311_dev_t *)calloc(1, sizeof(es8311_dev_t));
    if (!sensor) return NULL;
    sensor->port = port;
    sensor->dev_addr = dev_addr;
    return (es8311_handle_t)sensor;
}

esp_err_t es8311_codec_init(void)
{
    es8311_handle_t es_handle = es8311_create(0, ES8311_ADDRRES_0);
    ESP_RETURN_ON_FALSE(es_handle, ESP_FAIL, TAG, "es8311 create failed");

    const es8311_clock_config_t es_clk = {
        .mclk_inverted = false,
        .sclk_inverted = false,
        .mclk_from_mclk_pin = true,
        .mclk_frequency = EXAMPLE_MCLK_FREQ_HZ,
        .sample_frequency = EXAMPLE_SAMPLE_RATE
    };

    ESP_RETURN_ON_ERROR(es8311_init(es_handle, &es_clk, ES8311_RESOLUTION_16, ES8311_RESOLUTION_16), TAG, "init");
    ESP_RETURN_ON_ERROR(es8311_voice_volume_set(es_handle, EXAMPLE_VOICE_VOLUME, NULL), TAG, "volume");
    ESP_RETURN_ON_ERROR(es8311_microphone_config(es_handle, false), TAG, "microphone");
    // The setup previously never set the analog mic PGA, so it sat at the ~0 dB
    // reset value -> recordings came out very quiet. Boost the PGA (fw 1.5.8).
    // 30 dB is a strong, clean level for close speech; go to 36 dB if still low.
    ESP_RETURN_ON_ERROR(es8311_microphone_gain_set(es_handle, ES8311_MIC_GAIN_30DB), TAG, "mic gain");
    return ESP_OK;
}
