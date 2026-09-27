#pragma once

#include <stdint.h>

typedef struct {
    char wifi_ssid[64];
    char wifi_pass[64];
    char gateway_uri[256];
    int  vad_timeout;    // silence frames before speech_end
    int  volume;         // speaker volume 0-95 (persisted)
    char device_id[32];  // unique per device — defaults to "jarvis-XXYYZZ" from MAC
} device_config_t;

// Global config instance
extern device_config_t g_config;

// Load config from NVS, fall back to compiled defaults
void config_init(void);

// Write current g_config to NVS
void config_save(void);

// Reset g_config to compiled defaults (does not write NVS)
void config_set_defaults(void);
