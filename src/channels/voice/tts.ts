// Text to speech with ElevenLabs, streamed to the device as 16 kHz 16-bit mono PCM.
// Device protocol: {"event":"audio_start"}, binary PCM frames, {"event":"audio_end"}.
import type { ServerWebSocket } from 'bun'

// Buffer ~250 ms before audio_start so the device doesn't underrun at the start.
const HEAD_START_BYTES = 8000

export interface SpeakStats {
  bytes: number
  chunks: number
  /** ElevenLabs chunks with an odd byte count; evened out before sending. */
  oddChunks: number
  /** Time from request to the first audio byte. */
  firstByteMs: number
  /** Longest wait between two chunks; 16 kHz PCM plays 32 bytes per ms. */
  maxGapMs: number
}

export async function speak(ws: ServerWebSocket<any>, text: string): Promise<SpeakStats> {
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? 'onwK4e9ZLuTAKqWW03F9'
  const t0 = Date.now()
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2' }),
  })
  if (!res.ok) {
    release(ws)
    throw new Error(`TTS failed (${res.status}): ${await res.text()}`)
  }

  const stats: SpeakStats = { bytes: 0, chunks: 0, oddChunks: 0, firstByteMs: 0, maxGapMs: 0 }
  let head: Uint8Array[] = []
  let headBytes = 0
  let started = false
  const start = () => {
    ws.send(JSON.stringify({ event: 'audio_start' }))
    for (const chunk of head) ws.send(chunk)
    head = []
    started = true
  }
  // Chunks arrive with arbitrary byte counts. A frame that ends mid-sample can shift the speaker's
  // byte stream by one, turning everything after it into static, so only whole samples are sent.
  let carry: Uint8Array | undefined
  let last = t0
  for await (const raw of res.body!) {
    const now = Date.now()
    if (stats.chunks === 0) stats.firstByteMs = now - t0
    else stats.maxGapMs = Math.max(stats.maxGapMs, now - last)
    last = now
    stats.chunks++
    stats.bytes += raw.byteLength
    if (raw.byteLength % 2) stats.oddChunks++

    let data: Uint8Array = raw
    if (carry) {
      data = new Uint8Array(carry.byteLength + raw.byteLength)
      data.set(carry)
      data.set(raw, carry.byteLength)
      carry = undefined
    }
    if (data.byteLength % 2) {
      carry = data.slice(-1)
      data = data.subarray(0, -1)
    }
    if (!data.byteLength) continue

    if (started) ws.send(data)
    else {
      head.push(data)
      headBytes += data.byteLength
      if (headBytes >= HEAD_START_BYTES) start()
    }
  }
  if (!started) start()
  ws.send(JSON.stringify({ event: 'audio_end' }))
  return stats
}

/** Silent start/end pair: returns a waiting device to idle (otherwise it waits ~30 s). */
export function release(ws: ServerWebSocket<any>) {
  ws.send(JSON.stringify({ event: 'audio_start' }))
  ws.send(JSON.stringify({ event: 'audio_end' }))
}
