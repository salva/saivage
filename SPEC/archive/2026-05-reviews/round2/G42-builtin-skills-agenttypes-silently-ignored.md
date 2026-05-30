# G42 — Built-in skills declare `agentTypes:` which the loader silently ignores

- **Subsystem**: skills (`skills/builtin/*/SKILL.md`, `src/knowledge/builtinWalker.ts`)
- **Category**: bug, schema drift between authoring docs and runtime
- **Severity**: high
- **Transversality**: every built-in skill, every agent role

## Summary

All four built-in `SKILL.md` files use a YAML frontmatter key `agentTypes:`
to declare which agent roles each skill applies to (coder, planner,
researcher). The skill loader (`builtinWalker.ts`) only understands
`target_agents:` and treats unrecognised keys as silent forward-compatibility
no-ops. Every built-in skill therefore reaches the runtime with an *empty*
role filter and the carefully scoped routing in each frontmatter is dead code.

## Evidence

Built-in skill frontmatter — all four declare `agentTypes`:

```
==> skills/builtin/coding/SKILL.md <==
agentTypes: [coder]

==> skills/builtin/mcp-authoring/SKILL.md <==
agentTypes: [coder]

==> skills/builtin/planning/SKILL.md <==
agentTypes: [planner]

==> skills/builtin/research/SKILL.md <==
agentTypes: [researcher]
```

See [skills/builtin/coding/SKILL.md](skills/builtin/coding/SKILL.md#L1-L7),
[skills/builtin/mcp-authoring/SKILL.md](skills/builtin/mcp-authoring/SKILL.md#L1-L7),
[skills/builtin/planning/SKILL.md](skills/builtin/planning/SKILL.md#L1-L7),
[skills/builtin/research/SKILL.md](skills/builtin/research/SKILL.md#L1-L7).

Loader only knows `target_agents` and silently drops unknown keys:

```ts
case "triggers":
case "target_agents":
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`${key} must be a string array`);
  }
  fm[key] = value;
  return;
…
default:
  // Unknown keys are silently ignored — forward compatibility.
  return;
```

[src/knowledge/builtinWalker.ts](src/knowledge/builtinWalker.ts#L100-L120)

Everywhere else in the codebase the field is `target_agents`:

[src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L213),
[src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L114),
[src/knowledge/integration.test.ts](src/knowledge/integration.test.ts#L381).

There are no tests that round-trip a real `skills/builtin/*/SKILL.md` through
the loader and assert the role filter is non-empty.

## Why this matters

The skills system has two jobs: (1) inject domain knowledge into agent prompts,
(2) keep that knowledge *targeted* so the planner doesn't see coding advice
and the coder doesn't see research-skill mnemonics. The second job is silently
broken for every shipped skill. The user-visible effects are: every agent that
loads built-ins receives every built-in (token bloat); skill authors who copy
the existing frontmatter pattern will reproduce the bug; and the `version:`
key — which also has no schema in the walker — masks the silent drop because
authors assume the parser is taking everything.

Note this is *forward-compatibility-style* silence: a typo'd field with the
documented "best-practice" name is treated identically to a future key. That
is exactly the failure mode `default: // silently ignored` is designed to hide.

## Rough remediation direction

Pick one canonical name (`target_agents` matches the rest of the codebase and
the on-disk skill record schema, so use that) and rewrite every built-in's
frontmatter. Add a tiny round-trip test that loads each
`skills/builtin/*/SKILL.md` and asserts the parsed `target_agents` is
non-empty for the ones that declare a role filter. Drop the silent
`default: ignore` branch in `assignFrontmatterKey` and instead reject unknown
keys with a clear error pointing at the file — built-in skills are an
internal-only authoring surface, forward compatibility is not a real concern.

**Level up**: parse the frontmatter with a Zod schema (matching how runtime
skill records are validated in `lifecycle.ts`) so the YAML shape is checked
against the *same* type that the rest of the knowledge subsystem consumes.
Today the walker has its own private `BuiltinFrontmatter` interface that is
allowed to drift from `SkillRecord` — a Zod schema makes drift a compile
error, not a silent runtime behaviour.

## Cross-links

- G43 — `planning` skill content is also wrong (fictional plan format);
  combined with this bug, the planner is somehow both unaffected by the bad
  content and unaffected by the intended targeting.
- F24 (builtin skills) — Round 1 covered the existence of the built-in skill
  pipeline but not the frontmatter / loader contract drift.
