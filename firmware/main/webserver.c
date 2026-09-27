#include "webserver.h"
#include "config.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_netif.h"
#include <string.h>
#include <stdio.h>

static const char *TAG = "webserver";
static httpd_handle_t server = NULL;

// --- Embedded HTML page ---
static const char html_page[] =
"<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
"<title>Jarvis Settings</title><style>"
"*{box-sizing:border-box;margin:0;padding:0}"
"body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#e0e0e0;display:flex;justify-content:center;padding:20px}"
".card{background:#16213e;border-radius:12px;padding:24px;width:100%;max-width:420px;box-shadow:0 4px 24px rgba(0,0,0,.4)}"
"h1{text-align:center;margin-bottom:20px;color:#93c5fd;font-size:1.4em}"
"label{display:block;margin-top:14px;font-size:.85em;color:#9ca3af}"
"input{width:100%;padding:10px;margin-top:4px;border:1px solid #334155;border-radius:6px;background:#0f172a;color:#e0e0e0;font-size:.95em}"
"input:focus{outline:none;border-color:#3b82f6}"
".btns{display:flex;gap:10px;margin-top:20px}"
"button{flex:1;padding:10px;border:none;border-radius:6px;font-size:.95em;cursor:pointer;font-weight:600}"
"#saveBtn{background:#2563eb;color:#fff}#saveBtn:hover{background:#1d4ed8}"
"#rstBtn{background:#dc2626;color:#fff}#rstBtn:hover{background:#b91c1c}"
"#status{text-align:center;margin-top:14px;font-size:.85em;color:#6b7280}"
"</style></head><body><div class='card'><h1>Jarvis Settings</h1>"
"<label>Device ID<input id='did' type='text'></label>"
"<label>WiFi SSID<input id='ssid' type='text'></label>"
"<label>WiFi Password<input id='pass' type='password'></label>"
"<label>Gateway URI<input id='uri' type='text'></label>"
"<label>VAD Timeout (frames)<input id='vad' type='number' min='5' max='200'></label>"
"<label>Volume (%)<input id='vol' type='number' min='0' max='95' step='5'></label>"
"<div class='btns'><button id='saveBtn' onclick='save()'>Save</button>"
"<button id='rstBtn' onclick='restart()'>Restart</button></div>"
"<div id='status'>Loading...</div></div>"
"<script>"
"async function load(){"
"try{const r=await fetch('/api/config');const c=await r.json();"
"document.getElementById('did').value=c.device_id||'';"
"document.getElementById('ssid').value=c.wifi_ssid||'';"
"document.getElementById('pass').value=c.wifi_pass||'';"
"document.getElementById('uri').value=c.gateway_uri||'';"
"document.getElementById('vad').value=c.vad_timeout||30;"
"document.getElementById('vol').value=c.volume||75;"
"document.getElementById('status').textContent='Connected ('+c.ip+')'}"
"catch(e){document.getElementById('status').textContent='Error: '+e.message}}"
"async function save(){"
"const d={device_id:document.getElementById('did').value,"
"wifi_ssid:document.getElementById('ssid').value,"
"wifi_pass:document.getElementById('pass').value,"
"gateway_uri:document.getElementById('uri').value,"
"vad_timeout:parseInt(document.getElementById('vad').value)||30,"
"volume:parseInt(document.getElementById('vol').value)||75};"
"try{const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});"
"const j=await r.json();document.getElementById('status').textContent=j.status||'Saved'}"
"catch(e){document.getElementById('status').textContent='Error: '+e.message}}"
"async function restart(){"
"if(!confirm('Restart device?'))return;"
"try{await fetch('/api/restart',{method:'POST'});document.getElementById('status').textContent='Restarting...'}"
"catch(e){}document.getElementById('status').textContent='Restarting...'}"
"load();"
"</script></body></html>";

// --- Get current device IP as string ---
static void get_ip_string(char *buf, size_t len)
{
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (!netif) netif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    if (netif) {
        esp_netif_ip_info_t ip_info;
        if (esp_netif_get_ip_info(netif, &ip_info) == ESP_OK) {
            snprintf(buf, len, IPSTR, IP2STR(&ip_info.ip));
            return;
        }
    }
    strlcpy(buf, "unknown", len);
}

// GET / — serve HTML page
static esp_err_t root_handler(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, html_page, sizeof(html_page) - 1);
}

// GET /api/config — return current config as JSON
static esp_err_t config_get_handler(httpd_req_t *req)
{
    char ip[20];
    get_ip_string(ip, sizeof(ip));

    char json[640];
    int n = snprintf(json, sizeof(json),
        "{\"device_id\":\"%s\",\"wifi_ssid\":\"%s\",\"wifi_pass\":\"%s\","
        "\"gateway_uri\":\"%s\",\"vad_timeout\":%d,\"volume\":%d,\"ip\":\"%s\"}",
        g_config.device_id, g_config.wifi_ssid, g_config.wifi_pass,
        g_config.gateway_uri, g_config.vad_timeout, g_config.volume, ip);

    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, json, n);
}

// Simple JSON string value extractor (no dependencies)
static bool json_get_string(const char *json, const char *key, char *out, size_t out_len)
{
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
    const char *start = strstr(json, pattern);
    if (!start) return false;
    start += strlen(pattern);
    const char *end = strchr(start, '"');
    if (!end || (size_t)(end - start) >= out_len) return false;
    memcpy(out, start, end - start);
    out[end - start] = '\0';
    return true;
}

static bool json_get_int(const char *json, const char *key, int *out)
{
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char *start = strstr(json, pattern);
    if (!start) return false;
    start += strlen(pattern);
    *out = atoi(start);
    return true;
}

// POST /api/config — update config fields and save to NVS
static esp_err_t config_post_handler(httpd_req_t *req)
{
    char buf[512];
    int received = httpd_req_recv(req, buf, sizeof(buf) - 1);
    if (received <= 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "No body");
        return ESP_FAIL;
    }
    buf[received] = '\0';

    char tmp[256];
    if (json_get_string(buf, "device_id", tmp, sizeof(tmp)))
        strlcpy(g_config.device_id, tmp, sizeof(g_config.device_id));
    if (json_get_string(buf, "wifi_ssid", tmp, sizeof(tmp)))
        strlcpy(g_config.wifi_ssid, tmp, sizeof(g_config.wifi_ssid));
    if (json_get_string(buf, "wifi_pass", tmp, sizeof(tmp)))
        strlcpy(g_config.wifi_pass, tmp, sizeof(g_config.wifi_pass));
    if (json_get_string(buf, "gateway_uri", tmp, sizeof(tmp)))
        strlcpy(g_config.gateway_uri, tmp, sizeof(g_config.gateway_uri));

    int vad;
    if (json_get_int(buf, "vad_timeout", &vad))
        g_config.vad_timeout = vad;

    int vol;
    if (json_get_int(buf, "volume", &vol))
        g_config.volume = vol;

    config_save();

    const char *resp = "{\"status\":\"Saved\"}";
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, resp, strlen(resp));
}

// POST /api/restart — restart ESP32
static esp_err_t restart_handler(httpd_req_t *req)
{
    const char *resp = "{\"status\":\"Restarting\"}";
    httpd_resp_set_type(req, "application/json");
    httpd_resp_send(req, resp, strlen(resp));

    ESP_LOGI(TAG, "Restart requested via web UI");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK; // unreachable
}

esp_err_t webserver_start(void)
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_uri_handlers = 8;
    config.stack_size = 8192;

    esp_err_t err = httpd_start(&server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start HTTP server: %s", esp_err_to_name(err));
        return err;
    }

    const httpd_uri_t root = { .uri = "/", .method = HTTP_GET, .handler = root_handler };
    const httpd_uri_t cfg_get = { .uri = "/api/config", .method = HTTP_GET, .handler = config_get_handler };
    const httpd_uri_t cfg_post = { .uri = "/api/config", .method = HTTP_POST, .handler = config_post_handler };
    const httpd_uri_t rst = { .uri = "/api/restart", .method = HTTP_POST, .handler = restart_handler };

    httpd_register_uri_handler(server, &root);
    httpd_register_uri_handler(server, &cfg_get);
    httpd_register_uri_handler(server, &cfg_post);
    httpd_register_uri_handler(server, &rst);

    ESP_LOGI(TAG, "HTTP config server started on port 80");
    return ESP_OK;
}

void webserver_stop(void)
{
    if (server) {
        httpd_stop(server);
        server = NULL;
    }
}
