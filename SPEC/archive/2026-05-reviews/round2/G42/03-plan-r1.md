# G42 — Implementation plan r1 (Option B)

Adopts Option B from [02-design-r1.md](./02-design-r1.md): typed Zod
schema for SKILL.md frontmatter, fail-loud on unknown keys, one walker.

## Sequencing relative to G43

G43 rewrites the body of
[skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L1-L7).
G42 makes the loader actually deliver that body to the planner role only.
Order: **G43 lands first** (so the planner-targeted skill is correct when
G42 starts targeting it). Both findings touch
`skills/builtin/planning/SKILL.md`; G42 only touches its frontmatter and
G43 only touches its body, so the diffs do not overlap textually — but
the rebase order must be G43 → G42 to avoid landing a Zod-validated
SKILL.md whose body teaches a fictional plan format.

If G43 cannot land first, do steps 1–6 of this plan only (loader fix +
frontmatter rewrite for the three other skills) and leave
`planning/SKILL.md`'s frontmatter rewrite tied to G43's PR.

## Steps

1. **Add `BuiltinSkillFrontmatterSchema` to
   [src/knowledge/types.ts](../../../../src/knowledge/types.ts#L101-L114).**
   Strict object with `name`, `description`, `triggers` (default `[]`),
   `target_agents` (default `[]`, items typed as
   `KnowledgeAgentRoleSchema`), `survive_compaction` (default `false`).
   Export both the schema and the inferred type.

2. **Rewrite `walkBuiltinSkills` in
   [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122).**
   Replace the synthesised-field block with: read file → split into
   `{frontmatter, body}` via a small frontmatter splitter → load YAML
   subset into `Record<string, unknown>` using the trimmed parser moved
   over from `builtinWalker.ts` → `BuiltinSkillFrontmatterSchema.parse`
   → `SkillRecordSchema.parse({…skeleton, …fm, name: fm.name ?? topic,
   origin: "builtin"})`. The `body` written into `RawCandidate` must NOT
   contain the `---…---` preamble.

3. **Delete
   [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L1-L181).**
   Move only the YAML-subset tokeniser into a private helper inside
   `eagerLoader.ts` (≈30 lines). Remove `BuiltinFrontmatter`,
   `BuiltinSkillRaw`, `walkBuiltinSkills`, `builtinAsSkillRecord`,
   `assignFrontmatterKey`, and the silent-ignore default branch.

4. **Update
   [src/knowledge/loader.test.ts](../../../../src/knowledge/loader.test.ts#L21).**
   Remove the `from "./builtinWalker.js"` import and the two
   describe blocks at lines 337–410. The matching round-trip
   assertions move into `eagerLoader.test.ts` (step 6).

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
   - Loading a SKILL.md with an unknown key (`agentTypes:`, `foo:`)
     raises a clear error pointing at the file path.

7. **Update author-facing docs.** Edit
   [SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md#L27)
   to document only the canonical key set; remove any "forward
   compatibility" prose. Update
   [docs/internals/skill-loader.md](../../../../docs/internals/skill-loader.md#L25)
   and [docs/guide/skills.md](../../../../docs/guide/skills.md#L26) to
   point at `eagerLoader.ts` instead of `builtinWalker.ts`. Update
   [SPEC/v2/06-SYSTEM-DESIGN.md](../../06-SYSTEM-DESIGN.md#L248) and
   [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md#L284) for the
   same.

8. **Update the round-2 subsystem map** entry for Knowledge in
   [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md#L111)
   — remove `src/knowledge/builtinWalker.ts` from the file list.

## Validation

Run from `/home/salva/g/ml/saivage`:

1. `npx tsc -p tsconfig.json` — clean build, no references to the
   deleted file remain.
2. `npx vitest run src/knowledge/eagerLoader.test.ts src/knowledge/loader.test.ts src/agents/knowledge.agent.test.ts src/knowledge/regression.test.ts`
   — focused suite covering the new contract.
3. `npx vitest run` — full unit suite.
4. `npm run build` — `tsup` repackages SKILL.md files into
   `dist/skills/builtin/`; verify the new frontmatter is bundled
   (`grep -R "agentTypes" dist/` must return zero).
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
   stash for `--- SAIVAGE KNOWLEDGE` — assert the planner's eager block
   contains `SKILL: planning` and not `SKILL: coding`, and vice versa.

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
- Land order: G43 → G42. If reversed, G42's targeting change would
  point the planner at the fictional plan format until G43 lands. With
  the recommended order, the planner gets G43's corrected body the
  moment G42 starts targeting it.
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
