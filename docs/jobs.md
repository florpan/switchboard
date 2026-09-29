# Jobs

A job is a trigger plus a list of steps. Jobs live in the workspace's `config/jobs.json`, which is
reloaded when it changes, and the session can manage them with the jobs channel's tools.

```json
{ "jobs": [
  { "id": "errors",
    "schedule": "*/5 * * * *",
    "steps": [
      { "bash": "test app.log -nt state/.last-check && touch state/.last-check" },
      { "bash": "grep ERROR app.log | tail -20" },
      { "prompt": "New errors since last run:\n{output}" } ] }
] }
```

## Triggers

- `schedule`: cron, 5 fields, or 6 with seconds first.
- `at`: an ISO time with offset; runs once, then the job is disabled.
- Neither: the job only runs when triggered.

Any job can be triggered with `POST /api/jobs/:id/run` (returns 202 at once). The request body is
available to the steps as `{input}` and `$JOB_INPUT`. This is how Home Assistant or any other system
starts work: define a job without a schedule and point the webhook at it.

`enabled: false` turns a job off. Runs of the same job never overlap: a trigger while it runs is
dropped (`busy`).

## Steps

Steps run in order. The first key of a step is its type; further keys are options.

| Step | |
|---|---|
| `bash` | Shell command (Git Bash on Windows, `GATEWAY_BASH` to override). Exit 0: continue, its stdout becomes `{output}`. Exit 1: stop quietly (nothing to do). Other: stop with an error. |
| `pwsh` | Same for PowerShell (not included in the Docker image). |
| `prompt` | Text pushed into the session through the jobs channel, as `<channel source="...jobs" job="<id>" trigger="cron|at|webhook|manual">`. |
| `say` | Spoken on the voice speakers; option `device` picks one: `{ "say": "Dinner!", "device": "kitchen" }`. |

In `prompt` and `say` text, `{output}` (previous step's stdout), `{input}` (trigger body) and `{job}` are
replaced. Shell steps get the previous output on stdin and as `$JOB_OUTPUT`, the trigger body as
`$JOB_INPUT`, the job id as `$JOB_ID` and the workspace as `$GATEWAY_WORKSPACE`; they run in the
workspace (or `cwd` relative to it).

The pattern: cheap shell steps decide whether there is anything to do, so the model is only involved
when there is. Logic that grows beyond a line belongs in a script, ideally in a skill, so the session
can use the same code: `{ "bash": "bun .claude/skills/Iris/doorbell.ts" }`.

Options per job: `cwd`, `timeout` (seconds per shell step, 120), `cooldown` (seconds after a
`prompt`/`say` step ran during which later runs stop before reaching one), `description`.

## Session tools

| Tool | |
|---|---|
| `list_jobs` | Jobs with triggers, next run |
| `add_job {id, steps, schedule?, at?, description?, cwd?}` | Add or replace; e.g. a reminder: `at` + `say` |
| `remove_job {id}` | Delete |
| `run_job {id}` | Run now, returns how it ended |

## HTTP

`GET /api/jobs` (with `when`, `active`, `next`), `GET /api/runs` (last 200 runs: trigger, status,
detail, duration), `POST /api/jobs/:id/run`.

## Examples

Reminder on one speaker:
```json
{ "id": "laundry", "at": "2026-09-25T18:00:00+02:00", "steps": [{ "say": "The laundry is done.", "device": "kitchen" }] }
```

Start a fresh session every night (needs claude in the Docker image's tmux loop, which starts it again
after `/exit`); the SessionEnd hook writes the day's notes. Use a restart rather than `/clear`: after
`/clear` Claude Code registers the channel servers again but doesn't reopen their event streams, so
channel events stop arriving:
```json
{ "id": "nightly-restart", "schedule": "0 4 * * *", "steps": [{ "bash": "tmux send-keys -t gateway /exit Enter" }] }
```

Back up the workspace, and let the session deal with it only when something fails. The shell step
turns the usual meaning around: success exits 1 (nothing to do), a failure prints git's output and exits
0, so the prompt step runs with it:
```json
{ "id": "backup", "schedule": "30 4 * * *",
  "steps": [
    { "bash": "out=$( (git add -A && (git diff --cached --quiet || git commit -qm \"backup $(date +%F)\") && git pull -q --rebase && git push -q) 2>&1 ) && exit 1; echo \"$out\"" },
    { "prompt": "The nightly workspace backup (commit, pull --rebase, push) failed:\n{output}\nFix it if the cause is clear and the fix is safe, then push. Otherwise email the owner what happened and what you found." } ] }
```
