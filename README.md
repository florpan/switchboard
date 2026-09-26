# session-gateway

Turn a regular Claude Code session into an always-on assistant that people reach by voice, Discord, email
and scheduled jobs, and that you can still pick up from your phone with Remote Control.

There is no custom agent loop. The session is plain `claude`, running in a folder you own (the
*workspace*). A small daemon connects the outside world to it through Claude Code
[channels](https://code.claude.com/docs/en/channels-reference): MCP servers that push events into a
running session. Everything else is standard Claude Code: skills, hooks, `CLAUDE.md`, MCP servers.

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
git clone <this repo> session-gateway && cd session-gateway
bun install
cp -r workspace.example workspace && cd workspace && git init   # your workspace: its own repo
cp .env.example .env                                            # keys for the channels you use
claude plugin marketplace add ..                                # the plugins live in this repo

claude --remote-control "gateway" --dangerously-load-development-channels \
  plugin:voice@session-gateway plugin:jobs@session-gateway plugin:discord@session-gateway plugin:email@session-gateway
```

Confirm the development-channels dialog. The session's start hook launches the daemon and adds the
gateway instructions to the context. Leave out channels you don't use. To skip the dialog, allowlist
the plugins once: see [docs/deploy.md](docs/deploy.md#allowlisting-the-channel-plugins).

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
| [CLAUDE.md](CLAUDE.md) | For agents working on this repo |
