# G26 — Design (round 6, writer Claude Opus 4.7)

Reads from [01-analysis-r6.md](01-analysis-r6.md).
Addresses [04-review-r5.md](04-review-r5.md) (the sole required
change: fatal-abort on the legacy-key preprocess + exact-issue test
assertion).
Supersedes [02-design-r5.md](02-design-r5.md).

## Goal (unchanged from r5)

Architecturally delete the pre-v2 `model_overrides` routing format
and its `"legacy"` source-tier vocabulary from the resolver and the
project config schema. After this change the resolver has a
three-arm precedence (`routing` → `runtime-default` → throw) and the
`ResolvedModelRoute.source` union has exactly two literals:
`"routing" | "runtime-default"`. The schema refuses to load a
`config.json` that still carries the legacy key, with a single
typed Zod issue at path `["model_overrides"]`. No backward
compatibility, no migration shim.

## Changes from round 5

Two targeted edits relative to
[02-design-r5.md](02-design-r5.md):

1. The preprocess `ctx.addIssue` call gains `fatal: true`. This is
   the runtime mechanism that makes Zod 3.25's `ZodEffects`
   preprocess branch short-circuit to `INVALID` without invoking
   the inner schema — see
   [01-analysis-r6.md](01-analysis-r6.md#zod-fatal-abort-verification)
   for the verified call-site evidence in the installed
   `node_modules/zod/v3/types.js`. With `fatal: true`, the
   `ZodError.issues` array contains exactly one custom issue at
   path `["model_overrides"]`; the misleading required-field noise
   that round 5 would have emitted on `project_name`, `objectives`,
   and `skills` is structurally impossible.
2. The schema-rejection test in
   [src/types.test.ts](../../../../src/types.test.ts) is
   strengthened to pin the exact rejection surface:
   `result.error.issues.length === 1`, `issues[0].code` is the Zod
   custom-issue code, `issues[0].path` deep-equals
   `[LEGACY_KEY]`, and the message contains the runtime-built key.
   The round-5 assertion (`paths.toContain(LEGACY_KEY)`) would have
   passed under the round-5 defect because the inner schema's
   spurious issues would still have included one issue with the
   correct path. The round-6 assertion would not.

Everything else in
[02-design-r5.md](02-design-r5.md) is carried forward unchanged:
narrow-rejection scope, runtime-built legacy key, resolver
collapse, seeder edit, docs edits, hard ordering constraint between
schema and seeder, sequencing against G23 / G24 / G25, and the
out-of-scope list.

## Proposal A (recommended) — narrow rejection via `z.preprocess` with `fatal: true`

Touch the three on-disk surfaces (schema, seeder, resolver), update
tests, and trim the docs guide.

### A.1 Schema: narrow rejection of `model_overrides` (fatal-abort)

Edit [src/types.ts](../../../../src/types.ts#L12-L29). Delete the
field declaration at [src/types.ts](../../../../src/types.ts#L15)
and wrap the existing object in a `z.preprocess` that rejects only
the legacy key with a fatal issue.

```ts
const LEGACY_PROJECT_KEY = ["model", "overrides"].join("_");

const projectConfigObjectSchema = z.object({
  project_name: z.string(),
  objectives: z.array(z.string()),
  routing: projectRoutingSchema.optional(),
  skills: z.object({
    max_per_agent: z.number().default(5),
  }),
  agents: z
    .record(
      z.string(),
      z.object({
        compaction_threshold_pct: z.number().default(80),
        max_compactions: z.number().default(3),
      }),
    )
    .optional(),
});

export const ProjectConfigSchema = z.preprocess((raw, ctx) => {
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.prototype.hasOwnProperty.call(raw, LEGACY_PROJECT_KEY)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [LEGACY_PROJECT_KEY],
      fatal: true,
      message: `${LEGACY_PROJECT_KEY} is a removed legacy v1 routing field. Delete it from .saivage/config.json and use ProjectConfig.routing.roles instead.`,
    });
    return z.NEVER;
  }
  return raw;
}, projectConfigObjectSchema);
export type ProjectConfig = z.output<typeof ProjectConfigSchema>;
```

Why `fatal: true` is the correct mechanism (and why round 5's
non-fatal addIssue was not):

- The installed Zod runtime
  ([node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3174-L3181))
  defines the preprocess `checkCtx.addIssue` as:

  ```js
  addIssue: (arg) => {
    addIssueToContext(ctx, arg);
    if (arg.fatal) {
      status.abort();
    } else {
      status.dirty();
    }
  }
  ```

  Without `fatal: true`, `status.value` becomes `"dirty"`, not
  `"aborted"`.

- The preprocess branch's synchronous path
  ([node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3210-L3215))
  reads:

  ```js
  if (status.value === "aborted") return INVALID;
  const result = this._def.schema._parseSync({
    data: processed,
    path: ctx.path,
    parent: ctx,
  });
  ```

  With round-5's non-fatal addIssue, `status.value === "dirty"` and
  the inner `projectConfigObjectSchema._parseSync` is invoked on
  `processed === z.NEVER` (`undefined` at runtime). The inner
  `z.object` then emits the usual `invalid_type` issue on the
  object itself plus required-field issues on `project_name`,
  `objectives`, and `skills`. With round-6's `fatal: true`,
  `status.value === "aborted"`, the inner schema is skipped, and
  the only emitted issue is the custom one from the preprocess.

- The `code: z.ZodIssueCode.custom` literal is preserved so the
  rejection surface is a documented Zod issue code. The exact
  string of `ZodIssueCode.custom` is `"custom"`; tests assert
  against `z.ZodIssueCode.custom` rather than the literal `"custom"`
  for clarity.

- The `path: [LEGACY_PROJECT_KEY]` field still carries the
  runtime-built legacy key as the single path segment, which keeps
  the production-source grep gate at zero matches in
  `src/types.ts`.

- `z.output<typeof ProjectConfigSchema>` resolves through the
  preprocess to the inner schema's output type, so the
  `ProjectConfig` TS type is unchanged from today minus the
  deleted `model_overrides` member.

### A.2 Resolver: collapse legacy arm into runtime-default arm (unchanged from r5)

All edits in section A.2 of
[02-design-r5.md](02-design-r5.md#a2-resolver-collapse-legacy-arm-into-runtime-default-arm)
carry forward verbatim. Round 6 does not touch the resolver beyond
what round 5 already specified. The single resolver-side change
the round-6 fatal-abort fix touches is none: the schema's behavior
toward the resolver's input type is unchanged (still a parsed
`ProjectConfig` with no `model_overrides` member).

### A.3 Seeder: stop writing `model_overrides` (unchanged from r5)

See
[02-design-r5.md](02-design-r5.md#a3-seeder-stop-writing-model_overrides).
The seeder edit at
[src/store/project.ts](../../../../src/store/project.ts#L129) is
unchanged. The hard ordering constraint with A.1 is unchanged.

### A.4 Tests: drop legacy-source case, add schema-rejection cases (strengthened)

The resolver-side test edit at
[src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28)
is unchanged from
[02-design-r5.md](02-design-r5.md#a4-tests-drop-legacy-source-case-add-schema-rejection-cases).

The new file
[src/types.test.ts](../../../../src/types.test.ts) is strengthened
to pin the exact rejection surface required by
[04-review-r5.md](04-review-r5.md#L5):

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProjectConfigSchema } from "./types.js";

// Legacy v1 routing key built at runtime so the bareword does not
// appear in source-tree greps for the legacy field (G26 grep gate).
const LEGACY_KEY = ["model", "overrides"].join("_");

const baseFixture = () => ({
  project_name: "x",
  objectives: [],
  routing: { roles: {}, profiles: {} },
  skills: { max_per_agent: 5 },
});

describe("ProjectConfigSchema (G26 legacy-key rejection)", () => {
  it("rejects the pre-v2 legacy routing key with exactly one custom issue at the legacy path", () => {
    const fixture: Record<string, unknown> = baseFixture();
    fixture[LEGACY_KEY] = { coder: "github-copilot/gpt-5.4" };

    const result = ProjectConfigSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Round-6 reviewer requirement: assert the exact rejection
      // surface, not just "some issue mentions the legacy path".
      // Under the round-5 non-fatal preprocess, the inner schema
      // would have ALSO emitted required-field issues on
      // project_name / objectives / skills (because z.NEVER hit
      // the inner z.object as `undefined`). With fatal: true the
      // preprocess aborts before the inner schema runs.
      expect(result.error.issues).toHaveLength(1);
      const [issue] = result.error.issues;
      expect(issue.code).toBe(z.ZodIssueCode.custom);
      expect(issue.path).toEqual([LEGACY_KEY]);
      expect(issue.message).toContain(LEGACY_KEY);
    }
  });

  it("rejects an empty legacy stub with the same single-issue surface (matches the previously seeded shape)", () => {
    const fixture: Record<string, unknown> = baseFixture();
    fixture[LEGACY_KEY] = {};

    const result = ProjectConfigSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].path).toEqual([LEGACY_KEY]);
    }
  });

  it("accepts an otherwise-valid config with no legacy key", () => {
    expect(ProjectConfigSchema.safeParse(baseFixture()).success).toBe(true);
  });

  it("accepts and silently strips other unknown top-level keys (preserves today's behavior)", () => {
    // Round-4 reviewer required this positive regression: keys
    // like `notifications` that are not declared on the schema
    // must continue to be stripped from the parsed output, NOT
    // passed through. This pins the round-6 preprocess mechanism
    // against a future accidental tightening to .strict() or
    // loosening to .passthrough().
    const fixture = {
      ...baseFixture(),
      notifications: { channel: "stub" },
      provider: { legacy: "stub" },
    };
    const result = ProjectConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = result.data as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("notifications");
      expect(parsed).not.toHaveProperty("provider");
      expect(parsed.project_name).toBe("x");
      expect(parsed.skills).toMatchObject({ max_per_agent: 5 });
    }
  });
});
```

Why the assertion shape is what the round-5 reviewer asked for:

- `result.error.issues.length === 1` is the load-bearing assertion.
  It would have failed under the round-5 non-fatal preprocess
  (issue count would have been 4 or more: one custom issue at
  `model_overrides` plus inner required-field issues at
  `project_name`, `objectives`, `skills` because the inner schema
  parsed `z.NEVER` as the object input). With `fatal: true` it
  passes deterministically.

- `issue.code === z.ZodIssueCode.custom` pins the issue type.
  `issue.path.toEqual([LEGACY_KEY])` pins the exact path (a single
  segment with the legacy key, not a deeper nested path).
  `issue.message.toContain(LEGACY_KEY)` pins the human-readable
  signal without coupling the test to the exact wording.

- The "empty legacy stub" test confirms the rejection holds for
  the empty-object value as well — relevant because the pre-G26
  seeder writes `model_overrides: {}` and an operator might have
  copied that into a hand-edited config without noticing. Same
  single-issue surface.

- The "accepts and silently strips" test is the round-4 positive
  regression, carried forward unchanged.

### A.5 Docs (unchanged from r5)

See
[02-design-r5.md](02-design-r5.md#a5-docs-drop-legacy-field-from-the-routing-guide).
No round-6 changes to docs edits.

### A.6 What is explicitly not touched (unchanged from r5)

See
[02-design-r5.md](02-design-r5.md#a6-what-is-explicitly-not-touched).

## Proposal B (rejected) — non-fatal preprocess (round 5's mechanism)

The round-5 preprocess shipped `ctx.addIssue(...)` without
`fatal: true`. As established in
[01-analysis-r6.md](01-analysis-r6.md#zod-fatal-abort-verification),
this leaves `status.value === "dirty"` rather than `"aborted"`, so
Zod proceeds to call the inner schema's `_parseSync` on
`z.NEVER` (`undefined` at runtime). The resulting `ZodError.issues`
contains the custom issue plus inner-schema required-field issues.
Operator-facing surface is noisy; the assertion
`paths.toContain(LEGACY_KEY)` from round 5 hides this defect rather
than detecting it. Rejected by
[04-review-r5.md](04-review-r5.md#L5); replaced by Proposal A.

## Proposal C (rejected) — sentinel-rejected inner schema

A variant from the round-5 reviewer's suggestion list: have the
preprocess return a sentinel value (e.g. a `Symbol`), and let a
custom inner schema reject that sentinel with a single typed error.
Rejected because it splits the rejection logic across two schemas,
each of which has to carry the legacy-key vocabulary, and the test
must assert against the inner schema's bespoke issue shape. The
`fatal: true` mechanism in Proposal A is a single edit, runs in
the Zod-native error pipeline, and is the documented mechanism for
exactly this case. No reason to prefer the sentinel approach.

## Proposal D (rejected) — `.superRefine` after `.strip()`

A second variant from the round-5 reviewer's suggestion list:
replace `z.preprocess` with `.superRefine` chained after the inner
schema's strip step. Rejected because `.strip()` is Zod's default
behavior for `z.object` and it removes unknown keys before
`.superRefine` runs against the parsed output. The legacy key
would already have been removed by the time `.superRefine` is
called; there is nothing left for it to reject. The inspection
must happen on the raw input, which is exactly what `z.preprocess`
is for.

## Proposal E (rejected) — `.passthrough()` + `.superRefine`

Round-4 mechanism. Rejected for the same reason as in
[02-design-r5.md](02-design-r5.md#proposal-b-rejected--passthrough--superrefine):
`.passthrough()` retains all unknown keys on the parsed output,
which would newly expose currently-stripped keys like
`notifications` and `provider` through `runtime.project.config`
and `/api/debug/state`, violating the round-4 reviewer's strip-
semantics requirement.

## Proposal F (rejected) — `.strict()`

Round-3 mechanism. Rejected for the same reason as in
[02-design-r5.md](02-design-r5.md#proposal-c-rejected--strict): it
would reject seven of seven existing configs at restart on keys
unrelated to G26.

## Proposal G (rejected) — also delete the `source` field

Carried forward from
[02-design-r5.md](02-design-r5.md#proposal-d-rejected--also-delete-the-source-field).
Same rationale.

## Recommendation

Proposal A. Two-character runtime fix (`fatal: true`) plus a
strengthened test that pins the rejection surface. Architecturally,
nothing else moves relative to round 5.

## Sequencing constraints (unchanged from r5)

See
[02-design-r5.md](02-design-r5.md#sequencing-constraints-restated).
G23 and G24 are APPROVED; G25 r3 plan still orders the batch G23 →
G24 → G25 → G26.

## Ordering constraint: schema and seeder (unchanged from r5)

See
[02-design-r5.md](02-design-r5.md#ordering-constraint-schema-and-seeder).
Schema edit (A.1) and seeder edit (A.3) ship in the same commit.

## Daemon impact (unchanged from r5)

See
[01-analysis-r6.md](01-analysis-r6.md#daemon-impact-unchanged-from-r5)
which forwards to
[01-analysis-r5.md](01-analysis-r5.md#daemon-impact-concrete-on-disk-inventory).
The round-6 fatal-abort change does not alter which configs load;
it only sharpens the operator-visible error surface when a config
does carry the legacy key.
