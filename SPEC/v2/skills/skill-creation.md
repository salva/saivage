# Skill Authoring Guide

This document is **convention documentation** for skill content authors and runtime callers. It is *not* a skill loaded by the runtime — the runtime loads built-in skills from `saivage/skills/builtin/` (YAML frontmatter), and project skills from `<project>/.saivage/skills/{project,stages/<id>,sessions/<id>}/` via the MCP `create_skill` tool.

Full design: [SPEC/v2/skills-memory/01-DESIGN.md](../skills-memory/01-DESIGN.md) §C.1 (tool surface) and §D (retrieval / eager injection).

## What a skill is

A skill is a record (one `SkillRecord` per skill) holding instructions an agent should follow when its task matches the skill's triggers. Skills are **eagerly injected** into agent system prompts at construction time (subject to the budget in design §D.2). Triggerless skills are still findable via `search_skills` and `read_skill` by id.

## Two authoring paths

### A. Built-in skills (shipped with Saivage)

Built-in skills live at `saivage/skills/builtin/<topic>/SKILL.md`, are walked by `src/knowledge/builtinWalker.ts`, and are bundled into `dist/skills/builtin/` by `tsup`. They are loaded with `origin="builtin"`, `scope="project"`.

Each `SKILL.md` carries YAML frontmatter followed by markdown body:

```markdown
---
name: <skill-name>                # unique within scope; lowercase + hyphens
description: <one-line summary>
triggers:                          # all optional; see "Triggers" below
  - keyword:<word>
  - tag:<label>
  - agent:<role>
target_agents: [coder, manager]    # optional; empty = any role
survive_compaction: false          # optional; true => always reinjected after compaction
---

# Skill: <Human-Readable Name>

## When to Use
<One sentence: the situation that triggers this skill.>

## Rules
<Numbered or bulleted list of specific, actionable instructions.>
```

To add or modify a built-in skill, edit the file in `saivage/skills/builtin/<topic>/SKILL.md` and rebuild. The loader picks up the change on the next agent construction.

### B. Project skills (authored at runtime)

Project skills are authored exclusively via the MCP `create_skill` tool by Manager or Inspector (design §F). There is **no frontmatter** — every field lives in the `SkillRecord` JSON on disk; the markdown body is referenced by `body_path`.

Tool call shape (design §C.1):

```ts
create_skill({
  name: "skill-name",
  description: "One-line summary of what this skill teaches.",
  body: "<full markdown body>",
  triggers: ["keyword:oauth", "tag:authentication"],
  target_agents: ["coder"],
  scope: "project",          // or "stage" (with scope_ref = stage_id) or "session"
  survive_compaction: false, // set true only for truly durable lessons
  reason: "Established OAuth integration pattern; codify for reuse."
})
```

Returns `{ id, status }`. The runtime writes the record under `<project>/.saivage/skills/<scope>/records/<uuid>.json` (with the body at `<uuid>.md`), appends one `AuditEntry` to that scope's `audit.jsonl`, and rebuilds the scope `index.json`. Generic filesystem writes to `.saivage/skills/` are rejected by `fsGuard` — the MCP surface is the only authoring path.

Mutations after creation: `update_skill`, `supersede_skill`, `archive_skill`, `delete_skill`. All require a non-empty `reason` and produce one audit entry.

## Triggers

Skills declare zero or more triggers (design §D.4):

| Trigger type     | Format            | Matches when                                  |
|------------------|-------------------|-----------------------------------------------|
| `keyword:<word>` | case-insensitive  | Task / stage description contains the word    |
| `tag:<label>`    | exact match       | Task or stage has the given tag               |
| `agent:<type>`   | exact match       | Current agent role is the given type          |

The legacy `tool:<name>` and `path:<glob>` trigger types have been **dropped**. They are rejected at write time by `SkillRecord.triggers` validation; legacy records carrying them are ignored defensively at load time.

Triggerless skills (`triggers: []`) are valid (FR-8). They never participate in eager injection but are findable via `search_skills` and `read_skill` by id.

## `target_agents`

`target_agents` is a **role filter** for eager injection: empty means "any role", non-empty restricts injection (and on-demand visibility for worker roles) to the listed roles. Inspector and Chat are privileged readers — they bypass the filter on read.

## Lifecycle

Records transition `active` → `superseded` (via `supersede_skill`) | `archived` (via `archive_skill`, reversible) | `expired` (sweeper for TTL'd records). `delete_skill` writes a tombstone + audit. Stage-scoped skills are archived automatically when the stage terminates; session-scoped skills are archived when the chat channel closes. Supersession may widen scope (`stage → project`) but never narrow it (design §B.5).

## Where built-ins vs project skills live

| Origin    | Path                                                       | Authored by | `scope`   |
|-----------|------------------------------------------------------------|-------------|-----------|
| `builtin` | `saivage/skills/builtin/<topic>/SKILL.md`                  | repo commit | `project` |
| `project` | `<project>/.saivage/skills/project/records/<uuid>.{json,md}` | `create_skill` (Mg/In) | `project` |
| `project` | `<project>/.saivage/skills/stages/<stage_id>/records/...`  | `create_skill` (Mg/In, stage-scoped) | `stage` |
| `project` | `<project>/.saivage/skills/sessions/<channel_id>/records/...` | `create_skill` (Mg/In, session-scoped) | `session` |

The `SPEC/v2/skills/` directory (this file, plus `code-quality.md`, `git-conventions.md`, etc.) holds spec / convention documentation, **not** runtime-loaded skills. It is not walked by `builtinWalker.ts`.

## When to author a skill

Skills should be created when:

- A pattern or convention has been established that will recur in future tasks.
- A tool or library has project-specific usage patterns worth documenting.
- A non-obvious workflow was discovered that would save time for future agents.

Skills should **not** be created for:

- One-off procedures unlikely to recur.
- Generic programming knowledge (the LLM already knows this).
- Information that belongs in project documentation (README, API docs) rather than agent instructions.

## Authoring style

- Keep skills focused — one skill per topic. Don't create omnibus skills.
- Write instructions as imperative commands: "Use", "Do not", "Always", "When X, do Y".
- Include concrete examples (code snippets, file paths, command invocations).
- Do not repeat instructions already present in the agent's system prompt — skills add project-specific knowledge, not generic advice.
- Keep skills concise. Target 40–100 lines. If longer, split into multiple skills.

## Memory: when not to use a skill

If the information is a project-specific *fact* (a build command, an API quota, a recently discovered constraint) rather than an *instruction*, author a memory record via `create_memory` instead. Memories are surfaced via `get_memory({topic})` / `search_memories`, not eagerly injected (unless `target_agents` is set). See design §C.1.
