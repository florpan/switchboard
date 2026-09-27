---
name: Dashboard
description: Change the switchboard dashboard (http://<gateway>:8090/dashboard) by editing config/dashboard.json in the workspace; pages, widgets (stat, list, table, sparkline, feed, status, gauge, bars, markdown, image), their data sources (built-in, script, http, loki, prometheus) and the theme (presets chiba, ice, deadchannel). USE WHEN adding, moving or removing something on the dashboard, showing new data on it, changing its colours or look, or when a dashboard widget shows an error.
allowed-tools: Bash(bun ${CLAUDE_SKILL_DIR}/dashboard.ts *)
---

# Dashboard

The dashboard is one file: `config/dashboard.json` in the workspace. The daemon watches it and every open page
updates within a second. Never write HTML or CSS; the widget types and their look are fixed by the product.

Workflow:
1. Read `config/dashboard.json` (if it doesn't exist the default page is showing; start from
   `workspace.example/config/dashboard.json` of the product or write a new one).
2. Edit it. Keep widgets from overlapping: `at` is `[x, y, w, h]` in cells of a 12-column grid, rows 64 px.
3. Save, then `bun ${CLAUDE_SKILL_DIR}/dashboard.ts check`: it validates the saved file and runs each source once. Fix every error
   it prints. A file that doesn't parse is ignored (the last good one stays) with the error shown on the page.
4. `bun ${CLAUDE_SKILL_DIR}/dashboard.ts show` lists what every widget currently gets, when a page is open.

Commit the change with the rest of the workspace when asked to keep it.

## Shape

```json
{ "title": "switchboard // jarvis",
  "theme": { "preset": "chiba" },
  "pages": [{ "title": "Home", "columns": 12, "widgets": [
    { "type": "stat", "title": "Speakers", "source": "devices", "field": "length", "sub": "connected", "at": [0, 0, 3, 2] }
  ] }] }
```

Widget keys: `type`, `title`, `source`, `field` (dot path into the source's result; `length` counts a list),
`at`, plus the options below. More than one page gives tabs. Small screens stack widgets in file order.

## Sources

- Built-in names: `channels` `[{name, state, meta, session}]`, `jobs` `[{id, trigger, lastRun, result, next}]`,
  `runs` `[{time, source, text, job, status, detail}]`, `devices` `[{id, name, state}]`,
  `health` `{ok, uptime, connected, channels}`. Refreshed every 5 s.
- `{"script": "bun scripts/x.ts", "every": 60, "timeout": 10}`: bash in the workspace; stdout JSON (or text).
  Non-zero exit is an error. Best way to add something new: write a small script in `scripts/` that prints
  exactly the shape the widget wants.
- `{"http": "https://host/api?key=${API_KEY}", "headers": {"Authorization": "Bearer ${TOKEN}"}}`: GET, `${NAME}`
  from the workspace `.env`, resolved in the daemon (never in the browser). Use `field` to pick a value.
- `{"loki": "...", "range": "today"}` / `{"prometheus": "..."}`: only when `LOKI_URL` / `PROMETHEUS_URL` are
  set. `$range` in the query is the window (`today`, `24h`, `7d`), `$step` the step of `"series": true`.
  One unlabelled value gives a number, labelled values `{label: n}`, series `{label: [n]}`, a Loki log query
  (starting with `{`) a feed list `[{time, source, text}]` (`source` from the label in `"label"`).
  `usage-page.json` beside this file is a ready page of Claude Code usage (cost, prompts, tools,
  conversation) from Claude Code's OpenTelemetry events in Loki: add it to `pages` as is.

## Widgets: data they expect, options

| type | data | options |
|---|---|---|
| stat | number/string or `{value, sub, unit}` | prefix, unit, decimals, sub, color |
| gauge | number or `{value, max, min, unit, ...details}` | min, max (100), unit, decimals, color |
| status | `[{name, state, meta}]` or `{name: state}`; state ok/warn/bad/off or true/false | limit |
| list | `[string]` or `[{text, meta}]` | limit |
| table | `[{...}]` or `{key: value}` | columns, limit |
| feed | `[{time, source, text, detail}]` | limit |
| bars | `{label: n}` or `[{label, value}]` | limit (10), prefix, decimals |
| sparkline | `[n]` or `{series: [n]}` | show (sum/last/max), prefix, decimals |
| markdown | string, or no source and `text` | text |
| image | URL, or no source and `src` | src, every |

`color` is a theme colour name (primary, accent, ok, warn, bad, muted). `empty` sets the text for an empty
list. Table columns named result/status/state/ok render done/error/pending/... as coloured tags; ISO times
render as local times.

## Theme

`"theme": {"preset": "chiba" | "ice" | "deadchannel", ...overrides, "glow": true, "scanlines": true, "static": true}`.
Chiba is cyan and magenta on blue-black, ice cold blue and ultraviolet, deadchannel chrome grey with amber.
Overridable colours: bg, bg2, panel, line, text, muted, dim, primary, accent, ok, warn, bad, grid (CSS colour
strings). The three effects switch off with `false`.
