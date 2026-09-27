// config/dashboard.json: pages of widgets, each fed by a source, plus a theme. Validated here for the daemon
// and for POST /api/dashboard/check, so the agent gets the same errors before and after saving.

export const WIDGETS = ['stat', 'list', 'table', 'sparkline', 'feed', 'status', 'gauge', 'bars', 'markdown', 'image'] as const
export const BUILTIN = ['channels', 'jobs', 'runs', 'devices', 'health'] as const
const KINDS = ['script', 'http', 'loki', 'prometheus'] as const

export type Source =
  | (typeof BUILTIN)[number]
  | { script: string; every?: number; timeout?: number }
  | { http: string; headers?: Record<string, string>; every?: number }
  | { loki: string; range?: string; series?: boolean; limit?: number; label?: string; every?: number }
  | { prometheus: string; range?: string; series?: boolean; every?: number }

export interface Widget {
  type: (typeof WIDGETS)[number]
  title?: string
  source?: Source
  /** Dot path into the source's result, e.g. "channels.0.name". */
  field?: string
  /** [x, y, w, h] in grid cells; without it widgets flow in order, 4 columns wide. */
  at?: [number, number, number, number]
  [option: string]: unknown
}

export interface Page {
  title: string
  columns?: number
  widgets: Widget[]
}

export interface Config {
  title?: string
  theme?: Record<string, string | boolean>
  pages: Page[]
}

// The three palettes from design/dashboard-palettes.html. Chiba is the default; any variable can be overridden.
export const PRESETS: Record<string, Record<string, string>> = {
  chiba: {
    bg: '#070a12', bg2: '#0c1220', panel: 'rgba(14, 22, 38, .72)', line: '#1b2a44',
    text: '#d6e2f0', muted: '#6b7f99', dim: '#34445c',
    primary: '#00e5ff', accent: '#ff2bd6', ok: '#2dffb3', warn: '#ffb020', bad: '#ff3b5c',
    grid: 'rgba(0, 229, 255, .05)',
  },
  ice: {
    bg: '#05060f', bg2: '#0a0d1f', panel: 'rgba(12, 16, 38, .74)', line: '#1d2350',
    text: '#dfe6ff', muted: '#7480b3', dim: '#333b6b',
    primary: '#5ab4ff', accent: '#b15cff', ok: '#7df9ff', warn: '#ffd166', bad: '#ff4d6d',
    grid: 'rgba(90, 180, 255, .05)',
  },
  deadchannel: {
    bg: '#0a0a0c', bg2: '#111115', panel: 'rgba(22, 22, 27, .78)', line: '#2a2a31',
    text: '#e4e4e8', muted: '#85858f', dim: '#3c3c44',
    primary: '#c8ccd4', accent: '#ff9f1c', ok: '#19e6c1', warn: '#ff9f1c', bad: '#ff4b3e',
    grid: 'rgba(200, 204, 212, .035)',
  },
}
const EFFECTS = ['glow', 'scanlines', 'static']

/** Preset plus overrides, as CSS variables and effect switches for the page. */
export function resolveTheme(theme: Config['theme'] = {}) {
  const preset = PRESETS[String(theme.preset ?? 'chiba')] ?? PRESETS.chiba!
  const vars: Record<string, string> = { ...preset }
  for (const [key, value] of Object.entries(theme))
    if (key in preset && typeof value === 'string') vars[key] = value
  const effects = Object.fromEntries(EFFECTS.map(e => [e, theme[e] !== false]))
  return { vars, effects }
}

/**
 * Throws for errors that make the whole file unusable (bad JSON, no pages); returns per-widget errors, which
 * the page shows in place of the widget.
 */
export function validate(text: string): { config: Config; errors: string[] } {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`not valid JSON: ${(err as Error).message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected an object with "pages"')
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) throw new Error('"pages" must be a non-empty array')

  const errors: string[] = []
  const theme = raw.theme ?? {}
  if (typeof theme !== 'object' || Array.isArray(theme)) errors.push('theme: expected an object')
  else
    for (const [key, value] of Object.entries(theme)) {
      if (key === 'preset') {
        if (!(String(value) in PRESETS)) errors.push(`theme.preset: "${value}" is not one of ${Object.keys(PRESETS).join(', ')}`)
      } else if (EFFECTS.includes(key)) {
        if (typeof value !== 'boolean') errors.push(`theme.${key}: expected true or false`)
      } else if (!(key in PRESETS.chiba!)) errors.push(`theme.${key}: unknown (colours: ${Object.keys(PRESETS.chiba!).join(', ')})`)
      else if (typeof value !== 'string') errors.push(`theme.${key}: expected a CSS colour string`)
    }

  raw.pages.forEach((page: any, p: number) => {
    const where = `pages[${p}]`
    if (!page || typeof page.title !== 'string') throw new Error(`${where}: needs a "title"`)
    if (!Array.isArray(page.widgets)) throw new Error(`${where}: "widgets" must be an array`)
    const columns = page.columns ?? 12
    if (!Number.isInteger(columns) || columns < 1) throw new Error(`${where}.columns: expected a positive integer`)
    page.widgets.forEach((w: any, i: number) => {
      const problem = widgetError(w, columns)
      if (problem) {
        errors.push(`${where}.widgets[${i}]${w?.title ? ` "${w.title}"` : ''}: ${problem}`)
        w.error = problem
      }
    })
  })
  return { config: raw as Config, errors }
}

function widgetError(w: any, columns: number): string | undefined {
  if (!w || typeof w !== 'object') return 'expected an object'
  if (!WIDGETS.includes(w.type)) return `type "${w.type}" is not one of ${WIDGETS.join(', ')}`
  if (w.at !== undefined) {
    const at = w.at
    if (!Array.isArray(at) || at.length !== 4 || !at.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0))
      return '"at" must be [x, y, w, h] with whole numbers'
    if (at[2] < 1 || at[3] < 1) return '"at": width and height must be at least 1'
    if (at[0] + at[2] > columns) return `"at": x + w is ${at[0] + at[2]}, more than the ${columns} columns`
  }
  const static_ = (w.type === 'markdown' && typeof w.text === 'string') || (w.type === 'image' && typeof w.src === 'string')
  if (w.source === undefined) return static_ ? undefined : 'needs a "source"'
  return sourceError(w.source)
}

function sourceError(s: any): string | undefined {
  if (typeof s === 'string') return BUILTIN.includes(s as any) ? undefined : `source "${s}" is not one of ${BUILTIN.join(', ')}`
  if (!s || typeof s !== 'object') return 'source must be a built-in name or an object'
  const kinds = KINDS.filter(k => k in s)
  if (kinds.length !== 1) return `source needs exactly one of ${KINDS.join(', ')}`
  const kind = kinds[0]!
  if (typeof s[kind] !== 'string' || !s[kind]) return `source.${kind} must be a non-empty string`
  for (const key of ['every', 'timeout', 'limit'])
    if (s[key] !== undefined && !(typeof s[key] === 'number' && s[key] > 0)) return `source.${key} must be a positive number (seconds)`
  if (s.range !== undefined && parseRange(s.range) === undefined) return `source.range "${s.range}": use "today" or a duration like 30m, 24h, 7d`
  return undefined
}

/** "today" or 30m / 24h / 7d, as seconds back from now. */
export function parseRange(range: string, now = new Date()): number | undefined {
  if (range === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return Math.max(60, Math.round((+now - +midnight) / 1000))
  }
  const m = /^(\d+)([smhd])$/.exec(range)
  return m ? Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's']! : undefined
}
