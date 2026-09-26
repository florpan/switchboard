// SessionStart (startup, clear): make sure the gateway daemon runs, then print the base prompt,
// which Claude Code adds to the session context. Runs before MCP servers connect.
// Wired in the workspace's .claude/settings.json: bun "${CLAUDE_PROJECT_DIR}/../hooks/session-start.ts"
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.env.GATEWAY_HOOKS_OFF) process.exit(0)

const repo = resolve(import.meta.dir, '..')
const workspace = process.env.CLAUDE_PROJECT_DIR ?? resolve(repo, 'workspace')
const url = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8090'
const up = () => fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok, () => false)

// Start a local daemon unless one answers, or GATEWAY_URL says it runs elsewhere (e.g. its own container).
if (!(await up()) && !process.env.GATEWAY_URL) {
  mkdirSync(resolve(workspace, 'state'), { recursive: true })
  const logFile = openSync(resolve(workspace, 'state/gateway.log'), 'a')
  spawn(process.execPath, [resolve(repo, 'src/main.ts')], {
    cwd: repo,
    env: { ...process.env, GATEWAY_WORKSPACE: workspace },
    detached: true,
    stdio: ['ignore', logFile, logFile],
    windowsHide: true,
  }).unref()
  for (let i = 0; i < 80 && !(await up()); i++) await Bun.sleep(250) // cold start can take ~10 s
}

console.log(readFileSync(resolve(repo, 'prompts/gateway.md'), 'utf8'))
