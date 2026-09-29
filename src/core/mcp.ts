// One MCP endpoint per channel over streamable HTTP. Claude Code connects as a client
// (the channel's plugin points at /mcp/<name>); we push events with notifications/claude/channel.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Channel } from './channel'
import { log } from './log'

// streams: open GET (SSE) streams. Notifications only travel over that stream, and the SDK drops them
// silently when there is none, so a session without one is registered but deaf (seen after /clear).
type Session = { server: Server; transport: WebStandardStreamableHTTPServerTransport; streams: number }

/** e.g. 2026-09-25T10:17:54+02:00 (Thu) in the process time zone (set TZ). */
function localTime(now = new Date()) {
  const offset = -now.getTimezoneOffset()
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const local = new Date(now.getTime() + offset * 60_000).toISOString().slice(0, 19)
  const day = now.toLocaleDateString('en-US', { weekday: 'short' })
  return `${local}${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)} (${day})`
}

export class ChannelEndpoint {
  private sessions = new Map<string, Session>()

  constructor(private channel: Channel) {}

  get connected() {
    return [...this.sessions.values()].some(s => s.streams > 0)
  }

  async handle(req: Request): Promise<Response> {
    const id = req.headers.get('mcp-session-id')
    if (id) {
      const session = this.sessions.get(id)
      if (!session) return new Response('unknown session', { status: 404 })
      const res = await session.transport.handleRequest(req)
      return req.method === 'GET' ? this.watch(session, res) : res
    }
    return this.open().handleRequest(req)
  }

  /** Every listening session gets the event. Normally that is exactly one gateway session. */
  async push(content: string, meta: Record<string, string> = {}) {
    // Local time on every event, so the model never needs a tool call to know it.
    const params = { content, meta: { time: localTime(), ...meta } }
    let delivered = false
    for (const [id, { server, streams }] of this.sessions) {
      if (!streams) {
        log(this.channel.name, `session ${id} has no open event stream, event not delivered`)
        continue
      }
      try {
        await server.notification({ method: 'notifications/claude/channel', params })
        delivered = true
      } catch (err) {
        log(this.channel.name, `push to session ${id} failed, dropping it:`, err)
        this.sessions.delete(id)
      }
    }
    return delivered
  }

  /** Counts the session's GET stream while it is open. */
  private watch(session: Session, res: Response) {
    if (!res.ok || !res.body) return res
    const reader = res.body.getReader()
    let open = true
    const close = () => {
      if (!open) return
      open = false
      session.streams--
    }
    session.streams++
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (!done) return controller.enqueue(value)
          close()
          controller.close()
        } catch (err) {
          close()
          controller.error(err)
        }
      },
      cancel(reason) {
        close()
        return reader.cancel(reason)
      },
    })
    return new Response(body, { status: res.status, headers: res.headers })
  }

  private open() {
    const channel = this.channel
    const server = new Server(
      { name: channel.name, version: '0.1.0' },
      {
        capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
        instructions: channel.instructions,
      },
    )
    const tools = channel.tools ?? []
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async req => {
      const tool = tools.find(t => t.name === req.params.name)
      if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] }
      try {
        return { content: [{ type: 'text', text: await tool.run(req.params.arguments ?? {}) }] }
      } catch (err) {
        log(channel.name, `tool ${tool.name} failed:`, err)
        return { isError: true, content: [{ type: 'text', text: String(err) }] }
      }
    })

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: id => {
        // One gateway session: the newest connection wins. A Claude process that exits (or a daemon
        // restart it reconnected after) never closes its old session, and events must not go to both.
        for (const [old, session] of this.sessions) {
          this.sessions.delete(old)
          session.transport.close().catch(() => {})
        }
        this.sessions.set(id, { server, transport, streams: 0 })
        log(channel.name, 'session connected')
      },
      onsessionclosed: id => {
        this.sessions.delete(id)
        log(channel.name, `session closed (${this.sessions.size} left)`)
      },
    })
    server.connect(transport)
    return transport
  }
}
