# G42 — Implementation plan r2 (Option B)

Adopts Option B from [02-design-r2.md](./02-design-r2.md): typed Zod
schema for SKILL.md frontmatter, `target_agents` required (no default),
fail-loud on unknown keys, one walker.

## Round-2 deltas vs [03-plan-r1.md](./03-plan-r1.md)

1. Step 1 makes `target_agents` a required Zod field (no `.default([])`),
   and step 6 gains a negative test for the omitted-key shape.
2. The conditional G43 fallback is removed. G43 is a hard prerequisite;
   if G43 cannot land first, G42 does not land at all.
3. Step 7 is expanded from "swap one pointer" to "rewrite the stale
   sections of [docs/internals/skill-loader.md](../../../../docs/internals/skill-loader.md#L1-L66)
   and [docs/guide/skills.md](../../../../docs/guide/skills.md#L1-L100)
   to match the actual knowledge-loader architecture, or delete them".

## Sequencing relative to G43

**G43 lands first, then G42 lands completely.** Both findings touch
[skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L1-L7);
G42 only touches its frontmatter and G43 only touches its body, so the
diffs do not overlap textually, but the rebase order is fixed:

- G43 rewrites the planning body so the planner stops being taught a
  fictional plan format.
- G42 makes the loader actually deliver that body to the planner role
  only, and to no one else.

No partial-state fallback. If G43 is blocked, G42 waits. The cleaner
plan is one merge per finding rather than a half-applied G42 that
normalises three SKILL.md files and leaves the fourth as a sequencing
artefact.

## Steps

1. **Add `BuiltinSkillFrontmatterSchema` to
   [src/knowledge/types.ts](../../../../src/knowledge/types.ts#L101-L114).**
   `z.object({…}).strict()` with `name` (string), `description`
   (string), `triggers` (string array, default `[]`), `target_agents`
   (`z.array(KnowledgeAgentRoleSchema)` — **required, no default**),
   `survive_compaction` (boolean, default `false`). Export both the
   schema and the inferred type. Comment in the file states explicitly
   that `target_agents: []` is the canonical spelling for a global
   built-in and must be written deliberately.

2. **Rewrite `walkBuiltinSkills` in
   [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122).**
   Replace the synthesised-field block with: read file → split into
   `{frontmatter, body}` via a small frontmatter splitter → load YAML
   subset into `Record<string, unknown>` using the trimmed parser moved
   over from `builtinWalker.ts` → `BuiltinSkillFrontmatterSchema.parse`
   → `SkillRecordSchema.parse({…skeleton, ...fm, origin: "builtin"})`.
   The `body` written into `RawCandidate` must NOT contain the
   `---…---` preamble. On Zod failure the error message must name the
   offending file path so authors can locate it without grepping.

3. **Delete
   [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L1-L181).**
   Move only the YAML-subset tokeniser into a private helper inside
   `eagerLoader.ts` (≈30 lines). Remove `BuiltinFrontmatter`,
   `BuiltinSkillRaw`, `walkBuiltinSkills`, `builtinAsSkillRecord`,
   `parseSkillFrontmatter`, `assignFrontmatterKey`, and the
   silent-ignore default branch.

4. **Update
   [src/knowledge/loader.test.ts](../../../../src/knowledge/loader.test.ts#L21).**
   Remove the `from "./builtinWalker.js"` import and the two describe
   blocks at lines 337–410. The matching round-trip assertions move
   into `eagerLoader.test.ts` (step 6).

5. **Normalise the four shipped SKILL.md frontmatters.** For each of
   [skills/builtin/coding/SKILL.md](../../../../skills/builtin/coding/SKILL.md#L1-L7),
   [skills/builtin/mcp-authoring/SKILL.md](../../../../skills/builtin/mcp-authoring/SKILL.md#L1-L7),
   [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L1-L7),
   [skills/builtin/research/SKILL.md](../../../../skills/builtin/research/SKILL.md#L1-L7):
   rename `agentTypes:` → `target_agents:`; drop `version:` and (for
   `mcp-authoring`) `dependencies:`. Rewrite trigger entries to use the
   canonical `kind:value` form expected by
   [src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L57-L80)
   (`keyword:write`, `agent:coder`, …) — bare words score 0 today.
   Every file ships with an explicit non-empty `target_agents:` line;
   nothing is global.

6. **Replace fixture tests with real-bundle round-trip in
   [src/knowledge/eagerLoader.test.ts](../../../../src/knowledge/eagerLoader.test.ts#L73).**
   New cases:
   - For each `skills/builtin/<topic>` shipped with the repo,
     `loadAllCandidates(projectRoot, defaultBuiltinSkillsRoot())`
     produces a `SkillRecord` whose `target_agents` matches the file's
     frontmatter and whose `body` does not start with `---`.
   - `resolveEagerRecords({agentRole: "researcher"}, all)` returns the
     `research` skill and not `coding`, `mcp-authoring`, `planning`.
   - Symmetric: `agentRole: "planner"` returns `planning` only;
     `agentRole: "coder"` returns `coding` + `mcp-authoring`.
   - **Negative — missing key.** A temp SKILL.md fixture with
     `name`, `description`, `triggers`, `survive_compaction` but no
     `target_agents:` raises a Zod parse error whose message mentions
     both the file path and the string `"target_agents"`.
   - **Negative — unknown key.** A temp SKILL.md fixture carrying
     `agentTypes:`, `version:`, or `foo:` raises a Zod parse error
     whose message names the offending key and the file path.

7. **Rewrite the stale author-facing docs.**

   - [SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md#L27)
     — document only the canonical key set
     (`name`, `description`, `triggers`, `target_agents`,
     `survive_compaction`); state that `target_agents` is required and
     that a global built-in must declare `target_agents: []`
     intentionally; remove any "forward compatibility" prose.
   - [SPEC/v2/06-SYSTEM-DESIGN.md](../../06-SYSTEM-DESIGN.md#L248) and
     [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md#L284) —
     update file pointers to `src/knowledge/eagerLoader.ts` and remove
     references to `builtinWalker.ts`.
   - [docs/internals/skill-loader.md](../../../../docs/internals/skill-loader.md#L1-L66)
     — the page is pre-knowledge-loader and is reset, not patched.
     Replace the body with: pointer to
     [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L1)
     and [src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L1);
     description of the two-stage flow (eager candidate walk plus
     on-demand resolution) actually implemented today; trigger scoring
     `kind:value` form; the role-filter contract from
     `BuiltinSkillFrontmatterSchema`. Remove all references to
     `src/skills/loader.ts`, `SkillMatchContext`, `index.json`
     registries, `triggers: {tags, keywords, tools}` object schema,
     and the top-N selector. If a meaningful internals page cannot be
     written quickly, delete the file and link `eagerLoader.ts` from
     [SPEC/v2/06-SYSTEM-DESIGN.md](../../06-SYSTEM-DESIGN.md#L248)
     instead — do not leave the stale page in place.
   - [docs/guide/skills.md](../../../../docs/guide/skills.md#L1-L100)
     — same fate. Replace the body with: skills as Markdown injected
     into eager / survivor blocks; built-in root is
     `<saivage>/skills/builtin/`; project-local memory lives under
     `<project>/.saivage/knowledge/` and is authored via the MCP
     `knowledge_*` tools, not by hand-editing `index.json`; the
     frontmatter contract enumerated in
     [SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md#L27);
     no top-N cap, no object-shaped triggers, no
     `--- SKILL: name ---` block wrapper. Delete the
     `index.json`-based "Self-extension" lifecycle entirely; if a
     replacement lifecycle paragraph is wanted, source it from the
     real MCP tool surface in
     [src/mcp/knowledgeSkills.ts](../../../../src/mcp/knowledgeSkills.ts#L1).

8. **Update the round-2 subsystem map** entry for Knowledge in
   [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md#L111)
   — remove `src/knowledge/builtinWalker.ts` from the file list.

## Validation

Run from `/home/salva/g/ml/saivage`:

1. `npx tsc -p tsconfig.json` — clean build, no references to the
   deleted file remain.
2. `npx vitest run src/knowledge/eagerLoader.test.ts src/knowledge/loader.test.ts src/agents/knowledge.agent.test.ts src/knowledge/regression.test.ts`
   — focused suite covering the new contract and both negative tests.
3. `npx vitest run` — full unit suite.
4. `npm run build` — `tsup` repackages SKILL.md files into
   `dist/skills/builtin/`; verify the new frontmatter is bundled
   (`grep -R "agentTypes" dist/` must return zero,
   `grep -R "target_agents" dist/skills/builtin/` must return four
   hits).
5. Manual smoke per
   [.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md)
   on the `saivage` container after restart (see Rollback for which
   services to restart). The smoke is:
   `curl -fsS http://10.0.3.111:8080/api/notes` returns 200 and the
   server logs at startup show no `Zod` parse errors on the built-in
   walker step.
6. **Manual targeting check.** With the system serving, drive each
   agent role through one turn (planner via `manager`-spawned recovery
   or chat slash; coder via a trivial task) and grep the LLM transcript
   stash for the survivor block header — assert the planner's eager
   block contains the `planning` skill body and not the `coding` body,
   and vice versa.

## Rollback

No `git reset --hard`. Daemons in scope are listed in
[../../../../../WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md)
and the workspace handoff:

| Container | Address | Service | Affected? |
|---|---|---|---|
| `saivage` | 10.0.3.111:8080 | `saivage.service` | yes (loads the bundled skills at boot) |
| `diedrico` | 10.0.3.113:8080 | `saivage.service` | yes (same bundle, different project) |
| `saivage-v3` | 10.0.3.112:8080 | `saivage.service` | yes |

Rollback procedure if the change boots cleanly in dev but breaks a
deployment:

1. `git revert <merge-commit>` on the v2 branch and rebuild
   (`npm run build`).
2. Per container, `sudo lxc-attach -n <name> -- systemctl restart <service>`
   to re-run startup with the reverted bundle. Health-probe each:
   `curl -fsS http://10.0.3.111:8080/health`,
   `curl -fsS http://10.0.3.112:8080/health`,
   `curl -fsS http://10.0.3.113:8080/health`.
3. If a single container is wedged with a `Zod` parse error on boot
   (e.g. its bind-mounted `dist/skills/builtin/` is stale), `ssh
   root@<ip>` into that container and re-deploy the reverted bundle —
   the rest of the fleet keeps running because each container has its
   own bind mount.

No on-disk state (`.saivage/` per-project) is touched by this change.
There are no migration shims and nothing to back up — built-in skill
files are bundle artefacts.

## Cross-finding coordination with G43

- G43 owns the body of
  [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md);
  G42 owns its frontmatter. The two PRs touch disjoint lines.
- Land order: **G43 → G42, no exceptions.** Reversing the order would
  point the planner at the fictional plan format until G43 lands; a
  partial G42 that skips the planning SKILL.md is worse than no G42 at
  all because step 5's normalisation would either be incomplete
  (planning still has `agentTypes:`) or would race G43's edit.
- Both findings share the same test file
  [src/knowledge/eagerLoader.test.ts](../../../../src/knowledge/eagerLoader.test.ts);
  G42's new round-trip test should reference the corrected body text
  loosely (e.g. assert `body` contains `plan_add_stage`) rather than
  asserting exact content, to avoid coupling the two PRs at the
  assertion level.
- After both land, drop the
  [SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md#L27)
  "code-generate skills that embed internal contracts" thread that G43
  raises as a level-up — that is a separate, larger refactor and
  belongs in the metaplan, not this finding.
