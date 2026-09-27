# Handoff: open work

State 2026-09-27: all four channels (voice, jobs, Discord, email), the Home skill, hooks, notes and the Docker
image work and run in production for the first user. What is left, roughly in priority order.

## Product

1. **Dashboard (new).** Replace the old gateway's UI rather than port it. Wanted: channel status, jobs (list, edit,
   run, run history), users and their channel identities (ACL: who may use Discord/email), settings, session status.
   Available API: `GET /health`, `/api/channels`, `/api/jobs`, `/api/runs`, `/api/voice/devices`,
   `POST /api/jobs/:id/run`. Missing API: job create/update/delete over HTTP (the session has tools for it),
   users read/write, session status (running? which dialog is it waiting on? tmux capture), daemon log tail.
2. **Usage metrics.** Decision so far: not in this repo. Claude Code's built-in OpenTelemetry export (env vars only)
   pointed at an existing collector/Grafana; document the env vars in docs/deploy.md once tried.
3. **Discord: message a person, not a channel.** `reply` needs a `chat_id`; to DM someone who hasn't written first,
   the channel needs a tool that takes a Discord user id (from users.json) and opens the DM.
4. **Voice tuning.** `VOICE_REPLY_TIMEOUT` (20 s) fired on a first-use skill lookup in testing; watch whether it
   is too eager. `/voice/ask` returns the first `speak`, which is an interim line when the session says "one
   moment" first.
5. **Compaction.** The design relies on regular `/clear` instead of compaction; no documented switch to turn
   auto-compaction off was found. Check `/config` in the current client and document it.
6. **GATEWAY_TOKEN by default in the Docker example**, so `/mcp/*` is not open on the network.
7. **Tests.** Only manual ones (`tests/fake-device.ts`, `/voice/ask`, job webhooks). A small smoke test that starts
   the daemon and exercises the jobs runner and routes would catch regressions.
8. **Updating Claude Code in the image** is a manual `CLAUDE_CODE_VERSION` bump; document a routine (and consider
   checking the channels still register after each bump, since channels are a research preview).
9. **Speaker firmware.** `firmware/` builds both boards. The Korvo-1 build now includes the playback ring
   buffer, which has only been tested on the Waveshare; try it on a Korvo when one is reflashed anyway. The
   Korvo case model goes into `firmware/` once it's finished.
