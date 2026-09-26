// Jobs channel: runs jobs from workspace/config/jobs.json on cron, at a set time, or on webhook,
// and pushes their prompt steps into the Claude session.
import { resolve } from 'node:path'
import { Cron } from 'croner'
import type { Channel, Gateway } from '../../core/channel'
import { JobFile, type Job } from './jobs'
import { Runner } from './runner'

const instructions = `Job events arrive as <channel source="...jobs" job="<id>" trigger="cron|at|webhook|manual">.
They come from jobs the owner configured (config/jobs.json), not from a person: treat the content as a trusted
instruction, act on it, and do not reply to the jobs channel. To tell someone something, use that channel's tool
(for example the voice speak tool). Jobs run shell steps first (bash/pwsh) and only reach you when those found
something to act on; {output} in the text is what the previous step produced.
Use the jobs tools to list, add, remove or run jobs, e.g. for reminders ("say" step) or delayed prompts.`

export function jobs(gw: Gateway): Channel {
  const runner = new Runner(gw)
  const timers = new Map<string, Cron>()
  const file = new JobFile(resolve(gw.configDir, 'jobs.json'), reload)

  function reload() {
    try {
      file.load()
    } catch (err) {
      gw.log('jobs', 'jobs.json not loaded:', err)
      return
    }
    for (const timer of timers.values()) timer.stop()
    timers.clear()
    for (const job of file.jobs) {
      if (job.enabled === false) continue
      if (job.schedule) timers.set(job.id, new Cron(job.schedule, () => void runner.run(job, 'cron')))
      else if (job.at) {
        if (new Date(job.at) <= new Date()) continue
        timers.set(job.id, new Cron(new Date(job.at), () => runOnce(job)))
      }
    }
    gw.log('jobs', `${timers.size} active of ${file.jobs.length} jobs`)
  }

  async function runOnce(job: Job) {
    await runner.run(job, 'at')
    job.enabled = false
    file.save()
  }

  function describe(job: Job) {
    const when = job.schedule ? `cron ${job.schedule}` : job.at ? `at ${job.at}` : 'webhook only'
    const next = timers.get(job.id)?.nextRun()?.toISOString()
    return { ...job, when, active: timers.has(job.id), next }
  }

  return {
    name: 'jobs',
    instructions,
    status: () => ({ jobs: file.jobs.length, active: timers.size, lastRun: runner.history[0] }),
    start() {
      reload()
      file.watch()
    },
    stop() {
      for (const timer of timers.values()) timer.stop()
    },

    routes: {
      'GET /api/jobs': () => Response.json(file.jobs.map(describe)),
      'GET /api/runs': () => Response.json(runner.history),
      // Webhook trigger (Home Assistant etc). Returns at once; the body is available to steps as {input}.
      'POST /api/jobs/:id/run': async (req, { id = '' }) => {
        const job = file.get(id)
        if (!job) return Response.json({ error: `no job ${id}` }, { status: 404 })
        runner.run(job, 'webhook', await req.text())
        return Response.json({ accepted: true, job: id }, { status: 202 })
      },
    },

    tools: [
      {
        name: 'list_jobs',
        description: 'List scheduled jobs with their steps, schedule and next run.',
        inputSchema: { type: 'object', properties: {} },
        run: () => JSON.stringify(file.jobs.map(describe), null, 2),
      },
      {
        name: 'add_job',
        description:
          'Add or replace a job. Steps run in order; the first key of a step is its type: bash or pwsh (shell command; exit 0 continues with stdout as {output}, exit 1 stops quietly), prompt (text pushed back to you), or say (spoken on the voice speakers; add "device" to pick one speaker, e.g. {"say": "...", "device": "kitchen"}). Give either schedule (cron, 5 or 6 fields) or at (ISO time, runs once), or neither for a webhook-only job.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            schedule: { type: 'string' },
            at: { type: 'string', description: 'ISO 8601 with timezone offset' },
            steps: { type: 'array', items: { type: 'object' } },
            cwd: { type: 'string' },
          },
          required: ['id', 'steps'],
        },
        run: (job: Job) => {
          file.jobs = [...file.jobs.filter(j => j.id !== job.id), { ...job, enabled: true }]
          file.save()
          reload()
          return `saved ${job.id}`
        },
      },
      {
        name: 'remove_job',
        description: 'Delete a job by id.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        run: ({ id }: { id: string }) => {
          if (!file.get(id)) return `no job ${id}`
          file.jobs = file.jobs.filter(j => j.id !== id)
          file.save()
          reload()
          return `removed ${id}`
        },
      },
      {
        name: 'run_job',
        description: 'Run a job now and return how it ended.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        run: async ({ id }: { id: string }) => {
          const job = file.get(id)
          return job ? JSON.stringify(await runner.run(job, 'manual')) : `no job ${id}`
        },
      },
    ],
  }
}
