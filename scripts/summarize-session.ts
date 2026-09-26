// Summarize a finished session transcript into the daily notes (<notes dir>/YYYY-MM-DD.md).
// Started by the SessionEnd hook; runs claude -p outside the workspace so no gateway hooks fire.
//   bun scripts/summarize-session.ts <transcript.jsonl> [notes dir]
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const transcript = process.argv[2]
if (!transcript || !existsSync(transcript)) process.exit(0)

const repo = resolve(import.meta.dir, '..')
const notesDir = resolve(process.argv[3] ?? resolve(repo, 'workspace/notes'))
const MAX_CHARS = 150_000

type Entry = { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } }
const lines: string[] = []
let first = ''
let last = ''
for (const raw of readFileSync(transcript, 'utf8').split('\n')) {
  if (!raw.trim()) continue
  let entry: Entry
  try {
    entry = JSON.parse(raw)
  } catch {
    continue
  }
  if (entry.type !== 'user' && entry.type !== 'assistant') continue
  const content = entry.message?.content
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((b: any) => (b.type === 'text' ? [b.text] : b.type === 'tool_use' ? [`[tool ${b.name} ${JSON.stringify(b.input).slice(0, 200)}]`] : []))
        : []
  const text = texts.join('\n').trim()
  if (!text) continue
  first ||= entry.timestamp ?? ''
  last = entry.timestamp ?? last
  lines.push(`${entry.type === 'user' ? 'IN' : 'OUT'}: ${text}`)
}
if (lines.length < 2) process.exit(0)

const conversation = lines.join('\n\n').slice(-MAX_CHARS)
const prompt = `Below is the transcript of an assistant session (IN = messages to the assistant, including <channel> events
from voice, Discord, email and the scheduler; OUT = the assistant's text and tool calls).
Write concise daily notes in the language of the conversation: what happened, requests and how they were handled,
decisions, facts learned about people or the house, open follow-ups. Group by topic, skip small talk and routine
scheduler noise. Plain markdown bullets under short topic headings (###), no title and no preamble.

${conversation}`

const proc = Bun.spawn(['claude', '-p', '--model', 'haiku'], {
  cwd: tmpdir(), // outside any project: no project hooks, nothing written into the repo
  stdin: new TextEncoder().encode(prompt),
  stdout: 'pipe',
  stderr: 'ignore',
  env: { ...process.env, GATEWAY_HOOKS_OFF: '1' },
})
const notes = (await new Response(proc.stdout).text()).trim()
if ((await proc.exited) !== 0 || !notes) process.exit(1)

const time = (iso: string) => (iso ? new Date(iso).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }) : '?')
const day = new Date(first || Date.now()).toLocaleDateString('sv-SE')
mkdirSync(notesDir, { recursive: true })
appendFileSync(resolve(notesDir, `${day}.md`), `\n## Session ${time(first)}–${time(last)}\n\n${notes}\n`)
