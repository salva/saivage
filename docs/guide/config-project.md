# Project Configuration

Each target project has a `.saivage/config.json`. This is the contract
between the human and the agent system: objectives, model preferences,
notification rules, and routing overrides.

The schema is the `ProjectConfigSchema` Zod type from [`src/types.ts`](https://github.com/salva/saivage/blob/main/src/types.ts).

## Minimal example

```json
{
  "project_name": "myproject",
  "objectives": [
    "Build a REST API with /users and /sessions endpoints.",
    "Use Vitest for tests, target >80% coverage."
  ],
  "notifications": {
    "channels": ["web"],
    "filters": { "min_severity": "warning", "categories": [] }
  },
  "skills": { "max_per_agent": 5 }
}
```

## Full schema

```jsonc
{
  // human-readable identifier
  "project_name": "myproject",

  // free-form objective list, ordered roughly by priority
  "objectives": [ "…" ],

  // default provider/model when no role override applies
  "provider": "github-copilot/claude-sonnet-4",

  // per-role provider/model overrides (override runtime config too)
  "model_overrides": {
    "planner": "anthropic/claude-sonnet-4-20250514",
    "manager": "github-copilot/claude-sonnet-4",
    "coder":   "github-copilot/gpt-4o-mini",
    "researcher": "github-copilot/gpt-4o-mini",
    "inspector": "anthropic/claude-sonnet-4-20250514",
    "chat":    "github-copilot/gpt-4o-mini"
  },

  // structured routing — see /guide/routing
  "routing": {
    "roles": {},
    "profiles": {}
  },

  // which channels publish notifications + minimum severity
  "notifications": {
    "channels": ["web", "telegram"],
    "filters": {
      "min_severity": "warning",
      "categories": [
        "stage_completed",
        "stage_failed",
        "escalation",
        "task_failed",
        "inspector_complete",
        "plan_updated"
      ]
    }
  },

  // skill auto-attachment limits
  "skills": { "max_per_agent": 5 },

  // per-agent runtime knobs (advanced)
  "agents": {
    "planner": { "compaction_threshold_pct": 80, "max_compactions": 3 },
    "manager": { "compaction_threshold_pct": 80, "max_compactions": 3 }
  }
}
```

## Field reference

| Field | Type | Description |
|-------|------|-------------|
| `project_name` | string | Identifier shown in UIs. |
| `objectives` | string[] | What you want done. Specific is better. |
| `provider` | string? | Default `provider/model` for any role. |
| `model_overrides` | record? | Role → `provider/model`. Overrides everything. |
| `routing` | object? | Structured router config. See [Routing](./routing). |
| `notifications.channels` | enum[] | `"web"`, `"telegram"`. |
| `notifications.filters.min_severity` | enum | `"info"`, `"warning"`, `"error"`. |
| `notifications.filters.categories` | enum[] | Which event types to publish. Empty = all. |
| `skills.max_per_agent` | number | Cap on auto-attached skills per agent run. |
| `agents.<role>.compaction_threshold_pct` | number | % of context window before compaction kicks in (default 80). |
| `agents.<role>.max_compactions` | number | After this many compactions the agent fails (default 3). |

## Where the file lives

The runtime resolves the project root via `discoverProject(startDir)` —
walking up from the launch directory until it finds a `.saivage/config.json`.
You can also pass an explicit project path to the CLI (`saivage serve
/path/to/proj`).

The full set of resolved paths is exposed on `ProjectContext.paths`. See
[On-disk layout](/internals/on-disk-layout) for the directory tree.

## Initializing programmatically

```ts
import { initProject } from "saivage";

await initProject("/path/to/project", {
  project_name: "myproject",
  objectives: ["…"],
  notifications: { channels: ["web"], filters: { min_severity: "info", categories: [] } },
  skills: { max_per_agent: 5 },
});
```

`initProject` creates the `.saivage/` directory structure and the
`config.json` file.
