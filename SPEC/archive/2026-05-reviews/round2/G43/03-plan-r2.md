# G43 — Implementation plan r2 (Option C — delete the `planning` skill)

Round-2 delta over [03-plan-r1.md](./03-plan-r1.md):

- Sequencing rationale updated to match the revised dormancy model in
  [01-analysis-r2.md](./01-analysis-r2.md#5-why-the-bug-is-currently-dormant-revised)
  (reviewer change 1).
- G42 coordination tightened: the post-G43 G42 contract and the
  inverted-order fallback are stated explicitly, so the G42 PR cannot
  re-introduce `planner -> planning` assertions or expect a four-skill
  bundle (reviewer change 2).
- Validation step 3 replaces the loose transcript grep with two
  precise eager-block sentinels, and the positive grep is scoped to a
  planner-only transcript path (reviewer change 3). The bare word
  `summary` is no longer used as a fiction marker — see
  [01-analysis-r2.md](./01-analysis-r2.md#f7-example-uses-summary-at-the-top-level-l20).

Adopts Option C from [02-design-r2.md](./02-design-r2.md): delete
`skills/builtin/planning/`. The planner's eager skill block stays
empty (it is already empty today; G43 just makes that the intended
steady state) and the planner's planning prose lives exclusively in
[prompts/planner.md](../../../../prompts/planner.md).

## Sequencing relative to G42

G42 rewrites the loader so it parses each SKILL.md frontmatter,
honours `agentTypes`/`target_agents`, stops synthesising bare-topic
triggers, and adds a strict round-trip test asserting every shipped
SKILL.md frontmatter matches its declared role. G43 deletes the only
shipped SKILL.md whose body is wrong.

**Order: G43 lands first.** Reason: today the resolver drops every
built-in candidate before it can reach any agent
([01-analysis-r2.md](./01-analysis-r2.md#5-why-the-bug-is-currently-dormant-revised)),
so the fictional body never lands in the planner's context. G42 is
the change that lifts those filters and would start delivering the
body to the planner role exclusively. If G42 lands first, the fiction
becomes live for one PR window; G43-first prevents that window from
existing.

A secondary mechanical reason: G42 adds a round-trip test that
iterates over `readdirSync("skills/builtin")` and (per the G42 plan)
asserts a per-role mapping that includes `planner -> planning`. G43
removes that mapping. Landing G43 first lets G42 author the test
against the final three-skill bundle without a coordination patch.

### Inverted-order fallback (explicit contract)

If G42 must land first for unrelated reviewer reasons, G42's PR
absorbs the deletion as part of its own diff. Specifically the G42
patch must, in a single commit:

1. Perform the `git rm -r skills/builtin/planning` (this plan's
   Step 2 — not the no-op subsystem-map check in Step 6).
2. Drop the `planner -> planning` symmetry assertion from G42's plan
   and tests
   ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](../G42/03-plan-r1.md#L74),
   [SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](../G42/03-plan-r1.md#L117)
   — the "transcript contains `SKILL: planning` and not `SKILL:
   coding`" check).
3. Treat the bundled-skill count as three, not four, in any G42 test
   that pins the cardinality.

In either order, the post-merge invariant is the same: three built-in
SKILL.md files (`coding`, `mcp-authoring`, `research`), no
planner-targeted built-in skill, and an empty planner eager block
unless and until a future skill explicitly declares
`target_agents: [planner]`. G42's tests and docs must reflect that
invariant; specifically, no G42 assertion may rely on the planner
receiving any built-in skill body.

## Steps

1. **Confirm no production code path references the skill by name.**
   Run from `/home/salva/g/ml/saivage`:
   - `grep -RIn 'skills/builtin/planning' src/ web/ scripts/ tests/`
     — expect zero hits.
   - `grep -RIn '"planning"' src/knowledge/` — expect only generic
     `topic`/`name` field references in the walker, none hard-coded.
   - `grep -RIn 'planning' docs/ SPEC/` — collect doc references for
     step 5; expect references to be enumerative (lists of the four
     built-ins) rather than functional.

2. **Delete the file and directory.**
   - `git rm skills/builtin/planning/SKILL.md`
   - `git rm -r skills/builtin/planning` if any other files exist
     (today: none — verified via
     [list_dir of skills/builtin/](../../../../skills/builtin)).

3. **Verify the bundle no longer includes the file.**
   - `npm run build` (re-runs `tsup`).
   - `ls dist/skills/builtin/` — expect `coding`, `mcp-authoring`,
     `research` (three entries, no `planning`).
   - `grep -RIn 'executor\|dependsOn\|"steps"\|"type": "execute"' dist/skills/`
     — expect zero hits (precise fictional-shape sentinels; bare
     `"summary"` deliberately omitted because it is a real
     `plan_complete_stage` argument — see
     [01-analysis-r2.md](./01-analysis-r2.md#f7-example-uses-summary-at-the-top-level-l20)).
   - `grep -RIn '## Planning Guidelines\|--- SKILL: planning' dist/skills/`
     — expect zero hits (eager-block sentinels for the deleted body
     and its loader-rendered header).

4. **Update the G42 round-trip test (coordination only).** If G42 has
   already been written and stages a four-skill assertion, the G43 PR
   adjusts the expected count from 4 to 3, removes the
   `target_agents: [planner]` case, and removes the `SKILL: planning`
   assertion from G42's planner-transcript check
   ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](../G42/03-plan-r1.md#L117)).
   If G42 is written after G43, it sees only three skills and authors
   itself against the empty-planner-eager-block invariant from the
   start.

5. **Update author-facing docs.**
   - [docs/guide/skills.md](../../../../docs/guide/skills.md) — if it
     enumerates `coding`, `planning`, `research`, `mcp-authoring`,
     remove `planning` and add a one-sentence note:
     "Planner-facing planning prose is delivered through
     `prompts/planner.md`, not through an eager skill."
   - [docs/internals/skill-loader.md](../../../../docs/internals/skill-loader.md)
     — same enumeration check; remove `planning` from any built-ins
     list.
   - [SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md)
     — if any example uses `planning/` as a sample skill directory,
     switch the example to `coding/` (which remains).
   - [SPEC/v2/06-SYSTEM-DESIGN.md](../../../06-SYSTEM-DESIGN.md),
     [SPEC/v2/05-MCP-SERVICES.md](../../../05-MCP-SERVICES.md) — same
     enumeration check; touch only if the four built-ins are listed by
     name.

6. **Subsystem map.** No change to
   [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)
   (skills internals are out of scope per the map's preamble; the
   built-ins directory is not enumerated).

## Validation

Run from `/home/salva/g/ml/saivage`:

1. **Build clean.** `npx tsc -p tsconfig.json` — should succeed
   unchanged (no TypeScript references the file). `npm run build`
   should succeed; spot-check `dist/skills/builtin/` per step 3.
2. **Unit suite.** `npx vitest run` — full unit suite, expected
   clean. Specifically:
   - `src/knowledge/eagerLoader.test.ts` — must still pass; the
     test that walks `skills/builtin/` iterates whatever is present,
     so removing one entry is invisible to the existing assertions.
     Post-G42 (or in coordination with G42), the count assertion
     drops from 4 to 3.
   - `src/knowledge/regression.test.ts` — must still pass; this
     suite does not name `planning` directly.
   - `src/agents/knowledge.agent.test.ts` — must still pass; targets
     the resolution path, not specific built-ins.
3. **Planner eager-block manual check** (load-bearing). On the
   `saivage-v3` LXC container, restart the service and drive one
   planner turn:
   - From the workspace host: rebuild and `scp dist/` per the
     container's bind-mount layout (use the verified workflow from
     [.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md)
     and
     [.github/skills/saivage-v2-on-v3-control/SKILL.md](../../../../../.github/skills/saivage-v2-on-v3-control/SKILL.md)).
   - `sudo lxc-attach -n saivage-v3 -- systemctl restart saivage.service`.
   - `curl -fsS http://10.0.3.112:8080/health` — must return ok.
   - Trigger a planner round (e.g. via `/replan` from the SPA, or by
     leaving the existing plan to step). Locate the planner agent's
     pre-turn stash under
     `/work/saivage-v3/.saivage/tmp/state/runtime.json` (or the
     dedicated planner transcript file under
     `.saivage/tmp/state/transcripts/planner-*.jsonl`) — the
     **eager-knowledge block** that is read by the planner's first
     turn.
   - **Primary assertion (eager-block sentinels, precise):** the
     planner's eager-knowledge block contains neither
     `--- SKILL: planning` (the loader-rendered header that would
     introduce a planner-targeted skill named `planning`) nor
     `## Planning Guidelines` (the first heading of the deleted
     body). Both pre- and post-merge this must be true. Pre-merge it
     is true because the resolver drops every built-in candidate;
     post-merge it stays true because the file no longer exists.
     Failing either check means a planner-facing skill is being
     injected and G43's premise has shifted.
   - **Secondary fiction-shape check (optional, runs only if the
     primary sentinels somehow hit):** grep the same eager block —
     not the whole transcript — for the *combination* of `"steps"`,
     `dependsOn`, and `"type": "execute"`. Any line set that has all
     three is the deleted body or a regression of it. Bare
     `"summary"` is NOT a fiction marker and must not appear in any
     grep: `plan_complete_stage` accepts a `summary` argument
     ([prompts/planner.md](../../../../prompts/planner.md#L65),
     [src/types.ts](../../../../src/types.ts#L54-L62),
     [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L482-L487)),
     so a transcript containing tool schemas or stage summaries can
     mention `summary` legitimately.
   - **Real-tool positive check, scoped (optional):** confirm the
     planner is still using the real MCP surface by inspecting the
     planner-only transcript file (not the whole stash) for at least
     one occurrence of any of `plan_get`, `plan_init`,
     `plan_add_stage`, `plan_set_current`, or `run_manager`. A valid
     recovery turn can use just `plan_get`/`plan_init` without ever
     calling the dispatch tools, so the check is "any one of these,"
     not "all three of `plan_add_stage` + `plan_set_current` +
     `run_manager`" as r1 said. The point is to confirm the planner
     did not start emitting JSON; the eager-block sentinels above
     are the real guard.

4. **No planner test exists today** that asserts the eager block's
   contents directly. The eyeball check in step 3 substitutes. Adding
   an `eagerLoader.test.ts` case that constructs a planner-role
   resolve context and asserts the resolved eager block contains
   neither `## Planning Guidelines` nor `--- SKILL: planning` is a
   welcome follow-up but out of scope for this finding; tracked here
   so the metaplan can decide whether to add it as a separate item.

## Rollback

No `git reset --hard`. Daemons in scope:

| Container | Address | Service | Affected? |
|---|---|---|---|
| `saivage` | 10.0.3.111:8080 | `saivage.service` | yes (bundled skills loaded at boot) |
| `saivage-v3` | 10.0.3.112:8080 | `saivage.service` | yes |
| `diedrico` | 10.0.3.113:8080 | `saivage.service` | yes (same bundle) |
| `saivage-v3-getrich-v2` | 10.0.3.170:8080 | `saivage-v3-getrich.service` | not in v2 scope, but uses the same bundle path layout — verify after rebuild |

Rollback procedure if the change boots cleanly in dev but a deployment
misbehaves (e.g. an unrelated downstream test that imported the
`planning` skill body as a fixture starts failing):

1. `git revert <merge-commit>` on the v2 branch.
2. `npm run build`.
3. Per container, `sudo lxc-attach -n <name> -- systemctl restart
   <service>`; health-probe each with
   `curl -fsS http://<ip>:8080/health`.
4. Validate per
   [.github/skills/saivage-lxc-operations/SKILL.md](../../../../../.github/skills/saivage-lxc-operations/SKILL.md).

No on-disk state (`.saivage/` per-project) is touched by this change.
There are no migration shims; the skill file is a bundle artefact.

If revert is needed and a follow-up fix is required, the fallback is
Option A (hand-rewrite) rather than reinstating the original fictional
body. Option A's body design is captured in
[02-design-r2.md](./02-design-r2.md#option-a--hand-rewrite-the-skill-body-to-match-plan-server--roster)
for that scenario.

## Cross-finding coordination with G42

- G43 and G42 touch disjoint source surfaces:
  - G43 deletes `skills/builtin/planning/SKILL.md`.
  - G42 rewrites
    [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122),
    deletes
    [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L1-L181),
    normalises the *remaining three* SKILL.md frontmatters, and adds
    a strict-Zod round-trip test.
- Land order: **G43 → G42** by default; inverted-order fallback is
  spelled out in the "Inverted-order fallback" subsection above. In
  either order, the post-merge contract is:
  - exactly three built-in skill directories (`coding`,
    `mcp-authoring`, `research`);
  - no SKILL.md declares `target_agents: [planner]`;
  - G42's tests assert the planner's resolved eager block is empty
    (no built-in body delivered), and G42's planner-transcript
    smoke does not look for `SKILL: planning`.
- After both land, the planner's eager block is empty (or populated
  only by future planner-targeted skills). G42's design recommends a
  follow-up "code-generate skills that embed internal contracts" as a
  level-up; G43 makes that follow-up smaller (one fewer skill needs
  generation) and weaker in motivation (the case for generating skill
  bodies disappears for the planner specifically). Whether to pursue
  it for `coding`, `research`, `mcp-authoring` is a metaplan decision.
- F18 (system-prompt bloat): the round-1 issue text suggested checking
  [prompts/planner.md](../../../../prompts/planner.md) for residual
  fictional plan format. Verified clean in
  [01-analysis-r2.md](./01-analysis-r2.md#4-what-the-planner-already-knows-from-its-system-prompt);
  no F18 coordination required.
