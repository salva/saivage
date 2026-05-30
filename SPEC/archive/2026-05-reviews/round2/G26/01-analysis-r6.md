# G26 — Analysis (round 6, writer Claude Opus 4.7)

Issue source: [../G26-resolver-legacy-source-tier.md](../G26-resolver-legacy-source-tier.md).
Round 5 reviewer critique: [04-review-r5.md](04-review-r5.md).
Supersedes [01-analysis-r5.md](01-analysis-r5.md).

## Changes from round 5

Round 5 introduced a `z.preprocess` wrapper that adds a typed Zod
issue at path `["model_overrides"]` and returns `z.NEVER`. The
round-5 reviewer accepted the architectural direction and the strip
semantics, but blocked landing on one specific defect
([04-review-r5.md](04-review-r5.md#L5)): the custom issue was not
marked fatal, so under the installed Zod 3 runtime the inner
`projectConfigObjectSchema` still parsed the (now `z.NEVER`-typed)
processed value and emitted misleading required-field errors at
`project_name`, `objectives`, and `skills` alongside the intended
custom issue at `model_overrides`. Operators would see a parse
error with four issues, not one, and the rejection contract
promised by the design ("a single, unambiguous `model_overrides`
error", [02-design-r5.md](02-design-r5.md#L120-L123)) was not
actually delivered.

Round 6 keeps every other decision from round 5 unchanged and lands
exactly two targeted edits:

1. The preprocess `ctx.addIssue` call gains `fatal: true`. Zod 3's
   `ZodEffects` preprocess branch calls `status.abort()` whenever
   an issue is added with `fatal: true`, and then short-circuits to
   `INVALID` before invoking the inner schema's `_parseSync`. See
   the verified runtime evidence in
   [Zod fatal-abort verification](#zod-fatal-abort-verification)
   below. The resulting `ZodError.issues` array contains exactly
   one entry: the custom issue at path `["model_overrides"]`. No
   inner required-field noise.
2. The schema-rejection test in
   [src/types.test.ts](../../../../src/types.test.ts) is strengthened
   to assert the exact rejection surface: `issues.length === 1`,
   `issues[0].code === "custom"`, `issues[0].path` deep-equals
   `[LEGACY_KEY]`, and the message contains the runtime-built
   key. The round-5 test only asserted that some issue path equals
   `LEGACY_KEY` ([03-plan-r5.md](03-plan-r5.md#L389-L390)) which
   would have passed under the round-5 defect.

Every other round-5 decision carries forward unchanged:

- Narrow rejection scope (`model_overrides` only, not `.strict()`).
- Strip semantics for `notifications`, `provider`, and any other
  unknown top-level key — preserved by the inner plain `z.object`.
- Runtime-built legacy key in both the schema and the test (so the
  production-source grep gate stays at zero matches without an
  allow-list).
- Resolver edits in [src/routing/resolver.ts](../../../../src/routing/resolver.ts)
  (delete legacy arm, narrow source union, simplify `resolveSource`,
  throw on runtime-default exhaustion).
- Seeder edit at [src/store/project.ts](../../../../src/store/project.ts#L129)
  (delete `model_overrides: {},`).
- Hard ordering constraint: schema edit and seeder edit ship in the
  same commit.
- Docs deletions across [docs/guide/routing.md](../../../../docs/guide/routing.md)
  and neighbours.
- Sequencing: G23 → G24 → G25 → G26 (G23/G24 already APPROVED).
- Daemon-impact inventory: zero known on-disk configs carry
  `model_overrides`; all load cleanly under the round-6 schema.

## Zod fatal-abort verification

The installed Zod version is `^3.25.76`
([package.json](../../../../package.json#L39)). Round 6 directly
inspected the installed runtime in
[node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js)
to confirm the fatal-abort path is the one the design relies on.

Two runtime facts established by reading the installed source:

1. `ZodEffects._parse` builds a `checkCtx.addIssue` that calls
   `status.abort()` whenever the issue carries `fatal: true`
   ([node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3174-L3181)).
2. In the `effect.type === "preprocess"` branch, after the
   preprocess function returns, the synchronous code path checks
   `if (status.value === "aborted") return INVALID;` BEFORE
   invoking `this._def.schema._parseSync(...)` on the processed
   value ([node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3210-L3215)).

Therefore, when the round-6 preprocess calls
`ctx.addIssue({ code: "custom", path: [LEGACY_PROJECT_KEY], fatal: true, message: ... })`
and returns `z.NEVER`, the inner `projectConfigObjectSchema` is
never invoked and the `ZodError.issues` array contains exactly the
one custom issue emitted by the preprocess. The misleading
required-field issues that motivated
[04-review-r5.md](04-review-r5.md#L5) cannot appear under this code
path.

The fix does not require any zod version bump; `fatal` has been a
supported field on `ZodIssueData`/`addIssue` since Zod 3.20 and is
present in the installed 3.25.76.

## What the resolver actually does today (unchanged from r5)

See [01-analysis-r5.md](01-analysis-r5.md#what-the-resolver-actually-does-today)
for the per-arm narrative. No code change has landed since round 5,
so every cited resolver anchor remains live.

## Why it is a legacy input that must be removed (unchanged from r5)

See [01-analysis-r5.md](01-analysis-r5.md#why-it-is-a-legacy-input-that-must-be-removed-and-rejected).
The workspace no-shim rule and the architectural reasons for
deleting the `"legacy"` source tier are unchanged.

## Root cause (unchanged from r5)

See [01-analysis-r5.md](01-analysis-r5.md#root-cause).

## What the fix has to touch (unchanged from r5)

See [01-analysis-r5.md](01-analysis-r5.md#what-the-fix-has-to-touch).
Round 6 changes only the body of the schema-rejection preprocess
and the body of the schema-rejection test; the set of touched files
is identical to round 5.

## Verified anchors (pre-flight gate)

All anchors below were re-read from the live source tree on the
round-6 commit day. Live ranges unchanged from round 5
([01-analysis-r5.md](01-analysis-r5.md#verified-anchors-pre-flight-gate));
this section restates them rather than asking the reviewer to
cross-check two documents.

Production schema and seeder:

- [src/types.ts](../../../../src/types.ts#L12-L29) — `ProjectConfigSchema` body. Closing `});` is L29; `export type ProjectConfig = ...` at L30.
- [src/types.ts](../../../../src/types.ts#L15) — `model_overrides: z.record(z.string(), z.string()).optional(),` line.
- [src/store/project.ts](../../../../src/store/project.ts#L125-L133) — seeded `ProjectConfig` literal block.
- [src/store/project.ts](../../../../src/store/project.ts#L129) — `model_overrides: {},` line.

Resolver:

- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57) — `ProjectRoutingConfigLike` interface.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L55) — `model_overrides?: Record<string, string>;` member line.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L66-L77) — `ResolvedModelRoute` interface.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L75) — `source: "routing" | "legacy" | "runtime-default";` line.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L106-L131) — `resolve()` method body.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L110) — fallback call site: `const candidate = preferredModels[0] ?? this.resolveLegacyModels(role)[0];`.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L127) — `source: this.resolveSource(role, merged, preferredModels),` line.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L220) — `resolvePreferredModels` body.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219) — trailing `return this.resolveLegacyModels(role);` line.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L247-L252) — `resolveRuntimeDefaultModels` body.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L262) — `resolveLegacyModels` body.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L264-L269) — `resolveSource` body.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L266) — `if (this.project.model_overrides?.[role]) return "legacy";` line.

Resolver test:

- [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28) — `"preserves legacy override and runtime fallback behavior"` test body.

Consumers of the parsed-output shape (must not regress for any key
other than `model_overrides`):

- [src/store/documents.ts](../../../../src/store/documents.ts#L20-L23) — `readDoc` returns `schema.parse(data)`.
- [src/store/documents.ts](../../../../src/store/documents.ts#L75-L81) — `writeDoc` re-serializes the parsed value.
- [src/store/project.ts](../../../../src/store/project.ts#L66-L70) — `loadProject` stores parsed result as `project.config`.
- [src/server/server.ts](../../../../src/server/server.ts#L476-L498) — `/api/debug/state` returns `runtime.project.config`.

Zod runtime (consulted for the fatal-abort fix):

- [node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3174-L3181) — `checkCtx.addIssue` calls `status.abort()` when `arg.fatal` is set.
- [node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3210-L3215) — preprocess branch returns `INVALID` before calling the inner schema when `status.value === "aborted"`.
- [package.json](../../../../package.json#L39) — `"zod": "^3.25.76"`.

## Daemon impact (unchanged from r5)

See [01-analysis-r5.md](01-analysis-r5.md#daemon-impact-concrete-on-disk-inventory)
for the full per-config inventory. The round-6 fatal-abort change
does not alter which configs load. Net summary under the round-6
mechanism:

- Zero known on-disk configs carry `model_overrides`. All load
  cleanly. Their unrelated unknown keys (`notifications`,
  `provider`) remain silently stripped from `runtime.project.config`
  and `/api/debug/state` — exactly today's behavior — because the
  inner plain `z.object` is unchanged.
- The forward-looking failure mode (operator manually adds
  `model_overrides` to a `.saivage/config.json` before the next
  restart) is unchanged in shape, sharpened in surface: the
  daemon's parse error now contains exactly one Zod issue, at path
  `["model_overrides"]`, with the operator-facing message naming
  the field as a removed legacy v1 routing field. No
  required-field noise.

## Scope decision (unchanged from r5)

Narrow rejection via `z.preprocess` with `fatal: true`, not
`.strict()` and not `.passthrough() + .superRefine`. The reasoning
in
[01-analysis-r5.md](01-analysis-r5.md#scope-decision-narrow-rejection-via-preprocess-not-passthrough)
holds verbatim; round 6 only refines the within-preprocess
mechanism so the contract the design promised is the contract the
runtime delivers.

## Out-of-scope for G26 (unchanged from r5)

See [01-analysis-r5.md](01-analysis-r5.md#out-of-scope-for-g26).

## Risks (unchanged from r5)

See [01-analysis-r5.md](01-analysis-r5.md#risks). The round-6
fatal-abort fix removes one previously-unstated risk (operators
seeing four issues per parse error and triaging the wrong one);
nothing new is added.
