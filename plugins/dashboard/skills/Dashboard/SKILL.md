---
name: Dashboard
description: Change the switchboard dashboard (http://<gateway>:8090/dashboard) by editing config/dashboard.json in the workspace; pages, widgets (stat, list, table, sparkline, feed, status, gauge, bars, markdown, image, custom), their data sources (built-in, script, http, loki, prometheus), backends for custom widgets, and the theme (presets chiba, ice, deadchannel). USE WHEN adding, moving or removing something on the dashboard, showing new data on it, changing its colours or look, or when a dashboard widget shows an error.
allowed-tools: Bash(bun ${CLAUDE_SKILL_DIR}/dashboard.ts *)
---

# Dashboard

The dashboard is one file: `config/dashboard.json` in the workspace. The daemon watches it and every open page
updates within a second. The dashboard owns the look: header, grid, panels, theme. Use the built-in widget types
and never write HTML or CSS for them. Only when none of them can show something (an interactive map, a graph
explorer) write a custom widget (below); it draws inside its own box and never changes the page around it.

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

## Custom widgets

For what the fixed types can't show. An ES module that exports `mount(root, ctx)`:

```js
// dashboard/widgets/hello.js in the workspace
export function mount(root, ctx) {            // root: a ShadowRoot; its CSS stays inside
  root.innerHTML = '<style>p { color: var(--primary) }</style><p></p>'
  const show = data => { root.querySelector('p').textContent = `${ctx.options.greeting}: ${data?.connected}` }
  show(ctx.data)
  return { update: show, unmount() {} }      // both optional; update gets new source data
}
```

```json
{ "type": "custom", "title": "Hello", "module": "widgets/hello.js", "source": "health", "options": { "greeting": "hej" }, "at": [0, 0, 4, 2] }
```

- `module`: a path under the workspace's `dashboard/` folder, or `"<backend>:<path>"` for code a service serves
  itself (it then loads, and fetches relative to its own URL, through the backend).
- `ctx`: `options` (from the widget), `data` (its `source`, optional, same sources as other widgets), `theme`
  (the colours), `api(backend, path, params)` (GET JSON through a backend).
- Style with the theme's CSS variables: `--bg`, `--bg-2`, `--panel`, `--line`, `--text`, `--muted`, `--dim`,
  `--primary`, `--accent`, `--ok`, `--warn`, `--bad`, `--font`. They reach into the shadow root.
- `"bare": true` drops the widget's title and padding. A page with `"fill": true` and one widget gives it the
  whole window below the header.
- After saving, `check` validates the widget; open the page to see the module load (its errors show in place).

**Backends**: services the browser may reach through the daemon, so they need no CORS and secrets stay in the
daemon. `GET /dashboard/backend/<name>/<path>` goes to `url + path` with the configured headers (`${NAME}` from
the environment). GET only, never above `url`.

```json
"backends": { "knowledge": { "url": "http://host:8850/explorer/", "headers": { "Authorization": "Bearer ${KNOWLEDGE_TOKEN}" } } }
```

## Theme

`"theme": {"preset": "chiba" | "ice" | "deadchannel", ...overrides, "glow": true, "scanlines": true, "static": true}`.
Chiba is cyan and magenta on blue-black, ice cold blue and ultraviolet, deadchannel chrome grey with amber.
Overridable colours: bg, bg2, panel, line, text, muted, dim, primary, accent, ok, warn, bad, grid (CSS colour
strings). The three effects switch off with `false`.
