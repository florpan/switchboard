#include "config.h"
#include "wifi_config.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_log.h"
#include "esp_mac.h"
#include <string.h>
#include <stdio.h>

static const char *TAG = "config";
#define NVS_NAMESPACE "jarvis"

device_config_t g_config;

void config_set_defaults(void)
{
    strlcpy(g_config.wifi_ssid, WIFI_SSID, sizeof(g_config.wifi_ssid));
    strlcpy(g_config.wifi_pass, WIFI_PASS, sizeof(g_config.wifi_pass));
    strlcpy(g_config.gateway_uri, GATEWAY_WS_URI, sizeof(g_config.gateway_uri));
    g_config.vad_timeout = VAD_SILENCE_TIMEOUT;
    g_config.volume = 75;  // default 75%

    /* Default device_id from last 3 bytes of MAC: "jarvis-aabbcc". */
    uint8_t mac[6] = {0};
    esp_efuse_mac_get_default(mac);
    snprintf(g_config.device_id, sizeof(g_config.device_id),
             "jarvis-%02x%02x%02x", mac[3], mac[4], mac[5]);
}

void config_init(void)
{
    config_set_defaults();

    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs);
    if (err != ESP_OK) {
        ESP_LOGI(TAG, "No saved config, using defaults");
        return;
    }

    size_t len;

    len = sizeof(g_config.wifi_ssid);
    if (nvs_get_str(nvs, "wifi_ssid", g_config.wifi_ssid, &len) == ESP_OK)
        ESP_LOGI(TAG, "NVS: wifi_ssid = %s", g_config.wifi_ssid);

    len = sizeof(g_config.wifi_pass);
    if (nvs_get_str(nvs, "wifi_pass", g_config.wifi_pass, &len) == ESP_OK)
        ESP_LOGI(TAG, "NVS: wifi_pass loaded");

    len = sizeof(g_config.gateway_uri);
    if (nvs_get_str(nvs, "gw_uri", g_config.gateway_uri, &len) == ESP_OK)
        ESP_LOGI(TAG, "NVS: gateway_uri = %s", g_config.gateway_uri);

    int32_t vad;
    if (nvs_get_i32(nvs, "vad_timeout", &vad) == ESP_OK) {
        g_config.vad_timeout = (int)vad;
        ESP_LOGI(TAG, "NVS: vad_timeout = %d", g_config.vad_timeout);
    }

    int32_t vol;
    if (nvs_get_i32(nvs, "volume", &vol) == ESP_OK) {
        g_config.volume = (int)vol;
        ESP_LOGI(TAG, "NVS: volume = %d%%", g_config.volume);
    }

    len = sizeof(g_config.device_id);
    if (nvs_get_str(nvs, "device_id", g_config.device_id, &len) == ESP_OK)
        ESP_LOGI(TAG, "NVS: device_id = %s", g_config.device_id);
    else
        ESP_LOGI(TAG, "device_id (default from MAC): %s", g_config.device_id);

    nvs_close(nvs);
    ESP_LOGI(TAG, "Config loaded from NVS");
}

void config_save(void)
{
    nvs_handle_t nvs;
    ESP_ERROR_CHECK(nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs));

    nvs_set_str(nvs, "wifi_ssid", g_config.wifi_ssid);
    nvs_set_str(nvs, "wifi_pass", g_config.wifi_pass);
    nvs_set_str(nvs, "gw_uri", g_config.gateway_uri);
    nvs_set_i32(nvs, "vad_timeout", (int32_t)g_config.vad_timeout);
    nvs_set_i32(nvs, "volume", (int32_t)g_config.volume);
    nvs_set_str(nvs, "device_id", g_config.device_id);

    ESP_ERROR_CHECK(nvs_commit(nvs));
    nvs_close(nvs);
    ESP_LOGI(TAG, "Config saved to NVS");
}
