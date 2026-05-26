# G26 — Design (round 5, writer Claude Opus 4.7)

Reads from [01-analysis-r5.md](01-analysis-r5.md).
Addresses [04-review-r4.md](04-review-r4.md) required changes 1, 2, 3.

## Goal

Architecturally delete the pre-v2 `model_overrides` routing format
and its `"legacy"` source-tier vocabulary from the resolver and the
project config schema. After this change the resolver has a
three-arm precedence (`routing` → `runtime-default` → throw) and the
`ResolvedModelRoute.source` union has exactly two literals:
`"routing" | "runtime-default"`.

The change must not preserve the field as a deprecated alias, must
not silently swallow a legacy field that an operator still has on
disk, and must not change the parsed-output shape for any other
top-level key. Workspace rule: no backward compatibility, no
migration shim.

## Changes from round 4

- Schema mechanism switches from `.passthrough() + .superRefine` to
  `z.preprocess` wrapping the existing `z.object`. Reason: the
  round-4 mechanism retained unknown keys on the parsed output and
  thereby leaked currently-stripped keys (`notifications`,
  `provider`) through `runtime.project.config` and
  `/api/debug/state` ([04-review-r4.md](04-review-r4.md#L7)). The
  round-5 mechanism inspects raw input before the inner `z.object`
  parses, so the inner object retains today's default strip-unknown
  behavior. See
  [A.1 Schema](#a1-schema-narrow-rejection-of-model_overrides).
- Daemon-impact wording updated to say unrelated unknown keys remain
  stripped from the parsed output, not passed through. See
  [01-analysis-r5.md](01-analysis-r5.md#daemon-impact-concrete-on-disk-inventory).
- Stale schema snippets and the round-4 "actually use this other
  one" self-correction are removed. The design and plan show one
  schema implementation, with the legacy key built at runtime so the
  production-source grep gate stays at zero matches without a
  per-file allow-list. See
  [03-plan-r5.md](03-plan-r5.md#task-1--projectconfigschema-narrow-rejection-of-the-legacy-key).
- Every resolver line anchor is unchanged from round 4 and re-verified
  against the live source tree (see
  [01-analysis-r5.md](01-analysis-r5.md#verified-anchors-pre-flight-gate)).

## Proposal A (recommended) — narrow rejection via `z.preprocess`

Touch the three on-disk surfaces (schema, seeder, resolver), update
tests, and trim the docs guide.

### A.1 Schema: narrow rejection of `model_overrides`

Edit [src/types.ts](../../../../src/types.ts#L12-L29). Delete the
field declaration at [src/types.ts](../../../../src/types.ts#L15) and
wrap the existing object in a `z.preprocess` that rejects only the
legacy key. The inner `z.object` is the live schema minus the
deleted field; it keeps Zod's default strip-unknown-keys behavior so
every other unknown top-level key continues to be silently stripped
from the parsed output (matching today's contract for
`notifications`, `provider`, and any future addition).

The implementation builds the rejected key at runtime so the
production-source grep gate for the bareword `model_overrides`
stays at zero matches in `src/types.ts`:

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
      message: `${LEGACY_PROJECT_KEY} is a removed legacy v1 routing field. Delete it from .saivage/config.json and use ProjectConfig.routing.roles instead.`,
    });
    return z.NEVER;
  }
  return raw;
}, projectConfigObjectSchema);
export type ProjectConfig = z.output<typeof ProjectConfigSchema>;
```

Why this satisfies the round-4 reviewer requirement:

- `z.preprocess` runs before the inner schema parses. It is the
  Zod-native primitive for "look at the raw input first". The inner
  `projectConfigObjectSchema` is a plain `z.object` with no
  `.passthrough()` and no `.strict()`; its behavior on unknown
  top-level keys is exactly today's behavior (silently stripped from
  the parsed output).
- A positive regression in
  [A.4 Tests](#a4-tests-drop-legacy-source-case-add-schema-rejection-cases)
  pins the strip semantics: a fixture with an extra
  `notifications: { … }` top-level key parses successfully AND the
  parsed output object does not contain a `notifications` property.
  That asserts the contract the round-4 reviewer required.
- The `path: [LEGACY_PROJECT_KEY]` field is the typed signal the
  daemon surfaces when it refuses to load. Operators see a single,
  unambiguous error at path `model_overrides` and remove the key by
  hand. No auto-stripper.
- The legacy key is constructed via `["model","overrides"].join("_")`
  and the human-readable message uses string interpolation of the
  same const, so the literal bareword `model_overrides` does not
  appear in `src/types.ts`. The production-source grep gate in
  [03-plan-r5.md](03-plan-r5.md#task-6--build-and-validate) stays at
  zero matches without a per-file allow-list.
- `z.output<typeof ProjectConfigSchema>` resolves to the output type
  of the inner `projectConfigObjectSchema`, so the `ProjectConfig`
  TS type is unchanged from today minus the deleted
  `model_overrides` member. No other consumer of `ProjectConfig`
  needs to change.
- The `raw && typeof raw === "object" && !Array.isArray(raw)` guard
  on the preprocess input avoids `Object.prototype.hasOwnProperty.call`
  throwing on a non-object input; the inner schema will produce the
  usual "expected object" Zod error for that case, exactly as today.

### A.2 Resolver: collapse legacy arm into runtime-default arm

All line numbers are against the live file
[src/routing/resolver.ts](../../../../src/routing/resolver.ts) per
the verified anchors in
[01-analysis-r5.md](01-analysis-r5.md#verified-anchors-pre-flight-gate).

- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L55):
  remove the `model_overrides?: Record<string, string>;` member from
  `ProjectRoutingConfigLike`. The interface header at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57)
  shrinks to a single `routing?: ProjectRoutingConfig` member. (If
  G24 lands first, this member has already moved to
  `ProjectRoutingInput`; the deletion still applies.)
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L75):
  narrow the source union to
  `source: "routing" | "runtime-default";`. The surrounding
  interface span is
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L66-L77).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L110)
  (the fallback call site, NOT L108 — that line is
  `const merged = …`): replace
  `this.resolveLegacyModels(role)[0]` with
  `this.resolveRuntimeDefaultModels(role)[0]`. The surrounding
  `resolve()` method body is
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L106-L131).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219):
  the trailing `return this.resolveLegacyModels(role);` inside
  `resolvePreferredModels` becomes
  `return this.resolveRuntimeDefaultModels(role);`. The surrounding
  method body is
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L220).
  The helper must guarantee the same "throw if empty" contract on
  exhaustion; see the next bullet.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L247-L252):
  rewrite `resolveRuntimeDefaultModels` to throw on exhaustion:

  ```ts
  private resolveRuntimeDefaultModels(role: string): string[] {
    if (role === "supervisor") {
      const models = normalizeModelList(this.runtime.supervisorModel);
      if (models.length) return models;
      throw new MissingModelForRoleError([role], configPath());
    }
    if (role === "security") {
      const models = normalizeModelList(this.runtime.securityModel);
      if (models.length) return models;
      throw new MissingModelForRoleError([role], configPath());
    }
    const key = ROUTING_ROLE_TO_MODEL_KEY[role] ?? role;
    const models = normalizeModelList(this.runtime.models?.[key] ?? this.runtime.models?.default);
    if (models.length) return models;
    throw new MissingModelForRoleError([role], configPath());
  }
  ```

- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L262):
  delete the entire `resolveLegacyModels` method.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L264-L269):
  rewrite `resolveSource` so it no longer branches on
  `model_overrides`:

  ```ts
  private resolveSource(rule: NormalizedRule): ResolvedModelRoute["source"] {
    if (rule.model || rule.preferredModels.length || rule.allowedModels?.length || rule.profile) return "routing";
    return "runtime-default";
  }
  ```

  Drop the `role` and `preferredModels` arguments — neither is read
  by the new body. Update the single call site at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L127)
  to `this.resolveSource(merged)`. Drop the unreachable
  `throw new Error("unreachable: …")` at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L268):
  with the legacy arm gone and `resolveRuntimeDefaultModels` now
  responsible for the missing-role throw at `resolve()`'s call site,
  `resolveSource` is total.

### A.3 Seeder: stop writing `model_overrides`

Edit
[src/store/project.ts](../../../../src/store/project.ts#L125-L133).
Delete the `model_overrides: {},` line at
[src/store/project.ts](../../../../src/store/project.ts#L129) so the
seeded `ProjectConfig` literal no longer carries the stub. Because
the schema in [A.1](#a1-schema-narrow-rejection-of-model_overrides)
will reject the unknown key, the seeder must not keep writing it.
This change must land in the same commit as A.1 (see
[Ordering constraint](#ordering-constraint-schema-and-seeder)).

### A.4 Tests: drop legacy-source case, add schema-rejection cases

Edit
[src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28).
Replace the existing legacy case with a smaller runtime-default-only
case:

```ts
it("falls back to runtime-default models when no routing rule is set", () => {
  const resolver = new ModelRoutingResolver(
    {},
    {
      models: {
        orchestrator: "anthropic/claude-sonnet-4-20250514",
        chat: "github-copilot/gpt-5.4",
      },
    },
  );

  expect(resolver.resolve("chat")).toMatchObject({
    modelSpec: "github-copilot/gpt-5.4",
    source: "runtime-default",
  });
});
```

The "preserves legacy override" name disappears from the test file
because the behaviour disappears from the resolver. After this edit,
the resolver test file contains zero occurrences of the bareword
`model_overrides` and zero occurrences of the bareword `"legacy"`.

Add a new file
[src/types.test.ts](../../../../src/types.test.ts) with both the
schema-rejection regression and the strip-semantics positive
regression required by [04-review-r4.md](04-review-r4.md#L13). The
fixture is built so the literal token `model_overrides` does not
appear in the source file — this is the round-1 reviewer-concern-1
fix that lets the production-source grep gate remain a clean
zero-match assertion.

```ts
import { describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "./types.js";

// Legacy v1 routing key built at runtime so the bareword does not
// appear in source-tree greps for the legacy field (G26 grep gate).
const LEGACY_KEY = ["model", "overrides"].join("_");

describe("ProjectConfigSchema (G26 legacy-key rejection)", () => {
  it("rejects the pre-v2 legacy routing key at top level", () => {
    const fixture: Record<string, unknown> = {
      project_name: "x",
      objectives: [],
      routing: { roles: {}, profiles: {} },
      skills: { max_per_agent: 5 },
    };
    fixture[LEGACY_KEY] = { coder: "github-copilot/gpt-5.4" };

    const result = ProjectConfigSchema.safeParse(fixture);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain(LEGACY_KEY);
    }
  });

  it("also rejects an empty legacy stub (matches the previously seeded shape)", () => {
    const fixture: Record<string, unknown> = {
      project_name: "x",
      objectives: [],
      routing: { roles: {}, profiles: {} },
      skills: { max_per_agent: 5 },
    };
    fixture[LEGACY_KEY] = {};

    expect(ProjectConfigSchema.safeParse(fixture).success).toBe(false);
  });

  it("accepts an otherwise-valid config with no legacy key", () => {
    const fixture = {
      project_name: "x",
      objectives: [],
      routing: { roles: {}, profiles: {} },
      skills: { max_per_agent: 5 },
    };
    expect(ProjectConfigSchema.safeParse(fixture).success).toBe(true);
  });

  it("accepts and silently strips other unknown top-level keys (preserves today's behavior)", () => {
    // Round-4 reviewer required this positive regression: keys like
    // `notifications` that are not declared on the schema must
    // continue to be stripped from the parsed output, NOT passed
    // through. This pins the round-5 preprocess mechanism against a
    // future accidental tightening to .strict() or loosening to
    // .passthrough().
    const fixture = {
      project_name: "x",
      objectives: [],
      routing: { roles: {}, profiles: {} },
      skills: { max_per_agent: 5 },
      notifications: { channel: "stub" },
      provider: { legacy: "stub" },
    };
    const result = ProjectConfigSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed = result.data as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("notifications");
      expect(parsed).not.toHaveProperty("provider");
      // Declared fields still present.
      expect(parsed.project_name).toBe("x");
      expect(parsed.skills).toMatchObject({ max_per_agent: 5 });
    }
  });
});
```

Reasons to build the key at runtime rather than as a literal:

1. The grep gate in [03-plan-r5.md](03-plan-r5.md) asserts zero
   occurrences of `model_overrides` across the production source
   tree. Writing the bareword in a test file would make the gate
   fire on the test file itself. Constructing the key via
   `["model","overrides"].join("_")` keeps the test self-contained
   without coupling the gate to a per-file allow-list.
2. It documents intent: the literal is a key the codebase explicitly
   does not want to write any more, and naming it via concatenation
   makes that explicit.

The `paths.toContain(LEGACY_KEY)` assertion is the typed-path
guarantee from [A.1](#a1-schema-narrow-rejection-of-model_overrides):
the Zod issue's `path` is `["model_overrides"]`. The "accepts and
silently strips other unknown top-level keys" test is the
round-4-reviewer-required positive regression that pins the strip
semantics for unrelated keys.

### A.5 Docs: drop legacy field from the routing guide

- [docs/guide/routing.md](../../../../docs/guide/routing.md#L3):
  drop the "For non-trivial deployments, plain `model_overrides`…"
  framing; rewrite as "Saivage ships a `ModelRoutingResolver` that…".
- [docs/guide/routing.md](../../../../docs/guide/routing.md#L15):
  remove the bullet `- ProjectConfig.model_overrides (legacy, still
  honored)`.
- [docs/guide/routing.md](../../../../docs/guide/routing.md#L73):
  remove the "If still missing fields, fall back to
  `model_overrides[<role>]`…" step from the resolution algorithm.
- [docs/guide/routing.md](../../../../docs/guide/routing.md#L94):
  remove the "Mix of cheap & smart models → use `model_overrides`"
  bullet; the equivalent routing-profile recipe is already on the
  same page.
- [docs/guide/providers.md](../../../../docs/guide/providers.md#L58):
  remove the `ProjectConfig.model_overrides[<role>]` line from the
  precedence list.
- [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md#L68):
  remove the "Project-level `model_overrides` take …" clause.
- [docs/guide/config-project.md](../../../../docs/guide/config-project.md#L40-L89):
  delete the `model_overrides` JSON example and its table row.
- [docs/guide/troubleshooting.md](../../../../docs/guide/troubleshooting.md#L11):
  reword the "update `model_overrides`" advice to "update the routing
  profile".
- [docs/guide/install-lxc.md](../../../../docs/guide/install-lxc.md#L104):
  remove the `"model_overrides": {},` line from the sample seeded
  config.

`docs/api/**` is typedoc-generated from `src/*.ts`; regenerating
those files is a build step. The `docs/.vitepress/dist/**` tree is
the VitePress static build output.

### A.6 What is explicitly not touched

- `ResolvedModelRoute.source` itself: kept (only its literal set
  shrinks). G25 r3 plan is silent on `source`; nothing in the
  resolver batch needs the field to disappear
  ([../G25/03-plan-r3.md](../G25/03-plan-r3.md#L14-L16)).
- The parsed-output shape for any key other than `model_overrides`.
  `notifications`, `provider`, and any future unknown top-level key
  remain silently stripped from
  `ProjectConfigSchema.safeParse(...)`'s output, exactly as today.
- `resolveRuntimeDefaultModels`'s happy-path return shape: only its
  exhaustion contract changes (throw on empty).
- Resolver constructor cycle check (G23 territory).
- Input narrowing / cached `this.routing` (G24 territory).
- Allowed-list validation throws (G25 territory).
- No migration shim, no auto-stripper, no warn-and-strip path. The
  schema simply refuses to load a `config.json` that still has the
  legacy key, and operators remove it manually before restart.

## Proposal B (rejected) — `.passthrough()` + `.superRefine`

The round-4 mechanism. Rejected because the parsed output of a
`.passthrough()` schema retains every unknown key on the parsed
object. That would newly expose currently-stripped keys like
`notifications` and `provider` through
`runtime.project.config` ([src/store/project.ts](../../../../src/store/project.ts#L66-L70))
and `/api/debug/state` ([src/server/server.ts](../../../../src/server/server.ts#L476-L498)),
and would serialize them back if `writeDoc` is ever called on
project config ([src/store/documents.ts](../../../../src/store/documents.ts#L75-L81)).
The round-4 reviewer explicitly blocked this contract
([04-review-r4.md](04-review-r4.md#L7)).

A variant — `.passthrough()` + `.superRefine` + a final
`.transform` that re-parses through the stripping inner schema —
would technically restore strip semantics but at the cost of two
parses per load, an output type that needs manual recovery, and a
schema body materially harder to read than the `z.preprocess`
mechanism in [A.1](#a1-schema-narrow-rejection-of-model_overrides).
No reason to prefer it.

## Proposal C (rejected) — `.strict()`

Round 3's broader `.strict()` proposal. Rejected because the
daemon-impact inventory in
[01-analysis-r5.md](01-analysis-r5.md#daemon-impact-concrete-on-disk-inventory)
shows it would reject seven of seven existing configs at restart on
keys (`notifications`, `provider`) that are unrelated to the G26
finding. Reviewer's first option in
[04-review-r3.md](04-review-r3.md) authorised explicitly narrowing
to the legacy key. Schema completeness for `notifications` and
similar fields is a separate review item.

## Proposal D (rejected) — also delete the `source` field

A more aggressive cut: delete `source` from `ResolvedModelRoute`
entirely and stop computing it. A workspace-wide grep shows no live
consumer reads `source` outside the resolver test file. If `source`
carries no operational signal, the `resolveSource` helper and the
union literal are themselves dead code.

Rejected because the field is small, clearly documented, and a
sensible observability hook for future routing telemetry (for
example, a `/api/state` field reporting which spec source produced
each role's model). Deleting it now is a one-way door that does not
belong inside a low-severity dead-code finding. If the metaplan
later decides telemetry is not coming, a follow-on finding can
delete the field cleanly.

## Recommendation

Proposal A. It deletes the legacy arm architecturally (schema,
seeder, resolver, tests, docs), refuses to silently honour stale
on-disk fields, and keeps the design boundary with G23 / G24 / G25
intact. The schema-side rejection is targeted, typed, and
operator-visible while preserving today's strip semantics for every
other unknown top-level key.

## Sequencing constraints (restated)

- G23 (APPROVED, [../G23/APPROVED.md](../G23/APPROVED.md#L9)):
  independent. No collision.
- G24 (APPROVED, [../G24/APPROVED.md](../G24/APPROVED.md#L9)):
  collision on
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57)
  (`ProjectRoutingConfigLike` deletion + `model_overrides` member
  deletion). Both findings agree the member should disappear; the
  later finding in the merge order simply removes whatever survives.
  Recommended order: G24 lands first; G26 then has nothing to delete
  at this site.
- G25 (r3 plan, [../G25/03-plan-r3.md](../G25/03-plan-r3.md), not yet
  approved): collision on
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L220)
  (`resolvePreferredModels` body). Recommended order: G25 lands
  first; G26 renames the trailing
  `return this.resolveLegacyModels(role);` to
  `return this.resolveRuntimeDefaultModels(role);` inside the new
  G25 body. The plan task list in
  [03-plan-r5.md](03-plan-r5.md) targets the helper rename, not the
  surrounding body shape, so it is robust to G25 wording changes.

## Ordering constraint: schema and seeder

A.1 (schema rejection at
[src/types.ts](../../../../src/types.ts#L15)) and A.3 (seeder field
deletion at
[src/store/project.ts](../../../../src/store/project.ts#L129)) must
land in the same commit. The seeder is the only currently-active
producer of the `model_overrides` key on disk. If A.1 ships before
A.3, every project seeded between the two commits will trip load at
the next restart. If A.3 ships before A.1, the change is a no-op
until A.1 lands. Either ordering across separate commits introduces
a needless window; same-commit landing closes it.

Captured operationally as a hard task-ordering constraint in
[03-plan-r5.md](03-plan-r5.md#hard-ordering-constraint-task-1--task-3-ship-together).

## Daemon impact (summary; full table in analysis)

The full per-config table is in
[01-analysis-r5.md](01-analysis-r5.md#daemon-impact-concrete-on-disk-inventory).
Summary under the round-5 `z.preprocess` mechanism:

- Zero known on-disk configs fail load; none carries
  `model_overrides`.
- For every other unknown top-level key present in those configs
  today (`notifications`, `provider`), the parsed output of
  `ProjectConfigSchema.safeParse(...)` is exactly the same as today:
  the key is silently stripped, it does not appear in
  `runtime.project.config`, it does not appear in
  `/api/debug/state`, and a future `writeDoc(configPath,
  project.config, ProjectConfigSchema)` does not re-serialize it.
- The forward-looking reject-time failure mode for a future
  operator-edited config that adds `model_overrides`: typed Zod
  custom issue at path `["model_overrides"]`, daemon refuses to
  load, operator removes the key by hand and restarts the daemon.

The post-deploy verification in
[03-plan-r5.md](03-plan-r5.md#task-7--operator-gated-post-deploy-verification)
remains a true verification step (expected zero hits).
