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
- **Speaker firmware.** `firmware/` builds both boards. The Korvo-1 build now includes the playback ring buffer,
  which has only been tested on the Waveshare; try it when a Korvo is reflashed anyway. The Korvo case model goes
  into `firmware/` once it's finished.

## Watching, no action

- **Voice timing.** `VOICE_REPLY_TIMEOUT` (20 s) once fired on a first-use skill lookup; `/voice/ask` returns the
  first `speak`, which can be an interim "one moment". Fine in daily use so far.
- **Nightly restart.** `/clear` left the channels registered but without event streams, so every event was
  dropped until a restart (2026-09-28/29). The nightly job now sends `/exit` and the tmux loop starts a fresh
  session, and the daemon counts a session as connected only while its event stream is open. Check the morning
  after (2026-09-30) that channels answer; a day's session hasn't come near compaction.
- **Claude Code updates** in the image are a `CLAUDE_CODE_VERSION` bump and a rebuild.
