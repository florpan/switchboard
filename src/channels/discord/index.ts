// Discord channel: a bot listening on configured guild channels and DMs. Messages are pushed into the
// Claude session; Claude answers with the reply tool.
//   DISCORD_BOT_TOKEN, DISCORD_CHANNEL_IDS (comma separated), DISCORD_MENTION_ONLY=true
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js'
import type { Channel, Gateway } from '../../core/channel'

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const LIMIT = 2000 // Discord's max message length
const TYPING_MAX_MS = 5 * 60_000

const instructions = `Discord messages arrive as <channel source="...discord" chat_id="..." message_id="..." user="<person or unknown>" username="..." dm="true|false">.
The sender only sees what you send with the discord reply tool (pass the same chat_id); your normal text output is not
visible there. Markdown works. Attached images are saved to disk and their paths are in the message: read them to see them.
user is the person from the gateway's user registry; "unknown" means an unregistered Discord account, so be careful
with anything that acts on the house or infrastructure for unknown users.`

export function discord(gw: Gateway): Channel {
  const token = process.env.DISCORD_BOT_TOKEN
  const channelIds = new Set((process.env.DISCORD_CHANNEL_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean))
  const mentionOnly = process.env.DISCORD_MENTION_ONLY === 'true'
  const log = (...args: unknown[]) => gw.log('discord', ...args)
  const typing = new Map<string, Timer>() // chat_id -> typing refresher while Claude works

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel, Partials.Message],
  })

  async function chat(id: string) {
    const channel = await client.channels.fetch(id)
    if (!channel?.isTextBased() || !('send' in channel)) throw new Error(`chat ${id} not found or not a text channel`)
    return channel
  }

  function startTyping(message: Message) {
    stopTyping(message.channelId)
    const tick = () => ('sendTyping' in message.channel ? message.channel.sendTyping().catch(() => {}) : undefined)
    tick()
    const timer = setInterval(tick, 8000)
    typing.set(message.channelId, timer)
    setTimeout(() => stopTyping(message.channelId, timer), TYPING_MAX_MS)
  }

  function stopTyping(chatId: string, only?: Timer) {
    const timer = typing.get(chatId)
    if (!timer || (only && timer !== only)) return
    clearInterval(timer)
    typing.delete(chatId)
  }

  /** Message text plus attachments: images saved to disk, small text files inlined. */
  async function content(message: Message) {
    let text = message.content.replace(new RegExp(`<@!?${client.user?.id}>`, 'g'), '').trim()
    for (const att of message.attachments.values()) {
      const name = att.name ?? 'file'
      if (IMAGE.has(extname(name).toLowerCase())) {
        const dir = resolve(gw.filesDir, 'discord')
        mkdirSync(dir, { recursive: true })
        const path = resolve(dir, `${Date.now()}-${basename(name)}`)
        const res = await fetch(att.url)
        if (!res.ok) continue
        writeFileSync(path, Buffer.from(await res.arrayBuffer()))
        text += `\n[Image attached: ${path}]`
      } else if (att.size < 100_000 && att.contentType?.startsWith('text/')) {
        text += `\n--- ${name} ---\n${await (await fetch(att.url)).text()}\n--- end ${name} ---`
      } else text += `\n[Attachment: ${name} (${att.contentType}, ${att.size} bytes), not downloaded]`
    }
    return text.trim()
  }

  client.on('messageCreate', async message => {
    if (message.author.bot) return
    const dm = !message.guild
    if (!dm && !channelIds.has(message.channelId)) return
    if (!dm && mentionOnly && !(client.user && message.mentions.has(client.user.id))) return

    const text = await content(message)
    if (!text) return
    const person = gw.users.resolve('discord', message.author.id)
    log(`${person?.name ?? message.author.username} in ${dm ? 'DM' : `#${'name' in message.channel ? message.channel.name : message.channelId}`}: ${text.slice(0, 120)}`)

    const delivered = await gw.push('discord', text, {
      chat_id: message.channelId,
      message_id: message.id,
      user: person?.name ?? 'unknown',
      username: message.author.username,
      dm: String(dm),
    })
    if (delivered) startTyping(message)
    else await message.reply('Claude is not connected right now.').catch(() => {})
  })
  client.once('clientReady', () => log(`connected as ${client.user?.tag}, ${channelIds.size} channel(s), ${mentionOnly ? 'mention-only' : 'all messages'}`))
  client.on('error', err => log('client error:', err))

  return {
    name: 'discord',
    instructions,
    status: () => ({ configured: !!token, connected: client.isReady(), bot: client.user?.tag, chats: [...channelIds], mentionOnly }),
    async start() {
      if (!token) return log('DISCORD_BOT_TOKEN not set, channel idle')
      await client.login(token)
    },
    async stop() {
      await client.destroy()
    },

    tools: [
      {
        name: 'reply',
        description: 'Send a Discord message to a chat (chat_id from the incoming message, or one from list_chats). Long text is split automatically. files = absolute paths to attach.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            text: { type: 'string' },
            reply_to: { type: 'string', description: 'message_id to reply to (optional)' },
            files: { type: 'array', items: { type: 'string' } },
          },
          required: ['chat_id', 'text'],
        },
        run: async ({ chat_id, text, reply_to, files }: { chat_id: string; text: string; reply_to?: string; files?: string[] }) => {
          const target = await chat(chat_id)
          stopTyping(chat_id)
          const parts = split(text)
          for (const [i, part] of parts.entries()) {
            const last = i === parts.length - 1
            await target.send({
              content: part,
              files: last ? files : undefined,
              reply: i === 0 && reply_to ? { messageReference: reply_to, failIfNotExists: false } : undefined,
            })
          }
          return `sent (${parts.length} message${parts.length > 1 ? 's' : ''})`
        },
      },
      {
        name: 'react',
        description: 'Add an emoji reaction to a Discord message.',
        inputSchema: {
          type: 'object',
          properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, emoji: { type: 'string' } },
          required: ['chat_id', 'message_id', 'emoji'],
        },
        run: async ({ chat_id, message_id, emoji }: { chat_id: string; message_id: string; emoji: string }) => {
          const target = await chat(chat_id)
          await (await target.messages.fetch(message_id)).react(emoji)
          return 'reacted'
        },
      },
      {
        name: 'list_chats',
        description: 'List the Discord channels the bot listens on (for messages you start yourself).',
        inputSchema: { type: 'object', properties: {} },
        run: async () =>
          JSON.stringify(
            await Promise.all([...channelIds].map(async id => ({ chat_id: id, name: await chat(id).then(c => ('name' in c ? c.name : id), () => 'unavailable') }))),
          ),
      },
    ],
  }
}

/** Split at newlines where possible, never above Discord's limit. */
function split(text: string) {
  const parts: string[] = []
  let rest = text
  while (rest.length > LIMIT) {
    const cut = rest.lastIndexOf('\n', LIMIT)
    const at = cut > LIMIT / 2 ? cut : LIMIT
    parts.push(rest.slice(0, at))
    rest = rest.slice(at).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}
