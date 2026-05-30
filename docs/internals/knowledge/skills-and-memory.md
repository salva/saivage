# Skill Loader

Runtime skill and memory injection is implemented by
[`src/knowledge/eagerLoader.ts`](../../src/knowledge/eagerLoader.ts) and
[`src/knowledge/loader.ts`](../../src/knowledge/loader.ts).

## Flow

1. `loadAllCandidates(projectRoot)` collects project records from
   `.saivage/{skills,memory}/{project,stages,sessions}/` and built-in skills
   from `skills/builtin/<topic>/SKILL.md`.
2. Built-in `SKILL.md` files are parsed through the strict
   `BuiltinSkillFrontmatterSchema`. Unknown keys fail at startup; global
   built-ins must spell `target_agents: []` explicitly.
3. `resolveEagerRecords` filters to active records visible to the current
   role, scores skills, then applies the survivor and ordinary eager budgets.
4. `formatEagerBlock` renders selected records as labelled knowledge blocks
   appended to the agent prompt.

## Built-In Frontmatter

Built-in skills use this key set:

```yaml
name: coding
description: Best practices for writing and modifying code
triggers: [agent:coder, keyword:implement]
target_agents: [coder]
survive_compaction: false
```

`triggers` are flat strings using `kind:value` syntax. The loader scores
`keyword:`, `tag:`, and `agent:`. Unknown trigger kinds score zero.

`target_agents` is a role filter for eager injection. A non-empty list restricts
the skill to those roles. An empty list means global, but built-ins must write
that empty list deliberately.

## Project Skills

Project skills are not frontmatter files. They are `SkillRecord` JSON documents
and markdown bodies authored via the MCP knowledge tools under
`.saivage/skills/`. The loader reads the records and bodies from the document
tree; lifecycle, audit, permission, and index maintenance live in
`src/knowledge/lifecycle.ts` and the `src/mcp/knowledge*.ts` adapters.
