# The workspace

The workspace is where the Claude Code session runs and everything personal lives. Keep it in its own
(private) git repository: the product repo ignores `workspace/`, so product updates never touch your
data, and your data never ends up in the product. Start from `workspace.example/`.

```
workspace/
├── CLAUDE.md               persona, household, your rules; the assistant edits it when asked to remember
├── .claude/
│   ├── settings.json       enabled plugins, permissions, hooks (point to ../hooks)
│   └── skills/             your own skills
├── config/                 users.json, jobs.json, home.json, voice-devices.json      (committed)
├── notes/                  notes; daily/YYYY/MM/DD.md written from the transcript     (committed)
├── state/                  runtime state of scripts, gateway.log                    (ignored)
├── inbox/                  files that arrived on channels                           (ignored)
└── .env                    secrets and settings                                     (ignored)
```

## Prompts

- `prompts/gateway.md` (product) explains the gateway to the session: channels, tools, trust, notes. The
  SessionStart hook injects it at startup and after `/clear`.
- `CLAUDE.md` (yours) is only about you: who the assistant is, the household, how to talk, how to react to
  events. Nothing in it needs to change when the product is updated.
- Each channel adds its own instructions when the session connects to it.

## Memory

The session is meant to be cleared regularly rather than compacted: long contexts are slow and costly
when most of every turn is uncached. When a session ends (exit or `/clear`), the SessionEnd hook
summarizes its transcript into `notes/daily/YYYY/MM/DD.md`. The session reads notes when it needs to recall
earlier days; lasting facts belong in `CLAUDE.md` or `config/`.

## Skills

Skills are how the session acts: a `SKILL.md` and scripts it runs. Prefer skills with small CLIs over
MCP servers: only the description sits in context until a skill is used, and the same scripts can be
called from job steps. A `package.json` in a skill folder is installed at container start.

- **Home** (plugin `home@switchboard`): Home Assistant through a curated registry in
  `config/home.json`: devices with spoken names and aliases, groups (of devices, groups or areas), and
  house rules. `bun <skill>/home.ts state|do|find|unmapped|import|add|rename|alias|group|rules`, one line per
  device. `import` seeds the registry from Home Assistant areas; the session keeps it tidy as people use
  names. Needs `HA_URL` and `HA_TOKEN`.
- Your own skills go in `.claude/skills/<Name>/`, for example wrappers around your own services. Use
  `allowed-tools: Bash(bun ${CLAUDE_SKILL_DIR}/tool.ts *)` in the frontmatter so they run without
  permission prompts, and read settings from the workspace `.env`.

To save the first-use lookup on voice, let `CLAUDE.md` tell the session to read the skills it needs most
at session start.

External MCP servers (a knowledge graph, say) are configured as usual, in `.mcp.json` in the workspace
or in the user's Claude Code config.

## Settings (.env)

The daemon and the skills read the workspace `.env`; process environment wins.

| Variable | |
|---|---|
| `GATEWAY_PORT`, `GATEWAY_HOST` | Daemon listen address (8090, 0.0.0.0) |
| `GATEWAY_TOKEN` | Bearer token for `/mcp/*` |
| `GATEWAY_URL` | Where the plugins find the daemon (http://127.0.0.1:8090); when set, the start hook doesn't launch one |
| `GATEWAY_CHANNELS` | Channels the daemon runs (all) |
| `GATEWAY_BASH` | Bash for job steps |
| `ELEVENLABS_*`, `VOICE_*` | Voice, see [channels.md](channels.md#voice) |
| `DISCORD_*` | Discord |
| `RESEND_*`, `EMAIL_*` | Email |
| `HA_URL`, `HA_TOKEN` | Home skill |
| `TZ` | Time zone for event times and cron |

## Backups and self-maintenance

Because the workspace is a git repo, the assistant can commit its own changes (to `CLAUDE.md`, the home
registry, jobs) and a job can push daily (see [jobs.md](jobs.md#examples)). In the container, give it
credentials in the mounted home: an SSH deploy key in `~/.ssh` or a token in the remote URL.
