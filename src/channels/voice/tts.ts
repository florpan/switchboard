// Text to speech with ElevenLabs, streamed to the device as 16 kHz 16-bit mono PCM.
// Device protocol: {"event":"audio_start"}, binary PCM frames, {"event":"audio_end"}.
import type { ServerWebSocket } from 'bun'

// Buffer ~250 ms before audio_start so the device doesn't underrun at the start.
const HEAD_START_BYTES = 8000

export async function speak(ws: ServerWebSocket<any>, text: string) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? 'onwK4e9ZLuTAKqWW03F9'
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2' }),
  })
  if (!res.ok) {
    release(ws)
    throw new Error(`TTS failed (${res.status}): ${await res.text()}`)
  }

  let head: Uint8Array[] = []
  let headBytes = 0
  let started = false
  const start = () => {
    ws.send(JSON.stringify({ event: 'audio_start' }))
    for (const chunk of head) ws.send(chunk)
    head = []
    started = true
  }
  for await (const chunk of res.body!) {
    if (started) ws.send(chunk)
    else {
      head.push(chunk)
      headBytes += chunk.byteLength
      if (headBytes >= HEAD_START_BYTES) start()
    }
  }
  if (!started) start()
  ws.send(JSON.stringify({ event: 'audio_end' }))
}

/** Silent start/end pair: returns a waiting device to idle (otherwise it waits ~30 s). */
export function release(ws: ServerWebSocket<any>) {
  ws.send(JSON.stringify({ event: 'audio_start' }))
  ws.send(JSON.stringify({ event: 'audio_end' }))
}
