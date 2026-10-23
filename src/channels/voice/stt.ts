// Speech to text with ElevenLabs Scribe: realtime WebSocket while the device streams,
// REST as fallback when the stream never connected.
import { log } from '../../core/log'

const API = 'api.elevenlabs.io/v1/speech-to-text'
const REALTIME_KEYTERMS_MAX = 50
const key = () => process.env.ELEVENLABS_API_KEY ?? ''
const env = (name: string) => process.env[`ELEVENLABS_STT_${name}`]
const flag = (name: string) => env(name) === 'true'
const list = (name: string) => (env(name) ?? '').split(',').map(s => s.trim()).filter(Boolean)

let warnedKeyterms = false
/** Settings shared by both paths; defaults match the hardcoded values this replaced. */
function settings() {
  const keyterms = list('KEYTERMS')
  if (keyterms.length > REALTIME_KEYTERMS_MAX && !warnedKeyterms) {
    warnedKeyterms = true
    log('voice', `ELEVENLABS_STT_KEYTERMS has ${keyterms.length} terms; realtime uses the first ${REALTIME_KEYTERMS_MAX}`)
  }
  return {
    language: process.env.VOICE_LANGUAGE ?? 'sv',
    keyterms,
    noVerbatim: flag('NO_VERBATIM'),
    model: env('MODEL') ?? 'scribe_v2_realtime',
    fallbackModel: env('FALLBACK_MODEL') ?? 'scribe_v2',
  }
}

export class RealtimeSTT {
  private ws?: WebSocket
  private ready: Promise<void>
  private chunks = 0
  private pending?: { resolve: (text: string) => void; reject: (err: Error) => void }

  constructor() {
    const s = settings()
    const params = new URLSearchParams({
      model_id: s.model,
      language_code: s.language,
      audio_format: 'pcm_16000',
      commit_strategy: 'manual',
    })
    // List parameters are repeated keys (?keyterms=a&keyterms=b).
    s.keyterms.slice(0, REALTIME_KEYTERMS_MAX).forEach(term => params.append('keyterms', term))
    list('SECONDARY_LANGUAGES').forEach(code => params.append('secondary_languages', code))
    if (s.noVerbatim) params.set('no_verbatim', 'true')
    if (flag('FILTER_BACKGROUND_AUDIO')) params.set('filter_background_audio', 'true')
    if (env('LOGGING') === 'false') params.set('enable_logging', 'false')
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://${API}/realtime?${params}`, { headers: { 'xi-api-key': key() } } as any)
      ws.onopen = () => {
        this.ws = ws
        resolve()
      }
      ws.onerror = () => reject(new Error('realtime STT connection failed'))
      ws.onclose = () => {
        this.ws = undefined
        this.pending?.reject(new Error('realtime STT closed before transcript'))
      }
      ws.onmessage = event => {
        const msg = JSON.parse(String(event.data))
        if (msg.message_type?.startsWith('committed_transcript')) this.pending?.resolve(msg.text ?? '')
        else if (msg.error) this.pending?.reject(new Error(`realtime STT: ${msg.error}`))
      }
    })
    this.ready.catch(() => {}) // surfaced by connected()/commit()
  }

  get connected() {
    return !!this.ws
  }

  send(pcm: Uint8Array) {
    this.chunks++
    this.ws?.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.from(pcm).toString('base64'), commit: false, sample_rate: 16000 }))
  }

  /** Wait for the stream to open (buffered chunks are sent by the caller afterwards). */
  open() {
    return this.ready
  }

  async commit(): Promise<string> {
    if (!this.ws) throw new Error('realtime STT not connected')
    if (this.chunks === 0) return ''
    this.ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 }))
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
      setTimeout(() => reject(new Error('realtime STT commit timed out')), 10_000)
    })
  }

  close() {
    this.pending = undefined
    try {
      this.ws?.close()
    } catch {}
  }
}

export async function transcribe(pcm: Uint8Array): Promise<string> {
  const s = settings()
  const form = new FormData()
  form.append('model_id', s.fallbackModel)
  form.append('language_code', s.language)
  form.append('tag_audio_events', 'false')
  s.keyterms.forEach(term => form.append('keyterms', term))
  if (s.noVerbatim) form.append('no_verbatim', 'true')
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'audio.wav')
  const res = await fetch(`https://${API}`, { method: 'POST', headers: { 'xi-api-key': key() }, body: form })
  if (!res.ok) throw new Error(`STT failed (${res.status}): ${await res.text()}`)
  return ((await res.json()) as { text: string }).text
}

/** 16 kHz, 16-bit, mono PCM wrapped in a WAV header. */
function wav(pcm: Uint8Array) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
