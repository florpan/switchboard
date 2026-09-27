# Voice speaker firmware

Firmware for the ESP32-S3 speakers that talk to the voice channel. The speaker is only ears and a mouth:
it listens for the wake word on the device, streams what you say to the daemon, and plays back the
reply. Transcription, the session and speech synthesis all run on the daemon's side (see
[docs/channels.md](../docs/channels.md#voice) for the protocol).

Speakers are optional. Everything else in switchboard works without them, and `tests/fake-device.ts`
stands in for one when testing.

## Supported boards

| | Waveshare ESP32-S3 AI Smart Speaker | Espressif ESP32-S3-Korvo-1 |
|---|---|---|
| What it is | Complete small speaker: board, speaker and case | Bare audio dev board; you add a speaker and a case |
| Microphones | 2 | Mic array on a separate mic board |
| LEDs | 7× WS2812 ring (GPIO 38) | 12× WS2812 (GPIO 19) |
| Buttons | 3, on a TCA9555 I/O expander; Key1 = volume down, Key3 = volume up | 6 on an ADC ladder; VOL-/VOL+ used, the rest only logged |
| Memory | 16 MB flash, 8 MB PSRAM | 16 MB flash, 8 MB PSRAM |
| Build flag | `sdkconfig.board.waveshare` | `sdkconfig.board.korvo1` |
| Status | In daily use | In daily use; see the note below |

The Waveshare is the easy choice: it arrives as a finished speaker and only needs flashing. The Korvo-1
has better microphones but needs a speaker and a case.

### Where to buy

- **Waveshare ESP32-S3 AI Smart Speaker Development Board**: e.g.
  [Amazon.se](https://www.amazon.se/dp/B0FP1VL37J), or search for the name at other shops or Waveshare.
- **ESP32-S3-Korvo-1**: e.g. [Mouser](https://www.mouser.se/ProductDetail/Espressif-Systems/ESP32-S3-Korvo-1?qs=Rp5uXu7WBW%252BmK7yU7z04ow%3D%3D).
  - Speaker: PUI Audio AS05004PS-2-F-WP-R
    ([Mouser](https://www.mouser.se/ProductDetail/PUI-Audio/AS05004PS-2-F-WP-R?qs=By6Nw2ByBD3RxmbY8szwBQ%3D%3D)),
    on the board's speaker connector.
  - Case: 3D-printed; the model will be added here when it's finished.

## Behaviour

- Wake word "Jarvis" (WakeNet9, on the device). WakeNet has a fixed list of words; another one can be
  picked in `idf.py menuconfig` under ESP Speech Recognition.
- After the wake word the device streams audio until about a second of silence, then waits for the reply.
- LEDs: breathing blue = listening, rotating rainbow = playing, fast red blink = setup mode, off = idle.
  A volume press shows a short level gauge.
- Volume buttons change the volume in 5 % steps with a beep; the level is saved.
- Audio from the daemon goes through a 2 MB buffer in PSRAM and a separate playback task, so uneven
  network timing doesn't reach the speaker as static.
- On connect the device sends its `device_id` (default `jarvis-` plus the last three bytes of the MAC).
  Give it a name in the workspace's `config/voice-devices.json`.

**Note on the Korvo-1:** the playback buffer was developed and tested on the Waveshare. The Korvo-1 build
has it too, but that combination hasn't been tested on hardware yet. The Waveshare also has a reworked
I2S playback path in its board file (`components/hardware_driver/boards/esp32s3-audio-board`); the
Korvo-1 uses Espressif's original one.

## Building and flashing

Requires [ESP-IDF](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/get-started/) 5.5
(tested with 5.5.3). Run the commands in an ESP-IDF shell. On Windows that is the "ESP-IDF PowerShell"
shortcut, not a Git Bash/MSYS shell.

```sh
cd firmware
cp main/wifi_config.h.example main/wifi_config.h    # compiled-in defaults, not committed

# pick the board: waveshare or korvo1
idf.py -B build-waveshare -D SDKCONFIG=build-waveshare/sdkconfig \
  -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.board.waveshare" \
  build flash monitor
```

Each board gets its own build folder, so both can be built side by side. `flash` also writes the
wake-word model partition. Espressif's components (esp-sr, websocket client, button, LED strip) come
from the component manager on the first build; `dependencies.lock` pins their versions.

## First start

1. With no WiFi configured (or if it can't connect within 10 s), the device opens an access point
   **Jarvis-Setup** (no password) and blinks red.
2. Join it and open http://192.168.4.1. Set WiFi, the gateway URI (`ws://<daemon-host>:8090/voice`),
   the device ID if you want your own, and the VAD timeout. Save, then Restart.
3. On your network the same page is at `http://<device-ip>`. Settings are stored in flash (NVS
   namespace `jarvis`) and survive reflashing the app.
4. `GET /api/voice/devices` on the daemon shows the device once it's connected.

## Layout

```
main/            the app: state machine, WiFi and setup mode, WebSocket, LEDs, buttons, web config page
components/      from Espressif's ESP-Skainet: board drivers (hardware_driver, with the Waveshare board
                 added), player, sr_ringbuf
partitions.csv   nvs + app (2.5 MB) + model (5 MB)
sdkconfig.*      shared defaults and one file per board
```

Board-specific code in `main/main.c` is behind `#if CONFIG_ESP32_S3_AUDIO_BOARD`. Adding a board means
a board folder in `components/hardware_driver/boards/`, a Kconfig entry there, a `sdkconfig.board.<name>`
and its LED and button setup in `main.c`.

The app started from ESP-Skainet's `wake_word_detection/afe` example. ESP-Skainet's code is under the
ESPRESSIF MIT License ([components/LICENSE-ESPRESSIF](components/LICENSE-ESPRESSIF)).
