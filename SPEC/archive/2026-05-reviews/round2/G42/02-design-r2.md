# G42 — Design r2 (Option B, tightened)

## Round-2 deltas vs [02-design-r1.md](./02-design-r1.md)

The round-1 review accepted Option B but flagged that the Zod sketch
still let `target_agents` default to `[]`, which keeps the silent-global
failure mode the finding is trying to remove. r2 makes
`target_agents` a *required* frontmatter key on built-in skills and
gives the round-trip test a negative case for the omitted-key shape.
No other architectural change; the recommendation is still Option B.

## Shared context

The production loader
([src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122))
does not parse frontmatter at all. The parallel parser in
[src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L1-L181)
is test-only dead code. The chosen option deletes one of the two walkers
and fixes the field mismatch.

The canonical key name on disk is `target_agents:` — it already matches
`SkillRecord`, `SkillRecordSchema`, every MCP tool schema, every test
fixture, and the author-facing spec at
[SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md#L27).
Per the workspace architecture-first rule there are no migration shims;
the four shipped SKILL.md files are rewritten in-place to use the
canonical spelling and to declare `target_agents` explicitly.

---

## Option A — Minimal fix: teach the production walker the existing keys

(Kept here for the historical record; the recommendation below is still
Option B.)

### Idea

Make `eagerLoader.walkBuiltinSkills` actually parse frontmatter via the
existing `parseSkillFrontmatter` parser. Delete `builtinAsSkillRecord`
and merge the projection into the production walker. Keep the parser's
existing key set (`name`, `description`, `triggers`, `target_agents`,
`survive_compaction`); explicitly reject unknown keys instead of silently
ignoring them. Treat `target_agents` as required (no default).

### Trade-offs

Cheapest patch; touches a contained surface. Still leaves the walker
maintaining its own ad-hoc YAML subset parser and its own
`BuiltinFrontmatter` type that can drift from `SkillRecordSchema` again.
There is no compile-time link between "what the parser accepts" and
"what `SkillRecord` requires"; a future field added to the schema will
silently not be parseable from SKILL.md.

---

## Option B — Strict typed schema with Zod (architectural fix, recommended)

### Idea

Define the SKILL.md frontmatter contract once as a Zod schema that
projects directly to a subset of `SkillRecord`. Replace the hand-rolled
`parseSkillFrontmatter` with a tiny YAML→object pass that hands the
object to the Zod schema, and let Zod enforce: (a) required keys —
including `target_agents`, (b) types, (c) `agentTypes` / `version` /
`dependencies` / unknown-key rejection via `.strict()`, (d)
`target_agents` is the canonical name and its values must be
`KnowledgeAgentRole`s.

The walker becomes a thin orchestration step:

```ts
// src/knowledge/eagerLoader.ts
const BuiltinSkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  triggers: z.array(z.string()).default([]),
  target_agents: z.array(KnowledgeAgentRoleSchema),       // REQUIRED, no default
  survive_compaction: z.boolean().default(false),
}).strict();

type BuiltinSkillFrontmatter = z.infer<typeof BuiltinSkillFrontmatterSchema>;

export async function walkBuiltinSkills(builtinRoot, out) {
  …
  const { frontmatter, body } = splitFrontmatter(raw);          // pure split
  const fm = BuiltinSkillFrontmatterSchema.parse(loadYamlSubset(frontmatter));
  out.push({
    record: SkillRecordSchema.parse({ …skeleton, ...fm, origin: "builtin" }),
    body, origin: "builtin",
  });
}
```

`target_agents` has no `.default([])`. A SKILL.md that omits the key is
a hard parse error pointing at the file path. A built-in that is
genuinely global must declare `target_agents: []` explicitly — and the
docs (Step 7 of the plan) say so. The runtime
`SkillRecordSchema.target_agents` keeps its `.default([])` because
per-project on-disk JSON records still represent global skills that
way; the built-in *frontmatter* contract is tighter than the runtime
record contract on purpose.

### Files touched

- [src/knowledge/types.ts](../../../../src/knowledge/types.ts#L101-L114)
  — export `BuiltinSkillFrontmatterSchema` next to `SkillRecordSchema`
  so the runtime contract lives with the rest of the knowledge types.
- [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122)
  — rewrite `walkBuiltinSkills` to do split → load YAML subset →
  schema-parse → spread; remove every synthesised string
  (`Built-in skill: ${topic}` goes; `triggers: [topic]` goes;
  `target_agents: []` goes).
- [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L1-L181)
  — file deleted; only the YAML-subset tokeniser (≈30 lines) is moved
  into a private helper inside `eagerLoader.ts`. `BuiltinFrontmatter`,
  `BuiltinSkillRaw`, `walkBuiltinSkills`,
  `builtinAsSkillRecord`, `parseSkillFrontmatter`,
  `assignFrontmatterKey` and the silent-ignore default branch all go.
- [src/knowledge/loader.test.ts](../../../../src/knowledge/loader.test.ts#L21)
  — the import-from-`builtinWalker` line and the
  `parseSkillFrontmatter` / `walkBuiltinSkills + builtinAsSkillRecord`
  describe blocks (lines 337–410) deleted. Replacement assertions live
  in `eagerLoader.test.ts` (see below).
- [src/knowledge/eagerLoader.test.ts](../../../../src/knowledge/eagerLoader.test.ts#L73)
  — add a real-bundle round-trip plus a negative test that asserts
  loading a SKILL.md with no `target_agents:` key raises a Zod parse
  error naming the offending file.
- [skills/builtin/coding/SKILL.md](../../../../skills/builtin/coding/SKILL.md#L1-L7),
  [skills/builtin/mcp-authoring/SKILL.md](../../../../skills/builtin/mcp-authoring/SKILL.md#L1-L7),
  [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L1-L7),
  [skills/builtin/research/SKILL.md](../../../../skills/builtin/research/SKILL.md#L1-L7)
  — rename `agentTypes:` → `target_agents:`; drop `version:` and
  `dependencies:` (the strict schema will reject them); normalise
  triggers to `kind:value` form.

### Deletion list

- `src/knowledge/builtinWalker.ts` (entire file).
- `BuiltinFrontmatter`, `BuiltinSkillRaw`, `walkBuiltinSkills(string)`,
  `builtinAsSkillRecord`, `parseSkillFrontmatter`,
  `assignFrontmatterKey`, and the `// Unknown keys are silently
  ignored — forward compatibility.` no-op.
- The hand-written `walkBuiltinSkills + builtinAsSkillRecord` and
  `parseSkillFrontmatter` describe blocks in
  [src/knowledge/loader.test.ts](../../../../src/knowledge/loader.test.ts#L337-L410).
- `version:` and `dependencies:` keys from all four shipped SKILL.md
  files.

### Test impact

- A new test loads every real `skills/builtin/<topic>/SKILL.md` and
  asserts the produced `SkillRecord.target_agents` exactly matches the
  declared role (`coding → [coder]`, `mcp-authoring → [coder]`,
  `planning → [planner]`, `research → [researcher]`).
- A new test asserts the body does NOT start with `---\n` (frontmatter
  stripped, not shipped as Markdown).
- A new negative test asserts that a fixture SKILL.md missing
  `target_agents:` raises a Zod error whose message includes the file
  path and `"target_agents"`. (This is the round-1 review's
  "negative test for missing `target_agents`".)
- A second negative test asserts that an unknown frontmatter key
  (`agentTypes:`, `version:`, `foo:`) raises an equally loud error.
- The role-targeting check in `regression.test.ts`
  ([src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts#L9))
  asserts each agent role's eager block contains exactly the declared
  built-ins.

### Trade-offs

- Single source of truth: the schema in `types.ts` is the contract the
  parser, the walker, the MCP tool layer, and the JSON store all share.
- Strict mode (`.strict()`) plus a required `target_agents` is the
  loud-fail this whole finding wants — there is no
  "default: silently ignore" branch and no "default: global skill"
  branch anywhere in the path.
- Adding a new frontmatter key is one Zod field; the loader picks it up
  automatically because the spread copies whatever Zod admitted.

---

## Recommendation: Option B

Option A fixes the visible symptom of G42. Option B fixes the
architectural drift that caused the symptom (two walkers, a hand-rolled
type that can diverge from `SkillRecord`, a silent-ignore default
policy, and a silent-`target_agents`-default policy). The workspace's
architecture-first rule explicitly forbids "minimal change" defaults.

Effort delta is small: Option B's only extra code is the Zod schema
(~10 lines, in a file that already imports `KnowledgeAgentRoleSchema`)
and replacing `assignFrontmatterKey` (a 25-line switch) with
`BuiltinSkillFrontmatterSchema.parse(…)` (one line). Test cost is lower
because Zod's error messages are structured.

Cross-finding note: G43 rewrites the `planning` SKILL.md body. The
plan r2 makes G43 a hard prerequisite; there is no partial-state
fallback. See [03-plan-r2.md](./03-plan-r2.md).
