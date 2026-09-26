// Speech to text with ElevenLabs Scribe: realtime WebSocket while the device streams,
// REST as fallback when the stream never connected.
const API = 'api.elevenlabs.io/v1/speech-to-text'
const key = () => process.env.ELEVENLABS_API_KEY ?? ''
const language = () => process.env.VOICE_LANGUAGE ?? 'sv'

export class RealtimeSTT {
  private ws?: WebSocket
  private ready: Promise<void>
  private chunks = 0
  private pending?: { resolve: (text: string) => void; reject: (err: Error) => void }

  constructor() {
    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      language_code: language(),
      audio_format: 'pcm_16000',
      commit_strategy: 'manual',
    })
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
  const form = new FormData()
  form.append('model_id', 'scribe_v2')
  form.append('language_code', language())
  form.append('tag_audio_events', 'false')
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
