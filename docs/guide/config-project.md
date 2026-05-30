# Project Configuration

Each target project has a `.saivage/config.json`. This is the contract
between the human and the agent system: objectives, model preferences,
routing overrides, skill limits, and per-agent compaction knobs.

The schema is the `ProjectConfigSchema` Zod type from [`src/types.ts`](https://github.com/salva/saivage/blob/main/src/types.ts).

## Minimal example

```json
{
  "project_name": "myproject",
  "objectives": [
    "Build a REST API with /users and /sessions endpoints.",
    "Use Vitest for tests, target >80% coverage."
  ],
  "routing": { "roles": {}, "profiles": {} },
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

  // structured routing — see /guide/routing
  "routing": {
    "roles": {},
    "profiles": {}
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
| `routing` | object? | Structured router config. See [Routing](./routing). |
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
import { seedProject } from "saivage";

await seedProject("/path/to/project", {
  name: "myproject",
  objectives: ["…"],
});
```

`seedProject` creates the `.saivage/` directory structure plus both
`config.json` and `saivage.json`.
