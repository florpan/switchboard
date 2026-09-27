# Handoff: open work

State 2026-09-27: all four channels (voice, jobs, Discord, email), the Home skill, hooks, notes and the Docker
image work and run in production for the first user. Open work in priority order.

## Next

1. **Usage metrics.** Claude Code's built-in OpenTelemetry (env vars only, nothing in this repo's code) sent to
   an OpenTelemetry Collector, which forwards metrics to Prometheus, events to Loki and traces to Tempo; Grafana
   on top. Enable prompts and tool details (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`) and the beta traces
   (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`): only traces carry `agent_id`/`parent_agent_id`, which is what
   shows which agent and subagent did what. Tag each source with `OTEL_RESOURCE_ATTRIBUTES`. Document the env
   vars in docs/deploy.md once it works.
2. **Dashboard (new, not a port of the old gateway UI).** Channel status, jobs (list, edit, run, run history),
   users and their channel identities, session status, and live activity per agent and subagent from the
   telemetry. Available API: `GET /health`, `/api/channels`, `/api/jobs`, `/api/runs`, `/api/voice/devices`,
   `POST /api/jobs/:id/run`. Missing API: job create/update/delete over HTTP (the session has tools for it),
   users read/write, session status (running? which dialog is it waiting on? tmux capture), daemon log tail.
3. **Tests.** Only manual ones (`tests/fake-device.ts`, `/voice/ask`, job webhooks). A small smoke test that starts
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
- **Compaction.** Nightly `/clear` works and a day's session hasn't come near compaction.
- **Claude Code updates** in the image are a `CLAUDE_CODE_VERSION` bump and a rebuild.
