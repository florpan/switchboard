// Runs the sources the widgets use, on their own intervals, and keeps the last result of each. Everything
// runs in the daemon: secrets in ${ENV} and script output never reach the browser, only widget data does.
import { BASH } from '../channels/jobs/runner'
import { parseRange, type Source } from './config'

export type Result = { data?: unknown; error?: string; at?: string }
type Local = (path: string) => Promise<any>

const DEFAULT_EVERY = { builtin: 5, script: 60, http: 60, loki: 60, prometheus: 60 }

export const sourceKey = (s: Source) => JSON.stringify(s)

export class Sources {
  readonly results = new Map<string, Result>()
  private sources = new Map<string, Source>()
  private due = new Map<string, number>()
  private running = new Set<string>()

  constructor(
    private workspace: string,
    private local: Local,
    private onResult: (key: string, result: Result) => void,
  ) {}

  /** Replace the set of sources in use; results of sources still in use are kept. */
  use(sources: Source[]) {
    this.sources = new Map(sources.map(s => [sourceKey(s), s]))
    for (const key of this.results.keys()) if (!this.sources.has(key)) this.results.delete(key)
    this.due.clear()
  }

  /** Run whatever is due. Called every second while a browser is watching. */
  tick() {
    const now = Date.now()
    for (const [key, source] of this.sources) {
      if ((this.due.get(key) ?? 0) > now || this.running.has(key)) continue
      this.due.set(key, now + every(source) * 1000)
      void this.run(key, source)
    }
  }

  private async run(key: string, source: Source) {
    this.running.add(key)
    const previous = this.results.get(key)
    let result: Result
    try {
      result = { data: await fetchSource(source, this.workspace, this.local), at: new Date().toISOString() }
    } catch (err) {
      // Keep the last good data so the widget can show it next to the error.
      result = { ...previous, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.running.delete(key)
    }
    if (!this.sources.has(key)) return
    this.results.set(key, result)
    if (JSON.stringify(result.data) !== JSON.stringify(previous?.data) || result.error !== previous?.error) this.onResult(key, result)
  }
}

function every(s: Source) {
  if (typeof s === 'string') return DEFAULT_EVERY.builtin
  const kind = Object.keys(DEFAULT_EVERY).find(k => k in s) as keyof typeof DEFAULT_EVERY
  return s.every ?? DEFAULT_EVERY[kind]
}

export async function fetchSource(s: Source, workspace: string, local: Local): Promise<unknown> {
  if (typeof s === 'string') return builtin(s, local)
  if ('script' in s) return script(s.script, workspace, s.timeout ?? 10)
  if ('http' in s) {
    const res = await fetch(env(s.http), {
      headers: Object.fromEntries(Object.entries(s.headers ?? {}).map(([k, v]) => [k, env(v)])),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`http ${res.status}`)
    return parse(await res.text())
  }
  if ('loki' in s) return query('loki', s.loki, s)
  return query('prometheus', s.prometheus, s)
}

/** ${NAME} from the daemon's environment (the workspace .env included). */
function env(text: string) {
  return text.replace(/\$\{(\w+)\}/g, (_, name) => {
    const value = process.env[name]
    if (value === undefined) throw new Error(`\${${name}} is not set`)
    return value
  })
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text.trim()
  }
}

async function script(cmd: string, cwd: string, timeout: number) {
  const proc = Bun.spawn([BASH, '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GATEWAY_WORKSPACE: cwd } })
  const timer = setTimeout(() => proc.kill(), timeout * 1000)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  if (proc.signalCode) throw new Error(`timed out after ${timeout} s`)
  if (code !== 0) throw new Error(`exit ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`)
  return parse(stdout)
}

// --- built-in -------------------------------------------------------------------------------

async function builtin(name: string, local: Local): Promise<unknown> {
  if (name === 'channels') {
    const channels: any[] = await local('/api/channels')
    return channels.map(({ name, session, ...status }) => ({
      name,
      state: session ? 'ok' : 'warn',
      meta: [session ? 'session' : 'no session', ...summary(status)].join(' · '),
      session,
      ...status,
    }))
  }
  if (name === 'jobs') {
    const [jobs, runs]: [any[], any[]] = await Promise.all([local('/api/jobs'), local('/api/runs')])
    return jobs.map(j => {
      const last = runs.find(r => r.job === j.id)
      return {
        id: j.id,
        description: j.description,
        trigger: j.schedule ?? (j.at ? `at ${j.at}` : 'webhook'),
        lastRun: last?.startedAt ?? null,
        result: last?.status ?? (j.enabled === false ? 'disabled' : 'pending'),
        detail: last?.detail,
        next: j.next ?? null,
        active: j.active,
      }
    })
  }
  if (name === 'runs') {
    const runs: any[] = await local('/api/runs')
    return runs.map(r => ({ time: r.startedAt, source: 'jobs', text: `${r.job} ${r.status}`, ...r }))
  }
  if (name === 'devices') {
    const channels: any[] = await local('/api/channels')
    const speakers: any[] = channels.find(c => c.name === 'voice')?.speakers ?? []
    return speakers.map(s => ({ ...s, state: 'ok', meta: s.id === s.name ? '' : s.id }))
  }
  const health = await local('/health')
  const channels = Object.values(health.channels ?? {})
  return { ok: health.ok, uptime: Math.round(process.uptime()), connected: channels.filter(Boolean).length, channels: channels.length }
}

/** "3 jobs", "2 speakers": the countable parts of a channel's status. */
function summary(status: Record<string, unknown>) {
  return Object.entries(status).flatMap(([key, value]) =>
    typeof value === 'number' ? [`${value} ${key}`] : Array.isArray(value) ? [`${value.length} ${key}`] : [],
  )
}

// --- Loki / Prometheus ----------------------------------------------------------------------

type QueryOpts = { range?: string; series?: boolean; limit?: number; label?: string }

async function query(kind: 'loki' | 'prometheus', expr: string, opts: QueryOpts) {
  const base = process.env[kind === 'loki' ? 'LOKI_URL' : 'PROMETHEUS_URL']
  if (!base) throw new Error(`${kind === 'loki' ? 'LOKI_URL' : 'PROMETHEUS_URL'} is not set`)
  const api = `${base.replace(/\/$/, '')}${kind === 'loki' ? '/loki/api/v1' : '/api/v1'}`
  const now = Math.floor(Date.now() / 1000)
  const window = parseRange(opts.range ?? (opts.series ? '24h' : 'today'))!
  const step = Math.max(60, Math.round(window / 48))
  const q = expr.replaceAll('$range', `${window}s`).replaceAll('$step', `${step}s`)
  // Log queries (a stream selector with filters, no aggregation) only work as range queries.
  const logs = kind === 'loki' && q.trimStart().startsWith('{')

  const params = new URLSearchParams({ query: q })
  if (opts.series || logs) {
    params.set('start', String(now - window))
    params.set('end', String(now))
    if (logs) {
      params.set('limit', String(opts.limit ?? 50))
      params.set('direction', 'backward')
    } else params.set('step', String(step))
  } else params.set('time', String(now))

  const res = await fetch(`${api}/${opts.series || logs ? 'query_range' : 'query'}?${params}`, { signal: AbortSignal.timeout(15_000) })
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok || body.status !== 'success') throw new Error(`${kind} ${res.status}: ${body.error ?? body.message ?? 'query failed'}`)
  const { resultType, result } = body.data

  if (resultType === 'streams')
    return (result as any[])
      .flatMap(s => (s.values as [string, string][]).map(([ns, line]) => ({ ns: BigInt(ns), labels: s.stream, line })))
      .sort((a, b) => (b.ns > a.ns ? 1 : -1))
      .slice(0, opts.limit ?? 50)
      .map(e => ({ time: new Date(Number(e.ns / 1_000_000n)).toISOString(), source: e.labels[opts.label ?? 'event_name'] ?? '', text: e.line }))

  if (resultType === 'matrix') {
    // Align every series on the same step grid so sparklines line up; gaps count as 0.
    const start = now - window
    const points = Math.floor(window / step) + 1
    const out: Record<string, number[]> = {}
    for (const r of result as any[]) {
      const values = new Array(points).fill(0)
      for (const [t, v] of r.values as [number, string][]) {
        const i = Math.round((t - start) / step)
        if (i >= 0 && i < points) values[i] = Number(v)
      }
      out[name(r.metric)] = values
    }
    return out
  }

  if (resultType === 'scalar') return Number(result[1])
  const vector = result as any[]
  if (vector.length === 0) return 0
  if (vector.length === 1 && Object.keys(vector[0].metric).length === 0) return Number(vector[0].value[1])
  return Object.fromEntries(vector.map(r => [name(r.metric), Number(r.value[1])]))
}

const name = (metric: Record<string, string>) => Object.values(metric).join(' ') || 'value'
