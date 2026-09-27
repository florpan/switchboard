// Dashboard at /dashboard: widgets from config/dashboard.json, fed by sources the daemon runs. The file is
// watched; open pages get the new layout and data over SSE. A broken file keeps the last good config and
// the page shows the error, so whoever edited it sees the mistake.
import { existsSync, readFileSync, watch } from 'node:fs'
import { resolve } from 'node:path'
import type { RouteHandler } from '../core/channel'
import { resolveTheme, validate, type Config, type Source } from './config'
import { fetchSource, sourceKey, Sources } from './sources'

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
        widgets: p.widgets.map(({ source, ...w }) => ({ ...w, key: source === undefined ? undefined : sourceKey(source) })),
      })),
    }
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
