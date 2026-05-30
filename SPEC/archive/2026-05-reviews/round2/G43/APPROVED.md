# G43 — APPROVED

**Chosen proposal**: Option C (per [02-design-r2.md](02-design-r2.md)) — DELETE the `skills/builtin/planning/SKILL.md` outright. The planner system prompt (`prompts/planner.md`) is canonical and already teaches the correct contract end-to-end. The skill is duplicative AND wrong.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). All 3 r1 changes addressed.

**Sequencing**: G43 lands FIRST, then G42. Inverted-order fallback (if G42 merges first): G42's PR must delete the skill instead of relying on the no-op step, and must remove the `planner -> planning` symmetry/transcript assertions. Post-merge invariant: 3 skills total, empty planner eager block, no `SKILL: planning` assertion.

**Validation**: grep for `## Planning Guidelines` and `--- SKILL: planning` in eager-block-scoped contexts (NOT broad code searches — `summary` is a real `plan_complete_stage` arg).

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md).

**Daemon impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — all bind-mount.
