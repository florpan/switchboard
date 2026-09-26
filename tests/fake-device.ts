// Fake ESP32 speaker: speaks a sentence (ElevenLabs TTS -> PCM) into /voice like the firmware does,
// then records the audio the gateway sends back to replies/<device>-<n>.wav.
//   bun tests/fake-device.ts "Vad är klockan?" [device-id] [listen-seconds]
import { mkdirSync, writeFileSync } from 'node:fs'

const text = process.argv[2] ?? 'Hej, vad är klockan?'
const deviceId = process.argv[3] ?? 'jarvis-test01'
const listenMs = Number(process.argv[4] ?? 60) * 1000
const url = process.env.GATEWAY_WS ?? 'ws://127.0.0.1:8090/voice'

async function speech(text: string) {
  const voice = process.env.ELEVENLABS_VOICE_ID ?? 'onwK4e9ZLuTAKqWW03F9'
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
  })
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`)
  return new Uint8Array(await res.arrayBuffer())
}

const pcm = await speech(text)
console.log(`speech: ${pcm.length} bytes (${(pcm.length / 32000).toFixed(1)} s)`)

const ws = new WebSocket(url)
ws.binaryType = 'arraybuffer'
let reply: Uint8Array[] = []
let replies = 0
let t0 = 0
mkdirSync('replies', { recursive: true })

ws.onmessage = e => {
  if (typeof e.data !== 'string') return void reply.push(new Uint8Array(e.data))
  const event = JSON.parse(e.data).event
  if (event === 'audio_start') {
    reply = []
    console.log(`audio_start after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  } else if (event === 'audio_end') {
    const bytes = reply.reduce((n, c) => n + c.length, 0)
    const file = `replies/${deviceId}-${++replies}.wav`
    if (bytes) writeFileSync(file, wav(Buffer.concat(reply)))
    console.log(`audio_end: ${bytes} bytes (${(bytes / 32000).toFixed(1)} s)${bytes ? ` -> ${file}` : ' (release)'}`)
  } else console.log('event', e.data)
}

await new Promise(r => (ws.onopen = r))
ws.send(JSON.stringify({ event: 'hello', device_id: deviceId }))
await Bun.sleep(200)
// Firmware streams small chunks in real time (512 samples = 1024 bytes = 32 ms).
for (let i = 0; i < pcm.length; i += 1024) {
  ws.send(pcm.subarray(i, i + 1024))
  await Bun.sleep(32)
}
ws.send(JSON.stringify({ event: 'speech_end' }))
t0 = Date.now()
console.log('speech_end sent')
await Bun.sleep(listenMs)
ws.close()

function wav(pcm: Buffer) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28)
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}
