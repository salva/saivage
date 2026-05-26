# G43 — Implementation plan r1 (Option C — delete the `planning` skill)

Adopts Option C from [02-design-r1.md](./02-design-r1.md): delete
`skills/builtin/planning/`. The planner's eager skill block becomes
empty (today; populated only if some future skill declares
`target_agents: [planner]`), and the planner's planning prose lives
exclusively in
[prompts/planner.md](../../../../prompts/planner.md), which is already
the canonical and correct source.

## Sequencing relative to G42

G42 rewrites the loader to honour `target_agents:` and bundles a
round-trip test that asserts every shipped SKILL.md frontmatter
matches its declared role. G43 deletes the only shipped SKILL.md whose
body is wrong.

**Order: G43 lands first.** Two reasons:

1. If G42 lands first, the loader immediately starts delivering the
   fictional plan format to the planner role exclusively. Today the
   bug is masked by G42's loader bug (planner sees the body but also
   sees three unrelated skills smeared in, and the system prompt
   contradicts every line); under post-G42 conditions the body would
   be a confident, targeted, single-skill block.
2. G42's round-trip test in
   [src/knowledge/eagerLoader.test.ts](../../../../src/knowledge/eagerLoader.test.ts)
   iterates over `readdirSync("skills/builtin")`. G43 deletes one
   directory; if G43 lands second, G42's test must be edited in a
   coordinated patch. Landing G43 first lets G42's test be written
   against the final three-skill bundle.

If for any reason G42 cannot land second (e.g. PR reviewer wants the
loader patch first), apply step 6 of this plan immediately as part of
G42's diff: G42's PR strips `planning/SKILL.md` together with the
loader fix. That is the only acceptable inversion.

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
   - `grep -R 'executor\|dependsOn\|"steps"' dist/skills/` — expect
     zero hits (sentinel for the fictional tokens being fully purged).

4. **Update the G42 round-trip test (coordination only).** If G42 has
   already been written and stages a four-skill assertion, the G43 PR
   adjusts the expected count from 4 to 3 and removes the
   `target_agents: [planner]` case. If G42 is written after G43, it
   sees only three skills and no adjustment is required.

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
3. **Planner eyeball test.** This is the load-bearing manual check
   for this finding. On the `saivage-v3` LXC container, restart the
   service and drive one planner turn:
   - From the workspace host: rebuild and `scp dist/` per the
     container's bind-mount layout (recorded in
     [/memories/repo/saivage-v3-build-deploy.json](../../../../../.github/repo-memory.json)
     conceptually; use the verified workflow from
     [.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md)
     and [.github/skills/saivage-v2-on-v3-control/SKILL.md](../../../../../.github/skills/saivage-v2-on-v3-control/SKILL.md)).
   - `sudo lxc-attach -n saivage-v3 -- systemctl restart saivage.service`.
   - `curl -fsS http://10.0.3.112:8080/health` — must return ok.
   - Trigger a planner round (e.g. via `/replan` from the SPA, or by
     leaving the existing plan to step). Pull the latest transcript
     stash for the planner agent and grep for the fictional tokens:
     `grep -E 'executor|dependsOn|"steps"|"goal"|"summary"' <stash>`
     — must return zero hits. Grep for the real tokens:
     `grep -E 'plan_add_stage|plan_set_current|run_manager' <stash>`
     — must return non-zero hits (the planner is still using the
     real tool surface, unchanged because this PR did not modify the
     prompt).
   - Confirm the planner's eager skill block (visible in
     `.saivage/tmp/state/runtime.json` or the transcript stash for
     the planner) no longer contains the `## Planning Guidelines`
     heading from the deleted file.
4. **No planner test exists today** that asserts the eager block's
   contents directly. The eyeball test in step 3 substitutes. A
   future test that loads the planner and asserts the eager block
   shape would be welcome but is out of scope for this finding —
   tracking it here so the metaplan can decide whether to add it
   as a separate item.

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
4. Validate per [.github/skills/saivage-lxc-operations/SKILL.md](../../../../../.github/skills/saivage-lxc-operations/SKILL.md).

No on-disk state (`.saivage/` per-project) is touched by this change.
There are no migration shims; the skill file is a bundle artefact.

If revert is needed and a follow-up fix is required, the fallback is
Option A (hand-rewrite) rather than reinstating the original fictional
body. Option A's body design is captured in
[02-design-r1.md](./02-design-r1.md#option-a--hand-rewrite-the-skill-body-to-match-plan-server--roster)
for that scenario.

## Cross-finding coordination with G42

- G43 and G42 touch disjoint surfaces in this plan:
  - G43 deletes the file.
  - G42 rewrites
    [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122),
    deletes
    [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L1-L181),
    normalises the *remaining three* SKILL.md frontmatters, and adds
    a strict-Zod round-trip test.
- Land order: **G43 → G42**, for the two reasons in the Sequencing
  section above. With this order, G42's round-trip test is written
  against the three-skill bundle from day one; no test-fixture
  coordination patch is required between the PRs.
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
  [01-analysis-r1.md](./01-analysis-r1.md#4-what-the-planner-already-knows-from-its-system-prompt);
  no F18 coordination required.
