# G26 — Plan (round 7, writer Claude Opus 4.7)

Implements Proposal A from [02-design-r7.md](02-design-r7.md).
Supersedes [03-plan-r6.md](03-plan-r6.md). Addresses
[04-review-r6.md](04-review-r6.md) (the sole required change: pin
the exact operator-facing message in the schema-rejection test;
tidy the non-fatal-path evidence in the design).

## Changes from round 6

Two edits relative to [03-plan-r6.md](03-plan-r6.md):

- Task 4b's schema-rejection tests both assert
  `issue.message.toBe(EXACT_MESSAGE)`, where `EXACT_MESSAGE` is a
  runtime-built constant interpolated from the same template the
  schema's `ctx.addIssue` uses
  ([02-design-r7.md](02-design-r7.md#a1-schema-narrow-rejection-of-model_overrides-unchanged-from-r6)).
  The round-6 `toContain(LEGACY_KEY)` assertion
  ([03-plan-r6.md](03-plan-r6.md#L246-L250)) is replaced. The
  empty-legacy-stub test additionally asserts `issue.code` and
  `issue.message` so both legacy shapes prove the identical
  single-issue surface.
- The round-6 design's non-fatal-path evidence is reworded in
  round 7 to drop the unsupported "invalid_type issue on the
  object itself plus" clause
  ([02-design-r6.md](02-design-r6.md#L142-L149) →
  [02-design-r7.md](02-design-r7.md#why-fatal-true-is-the-correct-mechanism-reworded-from-r6)).
  This is a docs-only delta in the SPEC tree; no source-tree
  files change because of it.

Every other task, ordering constraint, grep gate, sequencing
note, and rollback policy is identical to
[03-plan-r6.md](03-plan-r6.md) and is summarised below for
self-containment rather than asking the reviewer to chase two
files.

## Touched files (unchanged from r6)

See [03-plan-r6.md](03-plan-r6.md#touched-files-unchanged-from-r5).
Identical set: [src/types.ts](../../../../src/types.ts),
[src/routing/resolver.ts](../../../../src/routing/resolver.ts),
[src/store/project.ts](../../../../src/store/project.ts),
[src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts),
[src/types.test.ts](../../../../src/types.test.ts), and the docs
guide files. `docs/api/**` and `docs/.vitepress/dist/**` are
build outputs.

## Sequencing dependency (unchanged)

See [03-plan-r5.md](03-plan-r5.md#sequencing-dependency).
G23 → G24 → G25 → G26.

## Hard ordering constraint: Task 1 + Task 3 ship together (unchanged)

See [03-plan-r6.md](03-plan-r6.md#hard-ordering-constraint-task-1--task-3-ship-together-unchanged-from-r5).
Schema legacy-key rejection and seeder field deletion land in the
same git commit.

## Grep-gate convention (unchanged)

See [03-plan-r5.md](03-plan-r5.md#grep-gate-convention). The new
`EXACT_MESSAGE` constant in
[src/types.test.ts](../../../../src/types.test.ts) is built via
interpolation of `${LEGACY_KEY}`, so the bareword
`model_overrides` still does not appear in the test source.

## Tasks (sequential)

### Task 1 — `ProjectConfigSchema` narrow rejection of the legacy key (unchanged from r6)

(Same commit as Task 3 per the hard ordering constraint.)

The schema body and grep gate are unchanged from
[03-plan-r6.md](03-plan-r6.md#task-1--projectconfigschema-narrow-rejection-of-the-legacy-key-fatal-abort).
The operator-facing message template is the literal string
`${LEGACY_PROJECT_KEY} is a removed legacy v1 routing field.
Delete it from .saivage/config.json and use
ProjectConfig.routing.roles instead.`
([02-design-r7.md](02-design-r7.md#L41-L57)). Round 7 does not
change a single character of the schema source.

Grep gate after this task:

```bash
grep -n 'model_overrides' src/types.ts
```

Must return zero matches.

### Task 2 — Resolver: collapse legacy arm (unchanged)

See [03-plan-r5.md](03-plan-r5.md#task-2--resolver-collapse-legacy-arm).

### Task 3 — Seeder: stop writing `model_overrides` (unchanged)

(Same commit as Task 1.)

See [03-plan-r5.md](03-plan-r5.md#task-3--seeder-stop-writing-model_overrides).
Delete the `model_overrides: {},` line at
[src/store/project.ts](../../../../src/store/project.ts#L129).

Grep gate after this task:

```bash
grep -rn 'model_overrides' src/ --include='*.ts' --exclude='*.test.ts'
```

Must return zero matches.

### Task 4 — Tests

4a. Resolver test (unchanged). See
[03-plan-r5.md](03-plan-r5.md#task-4--tests) sub-step 4a.

4b. Create [src/types.test.ts](../../../../src/types.test.ts)
with the strengthened schema-rejection regression. The legacy
key and the full operator-facing message are both built at
runtime so the literal `model_overrides` does not appear in the
test source. Both rejection tests assert
`issue.message.toBe(EXACT_MESSAGE)`; the empty-legacy-stub test
also pins `issue.code` and `issue.path`. The strip-semantics
positive regression is unchanged from r6.

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
      // Round-7 reviewer requirement: pin the FULL operator-facing
      // message with toBe, not toContain. A future change that
      // keeps the legacy key in the message while degrading the
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
    // passed through.
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

Grep gate after this task (file-scoped — `EXACT_MESSAGE` is built
via `${LEGACY_KEY}` interpolation so the bareword does not appear
in the test source):

```bash
grep -n 'model_overrides' src/types.test.ts
```

Must return zero matches.

### Task 5 — Docs (unchanged)

See [03-plan-r5.md](03-plan-r5.md#task-5--docs). No round-7
changes to docs edits in the source tree.

### Task 6 — Build and validate (unchanged in shape, message-pin behavior added)

Run from `/home/salva/g/ml/saivage`.

6a. Type-check and run the targeted test surface:

```bash
npx tsc -p tsconfig.json --noEmit
npx vitest run src/routing/resolver.test.ts src/types.test.ts src/config-validation.test.ts
```

Both must pass with no skipped tests. Under round 7, both
rejection assertions also require
`issue.message.toBe(EXACT_MESSAGE)`; if the schema's message
template ever diverges from
`${LEGACY_PROJECT_KEY} is a removed legacy v1 routing field.
Delete it from .saivage/config.json and use
ProjectConfig.routing.roles instead.` the tests fail at the
`toBe` line with a precise diff. The
`issues.length === 1` assertion from round 6 still catches any
regression of the fatal-abort fix.

6b. Final grep gates (unchanged). See
[03-plan-r5.md](03-plan-r5.md#task-6--build-and-validate)
sub-step 6b.

6c. Full suite (unchanged):

```bash
npx vitest run
```

Must pass.

### Task 7 — Operator-gated post-deploy verification (unchanged)

See [03-plan-r5.md](03-plan-r5.md#task-7--operator-gated-post-deploy-verification).

## Rollback (unchanged)

See [03-plan-r6.md](03-plan-r6.md#rollback-unchanged-from-r5).
