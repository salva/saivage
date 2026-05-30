# G42 — Review r1

## Findings

1. **Make the built-in frontmatter contract genuinely fail-loud for `target_agents`.**

   The design says Option B lets Zod enforce required keys and makes `target_agents:` canonical, but the schema sketch still defaults `target_agents` to `[]` ([SPEC/v2/review-2026-05-round2/G42/02-design-r1.md](02-design-r1.md#L109-L127)), and the implementation plan repeats that default ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](03-plan-r1.md#L24-L28)). That leaves a built-in skill with an omitted role filter silently becoming global, which is exactly the failure shape G42 is trying to remove: the resolver treats empty `target_agents` as any role ([src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L246)) and then relies on trigger scoring for inclusion ([src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L250-L251)).

   Tighten the writer docs so built-in `SKILL.md` files must explicitly declare `target_agents` under the canonical spelling. If a truly global built-in is ever needed, require `target_agents: []` to be written intentionally and tested. At minimum, remove the "required" language or add a negative test for missing `target_agents`; the current docs say both things at once.

2. **Remove or rewrite the conditional G43 fallback; it contradicts the rest of the plan.**

   The sequencing section correctly says G43 must land before G42 ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](03-plan-r1.md#L6-L17)), and the cross-finding section repeats the required order ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](03-plan-r1.md#L151-L159)). But the fallback says to do steps 1-6 while leaving `planning/SKILL.md` frontmatter tied to G43 ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](03-plan-r1.md#L18-L20)). That conflicts with step 5, which normalises all four shipped files including `planning`, and with step 6, which expects the planner to resolve the planning skill ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](03-plan-r1.md#L54-L76)).

   Given the architecture-first and no-shim rule, the cleaner plan is simply: G43 lands first, then G42 lands completely. If a fallback remains, it needs its own adjusted test matrix and must not claim every `SKILL.md` is normalised in that partial state.

3. **Expand the docs cleanup scope; two referenced docs preserve the old loader architecture.**

   Step 7 says to update [docs/internals/skill-loader.md](../../../../docs/internals/skill-loader.md#L25) and [docs/guide/skills.md](../../../../docs/guide/skills.md#L26) mainly so they point at `eagerLoader.ts` instead of `builtinWalker.ts` ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](03-plan-r1.md#L78-L88)). That is too narrow. Those docs currently reference a nonexistent/legacy `src/skills/loader.ts`, `<saivage>/skills/`, `index.json`-registered built-ins, object-shaped trigger groups, and top-N selection ([docs/internals/skill-loader.md](../../../../docs/internals/skill-loader.md#L3-L45), [docs/guide/skills.md](../../../../docs/guide/skills.md#L12-L43)).

   The implementation plan should require rewriting or deleting those stale sections, not just changing one pointer. Otherwise the change removes `builtinWalker.ts` but keeps author-facing docs that still teach the pre-knowledge-loader model.

## Verified Good

- The main correctness claim is sound. Production `walkBuiltinSkills` reads the whole `SKILL.md` into `body`, synthesises `description`, `triggers`, and `target_agents: []`, and is called by `loadAllCandidates` ([src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L150)). The separate parser in `builtinWalker.ts` parses frontmatter but is only exercised through tests, not production wiring ([src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L42-L158), [src/knowledge/loader.test.ts](../../../../src/knowledge/loader.test.ts#L337-L410)).
- Option B is the right architectural direction: one production walker, strict Zod validation, canonical `target_agents:`, stripped YAML preamble, and no compatibility shim for `agentTypes:`. That matches the existing runtime schema in [src/knowledge/types.ts](../../../../src/knowledge/types.ts#L101-L114) and removes the dead walker rather than preserving drift.
- The deletion requirement is explicit: the plan deletes [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L1-L181) and removes its import/test-only fixture path ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](03-plan-r1.md#L42-L53)).
- The shipped built-in inventory is exactly four `SKILL.md` files, and the plan names all four for frontmatter normalisation ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](03-plan-r1.md#L54-L66)). Current source confirms all four still use `agentTypes:` and `version:`, with `mcp-authoring` also carrying `dependencies:` ([skills/builtin/coding/SKILL.md](../../../../skills/builtin/coding/SKILL.md#L4-L6), [skills/builtin/mcp-authoring/SKILL.md](../../../../skills/builtin/mcp-authoring/SKILL.md#L4-L7), [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L4-L6), [skills/builtin/research/SKILL.md](../../../../skills/builtin/research/SKILL.md#L4-L6)).
- The trigger normalisation in step 5 is necessary, not scope creep: bare trigger words score zero in the current resolver ([src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L51-L68)), and non-survivor skills with score zero are dropped ([src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L250-L251)).

## Change Count

Requested changes: 3

VERDICT: CHANGES_REQUESTED