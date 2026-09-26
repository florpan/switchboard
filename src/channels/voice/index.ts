// Voice channel: ESP32 speakers connect to ws://<gateway>/voice. Speech is transcribed and pushed
// into the Claude session; Claude answers with the speak tool, which streams TTS back to the device.
import { resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { Channel, Gateway, SocketData } from '../../core/channel'
import { Devices, type Device } from './devices'
import { RealtimeSTT, transcribe } from './stt'
import { release, speak } from './tts'

const REPLY_TIMEOUT_MS = Number(process.env.VOICE_REPLY_TIMEOUT ?? 20) * 1000
const BUSY_TEXT = process.env.VOICE_BUSY_TEXT ?? 'Ett ögonblick, jag återkommer.'
const OFFLINE_TEXT = process.env.VOICE_OFFLINE_TEXT ?? 'Jag har ingen kontakt med Claude just nu.'

const instructions = `Speech from voice speakers arrives as <channel source="...voice" device="<speaker>" id="...">transcript</channel>.
The person hears ONLY what you pass to the voice speak tool; your normal text output is not heard.
Answer with speak(device=<the device attribute>, text=...): short, natural spoken language, no markdown or lists,
in the language you were spoken to (usually Swedish). The transcript is speech-to-text and may contain
recognition errors; ask back if it is unclear. Without device, speak announces on every speaker.
If an answer needs long work, say so briefly with speak first, then do the work and speak the result.
input="text" means the question was typed, not spoken (no speech recognition errors); still answer with speak
to the given device.`

export function voice(gw: Gateway): Channel {
  const devices = new Devices(resolve(gw.configDir, 'voice-devices.json'))
  const log = (...args: unknown[]) => gw.log('voice', ...args)

  /** Queue speech on a device so answers never overlap. */
  function say(device: Device, text: string) {
    clearTimeout(device.waiting)
    device.waiting = undefined
    device.speaking = device.speaking.then(() => speak(device.ws, text)).catch(err => log(`speak on ${device.name} failed:`, err))
    return device.speaking
  }

  // POST /voice/ask callers waiting for the answer, keyed by the device name the question was tagged with.
  const asks = new Map<string, (text: string) => void>()

  async function sayTo(target: string | undefined, text: string) {
    const ask = target ? asks.get(target) : undefined
    if (ask) {
      asks.delete(target!)
      ask(text)
      if (target!.startsWith('ask-')) return [target!] // text-only question: nobody to speak to
    }
    const targets = devices.find(target)
    if (!targets.length) throw new Error(target ? `no speaker "${target}" (connected: ${devices.list().map(d => d.name).join(', ') || 'none'})` : 'no speakers connected')
    await Promise.all(targets.map(d => say(d, text)))
    return targets.map(d => d.name)
  }
  gw.actions.set('say', (text, args) => sayTo(args?.device as string | undefined, text).then(() => {}))

  function register(ws: ServerWebSocket<SocketData>, id: string) {
    if (ws.data.state.device) return
    clearTimeout(ws.data.state.helloTimer)
    ws.data.state.device = devices.add(ws, id)
    log(`${ws.data.state.device.name} connected`)
  }

  function onAudio(device: Device, pcm: Uint8Array) {
    device.audio.push(pcm)
    if (!device.stt) {
      const stt = (device.stt = new RealtimeSTT())
      stt.open().then(
        () => device.audio.forEach(chunk => stt.send(chunk)),
        err => log('realtime STT unavailable, will use REST:', err),
      )
    } else if (device.stt.connected) device.stt.send(pcm)
  }

  async function onSpeechEnd(device: Device) {
    const { stt, audio } = device
    device.stt = undefined
    device.audio = []
    let text = ''
    try {
      text = stt?.connected ? await stt.commit() : audio.length ? await transcribe(Buffer.concat(audio)) : ''
    } catch (err) {
      log('transcription failed:', err)
    } finally {
      stt?.close()
    }
    text = text.trim()
    if (!text) return release(device.ws)
    log(`${device.name}: "${text}"`)

    if (!gw.connected('voice')) return say(device, OFFLINE_TEXT)
    await gw.push('voice', text, { device: device.name, id: crypto.randomUUID().slice(0, 8) })
    // The device waits for audio; if Claude is busy, tell the person instead of letting it time out.
    device.waiting = setTimeout(() => say(device, BUSY_TEXT), REPLY_TIMEOUT_MS)
  }

  return {
    name: 'voice',
    instructions,
    status: () => ({ configured: !!process.env.ELEVENLABS_API_KEY, speakers: devices.list() }),

    sockets: {
      '/voice': {
        open(ws) {
          // Firmware sends {"event":"hello","device_id":...} on connect; older clients don't.
          ws.data.state.helloTimer = setTimeout(() => register(ws, `unknown-${Date.now()}`), 3000)
        },
        message(ws, msg) {
          const device: Device | undefined = ws.data.state.device
          if (typeof msg !== 'string') {
            if (device) onAudio(device, msg)
            return
          }
          const event = JSON.parse(msg)
          if (event.event === 'hello') register(ws, event.device_id ?? `unknown-${Date.now()}`)
          else if (event.event === 'speech_end' && device) onSpeechEnd(device)
        },
        close(ws) {
          clearTimeout(ws.data.state.helloTimer)
          const device: Device | undefined = ws.data.state.device
          if (!device) return
          clearTimeout(device.waiting)
          device.stt?.close()
          devices.remove(device)
          log(`${device.name} disconnected`)
        },
      },
    },

    routes: {
      // Speak text directly, no Claude (reminders, alerts, other tools).
      'POST /voice/say': async req => {
        const { text, device } = (await req.json()) as { text?: string; device?: string }
        if (!text) return Response.json({ error: 'text required' }, { status: 400 })
        try {
          return Response.json({ ok: true, devices: await sayTo(device, text) })
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 404 })
        }
      },
      // A question as text instead of speech (scripts, other assistants, tests). Waits for Claude's speak() and returns it;
      // with device the answer is also spoken there.
      'POST /voice/ask': async req => {
        const { text, device, timeout = 120 } = (await req.json()) as { text?: string; device?: string; timeout?: number }
        if (!text) return Response.json({ error: 'text required' }, { status: 400 })
        if (!gw.connected('voice')) return Response.json({ error: 'no Claude session connected' }, { status: 503 })
        const target = device ?? `ask-${crypto.randomUUID().slice(0, 6)}`
        const answer = new Promise<string>(resolve => asks.set(target, resolve))
        await gw.push('voice', text, { device: target, id: crypto.randomUUID().slice(0, 8), input: 'text' })
        const response = await Promise.race([answer, Bun.sleep(timeout * 1000).then(() => null)])
        asks.delete(target)
        return response === null ? Response.json({ ok: false, error: 'timeout' }, { status: 504 }) : Response.json({ ok: true, input: text, response })
      },
      'GET /api/voice/devices': () => Response.json(devices.list()),
    },

    tools: [
      {
        name: 'speak',
        description: 'Say something out loud on a voice speaker. device = the device attribute of the voice message you answer; omit to announce on all speakers.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'What to say, spoken style' }, device: { type: 'string' } },
          required: ['text'],
        },
        run: async ({ text, device }: { text: string; device?: string }) => `spoken on ${(await sayTo(device, text)).join(', ')}`,
      },
      {
        name: 'list_speakers',
        description: 'List connected voice speakers.',
        inputSchema: { type: 'object', properties: {} },
        run: () => JSON.stringify(devices.list()),
      },
    ],
  }
}
