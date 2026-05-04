# Quickstart

The fastest way to try Saivage on your local machine, **without** the LXC
sandbox. Use this for development and experimentation only — running fully
autonomous agents directly on your host gives them shell access to your home
directory.

For a sandboxed deployment, jump to [LXC Container Deployment](./install-lxc).

## Prerequisites

- **Node.js ≥ 20** (24 recommended).
- **Git** (the agents use it for commits).
- An API key or OAuth account for at least one LLM provider — GitHub Copilot
  is the default and uses a device-code flow that requires no key in advance.

## 1. Build Saivage

```bash
git clone https://github.com/salva/saivage.git
cd saivage
npm ci
npm run build
```

The build produces `dist/cli.js` (server bundle, via tsup) and the static web
UI under `web/dist/`.

## 2. Authenticate with a provider

```bash
node dist/cli.js login        # interactive picker
# or specify a provider:
node dist/cli.js login github-copilot
node dist/cli.js login openai-codex
```

Tokens are saved under `<project>/.saivage/auth-profiles.json` (or
`~/.saivage/` if no project is in scope at login time).

See [LLM Providers & Auth](./providers) for details on each flow.

## 3. Initialize a target project

Pick (or create) a directory you want the agent to work on. **Do not point
Saivage at its own source tree.**

```bash
mkdir -p ~/playground
cd ~/playground
git init
node ~/saivage/dist/cli.js init . \
  --name "playground" \
  --objectives "Create a simple Node CLI that prints the current weather"
```

This produces `.saivage/config.json` and the runtime directory layout. Open
the file and refine the objectives — the more specific, the better.

## 4. Start the autonomous loop

There are two ways to run Saivage:

### One-shot CLI

Runs the Planner until plan completion, then exits.

```bash
node ~/saivage/dist/cli.js start ~/playground
```

### Long-running server (recommended)

Exposes the web UI on `:8080`, supports Telegram, accepts WebSocket clients.

```bash
node ~/saivage/dist/cli.js serve ~/playground
```

Open <http://localhost:8080> in a browser.

## 5. Watch and steer

- **Web dashboard**: see the plan, current stage, task list, agent
  conversations, and live event stream.
- **CLI status**: `node ~/saivage/dist/cli.js status ~/playground`.
- **Send a note**: `node ~/saivage/dist/cli.js note ~/playground "Use Vitest, not Jest"`.
- **Urgent abort & replan**: add `--urgent` to the `note` command.

For a complete operational reference see the [CLI](./cli) and
[Web Dashboard](./web-ui) pages.
