// Runs a job's steps in order. Each step's output feeds the next as {output}.
//
//   shell step (bash/pwsh): exit 0 = continue with its stdout as the new {output}
//                           exit 1 = stop, nothing to do
//                           other  = stop, error
//   prompt step:            pushed into the Claude session through the jobs channel
//   anything else:          an action another channel registered (e.g. say -> voice)
// The first key of a step is its kind; other keys are options, e.g. { "say": "...", "device": "kitchen" }.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Gateway } from '../../core/channel'
import type { Job } from './jobs'

export type RunResult = {
  job: string
  trigger: string
  status: 'done' | 'stopped' | 'error' | 'busy' | 'cooldown'
  detail?: string
  startedAt: string
  ms: number
}

// On Windows plain `bash` is usually WSL, which doesn't see our environment: prefer Git Bash.
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
export const BASH = process.env.GATEWAY_BASH ?? (process.platform === 'win32' && existsSync(GIT_BASH) ? GIT_BASH : 'bash')

const shells: Record<string, (cmd: string) => string[]> = {
  bash: cmd => [BASH, '-c', cmd],
  pwsh: cmd => ['pwsh', '-NoProfile', '-NonInteractive', '-Command', cmd],
}

export class Runner {
  private running = new Set<string>()
  private lastActed = new Map<string, number>()
  readonly history: RunResult[] = []

  constructor(private gw: Gateway) {}

  async run(job: Job, trigger: string, input = ''): Promise<RunResult> {
    const startedAt = new Date()
    const finish = (status: RunResult['status'], detail?: string) => {
      const result = { job: job.id, trigger, status, detail, startedAt: startedAt.toISOString(), ms: Date.now() - +startedAt }
      this.history.unshift(result)
      this.history.length = Math.min(this.history.length, 200)
      this.gw.log('jobs', `${job.id} (${trigger}): ${status}${detail ? ` - ${detail}` : ''}`)
      return result
    }

    if (this.running.has(job.id)) return finish('busy')
    this.running.add(job.id)
    try {
      let output = input
      for (const [i, step] of job.steps.entries()) {
        const [[kind, value] = [], ...options] = Object.entries(step)
        if (!kind || typeof value !== 'string') return finish('error', `step ${i + 1} is empty`)
        const vars = { output, input, job: job.id }

        if (kind in shells) {
          const res = await this.shell(shells[kind]!(value), job, output, input)
          if (res.code === 1) return finish('stopped', `step ${i + 1} (${kind}): nothing to do`)
          if (res.code !== 0) return finish('error', `step ${i + 1} (${kind}) exit ${res.code}: ${res.stderr.trim().slice(0, 300)}`)
          output = res.stdout.trim()
          continue
        }

        if (this.coolingDown(job)) return finish('cooldown', `step ${i + 1} (${kind})`)
        const text = fill(value, vars)
        if (kind === 'prompt') {
          const delivered = await this.gw.push('jobs', text, { job: job.id, trigger })
          if (!delivered) return finish('error', 'no Claude session connected to the jobs channel')
        } else {
          const action = this.gw.actions.get(kind)
          if (!action) return finish('error', `step ${i + 1}: unknown step type "${kind}"`)
          await action(text, Object.fromEntries(options))
        }
        this.lastActed.set(job.id, Date.now())
      }
      return finish('done')
    } catch (err) {
      return finish('error', String(err))
    } finally {
      this.running.delete(job.id)
    }
  }

  private coolingDown(job: Job) {
    const last = this.lastActed.get(job.id)
    return !!job.cooldown && !!last && Date.now() - last < job.cooldown * 1000
  }

  private async shell(cmd: string[], job: Job, output: string, input: string) {
    const proc = Bun.spawn(cmd, {
      cwd: job.cwd ? resolve(this.gw.workspace, job.cwd) : this.gw.workspace,
      stdin: new TextEncoder().encode(output),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GATEWAY_WORKSPACE: this.gw.workspace, JOB_ID: job.id, JOB_OUTPUT: output, JOB_INPUT: input },
    })
    const timer = setTimeout(() => proc.kill(), (job.timeout ?? 120) * 1000)
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    clearTimeout(timer)
    return { stdout, stderr, code: proc.signalCode ? -1 : code }
  }
}

/** Replace {output}, {input} and {job}; other braces are left alone. */
export function fill(template: string, vars: Record<string, string>) {
  return template.replace(/\{(output|input|job)\}/g, (_, key) => vars[key] ?? '')
}
