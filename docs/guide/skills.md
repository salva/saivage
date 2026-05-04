# Skills

A **skill** is a Markdown document containing reusable advice or
constraints, attached to one or more agent roles. Skills are discovered at
runtime and injected into an agent's system prompt when the skill's triggers
match the current task.

## Skill source paths

Skills are loaded from two locations (later entries override earlier ones):

1. **Built-in**: `<saivage>/skills/` — ships with the daemon
   (`coding/`, `planning/`, `research/`, `mcp-authoring/`).
2. **Project**: `<project>/.saivage/skills/` — committed alongside the
   project; created by the agents themselves over time.

Each directory has an `index.json`:

```json
{
  "skills": [
    {
      "id": "ts-strict-mode",
      "name": "TypeScript strict mode",
      "file": "ts-strict-mode.md",
      "target_agents": ["coder", "reviewer"],
      "triggers": {
        "tags": ["typescript", "ts"],
        "keywords": ["tsconfig", "strict", "noImplicitAny"],
        "tools": []
      },
      "updated_at": "2025-08-15T10:00:00Z"
    }
  ]
}
```

## Trigger matching

The loader (`src/skills/loader.ts`) scores each skill against the task
context:

- `tags`: stage or task tags vs. skill `triggers.tags`.
- `keywords`: case-insensitive match in the task description.
- `tools`: tools available to the agent vs. skill `triggers.tools`.

The top-N skills (default 5, capped by `ProjectConfig.skills.max_per_agent`)
are concatenated into the system prompt as labelled blocks:

```
--- SKILL: TypeScript strict mode ---
<contents of ts-strict-mode.md>
---
```

## Authoring skills

A skill file is plain Markdown. Keep it tightly focused on a single concern
and reusable across tasks. The file should be **short** — agents pay context
tokens for every byte.

```md
# TypeScript strict mode

When working in this project always:

- Add `"strict": true` and `"noUncheckedIndexedAccess": true` to tsconfig.
- Prefer `import type` for type-only imports.
- Use Zod for runtime parsing of external JSON.
```

After authoring, register it in `index.json` (or let the Manager schedule a
**skill-creation task** for the workers — see the built-in
`skill-creation.md` skill).

## Self-extension

Skills are how Saivage *self-extends*. A typical lifecycle:

1. The Manager notices a worker repeatedly making the same kind of mistake
   or following a non-obvious convention.
2. The Manager schedules a `code` task: *"Promote this convention into a
   skill"*.
3. The Coder writes the Markdown file under `.saivage/skills/<id>/` and
   patches `index.json`.
4. The skill is auto-attached to future tasks matching the triggers.

## Inspecting which skills are attached

Each agent invocation logs the resolved skill list. The web UI surfaces
this under the agent's conversation panel.
