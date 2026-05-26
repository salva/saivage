# G42 — Analysis r2 (built-in skill frontmatter silently ignored)

Round-2 review of r1 returned VERDICT: CHANGES_REQUESTED with three
findings, all on the design and plan. The analysis itself was marked
verified-good; r2 carries it forward with one expansion in §9 to make
the docs-rewrite scope match the actual rot, and one expansion in §5 to
note that the schema must make `target_agents` a required key (no
default `[]`) — both feeding the r2 design.

## 1. What G42 reports, in the loader's own words

The filed evidence says `src/knowledge/builtinWalker.ts` understands
`target_agents:` but not `agentTypes:`, so the four shipped SKILL.md files
declaring `agentTypes:` all reach the runtime with an empty role filter.
That is accurate, but it understates the bug.

## 2. Two `walkBuiltinSkills` exist; only one is wired

```
saivage/src/knowledge/
├── builtinWalker.ts           ← parses YAML frontmatter (target_agents, …)
│                                  imported only by loader.test.ts
└── eagerLoader.ts             ← production code path
        └── walkBuiltinSkills  ← does NOT parse frontmatter at all
```

- [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L1-L181)
  exports `parseSkillFrontmatter`, `walkBuiltinSkills`,
  `builtinAsSkillRecord`. The only importer in the tree is the test file
  [src/knowledge/loader.test.ts](../../../../src/knowledge/loader.test.ts#L21).
  No production module imports it. Verified via
  `rg -n "from .*builtinWalker"` — single hit, test-only.
- [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122)
  defines its own `walkBuiltinSkills(builtinRoot, out)`. It is the one
  called by `loadAllCandidates`
  ([src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L142-L151)),
  which is invoked from every agent's `buildEagerBlock` /
  `buildSurvivorBlock` site
  ([src/agents/base.ts](../../../../src/agents/base.ts#L32),
  [src/agents/coder.ts](../../../../src/agents/coder.ts#L12),
  [src/agents/planner.ts](../../../../src/agents/planner.ts#L19),
  [src/agents/manager.ts](../../../../src/agents/manager.ts#L22),
  [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L12),
  [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L12),
  [src/agents/inspector.ts](../../../../src/agents/inspector.ts#L19),
  [src/agents/designer.ts](../../../../src/agents/designer.ts#L12),
  [src/agents/chat.ts](../../../../src/agents/chat.ts#L33),
  [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L11)).

The production `walkBuiltinSkills` reads the SKILL.md file as UTF-8 and
shoves the entire contents — frontmatter delimiters and all — into the
record's `body` while synthesising every field from the directory name:

```ts
// src/knowledge/eagerLoader.ts:93-122
const rec: SkillRecord = SkillRecordSchema.parse({
  …
  name: topic,                                  // dir name
  description: `Built-in skill: ${topic}`,      // synthetic, ignores `description:`
  triggers: [topic],                            // single token, ignores `triggers:`
  target_agents: [],                            // empty, ignores `target_agents:` AND `agentTypes:`
  …
});
out.push({ record: rec, body, origin: "builtin" });
```

Consequence: **the production loader does not parse frontmatter at all.**
Every key — `name`, `description`, `triggers`, `target_agents`,
`agentTypes`, `version`, `dependencies`, `survive_compaction`, anything
else an author writes — is dead. The body the LLM sees still contains the
raw `---\nname: …\n---` block as Markdown text.

## 3. Why the issue still says "loader accepts `target_agents:` but not `agentTypes:`"

Because the issue was written against `builtinWalker.ts` — which *would*
distinguish the two if it were actually called. The hand-off from
`builtinWalker.ts` (the historical / "designed") to
`eagerLoader.walkBuiltinSkills` (the de facto) is the underlying
architectural drift. Once the production walker was added it shadowed the
proper frontmatter parser, and only the test file kept the original alive.

## 4. Frontmatter inventory — every shipped SKILL.md

All four production SKILL.md files use `agentTypes:` (not `target_agents:`).
There is no `skills/external/` directory in the bundle — only
`skills/builtin/`.

| File | `agentTypes:` | `target_agents:` | `triggers:` | `description:` | `version:` | `dependencies:` | Loader-recognised? |
|---|---|---|---|---|---|---|---|
| [skills/builtin/coding/SKILL.md](../../../../skills/builtin/coding/SKILL.md#L1-L7) | `[coder]` | — | yes | yes | `0.1.0` | — | **No** (none of the keys reach the runtime) |
| [skills/builtin/mcp-authoring/SKILL.md](../../../../skills/builtin/mcp-authoring/SKILL.md#L1-L7) | `[coder]` | — | yes | yes | `0.1.0` | `[coding]` | **No** |
| [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L1-L7) | `[planner]` | — | yes | yes | `0.1.0` | — | **No** |
| [skills/builtin/research/SKILL.md](../../../../skills/builtin/research/SKILL.md#L1-L7) | `[researcher]` | — | yes | yes | `0.1.0` | — | **No** |

Loader-recognised summary: **0 / 4**. Every shipped frontmatter is dead.
Loader-silently-ignored: **4 / 4** — and silently in the strongest sense,
because the loader does not look at the frontmatter dictionary at all, it
just reads the file as a Markdown blob.

## 5. Independent contracts in the codebase

For comparison, four contracts already encode the *intended* shape of the
frontmatter:

- `SkillRecord` schema —
  [src/knowledge/types.ts](../../../../src/knowledge/types.ts#L101-L114).
  `target_agents` is the canonical field name across the in-memory record
  and the on-disk JSON store. In the runtime schema `target_agents`
  carries a default `[]` because some on-disk JSON records are genuinely
  global; the *frontmatter* contract for built-in `SKILL.md` files does
  not need that default and the design r2 makes it a required key (a
  global built-in must be expressed as the explicit empty list `[]`).
- `BuiltinFrontmatter` interface —
  [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L18-L23).
  Pre-fork frontmatter parser, knows `target_agents`, never called.
- MCP create/update tools —
  [src/mcp/knowledgeSkills.ts](../../../../src/mcp/knowledgeSkills.ts#L49-L70),
  [src/mcp/knowledgeMemory.ts](../../../../src/mcp/knowledgeMemory.ts#L42-L63).
  Tool schemas accept `target_agents` only.
- Author-facing convention doc —
  [SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md#L27)
  documents the field as `target_agents:`. The four bundled SKILL.md files
  contradict their own SPEC.

The de facto field name `agentTypes:` is a hallucination — it appears in
**no** TypeScript, no schema, no spec, and is rejected by neither parser
(because one is dead and the other reads no frontmatter).

## 6. Test landscape

- [src/knowledge/loader.test.ts](../../../../src/knowledge/loader.test.ts#L337-L410)
  exhaustively tests `parseSkillFrontmatter` /
  `walkBuiltinSkills(builtinWalker.ts)`. These tests pass and prove
  nothing about production behaviour.
- [src/knowledge/eagerLoader.test.ts](../../../../src/knowledge/eagerLoader.test.ts#L73)
  has `walkBuiltinSkills picks up bundled SKILL.md` but only asserts that
  *some* candidate is loaded, not that the role filter is correctly
  applied from the frontmatter — confirmed by reading the assertion: the
  test would pass with the current empty-`target_agents` behaviour.
- No agent-level test asserts that the planner gets the `planning` skill
  and the coder does not get the `planning` skill. This is the test gap
  that has hidden the bug since WI-16.

## 7. Why this matters

The skills subsystem has two jobs: inject domain knowledge into prompts
and keep that knowledge targeted. Job 2 has never run in production for
built-in skills. The user-visible consequences:

1. Every agent that builds an eager block receives every built-in skill
   ([src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L243-L246)
   short-circuits on `target_agents.length === 0`). Four skills × every
   role = bloated context for everybody.
2. The frontmatter `description` is replaced by `"Built-in skill: <dir>"`,
   so the survivor-summary block —
   [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L182-L191)
   — shows a string that is *not* the author's description.
3. The `--- … ---` YAML preamble is shipped as part of the prompt body,
   so every agent reads literal `agentTypes: [coder]` Markdown lines.
4. Triggers are `[<topic>]`, i.e. literal `"coding"`, `"planning"`,
   `"research"`, `"mcp-authoring"`. Trigger scoring
   ([src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L57-L80))
   expects `kind:value` form (`keyword:…`, `tag:…`, `agent:…`); a bare
   `"coding"` matches nothing, so the trigger-based scoring is also dead.
   Skills survive into the eager pool only because `survive_compaction`
   evaluation in
   [src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L246-L251)
   still admits triggerless skills.

## 8. Interaction with G43

[../G43-planning-skill-fictional-plan-format.md](../G43-planning-skill-fictional-plan-format.md)
documents that `planning` SKILL.md teaches a fictional plan format. The
planner does not notice today because the *content* of `planning` skill is
delivered (as a non-targeted blob) to every agent — but the planner's
prompt already drives it through the real MCP `plan_*` tools. Both bugs
are dormant: G42 lets the broken content reach every agent including the
planner; G43 puts wrong content in one of the four blobs. Fixing G42's
loader without fixing G43 would re-target the broken content to *exactly*
the planner.

## 9. Scope of files touched by any fix

Code surface:

- `src/knowledge/eagerLoader.ts` — the production walker; must learn to
  parse frontmatter.
- `src/knowledge/builtinWalker.ts` — currently dead code; deleted.
- `src/knowledge/loader.test.ts` — its `builtinWalker` import disappears.
- `src/knowledge/eagerLoader.test.ts` — needs a real round-trip
  assertion on each shipped SKILL.md, plus a negative test for missing
  `target_agents`.
- `skills/builtin/*/SKILL.md` × 4 — keys normalised to one canonical
  spelling and `target_agents` written explicitly on every file.

Author-facing docs surface (expanded in r2 in response to the round-2
review finding that two of these docs preserve the *entire* old loader
architecture, not just an outdated file pointer):

- [SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md#L27)
  — author-facing convention reference; `target_agents:` canonical name
  must be documented as required.
- [SPEC/v2/06-SYSTEM-DESIGN.md](../../06-SYSTEM-DESIGN.md#L248) and
  [SPEC/v2/05-MCP-SERVICES.md](../../05-MCP-SERVICES.md#L284) — system
  design / MCP references that still call out the old walker file.
- [docs/internals/skill-loader.md](../../../../docs/internals/skill-loader.md#L1-L66)
  — the whole document is wrong, not just the pointer at L25. It
  references `src/skills/loader.ts` (no such path), `<project>/.saivage/skills/`
  as a discovery directory and `<saivage>/skills/` as the built-in root
  (the real paths are project memory under `.saivage/knowledge/` and
  built-in root `<saivage>/skills/builtin/`), describes
  `index.json`-registered built-ins (no built-in registry; the loader
  walks the directory), and documents a `SkillMatchContext`/top-N
  selector signature plus an object-shaped
  `triggers: {tags, keywords, tools}` schema. All of that pre-dates
  the knowledge-loader rewrite and must be replaced, not patched.
- [docs/guide/skills.md](../../../../docs/guide/skills.md#L1-L100) —
  same family of stale assertions: declares the built-in root as
  `<saivage>/skills/`, claims authors register skills in `index.json`,
  documents trigger schema as an object with `tags/keywords/tools`,
  describes top-N selection and the `--- SKILL: name ---` block format
  (the real block label, per `eagerLoader.ts`, is the survivor block
  header). The author-facing "self-extension" lifecycle still tells the
  Manager to patch `index.json`. Same fate: rewrite or delete.
