/// <reference lib="dom" />
// Browser side of /dashboard. Gets the layout and widget data over SSE and renders the fixed widget
// vocabulary. Transpiled by the daemon at startup; no imports, no framework.

type Result = { data?: unknown; error?: string; at?: string }
type Widget = { type: string; title?: string; key?: string; field?: string; at?: number[]; error?: string; [k: string]: any }
type View = {
  title: string
  error?: string
  theme: { vars: Record<string, string>; effects: Record<string, boolean> }
  pages: { title: string; columns: number; widgets: Widget[] }[]
}

let view: View | undefined
const results: Record<string, Result> = {}
const $ = (id: string) => document.getElementById(id)!

// --- connection -----------------------------------------------------------------------------

const events = new EventSource('/dashboard/events')
events.addEventListener('config', e => {
  view = JSON.parse((e as MessageEvent).data)
  applyTheme(view!)
  render()
})
events.addEventListener('data', e => {
  const update: Record<string, Result> = JSON.parse((e as MessageEvent).data)
  Object.assign(results, update)
  for (const key of Object.keys(update)) {
    document.querySelectorAll<HTMLElement>(`[data-key="${CSS.escape(key)}"]`).forEach(el => fill(el, widgetOf(el)))
    if (key === '"health"') session()
  }
})
events.onerror = () => {
  document.body.classList.add('offline')
  $('session').innerHTML = '<span class="dot bad"></span>daemon offline'
}
events.onopen = () => document.body.classList.remove('offline')
window.addEventListener('hashchange', render)

function applyTheme(v: View) {
  const root = document.documentElement
  for (const [name, value] of Object.entries(v.theme.vars)) root.style.setProperty(name === 'bg2' ? '--bg-2' : `--${name}`, value)
  root.dataset.glow = v.theme.effects.glow ? 'on' : 'off'
  root.dataset.scan = v.theme.effects.scanlines ? 'on' : 'off'
  root.dataset.static = v.theme.effects.static ? 'on' : 'off'
}

function session() {
  const h = results['"health"']?.data as { connected?: number } | undefined
  $('session').innerHTML = h?.connected
    ? '<span class="dot ok"></span>session live'
    : '<span class="dot warn"></span>no session'
}

// --- layout ---------------------------------------------------------------------------------

function render() {
  if (!view) return
  const [first, ...rest] = view.title.split('//')
  $('brand').innerHTML = rest.length ? `${esc(first!.trim())} <span>//</span> ${esc(rest.join('//').trim())}` : esc(view.title)
  document.title = view.title.replace('//', '·')

  const index = Math.min(Number(location.hash.slice(1)) || 0, view.pages.length - 1)
  const page = view.pages[index]!
  $('pages').innerHTML =
    view.pages.length > 1
      ? view.pages.map((p, i) => `<a href="#${i}"${i === index ? ' aria-current="page"' : ''}>${esc(p.title)}</a>`).join('')
      : ''

  const grid = $('grid')
  grid.style.setProperty('--cols', String(page.columns))
  grid.innerHTML = ''
  $('banner').innerHTML = ''
  if (view.error) {
    const banner = section('w err', 'dashboard.json', 'config')
    banner.querySelector('.body')!.innerHTML = `<pre>${esc(view.error)}\nshowing the last good config</pre>`
    $('banner').append(banner)
  }
  page.widgets.forEach((w, i) => {
    const el = section(`w t-${w.type}`, w.title ?? '', hint(w.key))
    el.dataset.page = String(index)
    el.dataset.index = String(i)
    if (w.key) el.dataset.key = w.key
    const [x, y, cw, ch] = w.at ?? []
    el.style.gridColumn = w.at ? `${x! + 1} / span ${cw}` : `span ${Math.min(4, page.columns)}`
    el.style.gridRow = w.at ? `${y! + 1} / span ${ch}` : 'span 4'
    grid.append(el)
    fill(el, w)
  })
  session()
}

function section(cls: string, title: string, note: string) {
  const el = document.createElement('section')
  el.className = cls
  el.innerHTML = `<h2>${esc(title)}<em>${esc(note)}</em></h2><div class="body"></div>`
  return el
}

function widgetOf(el: HTMLElement) {
  return view!.pages[Number(el.dataset.page)]!.widgets[Number(el.dataset.index)]!
}

/** "loki", "script · 60 s", "jobs": where a widget's data comes from. */
function hint(key?: string) {
  if (!key) return ''
  const s = JSON.parse(key)
  if (typeof s === 'string') return s
  const kind = ['script', 'http', 'loki', 'prometheus'].find(k => k in s) ?? ''
  return s.every ? `${kind} · ${s.every} s` : kind
}

function fill(el: HTMLElement, w: Widget) {
  const body = el.querySelector<HTMLElement>('.body')!
  el.querySelector('.stale')?.remove()
  const result: Result = w.key ? results[w.key] ?? {} : { data: undefined }
  const problem = w.error ?? (result.data === undefined ? result.error : undefined)
  el.classList.toggle('err', !!problem)
  if (problem) {
    body.innerHTML = `<pre>${esc(problem)}</pre>`
    return
  }
  if (w.key && result.data === undefined && !result.error) {
    body.innerHTML = '<span class="empty">waiting for data</span>'
    return
  }
  try {
    const data = w.field ? pick(result.data, w.field) : result.data
    body.innerHTML = (renderers[w.type] ?? (() => `unknown widget type ${esc(w.type)}`))(w, data)
  } catch (err) {
    el.classList.add('err')
    body.innerHTML = `<pre>${esc((err as Error).message)}</pre>`
  }
  if (result.error) {
    const stale = document.createElement('div')
    stale.className = 'stale'
    stale.textContent = `${result.error} · showing data from ${result.at ? time(result.at) : 'earlier'}`
    stale.title = result.error
    el.append(stale)
  }
}

// --- widgets --------------------------------------------------------------------------------

const renderers: Record<string, (w: Widget, data: any) => string> = {
  stat(w, data) {
    const d = isObject(data) ? data : { value: data }
    const unit = d.unit ?? w.unit
    const color = w.color ? ` style="--c: var(--${esc(w.color)})"` : ''
    const sub = d.sub ?? w.sub
    return `<div class="v"${color}>${esc(number(d.value, w))}${unit ? `<small>${esc(unit)}</small>` : ''}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`
  },

  status(w, data) {
    const items = isObject(data)
      ? Object.entries(data).map(([name, v]) => (isObject(v) ? { name, ...v } : { name, state: v }))
      : list(data, 'status')
    if (!items.length) return empty(w)
    return `<div class="rows">${items
      .slice(0, w.limit ?? 50)
      .map(i => `<div class="ch"><span class="dot ${state(i.state ?? i.ok ?? i.session)}"></span><span class="name">${esc(i.name ?? i.label ?? i.id ?? '')}</span><span class="meta">${esc(i.meta ?? '')}</span></div>`)
      .join('')}</div>`
  },

  list(w, data) {
    const items = list(data, 'list')
    if (!items.length) return empty(w)
    return `<div class="rows">${items
      .slice(0, w.limit ?? 50)
      .map(i => {
        const [text, meta] = typeof i === 'object' && i ? [i.text ?? i.label ?? i.name ?? i.title ?? '', i.meta ?? ''] : [i, '']
        return `<div class="ch nodot"><span class="name">${esc(text)}</span><span class="meta">${esc(format(meta))}</span></div>`
      })
      .join('')}</div>`
  },

  table(w, data) {
    const rows = isObject(data) ? Object.entries(data).map(([name, value]) => ({ name, value })) : list(data, 'table')
    if (!rows.length) return empty(w)
    const columns: string[] = w.columns ?? Object.keys(rows[0] ?? {})
    const head = columns.map(c => `<th>${esc(label(c))}</th>`).join('')
    const body = rows
      .slice(0, w.limit ?? 100)
      .map(r => `<tr>${columns.map(c => cell(c, r?.[c])).join('')}</tr>`)
      .join('')
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  },

  feed(w, data) {
    const items = list(data, 'feed')
    if (!items.length) return empty(w)
    return `<div class="feed">${items
      .slice(0, w.limit ?? 50)
      .map(i => {
        const src = String(i.source ?? '')
        const text = typeof i.text === 'string' ? i.text : JSON.stringify(i.text ?? '')
        return `<div><span class="t">${esc(i.time ? time(i.time, true) : '')}</span><span class="src${hash(src) % 2 ? ' a' : ''}">${esc(src)}</span><span class="msg" title="${esc(text)}">${esc(text)}${i.detail ? ` <i>${esc(i.detail)}</i>` : ''}</span></div>`
      })
      .join('')}</div>`
  },

  gauge(w, data) {
    const { value, max: dmax, min: dmin, unit: dunit, ...details } = isObject(data) ? data : ({ value: data } as any)
    const min = dmin ?? w.min ?? 0
    const max = dmax ?? w.max ?? 100
    const share = Math.max(0, Math.min(1, (Number(value) - min) / (max - min || 1)))
    const color = w.color ? ` style="--c: var(--${esc(w.color)})"` : ''
    // 270° arc: 3/4 of the circumference (2π·48 ≈ 302).
    const dl = Object.entries(details).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(format(v))}</dd>`).join('')
    return `<svg viewBox="0 0 120 120"${color}>
      <circle class="track" cx="60" cy="60" r="48" fill="none" stroke-width="7" stroke-dasharray="226 302" transform="rotate(135 60 60)"/>
      <circle class="arc" cx="60" cy="60" r="48" fill="none" stroke-width="7" stroke-dasharray="${(226 * share).toFixed(1)} 302" transform="rotate(135 60 60)"/>
      <text class="num" x="60" y="62" text-anchor="middle">${esc(number(value, w))}</text><text class="unit" x="60" y="80" text-anchor="middle">${esc(dunit ?? w.unit ?? '')}</text>
    </svg>${dl ? `<dl>${dl}</dl>` : ''}`
  },

  sparkline(w, data) {
    const series: [string, number[]][] = Array.isArray(data) ? [[w.title ?? 'value', data.map(Number)]] : Object.entries(data ?? {}).map(([k, v]) => [k, (v as any[]).map(Number)])
    if (!series.length || !series.some(([, v]) => v.length)) return empty(w)
    const all = series.flatMap(([, v]) => v)
    const top = Math.max(...all, 0) || 1
    const bottom = Math.min(...all, 0)
    const path = (v: number[]) =>
      v.map((n, i) => `${(i / Math.max(1, v.length - 1)) * 600},${(66 - ((n - bottom) / (top - bottom)) * 62).toFixed(1)}`).join(' L')
    const lines = series
      .map(([, v], i) => `${i === 0 ? `<path class="area" d="M${path(v)} L600,70 L0,70 Z"/>` : ''}<path class="line s${Math.min(i, 4)}" d="M${path(v)}"/>`)
      .join('')
    const show = w.show as 'sum' | 'last' | 'max' | undefined
    const stat = (v: number[]) => (show === 'sum' ? v.reduce((a, b) => a + b, 0) : show === 'max' ? Math.max(...v) : v[v.length - 1] ?? 0)
    const legend =
      series.length > 1 || show
        ? `<div class="legend">${series
            .map(([name, v], i) => `<span><i style="background:var(--${['primary', 'accent', 'ok', 'warn', 'muted'][Math.min(i, 4)]})"></i>${esc(name)}${show ? `<b>${esc(number(stat(v), w))}</b>` : ''}</span>`)
            .join('')}</div>`
        : ''
    const gradient =
      '<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--primary);stop-opacity:.35"/><stop offset="1" style="stop-color:var(--primary);stop-opacity:0"/></linearGradient></defs>'
    return `<svg viewBox="0 0 600 70" preserveAspectRatio="none">${gradient}${lines}</svg>${legend}`
  },

  bars(w, data) {
    const items: [string, number][] = (
      isObject(data) ? Object.entries(data) : list(data, 'bars').map(i => [i.label ?? i.name ?? '', i.value])
    ).map(([k, v]: any) => [String(k), Number(v)])
    items.sort((a, b) => b[1] - a[1])
    if (!items.length) return empty(w)
    const top = Math.max(...items.map(i => i[1])) || 1
    return `<div class="bars">${items
      .slice(0, w.limit ?? 10)
      .map(([name, v]) => `<div class="bar"><span class="n" title="${esc(name)}">${esc(name)}</span><span class="track"><span class="fill" style="width:${((v / top) * 100).toFixed(1)}%"></span></span><span class="val">${esc(number(v, w))}</span></div>`)
      .join('')}</div>`
  },

  markdown(w, data) {
    return `${markdown(String(w.text ?? data ?? ''))}`
  },

  image(w, data) {
    const src = String(w.src ?? data ?? '')
    if (!src) return empty(w)
    // Refresh by reloading with a new query string, rounded so re-renders within the interval reuse it.
    const bust = w.every ? `${src.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / (w.every * 1000))}` : ''
    return `<img src="${esc(src + bust)}" alt="${esc(w.title ?? '')}">`
  },
}

// Images with "every" refresh even when no data event arrives.
setInterval(() => {
  document.querySelectorAll<HTMLElement>('section.t-image').forEach(el => {
    const w = widgetOf(el)
    if (w.every) fill(el, w)
  })
}, 1000)

// --- helpers --------------------------------------------------------------------------------

function list(data: unknown, type: string): any[] {
  if (data == null) return []
  if (!Array.isArray(data)) throw new Error(`${type} expects a list; got ${typeof data} (use "field" to pick one)`)
  return data
}

function pick(data: any, path: string) {
  for (const part of path.split('.')) data = data?.[part]
  return data
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const empty = (w: Widget) => `<span class="empty">${esc(w.empty ?? 'nothing yet')}</span>`

function number(v: unknown, w: Widget) {
  if (typeof v !== 'number' || !isFinite(v)) return v == null ? '—' : String(v)
  const decimals = w.decimals ?? (Number.isInteger(v) ? 0 : Math.abs(v) < 10 ? 2 : 1)
  return `${w.prefix ?? ''}${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function format(v: unknown): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'string') return ISO.test(v) ? time(v) : v
  if (typeof v === 'number') return v.toLocaleString()
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return JSON.stringify(v)
}

/** Today: 14:05; within a week: "tue 14:05"; else the date. */
function time(iso: string, seconds = false) {
  const d = new Date(iso)
  const days = Math.abs(Date.now() - +d) / 86_400_000
  const clock = d.toLocaleTimeString('sv-SE', seconds ? {} : { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return clock
  if (days < 7) return `${d.toLocaleDateString('en-GB', { weekday: 'short' }).toLowerCase()} ${clock}`
  return d.toLocaleDateString('sv-SE')
}

const TAGS: Record<string, string> = {
  done: 'ok', ok: 'ok', true: 'ok', success: 'ok', online: 'ok',
  error: 'bad', failed: 'bad', false: 'bad', offline: 'bad',
  busy: 'warn', cooldown: 'warn', warn: 'warn',
  stopped: 'skip', pending: 'skip', disabled: 'skip',
}

function cell(column: string, v: unknown) {
  const tag = /^(result|status|state|ok)$/i.test(column) && v != null ? TAGS[String(v).toLowerCase()] : undefined
  const text = column === 'result' && v === 'stopped' ? 'nothing to do' : format(v)
  if (tag) return `<td><span class="tag ${tag}">${esc(text)}</span></td>`
  return `<td class="${typeof v === 'string' && !ISO.test(v) && /^(id|name|job)$/i.test(column) ? '' : 'muted'}" title="${esc(text)}">${esc(text)}</td>`
}

function state(v: unknown) {
  if (v === true) return 'ok'
  if (v === false) return 'bad'
  const s = String(v ?? '').toLowerCase()
  return ['ok', 'warn', 'bad', 'off'].includes(s) ? s : TAGS[s] === 'skip' ? 'off' : TAGS[s] ?? 'off'
}

const label = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

function hash(s: string) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
  return Math.abs(h)
}

function esc(v: unknown) {
  return String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

/** Enough markdown for notes: headings, lists, **bold**, *italic*, `code`, [links](url). */
function markdown(src: string) {
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  return src
    .trim()
    .split(/\n\s*\n/)
    .map(block => {
      const lines = block.split('\n')
      if (lines.every(l => /^\s*[-*] /.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`
      const h = /^#{1,6} (.*)/.exec(block)
      if (h && lines.length === 1) return `<h3>${inline(h[1]!)}</h3>`
      return `<p>${lines.map(inline).join('<br>')}</p>`
    })
    .join('')
}

const tick = () => ($('clock').textContent = new Date().toLocaleTimeString('sv-SE'))
tick()
setInterval(tick, 1000)
