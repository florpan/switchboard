// Opens a realtime STT session with the current ELEVENLABS_STT_* settings and prints the
// config ElevenLabs echoes back, to see which parameters it accepted. Needs ELEVENLABS_API_KEY.
import { RealtimeSTT } from '../src/channels/voice/stt'

const original = globalThis.WebSocket
globalThis.WebSocket = class extends original {
  constructor(url: string | URL, opts?: unknown) {
    super(url, opts as never)
    console.log('url:', String(url))
    this.addEventListener('message', e => console.log('server:', String(e.data)))
    this.addEventListener('close', e => console.log('closed:', e.code, e.reason))
  }
} as typeof WebSocket

const stt = new RealtimeSTT()
await stt.open().catch(err => console.log('open failed:', err))
await Bun.sleep(1500)
stt.close()
