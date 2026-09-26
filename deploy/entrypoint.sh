#!/usr/bin/env bash
# Container start: daemon (restarted if it exits) + Claude Code in tmux session "gateway".
#   docker exec -it <container> tmux attach -t gateway     # watch or type; detach with Ctrl-b d
set -uo pipefail

WS="${GATEWAY_WORKSPACE:-/app/workspace}"
CHANNELS="${GATEWAY_CHANNELS:-voice,jobs,discord,email}"
NAME="${GATEWAY_NAME:-gateway}"

if [ ! -f "$WS/.claude/settings.json" ]; then
  echo "No workspace at $WS: mount your workspace repo there (start from /app/workspace.example)." >&2
  exit 1
fi
mkdir -p "$WS/state" "$WS/inbox"
git config --global --add safe.directory "$WS"

# Plugins come from the image's marketplace. User scope, so the workspace repo isn't rewritten.
claude plugin marketplace add /app >/dev/null 2>&1 || claude plugin marketplace update switchboard >/dev/null 2>&1
for plugin in $(bun -e "
  const s = await Bun.file('$WS/.claude/settings.json').json();
  console.log(Object.keys(s.enabledPlugins ?? {}).filter(p => p.endsWith('@switchboard')).join(' '))"); do
  claude plugin install "$plugin" --scope user >/dev/null 2>&1 || true
done

# Workspace skills with their own dependencies (node_modules are not in the repo).
for pkg in "$WS"/.claude/skills/*/package.json; do
  [ -f "$pkg" ] && (cd "$(dirname "$pkg")" && bun install --silent)
done

# Daemon: logs to docker logs and state/gateway.log; restarted when it exits.
(
  while true; do
    bun /app/src/main.ts 2>&1 | tee -a "$WS/state/gateway.log"
    echo "daemon exited, restarting in 2s" | tee -a "$WS/state/gateway.log"
    sleep 2
  done
) &
DAEMON=$!
for _ in $(seq 60); do curl -fs http://127.0.0.1:8090/health >/dev/null && break; sleep 1; done

# Claude Code, interactive with Remote Control, restarted when it exits.
channel_args=""
for c in ${CHANNELS//,/ }; do channel_args+=" plugin:$c@switchboard"; done
tmux new-session -d -s gateway -x 220 -y 50 -c "$WS" \
  "while true; do claude --remote-control '$NAME' --channels$channel_args ${CLAUDE_ARGS:-}; echo 'claude exited, restarting in 5s'; sleep 5; done"
echo "claude started in tmux session 'gateway' (docker exec -it <container> tmux attach -t gateway)"

# First start (new home or workspace path): Claude Code waits on one-time dialogs (login, folder trust,
# permission mode) and no channel connects. Say so in the logs instead of failing silently.
(
  for _ in $(seq 90); do
    curl -fs http://127.0.0.1:8090/health | grep -q ':true' && exit 0
    sleep 2
  done
  echo "No Claude session connected after 3 min; it is probably waiting on a first-start dialog:"
  tmux capture-pane -pt gateway | grep -v '^\s*$' | tail -15
  echo "Answer it once: docker exec -it <container> tmux attach -t gateway   (detach: Ctrl-b d)"
) &

wait "$DAEMON"
