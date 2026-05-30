# G42 — Design r1 (two options + recommendation)

## Shared context

The production loader
([src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122))
does not parse frontmatter at all. The parallel parser in
[src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L1-L181)
is test-only dead code. Both options below delete one of the two walkers
and fix the field mismatch. They differ in how strictly the frontmatter
schema is enforced and how heavily we lean on Zod.

Both options drop the `agentTypes:` spelling from disk and pick
`target_agents:` as canonical (it already matches `SkillRecord`,
`SkillRecordSchema`, every MCP tool schema, every test fixture, and the
author-facing spec at
[SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md#L27)).
Per the workspace architecture-first rule there are no migration shims —
the four shipped SKILL.md files are rewritten in-place to use the
canonical spelling regardless of which option is chosen.

---

## Option A — Minimal fix: teach the production walker the existing keys

### Idea

Make `eagerLoader.walkBuiltinSkills` actually parse frontmatter via the
existing `parseSkillFrontmatter` parser. Delete `builtinAsSkillRecord`
and merge the projection into the production walker. Keep the parser's
existing key set (`name`, `description`, `triggers`, `target_agents`,
`survive_compaction`); explicitly reject unknown keys instead of silently
ignoring them.

### Files touched

- [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122)
  — replace synthesised fields with frontmatter-derived ones; strip the
  YAML preamble from `body`.
- [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L1-L181)
  — keep `parseSkillFrontmatter` only; move it into `eagerLoader.ts` and
  delete the file. Drop `BuiltinFrontmatter`, `BuiltinSkillRaw`,
  `walkBuiltinSkills`, `builtinAsSkillRecord`. Change
  `assignFrontmatterKey`'s `default:` branch from
  `return;` to `throw new Error("unknown frontmatter key: " + key + " in " + path)`.
- [src/knowledge/loader.test.ts](../../../../src/knowledge/loader.test.ts#L21)
  — the import-from-`builtinWalker` line and the `parseSkillFrontmatter`
  / `walkBuiltinSkills + builtinAsSkillRecord` describe blocks
  (lines 337–410) re-target `parseSkillFrontmatter` at its new home.
- [src/knowledge/eagerLoader.test.ts](../../../../src/knowledge/eagerLoader.test.ts#L73)
  — add a round-trip assertion that loads every real
  `skills/builtin/*/SKILL.md` and checks `target_agents`, `description`,
  `triggers` against the file's frontmatter.
- [skills/builtin/coding/SKILL.md](../../../../skills/builtin/coding/SKILL.md#L1-L7),
  [skills/builtin/mcp-authoring/SKILL.md](../../../../skills/builtin/mcp-authoring/SKILL.md#L1-L7),
  [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L1-L7),
  [skills/builtin/research/SKILL.md](../../../../skills/builtin/research/SKILL.md#L1-L7)
  — rename `agentTypes:` → `target_agents:`; drop `version:` and
  `dependencies:` (the parser will throw on unknown keys; nothing in the
  loader consumes them today).

### Deletion list

- `src/knowledge/builtinWalker.ts` (entire file).
- `BuiltinFrontmatter`, `BuiltinSkillRaw`, `walkBuiltinSkills(string)`,
  `builtinAsSkillRecord` symbols.
- The `// Unknown keys are silently ignored — forward compatibility.`
  no-op in `assignFrontmatterKey`.
- `version:` and `dependencies:` keys from all four shipped SKILL.md
  files (no consumer; would otherwise trip the new error).
- The hand-written `walkBuiltinSkills + builtinAsSkillRecord` describe
  block in [src/knowledge/loader.test.ts](../../../../src/knowledge/loader.test.ts#L376-L410)
  — replaced with assertions in `eagerLoader.test.ts` that round-trip the
  real bundle.

### Test impact

- The existing `parseSkillFrontmatter` tests
  ([src/knowledge/loader.test.ts](../../../../src/knowledge/loader.test.ts#L337-L373))
  keep passing, modulo import path change.
- The `walkBuiltinSkills + builtinAsSkillRecord` fixture test
  ([src/knowledge/loader.test.ts](../../../../src/knowledge/loader.test.ts#L376-L410))
  is replaced by a real-bundle test in `eagerLoader.test.ts`.
- A new test asserts that for each shipped SKILL.md the produced
  `SkillRecord.target_agents` is exactly the role declared in the file
  (`coding → [coder]`, `mcp-authoring → [coder]`, `planning → [planner]`,
  `research → [researcher]`).
- A new test asserts the body does NOT contain `---\n` (i.e. the
  frontmatter was stripped, not shipped as Markdown).
- A new negative test asserts that an unknown frontmatter key
  (`agentTypes:`, `version:`, `foo:`) raises a clear error pointing at
  the offending file.

### Trade-offs

- Cheapest patch; touches a contained surface.
- Still leaves the walker maintaining its own ad-hoc YAML subset parser
  and its own `BuiltinFrontmatter` type that can drift from
  `SkillRecordSchema` again. There is no compile-time link between "what
  the parser accepts" and "what `SkillRecord` requires"; a future field
  added to the schema will silently not be parseable from SKILL.md.

---

## Option B — Strict typed schema with Zod (architectural fix)

### Idea

Define the SKILL.md frontmatter contract once as a Zod schema that
projects directly to a subset of `SkillRecord`. Replace the hand-rolled
`parseSkillFrontmatter` with a tiny YAML→object pass that hands the
object to the Zod schema, and let Zod enforce: (a) required keys,
(b) types, (c) `agentTypes`/`version`/`dependencies`/unknown-key
rejection via `.strict()`, (d) `target_agents` is the canonical name and
its values must be `KnowledgeAgentRole`s.

The walker becomes a thin orchestration step:

```ts
// new src/knowledge/eagerLoader.ts
const BuiltinSkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  triggers: z.array(z.string()).default([]),
  target_agents: z.array(KnowledgeAgentRoleSchema).default([]),
  survive_compaction: z.boolean().default(false),
}).strict();

type BuiltinSkillFrontmatter = z.infer<typeof BuiltinSkillFrontmatterSchema>;

export async function walkBuiltinSkills(builtinRoot, out) {
  …
  const { frontmatter, body } = splitFrontmatter(raw);          // pure split
  const fm = BuiltinSkillFrontmatterSchema.parse(yaml.load(frontmatter));
  out.push({
    record: SkillRecordSchema.parse({ …skeleton, …fm, origin: "builtin" }),
    body, origin: "builtin",
  });
}
```

The YAML parser becomes whatever we already import (we have no `yaml`
dependency today — Option B opts for the existing tiny subset parser
kept *only* as a `Record<string, unknown>` producer, with the Zod schema
doing all type/key enforcement; the parser stays ~30 lines, the schema
takes over validation).

### Files touched

All of Option A's, plus:

- [src/knowledge/types.ts](../../../../src/knowledge/types.ts#L101-L114)
  — export `BuiltinSkillFrontmatterSchema` next to `SkillRecordSchema`
  so the runtime contract lives with the rest of the knowledge types.
- [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122)
  — rewrite `walkBuiltinSkills` to do split → load → schema-parse →
  spread; remove every synthesised string (`Built-in skill: ${topic}`
  goes; `triggers: [topic]` goes; `target_agents: []` goes).
- [src/knowledge/eagerLoader.test.ts](../../../../src/knowledge/eagerLoader.test.ts#L73)
  — same real-bundle round-trip as Option A, plus a positive assertion
  that `BuiltinSkillFrontmatterSchema.safeParse` rejects each unknown
  key in turn.

### Deletion list (additive to Option A)

- `parseSkillFrontmatter` (replaced by `splitFrontmatter` + Zod).
- The whole `assignFrontmatterKey` switch — Zod enforces types.
- Author-facing prose in
  [docs/internals/skill-loader.md](../../../../docs/internals/skill-loader.md#L25),
  [docs/guide/skills.md](../../../../docs/guide/skills.md#L26),
  [SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md#L27)
  — purge any "forward-compatibility" language; document the closed set.

### Test impact

Superset of Option A's:

- All existing `parseSkillFrontmatter` tests are replaced by direct
  schema tests that exercise `BuiltinSkillFrontmatterSchema.safeParse`
  on the same fixtures (cheaper and tighter — Zod gives structured
  errors).
- A new `eagerLoader.test.ts` block walks the real `skills/builtin/`
  directory shipped in the repo and asserts every SKILL.md round-trips
  with no warnings and the expected role filter.
- A `regression.test.ts` block (already present at
  [src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts#L9))
  gains an assertion that asking each agent role for its eager block
  returns the correct subset of built-ins (planner → planning only, the
  other roles → their declared ones).

### Trade-offs

- Single source of truth: the schema in `types.ts` is the contract the
  parser, the walker, the MCP tool layer, and the JSON store all share.
- Adding a new frontmatter key is one Zod field; the loader picks it up
  automatically because the spread copies whatever Zod admitted.
- Strict mode (`.strict()`) is the loud-fail this whole finding wants —
  there is no "default: silently ignore" branch anywhere in the path.

---

## Recommendation: Option B

Option A fixes the visible symptom of G42. Option B fixes the
architectural drift that caused the symptom in the first place (two
walkers, a hand-rolled type that can diverge from `SkillRecord`, and a
silent-ignore default policy). The workspace's architecture-first rule
explicitly forbids "minimal change" defaults; Option B is the conceptual
level-up requested by the prompt.

Effort delta is small: Option B's only extra code is the Zod schema
(~10 lines, in a file that already imports `KnowledgeAgentRoleSchema`)
and replacing `assignFrontmatterKey` (a 25-line switch) with
`BuiltinSkillFrontmatterSchema.parse(…)` (one line). Test cost is lower
because Zod's error messages are structured.

Cross-finding note: G43 rewrites the `planning` SKILL.md body. Under
Option B, that rewrite must keep the (now-required) `target_agents:` key
present and well-typed — see
[03-plan-r1.md](./03-plan-r1.md) for the joint sequencing.
