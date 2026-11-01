// Dashboard at /dashboard: widgets from config/dashboard.json, fed by sources the daemon runs. The file is
// watched; open pages get the new layout and data over SSE. A broken file keeps the last good config and
// the page shows the error, so whoever edited it sees the mistake.
import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { RouteHandler } from '../core/channel'
import { MODULE, resolveTheme, validate, type Config, type Source, type Widget } from './config'
import { env, fetchSource, sourceKey, Sources } from './sources'

// What a backend may send back to the browser, and what the browser may pass on to it.
const PASS_BACK = ['content-type', 'content-encoding', 'content-length', 'etag', 'last-modified', 'cache-control']
const PASS_ON = ['accept', 'accept-encoding', 'if-none-match', 'if-modified-since']
const STATIC_TYPES: Record<string, string> = {
  js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', html: 'text/html; charset=utf-8', wasm: 'application/wasm',
}

// Used until the workspace has its own config/dashboard.json.
const FALLBACK: Config = {
  pages: [
    {
      title: 'Home',
      widgets: [
        { type: 'status', title: 'Channels', source: 'channels', at: [0, 0, 4, 4] },
        { type: 'table', title: 'Jobs', source: 'jobs', columns: ['id', 'trigger', 'lastRun', 'result', 'next'], at: [4, 0, 8, 4] },
        { type: 'feed', title: 'Job runs', source: 'runs', at: [0, 4, 12, 4] },
      ],
    },
  ],
}

export function dashboard(opts: { configDir: string; workspace: string; local: (path: string) => Promise<any>; log: (scope: string, ...a: unknown[]) => void }) {
  const path = resolve(opts.configDir, 'dashboard.json')
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  let config = FALLBACK
  let loadedAt = Date.now() // module URLs carry it, so a config change reloads custom widgets' code
  let fileError: string | undefined
  let widgetErrors: string[] = []

  const sources = new Sources(opts.workspace, opts.local, (key, result) => send('data', { [key]: result }))

  function load() {
    if (!existsSync(path)) {
      config = FALLBACK
      fileError = undefined
      widgetErrors = []
    } else
      try {
        const checked = validate(readFileSync(path, 'utf8'))
        config = checked.config
        widgetErrors = checked.errors
        fileError = undefined
        if (widgetErrors.length) opts.log('dashboard', `dashboard.json: ${widgetErrors.join('; ')}`)
      } catch (err) {
        fileError = (err as Error).message
        opts.log('dashboard', `dashboard.json not loaded, keeping the last good one: ${fileError}`)
      }
    const used: Source[] = ['health']
    for (const page of config.pages) for (const w of page.widgets) if (w.source && !w.error) used.push(w.source)
    sources.use(used)
    loadedAt = Date.now()
    send('config', view())
    if (clients.size) sources.tick()
  }

  /** What the browser gets: layout and options, with sources replaced by their key. */
  function view() {
    return {
      title: config.title ?? 'switchboard',
      theme: resolveTheme(config.theme),
      error: fileError,
      pages: config.pages.map(p => ({
        title: p.title,
        columns: p.columns ?? 12,
        fill: p.fill === true,
        widgets: p.widgets.map(({ source, ...w }) => ({
          ...w,
          key: source === undefined ? undefined : sourceKey(source),
          moduleUrl: w.type === 'custom' && !w.error ? moduleUrl(w) : undefined,
        })),
      })),
    }
  }

  /** "knowledge:widget.js" -> /dashboard/backend/knowledge/widget.js; "widgets/x.js" -> /dashboard/widgets/widgets/x.js */
  function moduleUrl(w: Widget) {
    const [, backend, path] = MODULE.exec(String(w.module))!
    return `${backend ? `/dashboard/backend/${backend}/${path}` : `/dashboard/widgets/${path}`}?v=${loadedAt}`
  }

  // GET only, to a configured backend, never above its URL. Headers from the config (secrets via ${NAME}) are
  // added here, so the browser never sees them; responses are passed through as they are (gzip included).
  async function proxy(req: Request, name: string, rest: string) {
    const backend = config.backends?.[name]
    if (!backend) return Response.json({ error: `no backend "${name}" in dashboard.json` }, { status: 404 })
    // Resolved the way fetch will see it (backslashes, %2e and the like normalised), then checked.
    const base = new URL(backend.url.replace(/\/?$/, '/'))
    const target = new URL(rest, base)
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname))
      return Response.json({ error: 'path outside the backend' }, { status: 400 })
    target.search = new URL(req.url).search
    const headers: Record<string, string> = {}
    try {
      for (const [k, v] of Object.entries(backend.headers ?? {})) headers[k] = env(v)
    } catch (err) {
      return Response.json({ error: `backend ${name}: ${(err as Error).message}` }, { status: 502 })
    }
    for (const h of PASS_ON) {
      const v = req.headers.get(h)
      if (v) headers[h] = v
    }
    try {
      const res = await fetch(target, { headers, redirect: 'manual', decompress: false, signal: AbortSignal.timeout(120_000) } as RequestInit)
      const out = new Headers()
      for (const h of PASS_BACK) {
        const v = res.headers.get(h)
        if (v) out.set(h, v)
      }
      return new Response(res.body, { status: res.status, headers: out })
    } catch (err) {
      return Response.json({ error: `backend ${name}: ${(err as Error).message}` }, { status: 502 })
    }
  }

  // The workspace's own widget code and assets: <workspace>/dashboard/<path>.
  const widgetDir = resolve(opts.workspace, 'dashboard')
  function widgetFile(rest: string) {
    const file = resolve(widgetDir, rest)
    const type = STATIC_TYPES[file.split('.').pop()?.toLowerCase() ?? '']
    if (!file.startsWith(widgetDir + sep) || !type || !existsSync(file) || !statSync(file).isFile())
      return new Response('not found', { status: 404 })
    return new Response(Bun.file(file), { headers: { 'content-type': type, 'cache-control': 'no-cache' } })
  }

  function send(event: string, data: unknown) {
    const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    for (const c of clients)
      try {
        c.enqueue(chunk)
      } catch {
        clients.delete(c)
      }
  }

  const client = new Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(resolve(import.meta.dir, 'client.ts'), 'utf8'))
  const page = readFileSync(resolve(import.meta.dir, 'page.html'), 'utf8')
  let ticker: Timer | undefined
  let debounce: Timer | undefined

  const routes: Record<string, RouteHandler> = {
    'GET /dashboard': () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } }),
    'GET /dashboard/backend/:name/*': (req, params) => proxy(req, params.name!, params['*'] ?? ''),
    'GET /dashboard/widgets/*': (_, params) => widgetFile(params['*'] ?? ''),
    'GET /dashboard/client.js': () => new Response(client, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' } }),
    'GET /dashboard/events': req => {
      let self: ReadableStreamDefaultController<Uint8Array>
      let ping: Timer
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          self = c
          clients.add(c)
          c.enqueue(encoder.encode(`event: config\ndata: ${JSON.stringify(view())}\n\n`))
          c.enqueue(encoder.encode(`event: data\ndata: ${JSON.stringify(Object.fromEntries(sources.results))}\n\n`))
          ping = setInterval(() => c.enqueue(encoder.encode(': ping\n\n')), 25_000)
          sources.tick()
        },
        cancel() {
          clearInterval(ping)
          clients.delete(self)
        },
      })
      req.signal.addEventListener('abort', () => {
        clearInterval(ping)
        clients.delete(self)
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
    },
    // For the agent: the config as loaded, its errors, and what every widget currently gets.
    'GET /api/dashboard': () =>
      Response.json({
        file: existsSync(path) ? path : null,
        error: fileError ?? null,
        widgetErrors,
        watching: clients.size,
        pages: config.pages.map(p => ({
          title: p.title,
          widgets: p.widgets.map(w => {
            const result = w.source ? sources.results.get(sourceKey(w.source)) : undefined
            const data = w.field ? w.field.split('.').reduce<any>((d, k) => d?.[k], result?.data) : result?.data
            return { type: w.type, title: w.title, error: w.error ?? result?.error, data, at: result?.at }
          }),
        })),
      }),
    // Validate config/dashboard.json as it is on disk and run each source once, so broken queries show up now.
    // Only the file, never a posted config: sources run shell commands and send secrets.
    'POST /api/dashboard/check': async () => {
      if (!existsSync(path)) return Response.json({ ok: false, errors: [`${path} does not exist`] })
      try {
        const { config, errors } = validate(readFileSync(path, 'utf8'))
        const checks = config.pages.flatMap(p => p.widgets).filter(w => w.source && !w.error)
        const sourceErrors = await Promise.all(
          checks.map(w =>
            fetchSource(w.source!, opts.workspace, opts.local).then(
              () => null,
              err => `"${w.title ?? w.type}" source: ${(err as Error).message}`,
            ),
          ),
        )
        const all = [...errors, ...sourceErrors.filter((e): e is string => !!e)]
        return Response.json({ ok: all.length === 0, errors: all })
      } catch (err) {
        return Response.json({ ok: false, errors: [(err as Error).message] })
      }
    },
  }

  return {
    routes,
    start() {
      load()
      // Watch the folder rather than the file: it may not exist yet, and editors often replace it.
      watch(opts.configDir, (_, name) => {
        if (name !== 'dashboard.json') return
        clearTimeout(debounce)
        debounce = setTimeout(load, 300)
      })
      ticker = setInterval(() => clients.size && sources.tick(), 1000)
    },
    stop() {
      clearInterval(ticker)
    },
  }
}
