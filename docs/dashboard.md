# Dashboard

The daemon serves a read-only dashboard at `http://<gateway>:8090/dashboard`. Everything on it comes from
one file, `config/dashboard.json` in the workspace: pages, widgets, where their data comes from, and the
theme. The assistant changes the dashboard by editing that file (the Dashboard skill, plugin
`dashboard@switchboard`, documents it for the session); it never writes HTML. Without the file the daemon
shows a default page with channels, jobs and job runs.

## How it works

- The daemon watches `config/dashboard.json`. Open pages get the new layout at once over server-sent events
  (`/dashboard/events`).
- A file that doesn't parse keeps the last good config; the page shows the error above the widgets. A
  single broken widget (unknown type, bad source) shows its error in its own place, and the rest still work.
- Sources run in the daemon, on their own intervals, only while a page is open. The browser gets widget
  data only: no script output beyond what the widget shows, no URLs with secrets, no queries.
- When a source fails, the widget keeps its last data and shows the error under it.
- Widget types are a fixed vocabulary rendered by the product. What an owner can change is layout,
  sources and options.

Code: `src/dashboard/`: `config.ts` (schema, validation, theme presets), `sources.ts` (source runners),
`index.ts` (file watching, routes, SSE), `client.ts` + `page.html` (the browser side, no framework;
`client.ts` is transpiled by Bun at startup).

| Route | |
|---|---|
| `GET /dashboard` | The page. `#1` opens the second page |
| `GET /api/dashboard` | The loaded config's errors and what every widget currently gets (after `field`) |
| `POST /api/dashboard/check` | Validate `config/dashboard.json` and run each of its sources once; `{ok, errors}`. Only the file on disk, never a posted config: sources run commands and carry secrets |

## The file

```json
{
  "title": "switchboard // jarvis",
  "theme": { "preset": "chiba", "static": false },
  "pages": [
    { "title": "Home", "columns": 12, "widgets": [
      { "type": "status", "title": "Channels", "source": "channels", "at": [0, 0, 4, 4] },
      { "type": "table", "title": "Jobs", "source": "jobs", "columns": ["id", "trigger", "lastRun", "result", "next"], "at": [4, 0, 8, 4] },
      { "type": "stat", "title": "Solar", "source": { "script": "bun scripts/solar.ts", "every": 60 }, "field": "kw", "unit": "kW", "at": [0, 4, 3, 2] }
    ] }
  ]
}
```

- `title`: header text; `//` renders as the accent separator.
- `pages[]`: `title`, `columns` (12), `widgets`. With more than one page the header shows tabs.
- A widget: `type`, `title`, `source`, optional `field`, `at`, plus options per type.
- `at: [x, y, w, h]`: grid cells from the top left; a row is 64 px. Without `at` a widget takes 4 columns
  and 4 rows in reading order. On screens under 900 px wide, `at` is ignored and widgets stack in file
  order, so put the important ones first.
- `field`: a dot path into the source's result, e.g. `"connected"`, `"items.0.name"`, `"length"` (for a
  count of a list).

## Sources

| Source | Result | Default interval |
|---|---|---|
| `"channels"` | `[{name, state, meta, session, ...status}]` per channel | 5 s |
| `"jobs"` | `[{id, description, trigger, lastRun, result, detail, next, active}]` | 5 s |
| `"runs"` | job runs, newest first: `[{time, source, text, job, trigger, status, detail, ms}]` | 5 s |
| `"devices"` | connected speakers: `[{id, name, connectedAt, state, meta}]` | 5 s |
| `"health"` | `{ok, uptime, connected, channels}` | 5 s |
| `{"script": "cmd", "every": 60, "timeout": 10}` | stdout of a bash command run in the workspace, parsed as JSON (or text) | 60 s |
| `{"http": "url", "headers": {}, "every": 60}` | GET; `${NAME}` in the URL and headers is filled from the daemon's environment | 60 s |
| `{"loki": "query", ...}` | see below; needs `LOKI_URL` | 60 s |
| `{"prometheus": "query", ...}` | see below; needs `PROMETHEUS_URL` | 60 s |

A script exiting non-zero is an error (its stderr is shown). The workspace `.env` is in the environment of
both scripts and `${NAME}` substitution.

**Loki and Prometheus.** Generic query sources for anyone who has them; nothing in the default config needs
them. Options: `range` (`"today"` by default, or `30m`, `24h`, `7d`), `series: true` for a range query
(sparklines), `limit` and `label` for log queries. In the query, `$range` becomes the window (e.g.
`[$range]`) and `$step` the step of a series (window / 48, at least 60 s). Results:

- one number, no labels -> a number (`stat`, `gauge`);
- several labelled values -> `{label: number}` (`bars`, `table`);
- `series: true` -> `{label: [numbers]}` (`sparkline`);
- a Loki log query (starts with `{`) -> `[{time, source, text}]` (`feed`), `source` from the label named by
  `label` (`event_name`). Use `line_format` to shape the text.

Loki only indexes a few labels; filter structured metadata after the selector
(`{service_name="claude-code"} | event_name="api_request"`). See [deploy.md](deploy.md#usage-metrics-and-activity-opentelemetry) for
sending Claude Code's own telemetry there, and the Dashboard skill for a usage page built on it.

## Widgets

What each type expects from its data (after `field`), and its options.

| Type | Data | Options |
|---|---|---|
| `stat` | number or string, or `{value, sub, unit}` | `prefix`, `unit`, `decimals`, `sub`, `color` |
| `gauge` | number, or `{value, max, min, unit, ...}` (other keys are listed beside it) | `min` (0), `max` (100), `unit`, `decimals`, `color` |
| `status` | `[{name, state, meta}]` or `{name: state}`; state `ok`/`warn`/`bad`/`off` or a boolean | `limit` |
| `list` | `[string]` or `[{text, meta}]` | `limit` |
| `table` | `[{...}]` or `{key: value}` | `columns` (keys, default all of the first row), `limit` |
| `feed` | `[{time, source, text, detail}]` | `limit` |
| `bars` | `{label: number}` or `[{label, value}]`, sorted largest first | `limit` (10), `prefix`, `decimals` |
| `sparkline` | `[numbers]` or `{series: [numbers]}` | `show` (`sum`/`last`/`max` beside each series), `prefix`, `decimals` |
| `markdown` | a string; or no source and `text` | `text` |
| `image` | a URL; or no source and `src` | `src`, `every` (reload, seconds) |

- `color`: a theme colour name: `primary`, `accent`, `ok`, `warn`, `bad`, `muted`.
- Tables format ISO times as `14:05` (today) or `tue 14:05`; columns named `result`, `status`, `state` or
  `ok` show values like `done`/`error`/`pending` as coloured tags.
- `empty`: text shown when a list is empty (all list-like types).

## Theme

```json
"theme": { "preset": "chiba", "accent": "#ff6ad5", "glow": true, "scanlines": true, "static": false }
```

Three presets, from [design/dashboard-palettes.html](../design/dashboard-palettes.html) (open it to compare
them with the effects on and off):

- `chiba` (default): cyan and magenta on blue-black;
- `ice`: Sprawl ICE, cold blue and ultraviolet;
- `deadchannel`: chrome greys with sodium amber.

Any colour of the preset can be overridden: `bg`, `bg2`, `panel`, `line`, `text`, `muted`, `dim`,
`primary`, `accent`, `ok`, `warn`, `bad`, `grid`. `glow`, `scanlines` and `static` switch the effects (all on
by default). The page honours reduced-motion settings.
