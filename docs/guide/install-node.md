# Standalone Installation (Node.js)

This guide installs Saivage directly on a host without sandboxing.

::: warning Sandbox recommendation
Saivage's worker agents have shell access to whatever directory the daemon is
launched in. For anything beyond experimentation, use the
[LXC deployment](./install-lxc) instead. Running Saivage directly on your
laptop means you trust the agents and the upstream model with shell on your
home directory.
:::

## Prerequisites

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| Node.js     | 24.x    | Install via nvm or NodeSource |
| Git         | 2.34+   | Used by the git MCP service for commits |
| OS          | Linux / macOS | Windows is untested |
| RAM         | 2 GB free | LLM streaming is non-trivial when many agents run |
| Disk        | 1 GB    | Source tree, dist, node_modules, and runtime tmp |

Optional:

- **Anthropic / OpenAI / OpenRouter API keys** if you want to skip OAuth
  flows.
- **Ollama** or **llama.cpp** for local inference.
- A spare LAN IP if you intend to expose the web UI.

## Build from source

```bash
git clone https://github.com/salva/saivage.git
cd saivage
npm ci
npm run build
```

`npm run build` runs:

- `npm --prefix web run build` — builds the static web UI into `web/dist/`.
- `tsup` — bundles `src/server/cli.ts` to `dist/cli.js` along with type
  declarations.

For development with live reload use `npm run dev`, which runs `tsx
src/server/cli.ts` and rebuilds the web UI on demand.

## Install as a global binary

The `package.json` declares a `bin` entry. After `npm run build`:

```bash
npm link    # exposes `saivage` on PATH
saivage --help
```

Alternatively, run the bundled file directly with `node dist/cli.js`.

## Set up the runtime config (optional)

A project-local `.saivage/saivage.json` (created by `saivage init`) lets you
configure providers, model overrides, ports, and MCP server registrations. For
a shared daemon config, set `SAIVAGE_ROOT` and place `saivage.json` there:

```jsonc
{
  "server": { "port": 8080, "host": "0.0.0.0" },
  "models": {
    "orchestrator": "github-copilot/claude-sonnet-4",
    "coder":   "github-copilot/gpt-4o-mini",
    "researcher": "github-copilot/gpt-4o-mini",
    "default": "github-copilot/gpt-4o-mini",
    "chat":    "github-copilot/gpt-4o-mini"
  },
  "failover": {
    "github-copilot": ["openai-codex", "anthropic"]
  }
}
```

The schema and defaults are documented in [Runtime Configuration](./config-runtime).

## Run as a systemd service (optional)

```ini
# /etc/systemd/system/saivage.service
[Unit]
Description=Saivage AI Agent Server
After=network.target

[Service]
Type=simple
User=youruser
Group=youruser
WorkingDirectory=/home/youruser/saivage
ExecStart=/usr/bin/node dist/cli.js serve /home/youruser/myproject
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now saivage
journalctl -u saivage -f
```

## Verify

```bash
curl -fsS http://127.0.0.1:8080/api/config
saivage status /path/to/project
```

If both succeed, continue with [Project Configuration](./config-project) and
the [Web Dashboard](./web-ui).
