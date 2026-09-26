---
name: Home
description: Control and query the house through Home Assistant (lights, switches, climate, media, covers, locks, sensors) using a curated registry of named devices, groups and house rules. USE WHEN turning things on or off, asking about the state of something in the house, temperatures, what is on, naming devices, or setting house rules.
allowed-tools: Bash(bun ${CLAUDE_SKILL_DIR}/home.ts *)
---

# Home

Home Assistant has thousands of entities with poor names. This skill puts a registry in front of it:
devices with spoken names and aliases, groups, areas and house rules (`config/home.json` in the workspace).
Always go through the registry; it keeps answers small and names consistent.

Run: `bun ${CLAUDE_SKILL_DIR}/home.ts <command>` (no arguments prints help). Credentials: `HA_URL` and
`HA_TOKEN` in the workspace `.env`.

## Doing things

- `state <target>` / `do <target> <action>`: target is a device name or alias, a group, an area, or an entity_id.
  Actions: `on off toggle open close lock unlock play pause stop`, or `set brightness=40 kelvin=2700
  temperature=21 mode=heat volume=30 position=50 value=3 speed=50`. `do` prints the new state: confirm from that.
- `find <text>` when unsure what a name refers to. If it is not registered, `find` lists matching HA entities.
- Groups can hold devices, other groups and areas: "släck uppe" = `do uppe off` when `uppe` aliases a group.
- `call <domain.service> <entity_id> '{json}'` for anything the actions don't cover, `raw <entity_id>` for the
  full state. Both are escape hatches, not the normal path.

## Rules

`rules` lists the house rules. **Read them before acting or answering about the house** (they say things like
what must be checked before claiming a door is locked). The owner adds rules by asking: `rules add <text>`.

## Keeping the registry good

- When someone uses a name that doesn't resolve, find the entity (`find`, `unmapped <area>`), do what they asked
  if it is clear, then register it: `add <entity_id> <name> --area=<area> --alias=a,b` or `alias <name> = x, y`.
  Ask when two devices could match; don't guess on things like locks or heating.
- Names are what people say, in the household's language ("the kitchen ceiling light", not "light.zwave_node12_level").
  Imported devices keep HA's friendly names; `rename <name> -> <new name>` when a better one comes up.
- `group <name> = member, member` for things people control together; `alias <group> = ...` for how they say it.
- `unmapped [domain|area] [--all]` shows what isn't registered yet (controllable domains by default; filter by an
  area or domain like `sensor` to see sensors). `import` seeds the registry from HA areas (first-time setup).
