# session-gateway: notes for agents working on this repo

This repo is the product: a daemon that connects voice, Discord, email and jobs to a regular Claude Code
session through channels. Read [docs/architecture.md](docs/architecture.md) first; the other docs cover
each part. This file is for working on the code, not for running the assistant (that session's
instructions are `prompts/gateway.md` plus the owner's `workspace/CLAUDE.md`).

## Rules

- **Nothing personal in this repo.** Household data, credentials, the owner's jobs, skills for their own
  services: all of that belongs in the workspace, which is a separate repo (`workspace/` is ignored here).
  Examples go in `workspace.example/`.
- **Vanilla Claude Code first.** The daemon's MCP endpoints exist only to carry channels. Things the
  session does (house control, services) are skills with small CLIs, not MCP tools.
- **Channels are self-contained folders** under `src/channels/<name>/`: the channel object in
  `index.ts`, helpers beside it. Shared plumbing is in `src/core/` and stays small.
- Keep docs in `docs/` current with behaviour changes; they are written for people and agents alike and
  describe how things work, not how they changed.
- Code style: TypeScript on Bun, 2-space indent, single quotes, no semicolons, comments only where the
  why isn't obvious.

## Working on it

```sh
bun install
bunx tsc --noEmit -p .          # typecheck (strict, noUncheckedIndexedAccess)
bun start                       # daemon on :8090, uses ./workspace (GATEWAY_WORKSPACE to override)
curl localhost:8090/api/channels
```

Testing:
- Voice without hardware: `bun tests/fake-device.ts "Vad är klockan?"` streams generated speech into
  `/voice` and saves replies to `replies/`. Needs `ELEVENLABS_API_KEY`.
- A connected session: start `claude` in the workspace with the channels (see the README), then use
  `POST /voice/ask`, `POST /api/jobs/<id>/run`, or the fake device. `GET /health` shows which channels
  have a session.
- Restarting the daemon is safe while a session runs if it's back within seconds: the session reconnects
  within ~20 s. After a long outage it doesn't; reconnect from `/mcp` or restart the session.

Adding a channel: folder in `src/channels/`, register it in `src/main.ts`, plugin folder in `plugins/`
(copy an existing `.mcp.json`), entry in `.claude-plugin/marketplace.json`, entry in
`deploy/managed-settings.json`, enable it in `workspace.example/.claude/settings.json`, document it in
`docs/channels.md`.

Docker: `docker build -t session-gateway .`; see [docs/deploy.md](docs/deploy.md).
