// HTTP + WebSocket front door: /mcp/<channel> for Claude Code, plus each channel's own routes and sockets.
import type { Channel, RouteHandler, SocketData, SocketHandler } from './channel'
import type { ChannelEndpoint } from './mcp'
import { log } from './log'

type Route = { method: string; parts: string[]; handler: RouteHandler }

export function serve(opts: {
  host: string
  port: number
  token?: string
  channels: Channel[]
  endpoints: Map<string, ChannelEndpoint>
  /** Routes that don't belong to a channel (the dashboard). */
  routes?: Record<string, RouteHandler>
}) {
  const routes: Route[] = []
  const sockets = new Map<string, SocketHandler>()
  const addRoutes = (entries: Record<string, RouteHandler> = {}) => {
    for (const [key, handler] of Object.entries(entries)) {
      const [method = '', path = ''] = key.split(' ')
      routes.push({ method, parts: path.split('/'), handler })
    }
  }
  addRoutes(opts.routes)
  for (const channel of opts.channels) {
    addRoutes(channel.routes)
    for (const [path, handler] of Object.entries(channel.sockets ?? {})) sockets.set(path, handler)
  }

  const server = Bun.serve<SocketData>({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0, // MCP keeps a long-lived SSE stream open
    async fetch(req, server) {
      const url = new URL(req.url)

      const mcp = url.pathname.match(/^\/mcp\/([\w-]+)$/)
      if (mcp) {
        if (opts.token && req.headers.get('authorization') !== `Bearer ${opts.token}`)
          return new Response('unauthorized', { status: 401 })
        const endpoint = opts.endpoints.get(mcp[1]!)
        return endpoint ? endpoint.handle(req) : new Response('no such channel', { status: 404 })
      }

      if (sockets.has(url.pathname) && server.upgrade(req, { data: { path: url.pathname, state: {} } })) return

      for (const route of routes) {
        const params = match(route, req.method, url.pathname)
        if (params) return route.handler(req, params)
      }
      if (url.pathname === '/health')
        return Response.json({ ok: true, channels: Object.fromEntries([...opts.endpoints].map(([n, e]) => [n, e.connected])) })
      if (url.pathname === '/api/channels')
        return Response.json(
          await Promise.all(
            opts.channels.map(async c => ({ name: c.name, session: opts.endpoints.get(c.name)?.connected ?? false, ...(await c.status?.()) })),
          ),
        )
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open: ws => sockets.get(ws.data.path)?.open?.(ws),
      message: (ws, msg) => sockets.get(ws.data.path)?.message(ws, msg as string | Buffer),
      close: ws => sockets.get(ws.data.path)?.close?.(ws),
    },
  })
  log('gateway', `listening on http://${opts.host}:${opts.port}`)
  return server
}

function match(route: Route, method: string, path: string) {
  if (route.method !== method) return null
  const parts = path.split('/')
  if (parts.length !== route.parts.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < parts.length; i++) {
    const want = route.parts[i]!
    if (want.startsWith(':')) params[want.slice(1)] = decodeURIComponent(parts[i]!)
    else if (want !== parts[i]) return null
  }
  return params
}
