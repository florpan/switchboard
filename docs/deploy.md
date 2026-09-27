# Deploying

## Locally

See the quick start in the [README](../README.md). The workspace's SessionStart hook starts the daemon
(log in `workspace/state/gateway.log`) unless one already answers on `GATEWAY_URL`. You can also run it
yourself with `bun start` from the repo root.

On Windows, start `claude` from a normal (not elevated) terminal: an elevated session did not connect to
the channels in testing, without any error in `/mcp`.

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
never waits on a prompt; the container is the sandbox), `TZ`. Other settings can go in the compose
`environment` or in the workspace `.env`; the process environment wins over `.env`.

`/mcp/*` is protected by `GATEWAY_TOKEN`. Without one in the compose `environment`, the entrypoint makes a
random token at every start and hands it to both the daemon and the session. Set it yourself only if
something outside the container connects to `/mcp/*`, and then in the compose `environment`, not in `.env`:
the daemon reads `.env`, the session's plugins don't.

### Preparing the host

The container runs as uid **1001**, a user that normally doesn't exist on the host. Both mounted folders
must belong to it (ssh also refuses keys owned by someone else):

```sh
mkdir -p /srv/switchboard/home/.ssh
git clone <your workspace repo> /srv/switchboard/workspace     # or copy it there
sudo chown -R 1001:1001 /srv/switchboard
```

Because the uid is unknown on the host, `sudo -u 1001 ...` doesn't work there. Run git and other workspace
commands inside the container instead (`docker exec <container> git -C /app/workspace pull`), or as root
followed by `chown -R 1001:1001` again.

For backups the session pushes the workspace itself. Give it a key that can only reach that repo: create
an SSH key in `home/.ssh/`, add its public key as a deploy key with write access on the workspace repo, and
point `github.com` at it in `home/.ssh/config`:

```
Host github.com
  IdentityFile ~/.ssh/<key>
  IdentitiesOnly yes
```

plus `home/.ssh/known_hosts` (`ssh-keyscan github.com`) and a `[user]` name/email in `home/.gitconfig`.

### First start

Claude Code needs a claude.ai login: Remote Control does not work with API keys or `setup-token` tokens.
Start with an empty home and log in once, rather than copying a home that another running Claude Code
also uses (they would invalidate each other's refreshed tokens).

**Keep these out of the container environment:** `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` take
precedence over the login and can't start Remote Control, and `DISABLE_TELEMETRY`, `DO_NOT_TRACK`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` switch off the feature flags Remote Control depends on. The session
then runs, and channels work, but it never appears in the app. `GATEWAY_NAME` sets the name it appears under.

```sh
docker exec -it <container> tmux attach -t gateway
```

Then, in the session:
1. `/login` and follow the link.
2. Answer the one-time dialogs. **The default choice is "No" / "Exit", so use the arrow keys:**
   - folder trust for `/app/workspace` → "Yes, I trust this folder",
   - bypass permissions mode (with `--dangerously-skip-permissions`) → "Yes, I accept",
   - the full-screen renderer question → either.
3. Detach with **Ctrl-b d** (don't exit: claude keeps running in tmux).

Within seconds `docker logs` shows `session connected` for each channel and the session appears in
Remote Control. The answers are stored in the mounted home, so this happens once; folder trust is saved
per path and is asked again only if the workspace mount point changes. Until the dialogs are answered no
channel connects, and after three minutes the entrypoint prints the waiting screen to `docker logs`.

The same attach shows what the session is doing at any time; Remote Control shows it too.

### Updating

Build and deploy a new image; the workspace and home are untouched. The session reconnects to the daemon
by itself, and a restarted container starts both again. Bump `CLAUDE_CODE_VERSION` in the Dockerfile to
update Claude Code.

## Usage metrics and activity (OpenTelemetry)

Claude Code exports its own telemetry; switchboard adds nothing to it. Point it at an OpenTelemetry
Collector with environment variables in the compose `environment` (or the user settings' `env` for a
session on your own machine):

```yaml
- CLAUDE_CODE_ENABLE_TELEMETRY=1
- CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1        # traces: the only signal with agent/subagent ids
- OTEL_METRICS_EXPORTER=otlp
- OTEL_LOGS_EXPORTER=otlp
- OTEL_TRACES_EXPORTER=otlp
- OTEL_EXPORTER_OTLP_PROTOCOL=grpc
- OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4317
- OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=cumulative   # what Prometheus expects
- OTEL_LOG_USER_PROMPTS=1                      # prompt text in events and traces
- OTEL_LOG_TOOL_DETAILS=1                      # tool input: commands, file paths, subagent type
- OTEL_RESOURCE_ATTRIBUTES=host.name=<host>,deployment=switchboard
```

What arrives:

- **Metrics**: `claude_code_token_usage_tokens_total` (by `type`, `model`), `claude_code_cost_usage_USD_total`,
  `claude_code_session_count_total`, `claude_code_active_time_seconds_total`, plus lines/commits/PRs. Every
  resource attribute becomes a label, so `deployment` separates this session from others.
- **Events** (logs): `user_prompt`, `api_request`, `assistant_response`, `tool_decision`, `tool_result`,
  `subagent_completed`, `hook_execution_*`, `mcp_server_connection`, each with `session_id`.
- **Traces**: one `claude_code.interaction` per turn, with `claude_code.llm_request` (model, tokens, time to
  first token) and `claude_code.tool` spans (tool name, command, file path, time blocked on permission). Spans
  made by a subagent carry its `agent_id`, and `query_source_safe` names its type
  (`agent.builtin.Explore`); the main thread is `repl_main_thread`.

The two logging switches put prompts and commands in your telemetry store. That is the point for a personal
setup; leave them off where others' conversations shouldn't be stored.

A collector setup that works: OTLP receiver on 4317/4318; metrics through the `prometheus` exporter
(`resource_to_telemetry_conversion: enabled`) scraped by Prometheus; logs to Loki's native OTLP endpoint
(`http://loki:3100/otlp`, Loki 3 with schema v13); traces to Tempo over OTLP gRPC. Grafana reads all three.

[deploy/grafana/claude-code.json](../deploy/grafana/claude-code.json) is a ready dashboard (Grafana 12; import
it and pick the Loki, Prometheus and Tempo data sources): cost, prompts, sessions and tokens; cost by model and
by source (main thread, subagents, background requests); tool calls with MCP tools named `server.tool`;
subagents; the conversation (prompts and replies) and every tool call with its input; and the turns as traces.
Usage numbers come from the `api_request` events (exact per request), not from the metric counters, which are
split per session. Filter by `deployment` at the top.
