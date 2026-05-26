# Skills

Skills are Markdown instructions that can be injected into agent prompts when
their triggers and role filters match the current context.

## Built-In Skills

Built-ins ship with Saivage under `skills/builtin/<topic>/SKILL.md` and are
bundled into `dist/skills/builtin/`. The current built-in set is `coding`,
`mcp-authoring`, and `research`. Planner-facing planning guidance lives in
`prompts/planner.md`, not in a built-in skill.

Each built-in file has strict YAML frontmatter:

```yaml
name: coding
description: Best practices for writing and modifying code
triggers: [agent:coder, keyword:implement]
target_agents: [coder]
survive_compaction: false
```

Allowed keys are `name`, `description`, `triggers`, `target_agents`, and
`survive_compaction`. Unknown keys fail loudly. `target_agents` is required; use
`target_agents: []` only when a built-in should be global.

## Project Skills

Project skills are authored through MCP tools such as `create_skill`,
`update_skill`, `supersede_skill`, `archive_skill`, and `delete_skill`. They are
stored under `.saivage/skills/{project,stages,sessions}/` as records plus body
files. Agents should not hand-edit those files or patch `index.json`.

Typical creation shape:

```ts
create_skill({
  name: "oauth-pattern",
  description: "How this project wires OAuth providers.",
  body: "Use the existing provider registry and profile store...",
  triggers: ["keyword:oauth", "tag:auth"],
  target_agents: ["coder"],
  scope: "project",
  survive_compaction: false,
  reason: "Repeated OAuth edits need one reusable convention."
})
```

## Matching

Skill triggers are flat `kind:value` strings. The eager loader scores:

- `keyword:<word>` against task or stage description tokens.
- `tag:<label>` against stage or task tags.
- `agent:<role>` against the current agent role.

Triggerless skills are valid and remain findable through search/read tools, but
they are not eager-injected unless they survive compaction. Memories use the
same knowledge store and are generally looked up on demand; memory records only
enter eager injection when they declare `target_agents`.
