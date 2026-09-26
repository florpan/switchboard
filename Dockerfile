FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates tmux tzdata openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI, native binary from its per-platform npm package. Bump to upgrade.
ARG CLAUDE_CODE_VERSION=2.1.282
RUN mkdir -p /opt/claude \
    && curl -fsSL "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-${CLAUDE_CODE_VERSION}.tgz" \
       | tar xz -C /opt/claude --strip-components=1 package/claude \
    && chmod a+rx /opt/claude/claude \
    && ln -sf /opt/claude/claude /usr/local/bin/claude \
    && claude --version

# Our channel plugins replace Anthropic's channel allowlist: --channels works without the dev-channel dialog.
COPY deploy/managed-settings.json /etc/claude-code/managed-settings.json

RUN useradd -m -s /bin/bash gateway

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY .claude-plugin ./.claude-plugin
COPY plugins ./plugins
COPY src ./src
COPY hooks ./hooks
COPY prompts ./prompts
COPY scripts ./scripts
COPY workspace.example ./workspace.example
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
RUN chmod +x deploy/entrypoint.sh && mkdir -p workspace && chown -R gateway:gateway /app

USER gateway
ENV GATEWAY_WORKSPACE=/app/workspace

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://127.0.0.1:8090/health || exit 1
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
