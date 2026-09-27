# switchboard

A minimal, do-it-yourself personal assistant built on Claude Code. It connects voice speakers, Discord,
email and scheduled jobs to one long-running Claude Code session, which you can also use directly from
your phone with Remote Control.

It is meant as a small base to build on, in the same space as OpenClaw or Hermes but with far less of
its own: no agent framework, no custom agent loop. The session is plain `claude`, running in a folder you
own (the *workspace*), and uses only standard Claude Code features: [channels](https://code.claude.com/docs/en/channels-reference)
to receive messages, skills and MCP servers to act, hooks and `CLAUDE.md` for behaviour. A small daemon
(a few hundred lines per channel) does the plumbing, so you can read what runs and change it.

What you get:

- **Channels**: voice (ESP32 speakers, ElevenLabs speech), Discord, email (Resend), and jobs (cron, one-off
  and webhook triggers with shell steps that decide whether the model is needed at all).
- **Firmware for the speakers** in [firmware/](firmware/README.md): a ready-made Waveshare smart speaker or
  an Espressif Korvo-1 board. Optional; the other channels don't need them.
- **A workspace that is yours**: persona, people, jobs, skills and notes live in your own git repo, apart
  from this code. The session keeps daily notes and can maintain its own configuration.
- **A Home Assistant skill** that puts named devices, groups and house rules in front of HA.
- **A Docker image** that runs the daemon and the session with two mounts.

```
ESP32 speakers ──ws /voice───────┐
Home Assistant ──POST /api/jobs──┤   daemon (bun, :8090)             Claude Code session
Discord bot ─────────────────────┤     voice    ── /mcp/voice ───┐   in your workspace
Resend (email) ──POST /email/────┤     jobs     ── /mcp/jobs ────┤   (--remote-control,
cron / at ───────────────────────┘     discord  ── /mcp/discord ─┤    --channels ...)
                                       email    ── /mcp/email ───┘
```

## Quick start

Requirements: [Bun](https://bun.sh), Claude Code signed in with a claude.ai account (Remote Control does
not work with API keys).

```sh
git clone <this repo> switchboard && cd switchboard
bun install
cp -r workspace.example workspace && cd workspace && git init   # your workspace: its own repo
cp .env.example .env                                            # keys for the channels you use
claude plugin marketplace add ..                                # the plugins live in this repo

claude --remote-control "gateway" --dangerously-load-development-channels \
  plugin:voice@switchboard plugin:jobs@switchboard plugin:discord@switchboard plugin:email@switchboard
```

Confirm the development-channels dialog. The session's start hook launches the daemon and adds the
gateway instructions to the context. Leave out channels you don't use.

### Without the development-channels dialog

Claude Code only accepts channel plugins from an allowlist, which by default holds Anthropic's own; that is
why the quick start uses `--dangerously-load-development-channels` and gets a confirmation dialog at every
start. Allowlist this repo's plugins once and use `--channels` instead:

```sh
# as admin; Linux/WSL path shown, macOS/Windows paths in docs/deploy.md
cp deploy/managed-settings.json /etc/claude-code/managed-settings.json

cd workspace
claude --remote-control "gateway" --channels \
  plugin:voice@switchboard plugin:jobs@switchboard plugin:discord@switchboard plugin:email@switchboard
```

The Docker image has this built in. Details: [docs/deploy.md](docs/deploy.md#allowlisting-the-channel-plugins).

Then: say something to a speaker, message the Discord bot, or `curl -X POST localhost:8090/voice/ask
-H 'content-type: application/json' -d '{"text":"what time is it?"}'`.

## Documentation

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How it fits together: daemon, channels, plugins, session, hooks |
| [docs/channels.md](docs/channels.md) | Voice, Discord, email: protocols, tools, settings, HTTP API |
| [docs/jobs.md](docs/jobs.md) | Jobs: triggers (cron, at, webhook) and steps (bash, pwsh, prompt, say) |
| [docs/workspace.md](docs/workspace.md) | Your workspace: CLAUDE.md, config, skills, notes, secrets, backups |
| [docs/deploy.md](docs/deploy.md) | Running locally, allowlisting, the Docker image |
| [firmware/README.md](firmware/README.md) | Voice speakers: supported boards, where to buy, building and flashing |
| [CLAUDE.md](CLAUDE.md) | For agents working on this repo |

## License

MIT
