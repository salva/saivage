# G42 — APPROVED

**Chosen proposal**: Option B (per [02-design-r2.md](02-design-r2.md)) — strict typed `BuiltinSkillFrontmatterSchema` (Zod), fail-loud on unknown fields, single walker, canonical `target_agents:` spelling. Delete the dead `src/knowledge/builtinWalker.ts`. Every shipped SKILL.md must explicitly declare `target_agents` (no `.default([])` — empty list must be explicit).

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). All 3 r1 changes addressed.

**Sequencing**: G43 MUST land FIRST so the planner-targeted skill body is correct before G42 starts targeting it. No partial-state fallback.

**Docs cleanup**: full rewrite (or deletion) of `docs/internals/skill-loader.md` and `docs/guide/skills.md` to remove references to `src/skills/loader.ts`, `<saivage>/skills/` root, `index.json` registries, object-shaped `triggers`, top-N selection, and `index.json`-based lifecycle.

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md).

**Daemon impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — all bind-mount.
