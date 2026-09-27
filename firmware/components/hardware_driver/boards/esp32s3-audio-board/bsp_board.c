/**
 *
 * @copyright Copyright 2021 Espressif Systems (Shanghai) Co. Ltd.
 *
 *      Licensed under the Apache License, Version 2.0 (the "License");
 *      you may not use this file except in compliance with the License.
 *      You may obtain a copy of the License at
 *
 *               http://www.apache.org/licenses/LICENSE-2.0
 *
 *      Unless required by applicable law or agreed to in writing, software
 *      distributed under the License is distributed on an "AS IS" BASIS,
 *      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *      See the License for the specific language governing permissions and
 *      limitations under the License.
 */

#include "string.h"
#include "esp_heap_caps.h"
#include "bsp_board.h"
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
#include "driver/i2s_std.h"
#include "driver/i2s_tdm.h"
#include "soc/soc_caps.h"
#else
#include "driver/i2s.h"
#endif
#include "driver/gpio.h"
#include "esp_err.h"
#include "esp_log.h"
#include "driver/i2c.h"
#include "esp_rom_sys.h"
#include "esp_check.h"
#include "esp_vfs_fat.h"
#include "sdmmc_cmd.h"
#if ((SOC_SDMMC_HOST_SUPPORTED) && (FUNC_SDMMC_EN))
#include "driver/sdmmc_host.h"
#endif /* ((SOC_SDMMC_HOST_SUPPORTED) && (FUNC_SDMMC_EN)) */

#define GPIO_MUTE_NUM   GPIO_NUM_1
#define GPIO_MUTE_LEVEL 1
#define ACK_CHECK_EN   0x1     /*!< I2C master will check ack from slave*/
#define ADC_I2S_CHANNEL 4
static sdmmc_card_t *card;
static const char *TAG = "board";
static int s_play_sample_rate = 16000;
static int s_play_channel_format = 1;
static int s_bits_per_chan = 16;

/* Pre-allocated playback scratch — int32 stereo (8 bytes per int16 mono input).
   64KB covers ~16KB input frames (256ms of 16kHz int16 audio).
   Allocated once at boot in PSRAM to avoid per-call malloc which starved the codec. */
#define BSP_PLAY_SCRATCH_BYTES (64 * 1024)
static int *s_play_scratch = NULL;

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
static i2s_chan_handle_t                tx_handle = NULL;        // I2S tx channel handler
static i2s_chan_handle_t                rx_handle = NULL;        // I2S rx channel handler
#endif
static audio_codec_data_if_t *record_data_if = NULL;
static audio_codec_ctrl_if_t *record_ctrl_if = NULL;
static audio_codec_if_t *record_codec_if = NULL;
static esp_codec_dev_handle_t record_dev = NULL;

static audio_codec_data_if_t *play_data_if = NULL;
static audio_codec_ctrl_if_t *play_ctrl_if = NULL;
static audio_codec_gpio_if_t *play_gpio_if = NULL;
static audio_codec_if_t *play_codec_if = NULL;
static esp_codec_dev_handle_t play_dev = NULL;


esp_err_t bsp_i2c_init(i2c_port_t i2c_num, uint32_t clk_speed)
{
    i2c_config_t i2c_cfg = {
        .mode = I2C_MODE_MASTER,
        .scl_io_num = GPIO_I2C_SCL,
        .sda_io_num = GPIO_I2C_SDA,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = clk_speed,
    };
    esp_err_t ret = i2c_param_config(i2c_num, &i2c_cfg);
    if (ret != ESP_OK) {
        return ESP_FAIL;
    }
    return i2c_driver_install(i2c_num, i2c_cfg.mode, 0, 0, 0);
}

esp_err_t bsp_codec_adc_init(int sample_rate)
{
    esp_err_t ret_val = ESP_OK;

    // Do initialize of related interface: data_if, ctrl_if and gpio_if
    audio_codec_i2s_cfg_t i2s_cfg = {
        .port = I2S_NUM_1,
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
        .rx_handle = rx_handle,
        .tx_handle = NULL,
#endif
    };
    record_data_if = audio_codec_new_i2s_data(&i2s_cfg);

    audio_codec_i2c_cfg_t i2c_cfg = {.addr = ES7210_CODEC_DEFAULT_ADDR};
    record_ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
    // New input codec interface
    es7210_codec_cfg_t es7210_cfg = {
        .ctrl_if = record_ctrl_if,
        .mic_selected = ES7120_SEL_MIC1 | ES7120_SEL_MIC2 | ES7120_SEL_MIC3 | ES7120_SEL_MIC4,
    };
    record_codec_if = es7210_codec_new(&es7210_cfg);
    // New input codec device
    esp_codec_dev_cfg_t dev_cfg = {
        .codec_if = record_codec_if,
        .data_if = record_data_if,
        .dev_type = ESP_CODEC_DEV_TYPE_IN,
    };
    record_dev = esp_codec_dev_new(&dev_cfg);

    esp_codec_dev_sample_info_t fs = {
        .sample_rate = 16000,
        .channel = 2,
        .bits_per_sample = 32,
    };
    esp_codec_dev_open(record_dev, &fs);
    // esp_codec_dev_set_in_gain(record_dev, RECORD_VOLUME);
    esp_codec_dev_set_in_channel_gain(record_dev, ESP_CODEC_DEV_MAKE_CHANNEL_MASK(0), RECORD_VOLUME);
    esp_codec_dev_set_in_channel_gain(record_dev, ESP_CODEC_DEV_MAKE_CHANNEL_MASK(1), RECORD_VOLUME);
    esp_codec_dev_set_in_channel_gain(record_dev, ESP_CODEC_DEV_MAKE_CHANNEL_MASK(2), 0);
    esp_codec_dev_set_in_channel_gain(record_dev, ESP_CODEC_DEV_MAKE_CHANNEL_MASK(3), RECORD_VOLUME);

    return ret_val;
}

esp_err_t bsp_codec_dac_init(int sample_rate, int channel_format, int bits_per_chan)
{
    esp_err_t ret_val = ESP_OK;

    // Do initialize of related interface: data_if, ctrl_if and gpio_if
    audio_codec_i2s_cfg_t i2s_cfg = {
        .port = I2S_NUM_1,
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
        .rx_handle = NULL,
        .tx_handle = tx_handle,
#endif
    };
    play_data_if = audio_codec_new_i2s_data(&i2s_cfg);

    audio_codec_i2c_cfg_t i2c_cfg = {.addr = ES8311_CODEC_DEFAULT_ADDR};
    play_ctrl_if = audio_codec_new_i2c_ctrl(&i2c_cfg);
    play_gpio_if = audio_codec_new_gpio();
    // New output codec interface
    es8311_codec_cfg_t es8311_cfg = {
        .codec_mode = ESP_CODEC_DEV_WORK_MODE_DAC,
        .ctrl_if = play_ctrl_if,
        .gpio_if = play_gpio_if,
        .pa_pin = GPIO_PWR_CTRL,
        .use_mclk = true,
    };
    play_codec_if = es8311_codec_new(&es8311_cfg);
    // New output codec device
    esp_codec_dev_cfg_t dev_cfg = {
        .codec_if = play_codec_if,
        .data_if = play_data_if,
        .dev_type = ESP_CODEC_DEV_TYPE_OUT,
    };
    play_dev = esp_codec_dev_new(&dev_cfg);

    esp_codec_dev_sample_info_t fs = {
        .bits_per_sample = bits_per_chan,
        .sample_rate = sample_rate,
        .channel = channel_format,
    };
    esp_codec_dev_set_out_vol(play_dev, PLAYER_VOLUME);
    esp_codec_dev_open(play_dev, &fs);

    return ret_val;
}

static esp_err_t bsp_codec_adc_deinit()
{
    esp_err_t ret_val = ESP_OK;

    if (record_dev) {
        esp_codec_dev_close(record_dev);
        esp_codec_dev_delete(record_dev);
        record_dev = NULL;
    }

    // Delete codec interface
    if (record_codec_if) {
        audio_codec_delete_codec_if(record_codec_if);
        record_codec_if = NULL;
    }
    
    // Delete codec control interface
    if (record_ctrl_if) {
        audio_codec_delete_ctrl_if(record_ctrl_if);
        record_ctrl_if = NULL;
    }
    
    // Delete codec data interface
    if (record_data_if) {
        audio_codec_delete_data_if(record_data_if);
        record_data_if = NULL;
    }

    return ret_val;
}

static esp_err_t bsp_codec_dac_deinit()
{
    esp_err_t ret_val = ESP_OK;

    if (play_dev) {
        esp_codec_dev_close(play_dev);
        esp_codec_dev_delete(play_dev);
        play_dev = NULL;
    }

    // Delete codec interface
    if (play_codec_if) {
        audio_codec_delete_codec_if(play_codec_if);
        play_codec_if = NULL;
    }
    
    // Delete codec control interface
    if (play_ctrl_if) {
        audio_codec_delete_ctrl_if(play_ctrl_if);
        play_ctrl_if = NULL;
    }
    
    if (play_gpio_if) {
        audio_codec_delete_gpio_if(play_gpio_if);
        play_gpio_if = NULL;
    }
    
    // Delete codec data interface
    if (play_data_if) {
        audio_codec_delete_data_if(play_data_if);
        play_data_if = NULL;
    }

    return ret_val;
}

esp_err_t bsp_audio_set_play_vol(int volume)
{
    if (!play_dev) {
        ESP_LOGE(TAG, "DAC codec init fail");
        return ESP_FAIL;
    }
    esp_codec_dev_set_out_vol(play_dev, volume);
    return ESP_OK;
}

esp_err_t bsp_audio_get_play_vol(int *volume)
{
    if (!play_dev) {
        ESP_LOGE(TAG, "DAC codec init fail");
        return ESP_FAIL;
    }
    esp_codec_dev_get_out_vol(play_dev, volume);
    return ESP_OK;
}

// static esp_err_t bsp_i2s_init(i2s_port_t i2s_num, uint32_t sample_rate, i2s_channel_fmt_t channel_format, i2s_bits_per_chan_t bits_per_chan)
static esp_err_t bsp_i2s_init(i2s_port_t i2s_num, uint32_t sample_rate, int channel_format, int bits_per_chan)
{
    esp_err_t ret_val = ESP_OK;

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
    i2s_slot_mode_t channel_fmt = I2S_SLOT_MODE_STEREO;
    if (channel_format == 1) {
        channel_fmt = I2S_SLOT_MODE_MONO;
    } else if (channel_format == 2) {
        channel_fmt = I2S_SLOT_MODE_STEREO;
    } else {
        ESP_LOGE(TAG, "Unable to configure channel_format %d", channel_format);
        channel_format = 1;
        channel_fmt = I2S_SLOT_MODE_MONO;
    }

    if (bits_per_chan != 16 && bits_per_chan != 32) {
        ESP_LOGE(TAG, "Unable to configure bits_per_chan %d", bits_per_chan);
        bits_per_chan = 32;
    }

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(i2s_num, I2S_ROLE_MASTER);
    /* DMA descriptor max is 4092 bytes. With 32-bit stereo (8 bytes/frame) the max safe
       dma_frame_num is 4092/8 = 511. 8 descriptors × 511 frames at 16kHz ≈ 256ms buffer.
       auto_clear=true: when DMA is consumed faster than fed, descriptor goes silent
       instead of looping stale data — eliminates buzz/static on underrun. */
    chan_cfg.dma_desc_num = 8;
    chan_cfg.dma_frame_num = 511;
    chan_cfg.auto_clear = true;
    ret_val |= i2s_new_channel(&chan_cfg, &tx_handle, &rx_handle);
    i2s_std_config_t std_cfg = I2S_CONFIG_DEFAULT(sample_rate, channel_fmt, bits_per_chan);
    ret_val |= i2s_channel_init_std_mode(tx_handle, &std_cfg);
    ret_val |= i2s_channel_init_std_mode(rx_handle, &std_cfg);
    ret_val |= i2s_channel_enable(tx_handle);
    ret_val |= i2s_channel_enable(rx_handle);
#else
    i2s_channel_fmt_t channel_fmt = I2S_CHANNEL_FMT_RIGHT_LEFT;
    if (channel_format == 1) {
        channel_fmt = I2S_CHANNEL_FMT_ONLY_LEFT;
    } else if (channel_format == 2) {
        channel_fmt = I2S_CHANNEL_FMT_RIGHT_LEFT;
    } else {
        ESP_LOGE(TAG, "Unable to configure channel_format %d", channel_format);
        channel_format = 1;
        channel_fmt = I2S_CHANNEL_FMT_ONLY_LEFT;
    }

    if (bits_per_chan != 16 && bits_per_chan != 32) {
        ESP_LOGE(TAG, "Unable to configure bits_per_chan %d", bits_per_chan);
        bits_per_chan = 16;
    }

    i2s_config_t i2s_config = I2S_CONFIG_DEFAULT(sample_rate, channel_fmt, bits_per_chan);

    i2s_pin_config_t pin_config = {
        .bck_io_num = GPIO_I2S_SCLK,
        .ws_io_num = GPIO_I2S_LRCK,
        .data_out_num = GPIO_I2S_DOUT,
        .data_in_num = GPIO_I2S_SDIN,
        .mck_io_num = GPIO_I2S_MCLK,
    };

    ret_val |= i2s_driver_install(i2s_num, &i2s_config, 0, NULL);
    ret_val |= i2s_set_pin(i2s_num, &pin_config);
#endif

    return ret_val;
}

static esp_err_t bsp_i2s_deinit(i2s_port_t i2s_num)
{
    esp_err_t ret_val = ESP_OK;

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
    if (i2s_num == I2S_NUM_1 && rx_handle) {
        ret_val |= i2s_channel_disable(rx_handle);
        ret_val |= i2s_del_channel(rx_handle);
        rx_handle = NULL;
    } else if (i2s_num == I2S_NUM_0  && tx_handle) {
        ret_val |= i2s_channel_disable(tx_handle);
        ret_val |= i2s_del_channel(tx_handle);
        tx_handle = NULL;
    }
#else
    ret_val |= i2s_stop(i2s_num);
    ret_val |= i2s_driver_uninstall(i2s_num);
#endif

    return ret_val;
}

static esp_err_t bsp_codec_init(int adc_sample_rate, int dac_sample_rate, int dac_channel_format, int dac_bits_per_chan)
{
    esp_err_t ret_val = ESP_OK;

    ret_val |= bsp_codec_adc_init(adc_sample_rate);
    ret_val |= bsp_codec_dac_init(dac_sample_rate, dac_channel_format, dac_bits_per_chan);

    return ret_val;
}

static esp_err_t bsp_codec_deinit()
{
    esp_err_t ret_val = ESP_OK;

    ret_val |= bsp_codec_adc_deinit();
    ret_val |= bsp_codec_dac_deinit();
    return ret_val;
}

esp_err_t bsp_audio_play(const int16_t* data, int length, TickType_t ticks_to_wait)
{
    if (!play_dev || !s_play_scratch) {
        return ESP_FAIL;
    }

    /* Fast path: 16-bit mono input → 32-bit stereo output for the codec.
       Each int16 sample becomes one promoted int32 written twice (L + R).
       Uses the pre-allocated scratch buffer — no per-call malloc. */
    int n_samples = length / (int)sizeof(int16_t);
    int out_bytes = n_samples * (int)sizeof(int) * 2;

    if (out_bytes > BSP_PLAY_SCRATCH_BYTES) {
        /* Frame larger than scratch — fall back to a one-off malloc rather than fail. */
        int *out = malloc(out_bytes);
        if (!out) return ESP_ERR_NO_MEM;
        for (int i = 0; i < n_samples; i++) {
            int sample32 = ((int32_t)data[i]) << 16;
            out[2 * i + 0] = sample32;
            out[2 * i + 1] = sample32;
        }
        esp_err_t ret = esp_codec_dev_write(play_dev, (void *)out, out_bytes);
        free(out);
        return ret;
    }

    int *out = s_play_scratch;
    for (int i = 0; i < n_samples; i++) {
        int sample32 = ((int32_t)data[i]) << 16;
        out[2 * i + 0] = sample32;
        out[2 * i + 1] = sample32;
    }
    return esp_codec_dev_write(play_dev, (void *)out, out_bytes);
}

esp_err_t bsp_get_feed_data(bool is_get_raw_channel, int16_t *buffer, int buffer_len)
{
    esp_err_t ret = ESP_OK;
    size_t bytes_read;
    int audio_chunksize = buffer_len / (sizeof(int16_t) * ADC_I2S_CHANNEL);

    ret = esp_codec_dev_read(record_dev, (void *)buffer, buffer_len);
    if (!is_get_raw_channel) {
        for (int i = 0; i < audio_chunksize; i++) {
            int16_t ref = buffer[4 * i + 0];
            buffer[3 * i + 0] = buffer[4 * i + 1];
            buffer[3 * i + 1] = buffer[4 * i + 3];
            buffer[3 * i + 2] = ref;
        }
    }

    return ret;
}

int bsp_get_feed_channel(void)
{
    return ADC_I2S_CHANNEL;
}

char* bsp_get_input_format(void)
{
    return "RMNM";
}

/*
 * TCA9555 GPIO expander helper — enables the speaker PA on Waveshare.
 * The PA_EN line is wired to expander pin TCA9555_PA_EN_PIN (P1_0 in TCA9555 numbering),
 * not to a direct ESP32 GPIO. Must be called after I2C is initialized.
 */
#define TCA9555_REG_INPUT_P1    0x01
#define TCA9555_REG_OUTPUT_P1   0x03
#define TCA9555_REG_CONFIG_P1   0x07

/* Read input port 1 of TCA9555 — returns 8 bits of P1_0..P1_7. Used by the
   button polling task in main.c to detect Key1/Key2/Key3 presses on pins 9/10/11. */
esp_err_t bsp_tca9555_read_input_p1(uint8_t *value)
{
    if (!value) return ESP_ERR_INVALID_ARG;
    uint8_t reg = TCA9555_REG_INPUT_P1;
    return i2c_master_write_read_device(I2C_NUM, TCA9555_I2C_ADDR,
                                        &reg, 1, value, 1, pdMS_TO_TICKS(50));
}

static esp_err_t tca9555_enable_pa(void)
{
    /* Configure P1_0 as output (clear bit 0; default is 0xFF = all input). */
    uint8_t cfg[2] = { TCA9555_REG_CONFIG_P1, 0xFE };
    esp_err_t ret = i2c_master_write_to_device(I2C_NUM, TCA9555_I2C_ADDR,
                                               cfg, sizeof(cfg), pdMS_TO_TICKS(50));
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "TCA9555 config write failed at addr 0x%02X: %s",
                 TCA9555_I2C_ADDR, esp_err_to_name(ret));
        return ret;
    }

    /* Drive P1_0 high to enable PA. */
    uint8_t out[2] = { TCA9555_REG_OUTPUT_P1, 0x01 };
    ret = i2c_master_write_to_device(I2C_NUM, TCA9555_I2C_ADDR,
                                     out, sizeof(out), pdMS_TO_TICKS(50));
    if (ret != ESP_OK) {
        ESP_LOGW(TAG, "TCA9555 output write failed: %s", esp_err_to_name(ret));
        return ret;
    }

    ESP_LOGI(TAG, "TCA9555 PA enabled (addr 0x%02X, P1_0)", TCA9555_I2C_ADDR);
    return ESP_OK;
}

esp_err_t bsp_board_init(uint32_t sample_rate, int channel_format, int bits_per_chan)
{
    /*!< Initialize I2C bus, used for audio codec*/
    bsp_i2c_init(I2C_NUM, I2C_CLK);

    /* Enable speaker PA via TCA9555 GPIO expander (Waveshare wiring). */
    tca9555_enable_pa();

    /* Pre-allocate the playback scratch buffer in PSRAM (we have 8MB). */
    if (!s_play_scratch) {
        s_play_scratch = heap_caps_malloc(BSP_PLAY_SCRATCH_BYTES,
                                          MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!s_play_scratch) {
            /* Fall back to internal RAM if PSRAM not available. */
            s_play_scratch = malloc(BSP_PLAY_SCRATCH_BYTES);
        }
        if (s_play_scratch) {
            ESP_LOGI(TAG, "Allocated %d byte playback scratch", BSP_PLAY_SCRATCH_BYTES);
        } else {
            ESP_LOGE(TAG, "Failed to allocate playback scratch buffer");
        }
    }
    
    s_play_sample_rate = sample_rate;

    if (channel_format != 2 && channel_format != 1) {
        ESP_LOGE(TAG, "Unable to configure channel_format");
        channel_format = 2;
    }
    s_play_channel_format = channel_format;

    if (bits_per_chan != 32 && bits_per_chan != 16) {
        ESP_LOGE(TAG, "Unable to configure bits_per_chan");
        bits_per_chan = 32;
    }
    s_bits_per_chan = bits_per_chan;

    bsp_i2s_init(I2S_NUM_1, 16000, 2, 32);
    // Because record and play use the same i2s.
    bsp_codec_init(16000, 16000, 2, 32);

    /* Prime the I2S TX DMA with silence at boot. Without this, the first audio
       playback after boot starts with garbage in the DMA buffer (loud static).
       300ms covers any reasonable DMA chain length. */
    static const int16_t s_boot_silence[4800] = {0};
    bsp_audio_play(s_boot_silence, sizeof(s_boot_silence), pdMS_TO_TICKS(500));

    return ESP_OK;
}

esp_err_t bsp_sdcard_init(char *mount_point, size_t max_files)
{
    if (NULL != card) {
        return ESP_ERR_INVALID_STATE;
    }

    /* Check if SD crad is supported */
    if (!FUNC_SDMMC_EN && !FUNC_SDSPI_EN) {
        ESP_LOGE(TAG, "SDMMC and SDSPI not supported on this board!");
        return ESP_ERR_NOT_SUPPORTED;
    }

    esp_err_t ret_val = ESP_OK;

    /* SD card power on first */
    gpio_config_t power_gpio_config = {
        .mode = GPIO_MODE_OUTPUT,
        .pin_bit_mask = 1ULL << GPIO_SD_POWER_CTRL
    };
    ESP_ERROR_CHECK(gpio_config(&power_gpio_config));
    ESP_ERROR_CHECK(gpio_set_level(GPIO_SD_POWER_CTRL, 0));


    /**
     * @brief Options for mounting the filesystem.
     *   If format_if_mount_failed is set to true, SD card will be partitioned and
     *   formatted in case when mounting fails.
     *
     */
    esp_vfs_fat_sdmmc_mount_config_t mount_config = {
        .format_if_mount_failed = false,
        .max_files = max_files,
        .allocation_unit_size = 16 * 1024
    };

    /**
     * @brief Use settings defined above to initialize SD card and mount FAT filesystem.
     *   Note: esp_vfs_fat_sdmmc/sdspi_mount is all-in-one convenience functions.
     *   Please check its source code and implement error recovery when developing
     *   production applications.
     *
     */
    sdmmc_host_t host =
#if FUNC_SDMMC_EN
        SDMMC_HOST_DEFAULT();
#else
        SDSPI_HOST_DEFAULT();
    spi_bus_config_t bus_cfg = {
        .mosi_io_num = GPIO_SDSPI_MOSI,
        .miso_io_num = GPIO_SDSPI_MISO,
        .sclk_io_num = GPIO_SDSPI_SCLK,
        .quadwp_io_num = GPIO_NUM_NC,
        .quadhd_io_num = GPIO_NUM_NC,
        .max_transfer_sz = 4000,
    };
    ret_val = spi_bus_initialize(host.slot, &bus_cfg, SPI_DMA_CH_AUTO);
    if (ret_val != ESP_OK) {
        ESP_LOGE(TAG, "Failed to initialize bus.");
        return ret_val;
    }
#endif

    /**
     * @brief This initializes the slot without card detect (CD) and write protect (WP) signals.
     *   Modify slot_config.gpio_cd and slot_config.gpio_wp if your board has these signals.
     *
     */
#if FUNC_SDMMC_EN
    sdmmc_slot_config_t slot_config = SDMMC_SLOT_CONFIG_DEFAULT();
#else
    sdspi_device_config_t slot_config = SDSPI_DEVICE_CONFIG_DEFAULT();
#endif

#if FUNC_SDMMC_EN
    /* Config SD data width. 0, 4 or 8. Currently for SD card, 8 bit is not supported. */
    slot_config.width = SDMMC_BUS_WIDTH;

    /**
     * @brief On chips where the GPIOs used for SD card can be configured, set them in
     *   the slot_config structure.
     *
     */
#if SOC_SDMMC_USE_GPIO_MATRIX
    slot_config.clk = GPIO_SDMMC_CLK;
    slot_config.cmd = GPIO_SDMMC_CMD;
    slot_config.d0 = GPIO_SDMMC_D0;
    slot_config.d1 = GPIO_SDMMC_D1;
    slot_config.d2 = GPIO_SDMMC_D2;
    slot_config.d3 = GPIO_SDMMC_D3;
#endif
    slot_config.cd = GPIO_SDMMC_DET;
    slot_config.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
#else
    slot_config.gpio_cs = GPIO_SDSPI_CS;
    slot_config.host_id = host.slot;
#endif
    /**
     * @brief Enable internal pullups on enabled pins. The internal pullups
     *   are insufficient however, please make sure 10k external pullups are
     *   connected on the bus. This is for debug / example purpose only.
     */

    /* get FAT filesystem on SD card registered in VFS. */
    ret_val =
#if FUNC_SDMMC_EN
        esp_vfs_fat_sdmmc_mount(mount_point, &host, &slot_config, &mount_config, &card);
#else
        esp_vfs_fat_sdspi_mount(mount_point, &host, &slot_config, &mount_config, &card);
#endif

    /* Check for SDMMC mount result. */
    if (ret_val != ESP_OK) {
        if (ret_val == ESP_FAIL) {
            ESP_LOGE(TAG, "Failed to mount filesystem. "
                     "If you want the card to be formatted, set the EXAMPLE_FORMAT_IF_MOUNT_FAILED menuconfig option.");
        } else {
            ESP_LOGE(TAG, "Failed to initialize the card (%s). "
                     "Make sure SD card lines have pull-up resistors in place.", esp_err_to_name(ret_val));
        }
        return ret_val;
    }

    /* Card has been initialized, print its properties. */
    sdmmc_card_print_info(stdout, card);

    return ret_val;
}

esp_err_t bsp_sdcard_deinit(char *mount_point)
{
    if (NULL == mount_point) {
        return ESP_ERR_INVALID_STATE;
    }

    /* Unmount an SD card from the FAT filesystem and release resources acquired */
    esp_err_t ret_val = esp_vfs_fat_sdcard_unmount(mount_point, card);

    /* Make SD/MMC card information structure pointer NULL */
    card = NULL;

    return ret_val;
}
