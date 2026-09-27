# Handoff: open work

State 2026-09-27: all four channels (voice, jobs, Discord, email), the Home skill, hooks, notes and the Docker
image work and run in production for the first user. Open work in priority order.

## Next

1. **Dashboard.** Planned 2026-09-27, see [the plan below](#dashboard-plan). Palette picked (Chiba); ready to build.
2. **Tests.** Only manual ones (`tests/fake-device.ts`, `/voice/ask`, job webhooks). A small smoke test that starts
   the daemon and exercises the jobs runner and routes would catch regressions.

## Later, if cheap

- **Discord: message a person, not a channel.** `reply` needs a `chat_id`, so the person has to write first;
  good enough for now. A tool that takes a Discord user id (from users.json) and opens the DM would remove that.
- **Speaker firmware.** `firmware/` builds both boards. The Korvo-1 build now includes the playback ring buffer,
  which has only been tested on the Waveshare; try it when a Korvo is reflashed anyway. The Korvo case model goes
  into `firmware/` once it's finished.

## Dashboard plan

New, not a port of the old gateway UI. The idea: **everything on it is config the agent can edit**, so each owner's
dashboard becomes their own, the same way their jobs and skills are.

Decided:
- **Served by the daemon** at `/dashboard` on :8090. No extra container, no build step beyond what Bun does.
- **Read-only** for now. Actions (run a job, toggle things) later, behind a token.
- **Telemetry the easy way:** the daemon queries Loki and Prometheus itself (URLs from env, e.g. `LOKI_URL`,
  `PROMETHEUS_URL`), rather than receiving a copy from the collector. The queries in
  `deploy/grafana/claude-code.json` are tested and a good start (note: in Loki only `service_name` is an index
  label; filter the rest with `| event_name="..."`).
- **The agent never writes HTML.** It edits `config/dashboard.json` in the workspace: layout, widgets, data
  sources, theme.

How it works:
- The daemon watches `config/dashboard.json` (like `jobs.json`) and pushes changes to open browsers (SSE). An
  invalid file keeps the last good config and shows the error on the page, so the agent sees its own mistake.
- **Widget types** are a fixed vocabulary shipped in the product, rendered by the product: `stat`, `list`,
  `table`, `sparkline`, `feed`, `status`, `gauge`, `bars`, `markdown`, `image`. (Later: `button`.) The mockup
  in `design/dashboard-palettes.html` shows most of them, including an error widget.
- **Data sources** are where it's dynamic:
  - built-in: `channels`, `jobs`, `runs`, `devices`, `health` (existing APIs; `session` once session status exists)
  - `script`: a shell command run in the workspace on an interval (`every`, `timeout`), stdout is JSON. Same
    idea as job steps; this is how the agent adds anything new: a small script in a skill plus one widget entry.
  - `http`: GET with `${ENV}` substituted by the daemon, so secrets never reach the browser; pick a field.
  - `loki` / `prometheus`: a query, for usage and activity.
  The daemon runs and caches sources server-side; the browser only gets widget data.
- **Theme** is a set of CSS variables in the same config (`theme: { bg, panel, line, text, muted, primary,
  accent, ok, warn, bad, glow, scanlines, static }`), with the chosen palette as the default.
- Default config in `workspace.example/config/dashboard.json`: channels, jobs with last run and result, today's
  cost and prompts, activity feed. That's the "fixed" part, but it's just config too.
- A **Dashboard skill** in `workspace.example/.claude/skills/` documents the schema for the agent, plus a small
  `check` command that validates the file before it's saved (and the daemon validates again).

Sketch (not final):
```json
{ "theme": { "preset": "chiba", "glow": true, "scanlines": true, "static": true },
  "pages": [{ "title": "Home", "columns": 12, "widgets": [
    { "type": "status", "title": "Channels", "source": "channels", "at": [0, 0, 4, 3] },
    { "type": "table", "title": "Jobs", "source": "jobs", "columns": ["id", "trigger", "lastRun", "result", "next"], "at": [4, 0, 8, 3] },
    { "type": "stat", "title": "Cost today", "source": { "loki": "sum(sum_over_time({service_name=\"claude-code\"} | event_name=\"api_request\" | unwrap cost_usd [1d]))", "every": 60 }, "unit": "usd", "at": [0, 3, 3, 1] },
    { "type": "gauge", "title": "Solar", "source": { "script": "bun .claude/skills/Home/cli.ts solar --json", "every": 60 }, "value": "watts", "max": 6000, "at": [3, 3, 3, 2] }
  ] }] }
```

Open questions for the build session: exact source-to-widget data shapes (what JSON each widget type expects),
how `at` works on narrow screens, and where the code lives (probably `src/dashboard/`: config loader + source
runners on the server, plain TypeScript modules for the browser, no framework). Keep it small, like a channel.

Look: futuristic, dark, neon accents, glow; Neuromancer, not the Matrix (no green, no character rain). Three
palettes in `design/dashboard-palettes.html`: **Chiba** (cyan and magenta on blue-black), **Sprawl ICE** (cold
blue and ultraviolet), **Dead channel** (chrome greys with sodium amber). Glow, scanlines and a faint TV-static
overlay can each be switched off there to judge the effects. **Picked: Chiba** (2026-09-27, from screenshots;
the owner will still check the effects in the HTML). Its variables in that file are the default theme.

## Watching, no action

- **Voice timing.** `VOICE_REPLY_TIMEOUT` (20 s) once fired on a first-use skill lookup; `/voice/ask` returns the
  first `speak`, which can be an interim "one moment". Fine in daily use so far.
- **Compaction.** Nightly `/clear` works and a day's session hasn't come near compaction.
- **Claude Code updates** in the image are a `CLAUDE_CODE_VERSION` bump and a rebuild.
