/*
   switchboard voice device: ESP32-S3-Korvo-1 or Waveshare ESP32-S3-AUDIO-Board
   Wake word detection → stream audio over WebSocket to Gateway
   The board is chosen in menuconfig (Audio Media HAL); LEDs and buttons differ per board.
*/
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/stream_buffer.h"
#include "freertos/idf_additions.h"
#include "esp_heap_caps.h"
#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "esp_afe_sr_models.h"
#include "esp_mn_iface.h"
#include "esp_mn_models.h"
#include "esp_board_init.h"
#include "model_path.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "nvs_flash.h"
#include "esp_websocket_client.h"
#include "esp_timer.h"
#include "wifi_config.h"

/* Audio playback ring buffer (FreeRTOS StreamBuffer).
   Decouples WebSocket arrival from codec consumption. WS handler pushes with a
   500ms timeout (backpressure when buffer fills); playback task pulls and feeds
   codec. Sized for 64 seconds at 16kHz int16 mono = 2MB — fits any plausible TTS
   response in full even under heavy gateway bursts. PSRAM-backed. */
#define PLAY_STREAM_BYTES (64 * 16000 * 2)
static StreamBufferHandle_t s_play_stream = NULL;
#include "config.h"
#include "webserver.h"
#include "iot_button.h"
#include "led_strip.h"
#include <math.h>

static const char *TAG = "voice_assistant";

// --- State machine ---
typedef enum {
    STATE_IDLE,       // Waiting for wake word
    STATE_LISTENING,  // Streaming audio to Gateway
    STATE_PLAYING,    // Playing audio response from Gateway
    STATE_SETUP,      // AP mode — waiting for WiFi config
} assistant_state_t;

static volatile assistant_state_t state = STATE_IDLE;
static volatile int task_flag = 0;

#if CONFIG_ESP32_S3_AUDIO_BOARD
// --- LEDs (7x WS2812 ring on GPIO 38, Waveshare ESP32-S3-AUDIO-Board) ---
#define LED_STRIP_GPIO  GPIO_NUM_38
#define LED_STRIP_NUM   7
#else
// --- LEDs (12x WS2812 on GPIO 19, ESP32-S3-Korvo-1) ---
#define LED_STRIP_GPIO  GPIO_NUM_19
#define LED_STRIP_NUM   12
#endif
static led_strip_handle_t led_strip = NULL;

static void leds_init(void)
{
    led_strip_config_t strip_config = {
        .strip_gpio_num = LED_STRIP_GPIO,
        .max_leds = LED_STRIP_NUM,
        .led_pixel_format = LED_PIXEL_FORMAT_GRB,
        .led_model = LED_MODEL_WS2812,
        .flags.invert_out = false,
    };
    led_strip_rmt_config_t rmt_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,
        .mem_block_symbols = 64,
        .flags.with_dma = false,
    };
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_config, &rmt_config, &led_strip));
    led_strip_clear(led_strip);
}

/* The Waveshare board's WS2812 chips appear to use RBG byte order, not the standard
   GRB the led_strip library configures. Empirically:
     API r param  → displays as BLUE
     API g param  → displays as RED
     API b param  → displays as GREEN
   This wrapper accepts caller-friendly (r, g, b) and reorders for the chip. */
static inline void led_set(int idx, uint8_t r, uint8_t g, uint8_t b)
{
#if CONFIG_ESP32_S3_AUDIO_BOARD
    led_strip_set_pixel(led_strip, idx, b, r, g);
#else
    led_strip_set_pixel(led_strip, idx, r, g, b);
#endif
}

/* Rainbow color wheel: pos 0-255 → R,G,B values (full saturation). */
static inline void wheel(int pos, uint8_t *r, uint8_t *g, uint8_t *b)
{
    pos = ((pos % 256) + 256) % 256;
    if (pos < 85) {
        *r = (uint8_t)(pos * 3);
        *g = (uint8_t)(255 - pos * 3);
        *b = 0;
    } else if (pos < 170) {
        pos -= 85;
        *r = (uint8_t)(255 - pos * 3);
        *g = 0;
        *b = (uint8_t)(pos * 3);
    } else {
        pos -= 170;
        *r = 0;
        *g = (uint8_t)(pos * 3);
        *b = (uint8_t)(255 - pos * 3);
    }
}

static volatile int volume_show_ticks = 0;  // >0 = show volume gauge on LEDs

static void led_task(void *arg)
{
    int brightness = 2;
    int direction = 1;
    int rainbow_offset = 0;  /* rotates the rainbow during PLAYING */
    assistant_state_t prev = STATE_IDLE;

    while (1) {
        assistant_state_t s = state;

        // Volume gauge overlay — takes priority
        if (volume_show_ticks > 0) {
            int vol = g_config.volume;
            int num_lit = (vol * LED_STRIP_NUM) / 95;
            if (vol > 0 && num_lit == 0) num_lit = 1;  // at least 1 LED if not muted
            for (int i = 0; i < LED_STRIP_NUM; i++) {
                if (i < num_lit) {
                    // Green→Yellow→Red gradient
                    int r = (i >= LED_STRIP_NUM * 2 / 3) ? 30 : (i >= LED_STRIP_NUM / 3) ? 20 : 0;
                    int g = (i >= LED_STRIP_NUM * 2 / 3) ? 0 : 20;
                    led_set(i, r, g, 0);
                } else {
                    led_set(i, 0, 0, 0);
                }
            }
            led_strip_refresh(led_strip);
            volume_show_ticks--;
            if (volume_show_ticks == 0) prev = (assistant_state_t)-1;  // force redraw
            vTaskDelay(pdMS_TO_TICKS(30));
            continue;
        }

        if (s == STATE_LISTENING) {
            // Breathing blue
            for (int i = 0; i < LED_STRIP_NUM; i++) {
                led_set(i, 0, 0, brightness);
            }
            led_strip_refresh(led_strip);
            brightness += direction * 2;
            if (brightness >= 60) { brightness = 60; direction = -1; }
            if (brightness <= 2) { brightness = 2; direction = 1; }
        } else if (s == STATE_PLAYING) {
            // Rotating rainbow — magic-is-happening indicator
            for (int i = 0; i < LED_STRIP_NUM; i++) {
                uint8_t r, g, b;
                wheel(rainbow_offset + (i * 256 / LED_STRIP_NUM), &r, &g, &b);
                /* Dim to ~30/255 to match the rest of the LED palette intensity. */
                led_set(i, (r * 30) / 255, (g * 30) / 255, (b * 30) / 255);
            }
            led_strip_refresh(led_strip);
            rainbow_offset = (rainbow_offset + 6) % 256;  // ~1.3 sec/cycle at 30ms tick
        } else if (s == STATE_SETUP) {
            // Fast-blinking red = AP/setup mode
            static int blink = 0;
            blink++;
            for (int i = 0; i < LED_STRIP_NUM; i++) {
                led_set(i, (blink % 10 < 5) ? 30 : 0, 0, 0);
            }
            led_strip_refresh(led_strip);
        } else {
            if (prev != STATE_IDLE) {
                led_strip_clear(led_strip);
            }
        }

        if (s != STATE_LISTENING) {
            brightness = 2;
            direction = 1;
        }
        if (s != STATE_PLAYING) {
            rainbow_offset = 0;  /* reset rotation so each playback starts fresh */
        }

        prev = s;
        vTaskDelay(pdMS_TO_TICKS(30));
    }
}

static void set_state(assistant_state_t new_state)
{
    state = new_state;
}

// --- Buttons ---
// Volume is stored in g_config.volume (persisted to NVS)

// Generate and play a short beep tone (pitch scales with volume)
static void play_volume_beep(int volume)
{
    // 100ms tone at 16kHz = 1600 samples
    static int16_t beep_buf[1600];
    // Frequency: 300Hz at vol=0, 900Hz at vol=95
    float freq = 300.0f + (volume / 95.0f) * 600.0f;
    float amplitude = 4000.0f;  // moderate loudness
    for (int i = 0; i < 1600; i++) {
        beep_buf[i] = (int16_t)(amplitude * sinf(2.0f * M_PI * freq * i / 16000.0f));
    }
    esp_audio_play(beep_buf, sizeof(beep_buf), pdMS_TO_TICKS(200));
}

static void btn_volup_cb(void *handle, void *usr_data)
{
    g_config.volume += 5;
    if (g_config.volume > 95) g_config.volume = 95;
    esp_audio_set_play_vol(g_config.volume);
    volume_show_ticks = 33;  // ~1 second at 30ms per tick
    config_save();
    play_volume_beep(g_config.volume);
    ESP_LOGI(TAG, "Button: VOL+ -> Volume: %d%% (saved)", g_config.volume);
}

static void btn_voldown_cb(void *handle, void *usr_data)
{
    g_config.volume -= 5;
    if (g_config.volume < 0) g_config.volume = 0;
    esp_audio_set_play_vol(g_config.volume);
    volume_show_ticks = 33;  // ~1 second at 30ms per tick
    config_save();
    play_volume_beep(g_config.volume);
    ESP_LOGI(TAG, "Button: VOL- -> Volume: %d%% (saved)", g_config.volume);
}

#if CONFIG_ESP32_S3_AUDIO_BOARD
/* TCA9555 expander button reader — provided by bsp_board.c. Returns the 8-bit
   input port 1 state (each bit is a pin; 0=pressed because lines are inverted). */
extern esp_err_t bsp_tca9555_read_input_p1(uint8_t *value);

/* TCA9555 button polling task. Reads the expander every 50ms and dispatches
   edge-triggered VOL- / VOL+ events on Key1 (P1_1, pin 9) and Key3 (P1_3, pin 11). */
static void waveshare_button_task(void *arg)
{
    uint8_t prev = 0xFF;  /* assume all unpressed at start (pins idle high) */
    while (1) {
        uint8_t cur = 0xFF;
        if (bsp_tca9555_read_input_p1(&cur) == ESP_OK) {
            uint8_t falling = prev & ~cur;  /* bits that went 1 -> 0 = press events */
            if (falling & (1 << 1)) {        /* Key1 = P1_1 = pin 9 */
                btn_voldown_cb(NULL, NULL);
            }
            if (falling & (1 << 3)) {        /* Key3 = P1_3 = pin 11 */
                btn_volup_cb(NULL, NULL);
            }
            prev = cur;
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

static void buttons_init(void)
{
    /* 4KB stack — the volume callbacks call config_save() (NVS write) and may
       generate a beep tone, both of which use significant stack. 2KB overflows. */
    xTaskCreatePinnedToCore(&waveshare_button_task, "btn", 4096, NULL, 3, NULL, 0);
    ESP_LOGI(TAG, "Buttons initialized (TCA9555 polling: VOL- on pin 9, VOL+ on pin 11)");
}

#else
// Korvo-1: 6x ADC buttons on GPIO 8 / ADC1 CH7
static const char *btn_names[] = {"REC", "MODE", "PLAY", "SET", "VOL-", "VOL+"};

static void btn_press_cb(void *handle, void *usr_data)
{
    int idx = (int)(intptr_t)usr_data;
    ESP_LOGI(TAG, "Button: %s", btn_names[idx]);
}

static void buttons_init(void)
{
    static const struct { uint16_t min; uint16_t max; } adc_ranges[] = {
        {2310, 2510},  // REC
        {1880, 2080},  // MODE
        {1560, 1760},  // PLAY
        {1010, 1210},  // SET
        { 720,  920},  // VOL-
        { 280,  480},  // VOL+
    };

    button_handle_t btns[6] = {0};
    for (int i = 0; i < 6; i++) {
        button_config_t cfg = {
            .type = BUTTON_TYPE_ADC,
            .adc_button_config = {
                .adc_channel = ADC_CHANNEL_7,
                .button_index = i,
                .min = adc_ranges[i].min,
                .max = adc_ranges[i].max,
            },
        };
        btns[i] = iot_button_create(&cfg);
        if (!btns[i]) {
            ESP_LOGE(TAG, "Button %d (%s) create failed", i, btn_names[i]);
            continue;
        }
    }

    // Log all button presses (REC, MODE, PLAY, SET get generic logging)
    for (int i = 0; i < 4; i++) {
        if (btns[i]) iot_button_register_cb(btns[i], BUTTON_PRESS_DOWN, btn_press_cb, (void *)(intptr_t)i);
    }

    // Volume buttons get combined logging + action
    if (btns[4]) iot_button_register_cb(btns[4], BUTTON_PRESS_DOWN, btn_voldown_cb, NULL);
    if (btns[5]) iot_button_register_cb(btns[5], BUTTON_PRESS_DOWN, btn_volup_cb, NULL);

    ESP_LOGI(TAG, "Buttons initialized (6x ADC on GPIO 8, volume: %d%%)", g_config.volume);
}
#endif

// --- WiFi ---
static EventGroupHandle_t wifi_event_group;
#define WIFI_CONNECTED_BIT BIT0
static bool wifi_ap_mode = false;

static void wifi_event_handler(void *arg, esp_event_base_t event_base,
                               int32_t event_id, void *event_data)
{
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        if (!wifi_ap_mode) {
            ESP_LOGW(TAG, "WiFi disconnected, reconnecting...");
            xEventGroupClearBits(wifi_event_group, WIFI_CONNECTED_BIT);
            esp_wifi_connect();
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Connected! IP: " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

static void wifi_start_ap(void)
{
    ESP_LOGW(TAG, "WiFi STA failed — starting AP mode for setup");
    esp_wifi_stop();

    esp_netif_create_default_wifi_ap();

    wifi_config_t ap_config = {
        .ap = {
            .ssid = "Jarvis-Setup",
            .ssid_len = 12,
            .channel = 1,
            .max_connection = 4,
            .authmode = WIFI_AUTH_OPEN,
        },
    };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    wifi_ap_mode = true;
    set_state(STATE_SETUP);
    ESP_LOGI(TAG, "AP mode active: connect to 'Jarvis-Setup', open http://192.168.4.1");
}

static void wifi_init(void)
{
    wifi_event_group = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                        &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                        &wifi_event_handler, NULL, NULL));

    wifi_config_t wifi_config = { .sta = { {0}, {0} } };
    strlcpy((char *)wifi_config.sta.ssid, g_config.wifi_ssid, sizeof(wifi_config.sta.ssid));
    strlcpy((char *)wifi_config.sta.password, g_config.wifi_pass, sizeof(wifi_config.sta.password));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "Connecting to WiFi '%s'...", g_config.wifi_ssid);

    // 10 second timeout — fall back to AP mode if connection fails
    EventBits_t bits = xEventGroupWaitBits(wifi_event_group, WIFI_CONNECTED_BIT,
                                            false, true, pdMS_TO_TICKS(10000));
    if (!(bits & WIFI_CONNECTED_BIT)) {
        wifi_start_ap();
    }
}

// --- WebSocket ---
static esp_websocket_client_handle_t ws_client = NULL;
static volatile bool ws_connected = false;

static void ws_event_handler(void *arg, esp_event_base_t event_base,
                             int32_t event_id, void *event_data)
{
    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED: {
        ESP_LOGI(TAG, "WebSocket connected to Gateway");
        ws_connected = true;
        /* Identify ourselves to the Gateway so it can route by device_id. */
        char hello[160];
        int hlen = snprintf(hello, sizeof(hello),
                            "{\"event\":\"hello\",\"device_id\":\"%s\"}",
                            g_config.device_id);
        esp_websocket_client_send_text(ws_client, hello, hlen, pdMS_TO_TICKS(100));
        ESP_LOGI(TAG, "Sent hello: device_id=%s", g_config.device_id);
        break;
    }
    case WEBSOCKET_EVENT_DISCONNECTED:
        ESP_LOGW(TAG, "WebSocket disconnected");
        ws_connected = false;
        break;
    case WEBSOCKET_EVENT_DATA: {
        esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;
        if (data->op_code == 0x01) {
            // Text frame — control messages from Gateway
            ESP_LOGI(TAG, "Gateway: %.*s", data->data_len, (char *)data->data_ptr);

            // Parse control events
            if (data->data_len > 0) {
                if (strstr(data->data_ptr, "audio_start")) {
                    ESP_LOGI(TAG, "-----------PLAYING-----------");
                    set_state(STATE_PLAYING);
                    /* Pre-fill stream with 300ms silence — gives playback task a head
                       start before real audio arrives, and absorbs initial network jitter. */
                    if (s_play_stream) {
                        static const int16_t silence_prime[4800] = {0};  /* 300ms */
                        xStreamBufferSend(s_play_stream, silence_prime, sizeof(silence_prime), 0);
                    }
                } else if (strstr(data->data_ptr, "audio_end")) {
                    ESP_LOGI(TAG, "Playback complete");
                    /* Push 200ms silence to flush — playback task will play it after
                       any remaining real audio, ensuring clean tail with no buzz. */
                    if (s_play_stream) {
                        static const int16_t silence_flush[3200] = {0};
                        xStreamBufferSend(s_play_stream, silence_flush, sizeof(silence_flush), 0);
                    }
                    set_state(STATE_IDLE);
                    ESP_LOGI(TAG, "-----------IDLE-----------");
                }
            }
        } else if (data->op_code == 0x02) {
            // Binary frame — PCM audio from Gateway TTS
            if (state == STATE_PLAYING && data->data_len > 0) {
                /* Push to playback stream with 500ms timeout — strong backpressure on the
                   WS handler when buffer fills, throttling the gateway via TCP. 500ms is
                   well below typical WS keepalive intervals (30s+) so connection is safe. */
                if (s_play_stream) {
                    size_t sent = xStreamBufferSend(s_play_stream, data->data_ptr,
                                                    data->data_len, pdMS_TO_TICKS(500));
                    if ((int)sent < data->data_len) {
                        ESP_LOGW(TAG, "STREAM_FULL: dropped %d bytes (sent %zu of %d)",
                                 data->data_len - (int)sent, sent, data->data_len);
                    }
                }
            }
        }
        break;
    }
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGE(TAG, "WebSocket error");
        break;
    }
}

static void ws_init(void)
{
    esp_websocket_client_config_t ws_cfg = {
        .uri = g_config.gateway_uri,
        .buffer_size = 8192,
    };

    ws_client = esp_websocket_client_init(&ws_cfg);
    esp_websocket_register_events(ws_client, WEBSOCKET_EVENT_ANY, ws_event_handler, NULL);
    esp_websocket_client_start(ws_client);

    ESP_LOGI(TAG, "WebSocket connecting to %s ...", g_config.gateway_uri);
}

// --- AFE + Wake word ---
static const esp_afe_sr_iface_t *afe_handle = NULL;

void feed_Task(void *arg)
{
    esp_afe_sr_data_t *afe_data = arg;
    int audio_chunksize = afe_handle->get_feed_chunksize(afe_data);
    int nch = afe_handle->get_feed_channel_num(afe_data);
    int feed_channel = esp_get_feed_channel();
    assert(nch == feed_channel);
    int16_t *i2s_buff = malloc(audio_chunksize * sizeof(int16_t) * feed_channel);
    assert(i2s_buff);

    while (task_flag) {
        esp_get_feed_data(true, i2s_buff, audio_chunksize * sizeof(int16_t) * feed_channel);
        afe_handle->feed(afe_data, i2s_buff);
    }
    free(i2s_buff);
    vTaskDelete(NULL);
}

void detect_Task(void *arg)
{
    esp_afe_sr_data_t *afe_data = arg;
    int silence_count = 0;
    bool speech_started = false;
    int playing_timeout = 0;

    printf("------------detect start------------\n");

    while (task_flag) {
        afe_fetch_result_t *res = afe_handle->fetch(afe_data);
        if (!res || res->ret_value == ESP_FAIL) {
            printf("fetch error!\n");
            break;
        }

        // Timeout safety: if stuck in PLAYING for too long (~30s), go back to idle
        if (state == STATE_PLAYING) {
            playing_timeout++;
            if (playing_timeout > 940) {  // ~30s at 32ms per frame
                ESP_LOGW(TAG, "Playing timeout, returning to idle");
                set_state(STATE_IDLE);
                playing_timeout = 0;
                ESP_LOGI(TAG, "-----------IDLE-----------");
            }
            continue;  // Don't process wake words while playing
        }
        playing_timeout = 0;

        if (state == STATE_IDLE) {
            // Waiting for wake word
            if (res->wakeup_state == WAKENET_DETECTED) {
                ESP_LOGI(TAG, "Wake word detected! (model:%d, word:%d)",
                         res->wakenet_model_index, res->wake_word_index);
                set_state(STATE_LISTENING);
                silence_count = 0;
                speech_started = false;
                ESP_LOGI(TAG, "-----------LISTENING-----------");
            }
        } else if (state == STATE_LISTENING) {
            // Stream audio to Gateway via WebSocket
            if (ws_connected && res->data && res->data_size > 0) {
                esp_websocket_client_send_bin(ws_client, (const char *)res->data,
                                              res->data_size, pdMS_TO_TICKS(100));
            }

            // Track VAD for end-of-speech detection
            if (res->vad_state == VAD_SPEECH) {
                speech_started = true;
                silence_count = 0;
            } else {
                // Silence frame
                if (speech_started) {
                    silence_count++;
                    if (silence_count >= g_config.vad_timeout) {
                        ESP_LOGI(TAG, "Speech ended (silence timeout). Sent audio to Gateway.");
                        // Send a text frame to signal end-of-speech
                        if (ws_connected) {
                            const char *msg = "{\"event\":\"speech_end\"}";
                            esp_websocket_client_send_text(ws_client, msg,
                                                          strlen(msg), pdMS_TO_TICKS(100));
                        }
                        set_state(STATE_PLAYING);  // Wait for Gateway response
                        silence_count = 0;
                        speech_started = false;
                        ESP_LOGI(TAG, "-----------WAITING FOR RESPONSE-----------");
                    }
                }
            }
        }
    }
    vTaskDelete(NULL);
}

/* Dedicated playback task — pulls from the audio stream buffer and writes to the
   codec. Pinned to Core 1 (away from AFE on Core 0 and WiFi on Core 0).
   This decouples codec write timing from network frame arrival, eliminating the
   "WS handler blocked on codec write" stall pattern that caused intermittent static. */
static void playback_task(void *arg)
{
    static int16_t chunk[1600];  /* 100ms at 16kHz int16 mono per write */
    while (1) {
        size_t got = xStreamBufferReceive(s_play_stream, chunk, sizeof(chunk),
                                          pdMS_TO_TICKS(100));
        if (got > 0) {
            esp_audio_play(chunk, (int)got, pdMS_TO_TICKS(500));
        }
        /* If got == 0 (timeout, no data): I2S DMA auto_clear will play silence. */
    }
}

void app_main()
{
    // Initialize NVS (required for WiFi and config)
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // Load config from NVS (or compiled defaults)
    config_init();

    // Initialize board audio (16kHz, 1 channel, 16-bit)
    ESP_ERROR_CHECK(esp_board_init(16000, 1, 16));

    // Initialize LEDs and buttons (board-specific, see above)
    leds_init();
    buttons_init();
    esp_audio_set_play_vol(g_config.volume);
    ESP_LOGI(TAG, "Speaker volume: %d%%", g_config.volume);

    /* Audio playback ring buffer + task — decouples WS frame arrival from codec writes.
       Stream buffer storage must be in PSRAM, not internal RAM. WiFi TX descriptors live
       in internal RAM and starve if our buffer takes too much. Use *WithCaps to specify
       MALLOC_CAP_SPIRAM. Priority 5 = default — does not outrank the WebSocket client. */
    s_play_stream = xStreamBufferCreateWithCaps(PLAY_STREAM_BYTES, 1,
                                                MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_play_stream) {
        ESP_LOGE(TAG, "Failed to create playback stream buffer");
    } else {
        ESP_LOGI(TAG, "Playback stream buffer: %d bytes (PSRAM)", PLAY_STREAM_BYTES);
        /* Priority 6 — slightly above default (5) so playback task preempts the WS
           handler when both have work, ensuring the buffer drains during heavy receive. */
        xTaskCreatePinnedToCore(&playback_task, "play", 4096, NULL, 6, NULL, 1);
    }
    xTaskCreatePinnedToCore(&led_task, "leds", 2048, NULL, 3, NULL, 0);

    // Connect to WiFi (10s timeout, falls back to AP mode)
    wifi_init();

    // Start HTTP config server (runs in both STA and AP mode)
    webserver_start();

    // In AP/setup mode, skip voice assistant — just serve config page
    if (wifi_ap_mode) {
        ESP_LOGI(TAG, "Setup mode active. Configure WiFi at http://192.168.4.1");
        return;
    }

    // Connect WebSocket to Gateway
    ws_init();

    // Initialize speech recognition models
    srmodel_list_t *models = esp_srmodel_init("model");
    if (models) {
        for (int i = 0; i < models->num; i++) {
            if (strstr(models->model_name[i], ESP_WN_PREFIX) != NULL) {
                ESP_LOGI(TAG, "Wake word model: %s", models->model_name[i]);
            }
        }
    }

    afe_config_t *afe_config = afe_config_init(esp_get_input_format(), models,
                                                AFE_TYPE_SR, AFE_MODE_LOW_COST);

    // Boost output volume — default is too quiet for STT
    afe_config->afe_linear_gain = 4.0;  // 4x amplitude (range 0.1–10.0)

    if (afe_config->wakenet_model_name) {
        ESP_LOGI(TAG, "Active wake word: %s", afe_config->wakenet_model_name);
    }

    afe_handle = esp_afe_handle_from_config(afe_config);
    esp_afe_sr_data_t *afe_data = afe_handle->create_from_config(afe_config);
    afe_config_free(afe_config);

    task_flag = 1;
    xTaskCreatePinnedToCore(&feed_Task, "feed", 8 * 1024, (void *)afe_data, 5, NULL, 0);
    xTaskCreatePinnedToCore(&detect_Task, "detect", 8 * 1024, (void *)afe_data, 5, NULL, 1);

    ESP_LOGI(TAG, "Voice assistant ready. Say the wake word!");
}
