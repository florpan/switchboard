// SessionEnd: hand the transcript to a detached summarizer that appends to the workspace's
// notes/YYYY-MM-DD.md. SessionEnd hooks block Claude Code (max 60 s), so this only starts the job.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

if (process.env.GATEWAY_HOOKS_OFF) process.exit(0)

const input = JSON.parse(await Bun.stdin.text()) as { transcript_path?: string; reason?: string; cwd?: string }
if (!input.transcript_path || input.reason === 'resume') process.exit(0)

const repo = resolve(import.meta.dir, '..')
const workspace = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? resolve(repo, 'workspace')
spawn(process.execPath, [resolve(repo, 'scripts/summarize-session.ts'), input.transcript_path, resolve(workspace, 'notes')], {
  cwd: repo,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
}).unref()
