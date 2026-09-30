# Handoff: open work

State 2026-09-28: all four channels (voice, jobs, Discord, email), the Home skill, hooks, notes and the Docker
image work and run in production for the first user. The dashboard (`/dashboard`, [docs/dashboard.md](docs/dashboard.md))
is built and tested locally, not yet deployed. Open work in priority order.

## Next

1. **Dashboard in production.** Deploy the image; set `LOKI_URL`/`PROMETHEUS_URL` for the daemon if the usage page
   should work there; enable `dashboard@switchboard` in the workspace settings. Then use it for a while and see
   what's missing. Not built on purpose: actions (run a job, toggles; later, behind a token, with a `button`
   widget), a `session` source (needs session status first), named/shared sources.
2. **Tests.** Only manual ones (`tests/fake-device.ts`, `/voice/ask`, job webhooks). A small smoke test that starts
   the daemon and exercises the jobs runner and routes would catch regressions.

## Later, if cheap

- **Discord: message a person, not a channel.** `reply` needs a `chat_id`, so the person has to write first;
  good enough for now. A tool that takes a Discord user id (from users.json) and opens the DM would remove that.
- **Speaker firmware.** `firmware/` builds both boards. The Korvo case model goes into `firmware/` once it's
  finished. To do at the next reflash (not before; firmware changes are only worth it when they can be tested):
  - Flash the Korvo with the current build: it gets the playback ring buffer, which has only been tested on the
    Waveshare.
  - Keep whole samples in `playback_task` (`main/main.c`): `xStreamBufferReceive` can return an odd byte count
    when the task catches up with the network, and the Waveshare `bsp_audio_play` does `length / 2`, dropping
    the odd byte. Every later read then starts mid-sample, which plays as static until another odd read. Round
    `got` down to even and keep the leftover byte for the next read. The daemon only sends whole-sample frames
    now, so this is belt and braces.

## Watching, no action

- **Voice timing.** `VOICE_REPLY_TIMEOUT` (20 s) once fired on a first-use skill lookup; `/voice/ask` returns the
  first `speak`, which can be an interim "one moment". Fine in daily use so far.
- **Nightly restart.** `/clear` left the channels registered but without event streams, so every event was
  dropped until a restart (2026-09-28/29). The nightly job now sends `/exit` and the tmux loop starts a fresh
  session, and the daemon counts a session as connected only while its event stream is open. Check the morning
  after (2026-09-30) that channels answer; a day's session hasn't come near compaction.
- **Static on the Korvo speaker.** 2026-09-30: three answers played as static from the start, all on the Korvo
  (still on the old firmware without the ring buffer; the Waveshare may have had it unheard). The old gateway never
  did this in months, with the same 8000-byte head start. Suspected cause: odd-sized ElevenLabs chunks forwarded
  as-is, leaving a frame that ends mid-sample. The daemon now sends only whole samples and logs chunk stats per
  answer (`spoke on …` in the voice log). If static comes back, check that line: odd chunks are now harmless, so
  look at the longest gap and at the firmware.
- **Claude Code updates** in the image are a `CLAUDE_CODE_VERSION` bump and a rebuild.
