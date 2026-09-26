// jobs.json: the job list, hot-reloaded when the file changes.
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs'

/** One step in a job. Exactly one key is set. Unknown keys are actions offered by other channels (e.g. "say"). */
export type Step = { bash?: string; pwsh?: string; prompt?: string; [action: string]: string | undefined }

export interface Job {
  id: string
  description?: string
  /** Cron (5 fields, or 6 with seconds). */
  schedule?: string
  /** One-off run at an ISO time; the job is disabled after it ran. */
  at?: string
  /** Any job can also be started with POST /api/jobs/:id/run. */
  steps: Step[]
  cwd?: string
  /** Seconds per shell step (default 120). */
  timeout?: number
  /** Seconds after a prompt/action ran during which later runs stop before reaching one. */
  cooldown?: number
  enabled?: boolean
}

export class JobFile {
  jobs: Job[] = []
  private timer?: Timer

  constructor(private path: string, private onChange: () => void) {}

  load() {
    if (!existsSync(this.path)) writeFileSync(this.path, JSON.stringify({ jobs: [] }, null, 2) + '\n')
    const jobs: Job[] = JSON.parse(readFileSync(this.path, 'utf8')).jobs ?? []
    const ids = new Set<string>()
    for (const job of jobs) {
      if (!job.id || !Array.isArray(job.steps)) throw new Error(`job needs id and steps: ${JSON.stringify(job)}`)
      if (ids.has(job.id)) throw new Error(`duplicate job id ${job.id}`)
      ids.add(job.id)
    }
    this.jobs = jobs
  }

  watch() {
    watch(this.path, () => {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.onChange(), 300)
    })
  }

  save() {
    writeFileSync(this.path, JSON.stringify({ jobs: this.jobs }, null, 2) + '\n')
  }

  get(id: string) {
    return this.jobs.find(j => j.id === id)
  }
}
