# Command-Line Interface

The `saivage` binary (built to `dist/cli.js`) is the primary control plane
for the daemon. It is implemented with `commander` in
[`src/server/cli.ts`](https://github.com/salva/saivage/blob/main/src/server/cli.ts).

```bash
saivage --help
```

## Commands

### `init <project-path>`

Initialize a `.saivage/` directory and write a default `config.json`.

```bash
saivage init ./myproject \
  --name myproject \
  --objectives "Build a CLI" "Write tests"
```

| Flag | Description |
|------|-------------|
| `-n, --name <name>` | Project name (default `my-project`). |
| `-o, --objectives <list...>` | Initial objectives. |

### `start [project-path]`

Run the **autonomous loop** to completion in the foreground (no HTTP server).
Returns a non-zero exit code on failure or escalation.

```bash
saivage start ./myproject
```

If `[project-path]` is omitted, the project is discovered by walking up from
`cwd` for a `.saivage/config.json`.

### `serve [project-path]`

Run the **long-running server** with HTTP, WebSocket, optional Telegram bot,
and the supervisor loop. This is the production mode used by `systemd`.

```bash
saivage serve ./myproject
```

Default port `8080` (override in `saivage.json`'s `server` section).

### `status [project-path]`

Print the current plan, current stage, runtime status, and PID.

### `models [project-path]`

Print, per role, the resolved provider/model and the source of the decision
(routing vs runtime-default vs hardcoded-default).

### `note <project-path> <message…>`

Inject a user note for the Planner.

```bash
saivage note ./myproject "Use Vitest, not Jest" --permanent
saivage note ./myproject "Stop everything and refactor X" --urgent
```

| Flag | Effect |
|------|--------|
| `-p, --permanent` | Treat as a lasting objective tweak. |
| `-u, --urgent` | Abort the active agent chain and replan immediately. |

### `inspect <project-path> <scope>`

Dispatch the Inspector agent synchronously and print its report on stdout.

```bash
saivage inspect ./myproject "review test coverage"
```

### `request-shutdown <project-path>`

Record a structured shutdown reason. The next time the Planner starts, it
receives this reason as context — useful for graceful operator intervention.

| Flag | Description |
|------|-------------|
| `-r, --reason <reason>` | Reason string. |
| `--reason-stdin` | Read reason from stdin instead. |
| `--requested-by <name>` | Origin label. |

### `login [project-path]`

OAuth-login to a provider. With no provider, prompts interactively.

```bash
saivage login github-copilot
saivage login anthropic
saivage login openai-codex
```

### `logout [project-path]`

Remove a stored OAuth profile.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success / plan completed |
| 1 | Failure or escalation |

(Aborted plans return 0.)

## Programmatic equivalents

Most CLI actions have a typed entry-point exported from the
[`saivage`](/api/) package — useful for embedding the daemon into a larger
system or writing custom tools:

- `bootstrap(projectPath)` → `SaivageRuntime`
- `runPlanner(runtime)` → `{ kind: "success" | "failure" | "abort" | "escalation" }`
- `startServer(runtime, options)` → starts the HTTP/WebSocket server.

See the [API reference](/api/).
