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
