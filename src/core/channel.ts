// What a channel module provides. The gateway wires each channel to its own MCP endpoint
// (/mcp/<name>), which a Claude Code session connects to via the channel's plugin.
import type { ServerWebSocket } from 'bun'
import type { Users } from './users'

export type Json = Record<string, unknown>

export interface Tool {
  name: string
  description: string
  inputSchema: Json // JSON Schema
  run(args: any): Promise<string> | string
}

export type RouteHandler = (req: Request, params: Record<string, string>) => Response | Promise<Response>

export type SocketData = { path: string; state: any }

export interface SocketHandler {
  open?(ws: ServerWebSocket<SocketData>): void
  message(ws: ServerWebSocket<SocketData>, message: string | Buffer): void
  close?(ws: ServerWebSocket<SocketData>): void
}

export interface Channel {
  name: string
  /** Delivered to Claude when the session connects: what arrives, how to answer. */
  instructions: string
  tools?: Tool[]
  /** HTTP routes, keyed "METHOD /path/:param". */
  routes?: Record<string, RouteHandler>
  /** WebSocket endpoints, keyed by path. */
  sockets?: Record<string, SocketHandler>
  /** Channel-specific state for GET /api/channels (dashboard). */
  status?(): Json | Promise<Json>
  start?(): Promise<void> | void
  stop?(): Promise<void> | void
}

/** Services the gateway offers to channel modules. */
export interface Gateway {
  /** Push an event into the Claude session(s) connected to a channel. False if none is connected. */
  push(channel: string, content: string, meta?: Record<string, string>): Promise<boolean>
  connected(channel: string): boolean
  /** Named actions channels offer to each other (e.g. voice registers "say" for jobs). */
  actions: Map<string, (text: string, args?: Json) => Promise<void>>
  users: Users
  /** The Claude session's working directory (the owner's repo): config/, state/, inbox/, .env. */
  workspace: string
  /** workspace/config: users.json, jobs.json, voice-devices.json, ... */
  configDir: string
  /** workspace/inbox: inbound files (Discord attachments, emails). */
  filesDir: string
  log(scope: string, ...args: unknown[]): void
}
