// Home: a curated layer over Home Assistant. The registry (<workspace>/config/home.json) gives devices spoken
// names, aliases, groups and house rules; every command prints compact lines instead of raw HA state.
//   bun home.ts <command> [...]      (run without arguments for help)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

type Device = { entity: string; area?: string; aliases?: string[]; note?: string }
type Group = { members: string[]; aliases?: string[] }
type Registry = { devices: Record<string, Device>; groups: Record<string, Group>; rules: string[] }
type State = { entity_id: string; state: string; attributes: Record<string, any> }

// The workspace (the Claude session's project dir) holds the registry and the .env with HA credentials.
const WORKSPACE = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
if (existsSync(resolve(WORKSPACE, '.env')))
  for (const [, key, value] of readFileSync(resolve(WORKSPACE, '.env'), 'utf8').matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/gm))
    process.env[key!] ??= value!

const REGISTRY = process.env.HOME_REGISTRY ?? resolve(WORKSPACE, 'config/home.json')
const CONTROLLABLE = ['light', 'switch', 'climate', 'fan', 'cover', 'lock', 'media_player', 'scene', 'script', 'input_boolean', 'vacuum']

// --- Home Assistant ---------------------------------------------------------------------------

function haConfig() {
  if (process.env.HA_URL && process.env.HA_TOKEN) return { url: process.env.HA_URL, token: process.env.HA_TOKEN }
  const path = process.env.HA_CONFIG_PATH
  if (path && existsSync(path)) {
    const { url, api_token } = JSON.parse(readFileSync(path, 'utf8')).homeassistant ?? {}
    if (url && api_token) return { url, token: api_token }
  }
  throw new Error('set HA_URL and HA_TOKEN (or HA_CONFIG_PATH to a settings.json with homeassistant.url/api_token)')
}

async function ha(path: string, body?: unknown) {
  const { url, token } = haConfig()
  const res = await fetch(`${url.replace(/\/$/, '')}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HA ${path}: ${res.status} ${await res.text()}`)
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text()
}

const allStates = () => ha('states') as Promise<State[]>
const stateOf = (entity: string) => ha(`states/${entity}`) as Promise<State>

/** entity_id -> HA area name, one template call. */
async function haAreas(): Promise<Map<string, string>> {
  const out = (await ha('template', {
    template: '{% for s in states %}{% set a = area_name(s.entity_id) %}{% if a %}{{ s.entity_id }}|{{ a }}\n{% endif %}{% endfor %}',
  })) as string
  return new Map(out.split('\n').filter(Boolean).map(l => l.split('|') as [string, string]))
}

// --- Registry ---------------------------------------------------------------------------------

const load = (): Registry =>
  existsSync(REGISTRY) ? { devices: {}, groups: {}, rules: [], ...JSON.parse(readFileSync(REGISTRY, 'utf8')) } : { devices: {}, groups: {}, rules: [] }
const save = (r: Registry) => {
  mkdirSync(dirname(REGISTRY), { recursive: true })
  writeFileSync(REGISTRY, JSON.stringify(r, null, 2) + '\n')
}
const norm = (s: string) => s.toLowerCase().normalize('NFKC').trim()

/** A spoken target -> registry device names. Order: device name/alias, group, area, entity id, substring. */
function resolveTarget(r: Registry, target: string): string[] {
  const t = norm(target)
  const byName = Object.entries(r.devices).filter(([n, d]) => norm(n) === t || d.aliases?.some(a => norm(a) === t))
  if (byName.length) return byName.map(([n]) => n)
  const group = Object.entries(r.groups).find(([n, g]) => norm(n) === t || g.aliases?.some(a => norm(a) === t))
  if (group) return group[1].members.flatMap(m => (r.devices[m] ? [m] : resolveTarget(r, m)))
  const area = Object.entries(r.devices).filter(([, d]) => d.area && norm(d.area) === t)
  if (area.length) return area.map(([n]) => n)
  const entity = Object.entries(r.devices).filter(([, d]) => d.entity === target)
  if (entity.length) return entity.map(([n]) => n)
  return Object.entries(r.devices)
    .filter(([n, d]) => norm(n).includes(t) || d.aliases?.some(a => norm(a).includes(t)))
    .map(([n]) => n)
}

/** Registry names, or a raw entity id that isn't registered. */
function entitiesFor(r: Registry, target: string): { name: string; entity: string }[] {
  const names = resolveTarget(r, target)
  if (names.length) return names.map(n => ({ name: n, entity: r.devices[n]!.entity }))
  if (/^\w+\.\w+$/.test(target)) return [{ name: target, entity: target }]
  throw new Error(`nothing matches "${target}". Try: find ${target}`)
}

// --- Compact output ---------------------------------------------------------------------------

function summary(s: State): string {
  const a = s.attributes
  const [domain] = s.entity_id.split('.')
  const bits = [s.state]
  if (domain === 'light' && s.state === 'on' && a.brightness != null) bits.push(`${Math.round((a.brightness / 255) * 100)}%`)
  if (domain === 'climate') bits.push(`now ${a.current_temperature ?? '?'}°, target ${a.temperature ?? '?'}°`)
  if (domain === 'cover' && a.current_position != null) bits.push(`${a.current_position}%`)
  if (domain === 'media_player' && a.media_title) bits.push(`"${a.media_title}"${a.media_artist ? ` - ${a.media_artist}` : ''}`)
  if (domain === 'media_player' && a.volume_level != null) bits.push(`vol ${Math.round(a.volume_level * 100)}%`)
  if (a.unit_of_measurement) bits[0] = `${s.state} ${a.unit_of_measurement}`
  return bits.join(', ')
}

const line = (name: string, s: State, area?: string) =>
  `${name}${name === s.entity_id ? '' : ` (${s.entity_id}${area ? `, ${area}` : ''})`}: ${summary(s)}`

// --- Actions ----------------------------------------------------------------------------------

/** "on" | "off" | "toggle" | "open" ... | key=value pairs -> [service, data]. */
function serviceFor(entity: string, action: string, params: Record<string, string>): [string, Record<string, unknown>] {
  const [domain] = entity.split('.') as [string]
  const data: Record<string, unknown> = { entity_id: entity }
  const num = (v?: string) => (v === undefined ? undefined : Number(v))
  switch (action) {
    case 'on':
      if (domain === 'scene' || domain === 'script') return [`${domain}.turn_on`, data]
      return [`${domain === 'input_boolean' ? 'input_boolean' : domain}.turn_on`, data]
    case 'off':
      return [`${domain}.turn_off`, data]
    case 'toggle':
      return [`${domain}.toggle`, data]
    case 'open':
    case 'close':
      return [`cover.${action}_cover`, data]
    case 'lock':
    case 'unlock':
      return [`lock.${action}`, data]
    case 'play':
    case 'pause':
    case 'stop':
      return [`media_player.media_${action}`, data]
    case 'set':
      if (domain === 'light') {
        if (params.brightness) data.brightness_pct = num(params.brightness)
        if (params.kelvin) data.color_temp_kelvin = num(params.kelvin)
        if (params.color) data.color_name = params.color
        return ['light.turn_on', data]
      }
      if (domain === 'climate' && params.temperature) return ['climate.set_temperature', { ...data, temperature: num(params.temperature) }]
      if (domain === 'climate' && params.mode) return ['climate.set_hvac_mode', { ...data, hvac_mode: params.mode }]
      if (domain === 'media_player' && params.volume) return ['media_player.volume_set', { ...data, volume_level: num(params.volume)! / 100 }]
      if (domain === 'cover' && params.position) return ['cover.set_cover_position', { ...data, position: num(params.position) }]
      if ((domain === 'number' || domain === 'input_number') && params.value) return [`${domain}.set_value`, { ...data, value: num(params.value) }]
      if (domain === 'fan' && params.speed) return ['fan.set_percentage', { ...data, percentage: num(params.speed) }]
      throw new Error(`don't know how to set ${Object.keys(params).join(', ')} on ${domain}; use: call <domain.service> ${entity} '<json>'`)
  }
  throw new Error(`unknown action "${action}" (on, off, toggle, open, close, lock, unlock, play, pause, stop, set key=value)`)
}

// --- Commands ---------------------------------------------------------------------------------

const [cmd = 'help', ...args] = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const words = args.filter(a => !a.startsWith('--'))
const option = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

const commands: Record<string, () => Promise<void> | void> = {
  async find() {
    const r = load()
    const q = norm(words.join(' '))
    for (const [n, g] of Object.entries(r.groups)) if (norm(n).includes(q) || g.aliases?.some(a => norm(a).includes(q))) console.log(`group ${n}: ${g.members.join(', ')}`)
    const names = resolveTarget(r, q)
    const states = new Map((await allStates()).map(s => [s.entity_id, s]))
    for (const n of names) console.log(line(n, states.get(r.devices[n]!.entity)!, r.devices[n]!.area))
    if (!names.length) {
      // Not registered: search HA friendly names, compact.
      const hits = [...states.values()].filter(s => norm(`${s.entity_id} ${s.attributes.friendly_name ?? ''}`).includes(q)).slice(0, 20)
      console.log(hits.length ? `not in registry; HA matches:\n${hits.map(s => `  ${s.entity_id} "${s.attributes.friendly_name ?? ''}": ${summary(s)}`).join('\n')}` : `nothing matches "${q}"`)
    }
  },

  async state() {
    const r = load()
    for (const target of words.length ? [words.join(' ')] : []) {
      for (const { name, entity } of entitiesFor(r, target)) console.log(line(name, await stateOf(entity), r.devices[name]?.area))
    }
  },

  async do() {
    const r = load()
    const actionAt = words.findIndex(w => ['on', 'off', 'toggle', 'open', 'close', 'lock', 'unlock', 'play', 'pause', 'stop', 'set'].includes(w))
    if (actionAt < 1) throw new Error('usage: do <target> <on|off|toggle|open|close|lock|unlock|play|pause|stop|set key=value...>')
    const target = words.slice(0, actionAt).join(' ')
    const action = words[actionAt]!
    const params = Object.fromEntries(words.slice(actionAt + 1).map(p => p.split('=') as [string, string]))
    for (const { name, entity } of entitiesFor(r, target)) {
      const [service, data] = serviceFor(entity, action, params)
      if (flags.has('--dry')) {
        console.log(`[dry] ${name}: ${service} ${JSON.stringify(data)}`)
        continue
      }
      await ha(`services/${service.replace('.', '/')}`, data)
      await Bun.sleep(400)
      console.log(line(name, await stateOf(entity), r.devices[name]?.area))
    }
  },

  async call() {
    const [service, entity, json] = words
    if (!service?.includes('.') || !entity) throw new Error("usage: call <domain.service> <entity_id> ['{json data}']")
    await ha(`services/${service.replace('.', '/')}`, { entity_id: entity, ...(json ? JSON.parse(json) : {}) })
    console.log(line(entity, await stateOf(entity)))
  },

  async raw() {
    console.log(JSON.stringify(await stateOf(words[0] ?? ''), null, 2))
  },

  async areas() {
    const r = load()
    const counts = new Map<string, number>()
    for (const d of Object.values(r.devices)) counts.set(d.area ?? '(no area)', (counts.get(d.area ?? '(no area)') ?? 0) + 1)
    const ha = new Set((await haAreas()).values())
    for (const a of new Set([...ha, ...counts.keys()])) console.log(`${a}: ${counts.get(a) ?? 0} registered`)
  },

  async unmapped() {
    const r = load()
    const known = new Set(Object.values(r.devices).map(d => d.entity))
    const areas = await haAreas()
    const filter = words.join(' ')
    const rows = (await allStates()).filter(s => {
      if (known.has(s.entity_id)) return false
      const domain = s.entity_id.split('.')[0]!
      if (filter) return domain === filter || norm(areas.get(s.entity_id) ?? '') === norm(filter) // any domain
      return flags.has('--all') || CONTROLLABLE.includes(domain)
    })
    for (const s of rows.slice(0, Number(option('limit') ?? 80)))
      console.log(`${s.entity_id} "${s.attributes.friendly_name ?? ''}" [${areas.get(s.entity_id) ?? 'no area'}]: ${summary(s)}`)
    if (rows.length > Number(option('limit') ?? 80)) console.log(`... ${rows.length} total, use --limit=N or filter by domain/area`)
  },

  async import() {
    // Seed the registry from HA: controllable entities that have an area, named by their friendly name.
    const r = load()
    const known = new Set(Object.values(r.devices).map(d => d.entity))
    const domains = option('domains')?.split(',') ?? CONTROLLABLE.filter(d => d !== 'script' && d !== 'scene')
    const areas = await haAreas()
    let added = 0
    for (const s of await allStates()) {
      const domain = s.entity_id.split('.')[0]!
      if (known.has(s.entity_id) || !domains.includes(domain) || (!areas.has(s.entity_id) && !flags.has('--no-area'))) continue
      let name = String(s.attributes.friendly_name ?? s.entity_id)
      if (r.devices[name]) name = `${name} (${s.entity_id})`
      r.devices[name] = { entity: s.entity_id, area: areas.get(s.entity_id) }
      added++
    }
    if (!flags.has('--dry')) save(r)
    console.log(`${flags.has('--dry') ? '[dry] would add' : 'added'} ${added} devices (${Object.keys(r.devices).length} in registry)`)
  },

  add() {
    const [entity, ...rest] = words
    if (!entity?.includes('.') || !rest.length) throw new Error('usage: add <entity_id> <name> [--area=X] [--alias=a,b]')
    const r = load()
    r.devices[rest.join(' ')] = { entity, area: option('area'), aliases: option('alias')?.split(',').map(s => s.trim()) }
    save(r)
    console.log(`added ${rest.join(' ')} -> ${entity}`)
  },

  rename() {
    const [from, to] = args.join(' ').split(' -> ')
    const r = load()
    if (!from || !to || !r.devices[from]) throw new Error('usage: rename <name> -> <new name>')
    r.devices[to] = r.devices[from]!
    delete r.devices[from]
    for (const g of Object.values(r.groups)) g.members = g.members.map(m => (m === from ? to : m))
    save(r)
    console.log(`renamed ${from} -> ${to}`)
  },

  alias() {
    const [target, aliases] = args.join(' ').split(' = ')
    const r = load()
    const entry = target && (r.devices[target] ?? r.groups[target])
    if (!entry || !aliases) throw new Error('usage: alias <device or group name> = alias1, alias2')
    entry.aliases = [...new Set([...(entry.aliases ?? []), ...aliases.split(',').map(a => a.trim())])]
    save(r)
    console.log(`${target}: ${entry.aliases.join(', ')}`)
  },

  group() {
    const [name, members] = args.join(' ').split(' = ')
    if (!name || !members) throw new Error('usage: group <name> = member1, member2 (device names, groups or areas)')
    const r = load()
    r.groups[name] = { ...r.groups[name], members: members.split(',').map(m => m.trim()) }
    save(r)
    console.log(`group ${name}: ${r.groups[name]!.members.join(', ')}`)
  },

  remove() {
    const r = load()
    const name = words.join(' ')
    if (r.devices[name]) delete r.devices[name]
    else if (r.groups[name]) delete r.groups[name]
    else throw new Error(`no device or group "${name}"`)
    save(r)
    console.log(`removed ${name}`)
  },

  rules() {
    const r = load()
    const [sub, ...rest] = words
    if (sub === 'add') r.rules.push(rest.join(' '))
    else if (sub === 'rm') r.rules.splice(Number(rest[0]) - 1, 1)
    if (sub) save(r)
    r.rules.forEach((rule, i) => console.log(`${i + 1}. ${rule}`))
    if (!r.rules.length) console.log('(no rules)')
  },

  help() {
    console.log(`home.ts: Home Assistant through a curated registry (${REGISTRY})
  find <text>                     registered devices/groups matching text (falls back to HA names)
  state <target>                  compact state; target = device name/alias, group, area or entity_id
  do <target> <action> [k=v]      on off toggle open close lock unlock play pause stop | set brightness=40 kelvin=2700
                                  temperature=21 mode=heat volume=30 position=50 value=3 speed=50   (--dry to preview)
  call <domain.service> <entity> ['{json}']   any HA service (escape hatch)
  raw <entity_id>                 full HA state (large)
  areas                           areas and registered device counts
  unmapped [domain|area] [--all]  entities not in the registry (controllable domains unless --all)
  import [--domains=a,b] [--no-area] [--dry]   seed registry from HA areas and friendly names
  add <entity_id> <name> [--area=X] [--alias=a,b]
  rename <name> -> <new name>
  alias <name> = a, b             group <name> = member, member
  remove <name>                   rules [add <text> | rm <n>]`)
  },
}

try {
  await (commands[cmd] ?? commands.help)!()
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
}
