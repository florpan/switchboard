// Dashboard: check config/dashboard.json against the running daemon, and show what each widget gets.
//   bun dashboard.ts check            validate config/dashboard.json and run every source once
//   bun dashboard.ts show             the loaded config's errors and each widget's current data
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const WORKSPACE = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
if (existsSync(resolve(WORKSPACE, '.env')))
  for (const [, key, value] of readFileSync(resolve(WORKSPACE, '.env'), 'utf8').matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/gm))
    process.env[key!] ??= value!
const GATEWAY = (process.env.GATEWAY_URL ?? `http://127.0.0.1:${process.env.GATEWAY_PORT ?? 8090}`).replace(/\/$/, '')

const [command] = process.argv.slice(2)

if (command === 'check') {
  const res = await fetch(`${GATEWAY}/api/dashboard/check`, { method: 'POST' })
  const { ok, errors } = (await res.json()) as { ok: boolean; errors: string[] }
  console.log(ok ? 'ok' : errors.map(e => `error: ${e}`).join('\n'))
  process.exit(ok ? 0 : 1)
} else if (command === 'show') {
  const d: any = await (await fetch(`${GATEWAY}/api/dashboard`)).json()
  console.log(`file: ${d.file ?? '(none, showing the default page)'}${d.error ? `\nNOT LOADED, last good config in use: ${d.error}` : ''}`)
  for (const e of d.widgetErrors) console.log(`error: ${e}`)
  for (const page of d.pages) {
    console.log(`\n# ${page.title}`)
    for (const w of page.widgets) {
      const data = w.data === undefined ? '(no data yet: sources only run while a page is open)' : JSON.stringify(w.data)
      console.log(`- ${w.type} "${w.title ?? ''}": ${w.error ? `ERROR ${w.error} | ` : ''}${data.length > 200 ? `${data.slice(0, 200)}…` : data}`)
    }
  }
} else {
  console.log('usage: bun dashboard.ts check | show')
}
