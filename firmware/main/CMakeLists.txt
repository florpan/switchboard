set(requires
    hardware_driver
    player
    nvs_flash
    esp_wifi
    esp_event
    esp_netif
    esp_websocket_client
    esp_http_server
    esp_timer
    button
    led_strip
    )

idf_component_register(SRCS main.c config.c webserver.c
                       REQUIRES ${requires})

