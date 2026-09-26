# Architecture

## Parts

**Workspace** (`workspace/`, the owner's own git repo). The folder the Claude Code session runs in. It
holds everything personal: `CLAUDE.md` (persona, household), `config/` (users, jobs, devices),
personal skills, notes, runtime state and secrets. See [workspace.md](workspace.md).

**Claude Code session.** A normal interactive `claude` in the workspace, started with
`--remote-control` (reachable from claude.ai and the mobile app) and `--channels` (receives events).
It answers people through channel tools and acts through skills. One session serves every channel;
events that arrive while it is busy are queued and handled after the current turn.

**Daemon** (`src/`, `bun src/main.ts`, port 8090). Connects the outside world to the session:

- listens where the world talks (WebSocket for speakers, webhooks, Discord gateway, timers),
- turns what arrives into channel events for the session,
- carries out the channel tools the session calls (speak, reply, send_email, add_job, ...).

It runs independently of the session. Claude Code connects to it as an MCP client over HTTP, one MCP
server per channel at `/mcp/<channel>`. Either side can restart: the session reconnects to a
restarted daemon by itself; the daemon keeps working (and says so on voice) while no session is
connected.

**Plugins** (`plugins/`, marketplace in `.claude-plugin/marketplace.json`). Each channel is a plugin
that only contains the URL of its MCP endpoint (`${GATEWAY_URL:-http://127.0.0.1:8090}/mcp/<name>`), so a
session opts into channels one by one with `--channels plugin:<name>@session-gateway`. The `home` plugin
ships the generic Home skill.

**Hooks** (`hooks/`, wired in the workspace's `.claude/settings.json`).
- `SessionStart` (startup, after `/clear`): starts the daemon if none answers, then prints
  `prompts/gateway.md`, which Claude Code adds to the context. The gateway's own instructions therefore
  never live in the owner's `CLAUDE.md`.
- `SessionEnd`: starts `scripts/summarize-session.ts` detached; it summarizes the finished transcript
  with `claude -p --model haiku` into `notes/YYYY-MM-DD.md`.

## A message's path

1. A speaker streams audio to `ws://gateway:8090/voice`; the voice channel transcribes it.
2. The daemon pushes `notifications/claude/channel` on the voice MCP session. Claude Code shows it in the
   session as `<channel source="plugin:voice:voice" device="kitchen" time="..." id="...">text</channel>`.
3. The session works on it (skills, other tools) and calls the voice `speak` tool.
4. The daemon streams TTS audio back to that speaker.

Every channel follows the same shape: inbound event with routing attributes (`device`, `chat_id`,
`from`, `job`), outbound through that channel's tool. Plain text output of the session is only seen
in the terminal and Remote Control.

## Code layout

```
src/main.ts                  loads the workspace .env, starts the enabled channels (GATEWAY_CHANNELS)
src/core/channel.ts          the Channel interface and the Gateway services channels get
src/core/mcp.ts              one MCP endpoint per channel: sessions, tools, push (adds time=...)
src/core/server.ts           HTTP + WebSocket routing, /health, /api/channels
src/core/users.ts            config/users.json: channel identities -> people
src/channels/<name>/         one folder per channel (voice, jobs, discord, email)
plugins/<name>/              plugin manifests (channels: URL only; home: skill)
hooks/                       SessionStart / SessionEnd scripts
prompts/gateway.md           base prompt injected at session start
scripts/summarize-session.ts transcript -> daily notes
deploy/                      Docker entrypoint, compose example, managed settings (allowlist)
workspace.example/           template for a new workspace
tests/fake-device.ts         fake ESP32 speaker for testing voice
```

A channel is an object with `name`, `instructions` (delivered to the session when it connects),
`tools`, `routes`, `sockets`, `status()` and `start()/stop()`. Channels can offer actions to each
other through `gw.actions` (voice registers `say`, which job steps use). Adding a channel means one
folder under `src/channels/`, one line in `src/main.ts`, one plugin folder and one allowlist entry.

## Claude Code behaviour this relies on

Verified with Claude Code 2.1.281-282.

- Channels are a research preview. Custom channel plugins need `--dangerously-load-development-channels`
  (a confirmation dialog at every start, and they do not register at all in `-p` mode) unless the
  plugin is on `allowedChannelPlugins` in a managed-settings file, which also works on personal
  Pro/Max accounts.
- `--channels` opts in per plugin: every MCP server in the plugin becomes a channel.
- HTTP-transport MCP servers work as channels. A session reconnects by itself when the daemon restarts
  quickly (seconds), but gives up after a longer outage (observed at ~15 min): then reconnect from `/mcp`
  in the session or restart it. The Docker entrypoint restarts the daemon within seconds for this reason.
- Events that arrive during a turn are queued and delivered after it; Remote Control shows them like
  any other message.
- `SessionStart` hooks run before MCP servers connect, so a hook can start the daemon.
- `SessionEnd` hooks block for at most 60 s, hence the detached summarizer.
- A session that exits never closes its MCP sessions; the daemon keeps only the newest session per
  channel.
