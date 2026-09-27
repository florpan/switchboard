# Channels

Each channel is a module in `src/channels/<name>/`, an MCP endpoint at `/mcp/<name>` and a plugin
`plugins/<name>`. Every event carries `time` (local time, e.g. `2026-09-25T10:17:54+02:00 (Thu)`) so
the session never needs a tool call to know it. Settings are environment variables, read from the
workspace `.env`. `GET /api/channels` shows per channel whether a session is connected plus its status.

## voice

ESP32 speakers ([firmware/](../firmware/README.md)) keep a WebSocket open to `ws://<gateway>:8090/voice`.

Protocol:
- device → gateway: `{"event":"hello","device_id":"jarvis-aabbcc"}` on connect; binary PCM
  (16 kHz, 16-bit, mono) after the wake word; `{"event":"speech_end"}` when the speaker stops talking.
- gateway → device: `{"event":"audio_start"}`, binary PCM, `{"event":"audio_end"}`. An empty
  start/end pair releases a waiting device.

Speech is transcribed with ElevenLabs Scribe (realtime while streaming, REST as fallback) and pushed as
`<channel ... device="kitchen" id="...">transcript</channel>`. The session answers with
`speak(device, text)`; TTS is ElevenLabs, streamed to the device. Speech on one device is queued, so
answers never overlap.

The device times out after ~30 s without audio. If no `speak` arrives within `VOICE_REPLY_TIMEOUT`
seconds (20) the device hears `VOICE_BUSY_TEXT`; with no session connected it hears
`VOICE_OFFLINE_TEXT`.

| Tool | |
|---|---|
| `speak {text, device?}` | Say something; without `device` on every speaker |
| `list_speakers` | Connected speakers |

| HTTP | |
|---|---|
| `POST /voice/say {text, device?}` | Speak text directly, no session involved |
| `POST /voice/ask {text, device?, timeout?}` | Typed question into the voice channel; returns `{response}` with the session's first `speak` (also spoken on `device` if given) |
| `GET /api/voice/devices` | Connected speakers |

Settings: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`, `VOICE_LANGUAGE` (sv),
`VOICE_REPLY_TIMEOUT`, `VOICE_BUSY_TEXT`, `VOICE_OFFLINE_TEXT`. Friendly speaker names:
`config/voice-devices.json` `{ "devices": { "jarvis-aabbcc": "kitchen" } }`. Voice also offers the
`say` action to other channels (job steps).

Test without hardware: `bun tests/fake-device.ts "Vad är klockan?" [device-id] [listen-seconds]` speaks
a sentence into `/voice` and saves the answer to `replies/*.wav`.

## jobs

Timed and triggered work, see [jobs.md](jobs.md).

## discord

A bot on the channels in `DISCORD_CHANNEL_IDS` plus DMs (`DISCORD_MENTION_ONLY=true`: guild channels
only when mentioned). Events: `<channel ... chat_id="..." message_id="..." user="<person|unknown>"
username="..." dm="true|false">`. Images are saved to `inbox/discord/` and their paths added to the
text; small text files are inlined. A typing indicator runs until the reply.

| Tool | |
|---|---|
| `reply {chat_id, text, reply_to?, files?}` | Send a message (split at 2000 characters, files attached to the last part) |
| `react {chat_id, message_id, emoji}` | Add a reaction |
| `list_chats` | The channels the bot listens on |

Settings: `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_IDS`, `DISCORD_MENTION_ONLY`. The bot needs the Message
Content intent.

## email

Resend: inbound mail arrives as a webhook at `POST /email/inbound`, verified with the Svix signature when
`RESEND_WEBHOOK_SECRET` is set. Only mail to `EMAIL_ALLOWED_RECIPIENTS` from `EMAIL_ALLOWED_SENDERS` is
accepted (both required). The full mail (fetched from the Resend API), its HTML and attachments are
saved in `inbox/email/<time>/`. Events: `<channel ... from="..." name="..." user="..." subject="..."
message_id="..." folder="...">body</channel>`.

| Tool | |
|---|---|
| `send_email {to, subject, text, in_reply_to?, attachments?}` | `to` is a name from users.json or an address; `in_reply_to` threads the reply; attachments are `{filename, content}` or `{path}` |

Settings: `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `RESEND_WEBHOOK_SECRET`, `EMAIL_ALLOWED_SENDERS`,
`EMAIL_ALLOWED_RECIPIENTS`.

## Users

`config/users.json` maps channel identities to people; channels put the name in the `user` attribute
(`unknown` otherwise), and `send_email` resolves names through it.

```json
{ "users": [ { "name": "Alex", "aliases": { "discord": ["1234..."], "email": ["alex@example.com"] },
               "contact": { "email": "alex@example.com" } } ] }
```

## Security

`GATEWAY_TOKEN` protects `/mcp/*` with a bearer token (set it for the daemon and the Claude process; the
plugins send `Bearer ${GATEWAY_TOKEN}`). The other endpoints are meant for the local network, like the
devices and webhooks that call them.

## HTTP overview

| | |
|---|---|
| `GET /health` | `{ok, channels: {name: sessionConnected}}` |
| `GET /api/channels` | Per channel: session connected + status |
| `GET /api/jobs`, `GET /api/runs`, `POST /api/jobs/:id/run` | Jobs, run history, trigger |
| `POST /voice/say`, `POST /voice/ask`, `GET /api/voice/devices` | Voice |
| `POST /email/inbound` | Resend webhook |
| `/mcp/<channel>` | MCP endpoint for the session |
