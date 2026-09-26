# Deploying

## Locally

See the quick start in the [README](../README.md). The workspace's SessionStart hook starts the daemon
(log in `workspace/state/gateway.log`) unless one already answers on `GATEWAY_URL`. You can also run it
yourself with `bun start` from the repo root.

## Allowlisting the channel plugins

Channels are a Claude Code research preview. `--channels` only accepts plugins on an allowlist, which
by default holds Anthropic's own channel plugins; other plugins need
`--dangerously-load-development-channels`, which asks for confirmation at every start. A managed
settings file replaces that allowlist:

```json
{ "channelsEnabled": true,
  "allowedChannelPlugins": [ { "marketplace": "switchboard", "plugin": "voice" }, ... ] }
```

`deploy/managed-settings.json` lists all channel plugins. Copy it (admin rights) to:

| | |
|---|---|
| Linux / WSL | `/etc/claude-code/managed-settings.json` |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` |

Then start with `--channels plugin:voice@switchboard ...` and no dialog appears. The file applies to
every Claude Code session on the machine, but only decides which channel plugins may register. If you
also use Anthropic's channel plugins (Telegram, Discord), add them to the list.

## Docker

The image contains the product, Bun, Claude Code, tmux and the managed settings. It needs two mounts:

| Mount | |
|---|---|
| `/app/workspace` | Your workspace repo |
| `/home/gateway` | Claude Code's home: login, `.claude.json`, user settings; git/ssh credentials for backups |

```sh
docker build -t switchboard .
docker compose -f deploy/docker-compose.yml up -d     # adjust image and paths first
```

The entrypoint:
1. registers the image's plugin marketplace and installs the plugins the workspace enables,
2. installs dependencies of workspace skills that have a `package.json`,
3. runs the daemon (restarted if it exits; logs to `docker logs` and `state/gateway.log`),
4. runs `claude --remote-control <GATEWAY_NAME> --channels ... $CLAUDE_ARGS` in tmux session `gateway`,
   restarted if it exits.

Container settings: `GATEWAY_CHANNELS` (voice,jobs,discord,email), `GATEWAY_NAME` (Remote Control session
name, gateway), `CLAUDE_ARGS` (extra flags, e.g. `--dangerously-skip-permissions` so an unattended session
never waits on a prompt; the container is the sandbox), `TZ`. Everything else goes in the workspace `.env`.

### First start

Claude Code needs a claude.ai login (Remote Control does not work with API keys or `setup-token`
tokens). Either mount a home that already has one, or log in once:

```sh
docker exec -it gateway tmux attach -t gateway    # /login, accept the folder-trust and permission
                                                  # dialogs; detach with Ctrl-b d
```

The answers are stored in the mounted home, so this is one-time. Folder trust is saved per path, so it
is asked again only if the workspace mount point changes. Until the dialogs are answered no channel
connects; the entrypoint then prints the waiting screen to `docker logs` after three minutes. The same
attach shows what the session is doing at any time; Remote Control shows it too.

### Updating

Build and deploy a new image; the workspace and home are untouched. The session reconnects to the daemon
by itself, and a restarted container starts both again. Bump `CLAUDE_CODE_VERSION` in the Dockerfile to
update Claude Code.
