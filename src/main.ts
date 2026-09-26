// Gateway daemon. Runs on its own; a Claude Code session in the workspace connects to the channels it
// opted into with --channels plugin:<channel>@session-gateway.
import { resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import type { Channel, Gateway } from './core/channel'
import { ChannelEndpoint } from './core/mcp'
import { serve } from './core/server'
import { log } from './core/log'
import { Users } from './core/users'
import { voice } from './channels/voice'
import { jobs } from './channels/jobs'
import { discord } from './channels/discord'
import { email } from './channels/email'

const available: Record<string, (gw: Gateway) => Channel> = { voice, jobs, discord, email }

// Everything personal lives in the workspace: config/, state/, inbox/, .env.
const workspace = resolve(process.env.GATEWAY_WORKSPACE ?? resolve(import.meta.dir, '../workspace'))
loadEnv(resolve(workspace, '.env'))
const configDir = resolve(workspace, 'config')
const filesDir = resolve(workspace, 'inbox')
for (const dir of [configDir, filesDir, resolve(workspace, 'state')]) mkdirSync(dir, { recursive: true })

const enabled = (process.env.GATEWAY_CHANNELS ?? Object.keys(available).join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const endpoints = new Map<string, ChannelEndpoint>()
const gateway: Gateway = {
  push: async (channel, content, meta) => (await endpoints.get(channel)?.push(content, meta)) ?? false,
  connected: channel => endpoints.get(channel)?.connected ?? false,
  actions: new Map(),
  users: new Users(resolve(configDir, 'users.json')),
  workspace,
  configDir,
  filesDir,
  log,
}

const channels: Channel[] = []
for (const name of enabled) {
  const create = available[name]
  if (!create) throw new Error(`unknown channel "${name}" (available: ${Object.keys(available).join(', ')})`)
  const channel = create(gateway)
  channels.push(channel)
  endpoints.set(channel.name, new ChannelEndpoint(channel))
}

for (const channel of channels) await channel.start?.()

serve({
  host: process.env.GATEWAY_HOST ?? '0.0.0.0',
  port: Number(process.env.GATEWAY_PORT ?? 8090),
  token: process.env.GATEWAY_TOKEN || undefined,
  channels,
  endpoints,
})
log('gateway', `channels: ${channels.map(c => c.name).join(', ')} · workspace: ${workspace}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    for (const channel of channels) await channel.stop?.()
    process.exit(0)
  })

/** KEY=value lines; the process environment wins. */
function loadEnv(path: string) {
  if (!existsSync(path)) return
  for (const [, key, value] of readFileSync(path, 'utf8').matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/gm))
    process.env[key!] ??= value!.replace(/^(['"])(.*)\1$/, '$2')
}
