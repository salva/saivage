# G26 — Design (round 7, writer Claude Opus 4.7)

Reads from [01-analysis-r7.md](01-analysis-r7.md).
Addresses [04-review-r6.md](04-review-r6.md) (the sole required
change: pin the exact operator-facing message in the
schema-rejection test; tidy the non-fatal-path evidence).
Supersedes [02-design-r6.md](02-design-r6.md).

## Goal (unchanged)

See [02-design-r6.md](02-design-r6.md#goal-unchanged-from-r5).

## Changes from round 6

Two targeted edits relative to
[02-design-r6.md](02-design-r6.md):

1. The schema-rejection test in
   [src/types.test.ts](../../../../src/types.test.ts) pins the
   exact operator-facing message with `toBe`, built from the same
   template as the schema's `ctx.addIssue` message. Same
   assertion applies to the empty-legacy-stub fixture. The
   round-6 `toContain` assertion would have passed if a future
   change kept the legacy key in the message while degrading the
   remediation text; the round-7 `toBe` assertion would not.
2. The "Why `fatal: true` is the correct mechanism" evidence
   block in
   [02-design-r6.md](02-design-r6.md#L138-L150) is reworded to
   drop the "invalid_type issue on the object itself plus" claim
   for the non-fatal path. The installed Zod 3.25.76 runtime,
   under a non-fatal preprocess returning `z.NEVER`, emits the
   custom preprocess issue plus three required-field issues from
   the inner `z.object` — not an additional root invalid-type
   issue. That is enough evidence to motivate the fatal-abort
   fix; the extra wording was unnecessary and made the round-6
   evidence less crisp.

Everything else in [02-design-r6.md](02-design-r6.md) carries
forward unchanged: the schema body, the runtime-built legacy key,
the resolver collapse (A.2), the seeder edit (A.3), the docs
edits (A.5), the hard ordering constraint between schema and
seeder, the sequencing against G23 / G24 / G25, and the
out-of-scope list.

## Proposal A (recommended) — narrow rejection via `z.preprocess` with `fatal: true`

### A.1 Schema: narrow rejection of `model_overrides` (unchanged from r6)

The schema body is unchanged from
[02-design-r6.md](02-design-r6.md#a1-schema-narrow-rejection-of-model_overrides-fatal-abort).
The full literal is restated here only to make the test's
`EXACT_MESSAGE` template trivially auditable:

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

The operator-facing message template is the single string the
round-7 test pins with `toBe`. Any future change to the wording
will break the test at the assertion line, by design.

### Why `fatal: true` is the correct mechanism (reworded from r6)

The installed Zod runtime
([node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3174-L3181))
defines the preprocess `checkCtx.addIssue` so that
`status.abort()` runs whenever `arg.fatal` is set, and the
preprocess branch
([node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3210-L3215))
returns `INVALID` before calling the inner schema's
`_parseSync` when `status.value === "aborted"`.

Without `fatal: true`, `status.value === "dirty"` and the inner
`projectConfigObjectSchema._parseSync` is invoked on
`processed === z.NEVER` (`undefined` at runtime). The inner
`z.object` then emits the usual required-field issues on
`project_name`, `objectives`, and `skills`. The resulting
`ZodError.issues` array carries the custom preprocess issue plus
those three required-field issues — four issues for one operator
mistake. That is the round-5 defect the round-6 fatal-abort fix
resolved.

With `fatal: true`, `status.value === "aborted"`, the inner
schema is skipped entirely, and the only emitted issue is the
custom one from the preprocess. The
`code: z.ZodIssueCode.custom`, `path: [LEGACY_PROJECT_KEY]`, and
`message: ${LEGACY_PROJECT_KEY} ...` literal are preserved from
the round-6 design. `z.output<typeof ProjectConfigSchema>` still
resolves through the preprocess to the inner schema's output
type, so the `ProjectConfig` TS type is unchanged from today
minus the deleted `model_overrides` member.

### A.2 Resolver: collapse legacy arm (unchanged)

See [02-design-r5.md](02-design-r5.md#a2-resolver-collapse-legacy-arm-into-runtime-default-arm).

### A.3 Seeder: stop writing `model_overrides` (unchanged)

See [02-design-r5.md](02-design-r5.md#a3-seeder-stop-writing-model_overrides).
The seeder edit at
[src/store/project.ts](../../../../src/store/project.ts#L129) is
unchanged.

### A.4 Tests (round-7 strengthening of the message assertion)

The resolver-side test edit at
[src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28)
is unchanged from
[02-design-r5.md](02-design-r5.md#a4-tests-drop-legacy-source-case-add-schema-rejection-cases).

The new file
[src/types.test.ts](../../../../src/types.test.ts) is strengthened
relative to [02-design-r6.md](02-design-r6.md#L213-L218): both
rejection tests assert the full single-issue surface with the
exact operator-facing message via `toBe`.

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProjectConfigSchema } from "./types.js";

// Legacy v1 routing key built at runtime so the bareword does not
// appear in source-tree greps for the legacy field (G26 grep gate).
const LEGACY_KEY = ["model", "overrides"].join("_");

// Exact operator-facing message the schema's ctx.addIssue emits.
// Built from the same template as src/types.ts so a future change
// to the wording or to the legacy key fails this test at toBe.
const EXACT_MESSAGE = `${LEGACY_KEY} is a removed legacy v1 routing field. Delete it from .saivage/config.json and use ProjectConfig.routing.roles instead.`;

const baseFixture = () => ({
  project_name: "x",
  objectives: [],
  routing: { roles: {}, profiles: {} },
  skills: { max_per_agent: 5 },
});

describe("ProjectConfigSchema (G26 legacy-key rejection)", () => {
  it("rejects the pre-v2 legacy routing key with exactly one custom issue at the legacy path with the exact operator-facing message", () => {
    const fixture: Record<string, unknown> = baseFixture();
    fixture[LEGACY_KEY] = { coder: "github-copilot/gpt-5.4" };

    const result = ProjectConfigSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Round-7 reviewer requirement: pin the FULL message with
      // toBe, not just toContain(LEGACY_KEY). A future change
      // that keeps the key in the message while degrading the
      // remediation text would have passed the round-6
      // assertion; it does not pass this one.
      expect(result.error.issues).toHaveLength(1);
      const [issue] = result.error.issues;
      expect(issue.code).toBe(z.ZodIssueCode.custom);
      expect(issue.path).toEqual([LEGACY_KEY]);
      expect(issue.message).toBe(EXACT_MESSAGE);
    }
  });

  it("rejects an empty legacy stub with the same single-issue surface and exact message (matches the previously seeded shape)", () => {
    const fixture: Record<string, unknown> = baseFixture();
    fixture[LEGACY_KEY] = {};

    const result = ProjectConfigSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      const [issue] = result.error.issues;
      expect(issue.code).toBe(z.ZodIssueCode.custom);
      expect(issue.path).toEqual([LEGACY_KEY]);
      expect(issue.message).toBe(EXACT_MESSAGE);
    }
  });

  it("accepts an otherwise-valid config with no legacy key", () => {
    expect(ProjectConfigSchema.safeParse(baseFixture()).success).toBe(true);
  });

  it("accepts and silently strips other unknown top-level keys (preserves today's behavior)", () => {
    // Round-4 reviewer required this positive regression: keys
    // like `notifications` that are not declared on the schema
    // must continue to be stripped from the parsed output, NOT
    // passed through. Pins the preprocess mechanism against a
    // future accidental tightening to .strict() or loosening to
    // .passthrough().
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

Why the assertion shape is what the round-6 reviewer asked for:

- `result.error.issues.length === 1` remains the load-bearing
  assertion against any future regression of the round-6
  fatal-abort fix.
- `issue.message.toBe(EXACT_MESSAGE)` is the new round-7
  contract. It pins the operator-facing string in full, including
  the remediation pointer to `.saivage/config.json` and
  `ProjectConfig.routing.roles`. The `EXACT_MESSAGE` constant is
  built from the same template the schema uses, so the test
  source still does not carry the bareword `model_overrides` and
  the file-scoped grep gate stays at zero.
- The empty-legacy-stub test now applies the same full
  single-issue surface assertion (code, path, message) to prove
  both legacy shapes (`{}` and `{ coder: ... }`) produce
  identical rejection output.
- The "accepts and silently strips" round-4 positive regression
  is unchanged.

### A.5 Docs (unchanged)

See [02-design-r5.md](02-design-r5.md#a5-docs-drop-legacy-field-from-the-routing-guide).

### A.6 What is explicitly not touched (unchanged)

See [02-design-r5.md](02-design-r5.md#a6-what-is-explicitly-not-touched).

## Proposals B–G (rejected, unchanged)

See [02-design-r6.md](02-design-r6.md#proposal-b-rejected--non-fatal-preprocess-round-5s-mechanism)
through
[02-design-r6.md](02-design-r6.md#proposal-g-rejected--also-delete-the-source-field).

## Recommendation

Proposal A. The round-7 delta is one new constant
(`EXACT_MESSAGE`), two strengthened assertions
(`issue.message.toBe(EXACT_MESSAGE)`), and a reworded
non-fatal-path evidence block. No architectural decision is
reopened.

## Sequencing constraints (unchanged)

See [02-design-r5.md](02-design-r5.md#sequencing-constraints-restated).

## Ordering constraint: schema and seeder (unchanged)

See [02-design-r5.md](02-design-r5.md#ordering-constraint-schema-and-seeder).

## Daemon impact (unchanged)

See [01-analysis-r6.md](01-analysis-r6.md#daemon-impact-unchanged-from-r5).
The round-7 edits do not alter which configs load. The
operator-visible rejection surface is identical to round 6; only
the test's assertion against that surface is stricter.
