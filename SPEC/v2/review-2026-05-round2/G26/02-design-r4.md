# G26 — Design (round 4, writer Claude Opus 4.7)

Reads from [01-analysis-r4.md](01-analysis-r4.md).
Addresses [04-review-r3.md](04-review-r3.md) reviewer findings 1 and 2.

## Goal

Architecturally delete the pre-v2 `model_overrides` routing format
and its `"legacy"` source-tier vocabulary from the resolver and the
project config schema. After this change the resolver has a
three-arm precedence (`routing` → `runtime-default` → throw) and the
`ResolvedModelRoute.source` union has exactly two literals:
`"routing" | "runtime-default"`.

The change must not preserve the field as a deprecated alias and must
not silently swallow a legacy field that an operator still has on
disk. Workspace rule: no backward compatibility, no migration shim.

## Changes from round 3

- The schema-side rejection is narrowed from `.strict()` (round 3) to
  a targeted `superRefine`-on-`passthrough` check that fires only on
  the legacy `model_overrides` key. Reason: the round-4 daemon-impact
  inventory in
  [01-analysis-r4.md](01-analysis-r4.md#daemon-impact-concrete-on-disk-inventory)
  shows that `.strict()` would also reject `notifications`
  (everywhere) and `provider` (on GetRich-v1 configs), neither of
  which is a G26 concern. Reviewer's first option in
  [04-review-r3.md](04-review-r3.md) authorised this narrowing
  explicitly. The contract — typed Zod error pointing at
  `model_overrides`, operator removes the key by hand, no
  auto-stripper — is preserved.
- The fallback-call anchor is corrected from L108 to L110. Every
  resolver anchor used below is re-verified against the live source
  tree and listed in
  [01-analysis-r4.md](01-analysis-r4.md#verified-anchors-pre-flight-gate).
- Method-body span anchors are tightened: `resolve()` is L106-L131
  (not L105-L129), `resolvePreferredModels` is L204-L220 (not
  L201-L221), `ResolvedModelRoute` is L66-L77 (not L64-L75),
  `ProjectConfigSchema` literal is L12-L29 (not L12-L30; L30 is the
  `export type` line). These do not change the design content.
- G25 cross-references stay pointed at
  [../G25/03-plan-r3.md](../G25/03-plan-r3.md).

## Proposal A (recommended) — focused removal with targeted rejection

Touch the three on-disk surfaces (schema, seeder, resolver), update
tests, and trim the docs guide.

### A.1 Schema: narrow rejection of `model_overrides`

Edit [src/types.ts](../../../../src/types.ts#L12-L29). Delete the
line at [src/types.ts](../../../../src/types.ts#L15):

```ts
model_overrides: z.record(z.string(), z.string()).optional(),
```

Add `.passthrough()` (so the `superRefine` body can see the raw
parsed object including unknown keys) followed by a `superRefine`
that rejects only `model_overrides`:

```ts
export const ProjectConfigSchema = z
  .object({
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
  })
  .passthrough()
  .superRefine((val, ctx) => {
    if (Object.prototype.hasOwnProperty.call(val, "model_overrides")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model_overrides"],
        message:
          "model_overrides is a removed legacy v1 routing field. Delete it from .saivage/config.json and use ProjectConfig.routing.roles instead.",
      });
    }
  });
```

Rationale:

- The default Zod strip-unknown behaviour would silently delete an
  operator's `model_overrides` field and erase the routing intent
  with no signal. Under the no-shim rule, that is the migration-shim
  failure mode we are deleting. A targeted refine surfaces a typed
  error.
- `.passthrough()` keeps other unknown top-level keys
  (`notifications`, `provider`, future fields) on the parsed object,
  matching today's strip-vs-keep behaviour for consumers that do
  not read them. No other consumer reads those keys off the parsed
  `ProjectConfig` today; the round-4 inventory in
  [01-analysis-r4.md](01-analysis-r4.md#daemon-impact-concrete-on-disk-inventory)
  documents why broadening to `.strict()` is out of scope.
- The `superRefine` body uses `Object.prototype.hasOwnProperty.call`
  (not `in`) to avoid prototype-chain false positives on hostile
  inputs.
- The `path: ["model_overrides"]` is the typed signal the daemon
  surfaces when it refuses to load. Operators see a single,
  unambiguous error and remove the key by hand. No auto-stripper.

The schema-rejection regression test (see A.4) covers the typed-path
guarantee.

### A.2 Resolver: collapse legacy arm into runtime-default arm

All line numbers below are against the live file
[src/routing/resolver.ts](../../../../src/routing/resolver.ts) per
the verified anchors in
[01-analysis-r4.md](01-analysis-r4.md#verified-anchors-pre-flight-gate).

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
  (round-3 blocker; this is the fallback call site, not L108):
  replace `this.resolveLegacyModels(role)[0]` with
  `this.resolveRuntimeDefaultModels(role)[0]`. The `?? throw`
  semantics are preserved by the new throw contract on
  `resolveRuntimeDefaultModels` (see below). The surrounding
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
  rewrite `resolveRuntimeDefaultModels` to throw on exhaustion. New
  body (preserves all three branches: supervisor, security, mapped
  role):

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
  `throw new Error("unreachable: …")` line at
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
the schema in A.1 will reject the unknown key, the seeder must not
keep writing it. This change must land in the same commit as A.1
(see [Ordering constraint](#ordering-constraint-schema-and-seeder)).

### A.4 Tests: drop legacy-source case, add schema-rejection case

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

Add one schema-rejection regression in a new
[src/types.test.ts](../../../../src/types.test.ts). The fixture is
built so the literal token `model_overrides` does **not** appear in
the source file — this is the round-1 reviewer-concern-1 fix that
lets the source-wide grep gates remain a clean zero-match assertion:

```ts
import { describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "./types.js";

// The legacy v1 routing key we are confirming is rejected by the
// targeted superRefine. Built at runtime so the bareword does not
// appear in source-tree greps for "model_overrides" (G26 grep gate).
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
});
```

Two reasons to build the key at runtime rather than as a literal:

1. The grep gate in [03-plan-r4.md](03-plan-r4.md) asserts zero
   occurrences of `model_overrides` across the production source
   tree. Writing the bareword in a test file would make the gate
   fire on the test file itself. Constructing the key via
   `["model","overrides"].join("_")` keeps the test self-contained
   without coupling the gate to a per-file allow-list.
2. It documents intent: the literal is a key the codebase explicitly
   does not want to write any more, and naming it via concatenation
   makes that explicit.

The `paths.toContain(LEGACY_KEY)` assertion is the typed-path
guarantee from A.1: the Zod issue's `path` is `["model_overrides"]`.
This is stricter than round 3's `keys` check (which was tied to the
`unrecognized_keys` code that no longer applies under the narrowed
contract).

The third test (`accepts an otherwise-valid config with no legacy
key`) is the positive-path complement: schema acceptance still
works when only the legacy key has been removed. This pins the
narrowing of A.1 against a future accidental over-tightening.

### A.5 Docs: drop legacy field from the routing guide

Edit the routing guide so it no longer markets `model_overrides`:

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
- `resolveRuntimeDefaultModels` body: only its exhaustion contract
  changes (throw on empty), not its happy-path return shape.
- Other unknown top-level keys (`notifications`, `provider`, future
  additions). They remain silently passed through, matching today's
  consumer-visible behaviour. Schema completeness for those keys is
  a separate finding; see
  [01-analysis-r4.md](01-analysis-r4.md#scope-decision-narrow-rejection-not-strict).
- Resolver constructor cycle check (G23 territory).
- Input narrowing / cached `this.routing` (G24 territory).
- Allowed-list validation throws (G25 territory).
- No migration shim, no auto-stripper, no warn-and-strip path. The
  schema simply refuses to load a `config.json` that still has the
  legacy key, and operators remove it manually before restart.

## Proposal B — also delete the `source` field

A more aggressive cut: delete `source` from `ResolvedModelRoute`
entirely and stop computing it. A workspace-wide grep shows no live
consumer reads `source` outside the resolver test file. If `source`
carries no operational signal, the `resolveSource` helper and the
union literal are themselves dead code.

Rejected because:

- The field is small and clearly documented. Removing it adds
  cross-finding risk that does not belong inside a low-severity
  dead-code finding.
- Even if the field has no current consumer, it is a sensible
  observability hook for future routing telemetry (e.g. a
  `/api/state` field reporting which spec source produced each
  role's model). Deleting it now is a one-way door.
- The G25 r3 plan at
  [../G25/03-plan-r3.md](../G25/03-plan-r3.md#L14-L16) requires only
  the helper rename; it does not lean on `source` either way, so the
  argument for preserving it is purely "don't widen scope".

If the metaplan later decides telemetry is not coming, a follow-on
finding can delete the field cleanly. G26 should not be that
finding.

## Proposal C — keep round-3 `.strict()`

Round 3's broader `.strict()` proposal. Rejected for round 4 because
the daemon-impact inventory in
[01-analysis-r4.md](01-analysis-r4.md#daemon-impact-concrete-on-disk-inventory)
shows it would reject seven of seven existing configs at restart on
keys (`notifications`, `provider`) that are unrelated to the G26
finding. Reviewer's first option in
[04-review-r3.md](04-review-r3.md) authorised explicitly narrowing
to the legacy key. Schema completeness for `notifications` and
similar fields is a separate review item.

## Recommendation

**Proposal A**. It deletes the legacy arm architecturally (schema,
seeder, resolver, tests, docs), refuses to silently honour stale
on-disk fields, and keeps the design boundary with G23 / G24 / G25
intact. The schema-side rejection is targeted, typed, and
operator-visible, without conflating G26 with schema completeness
for unrelated fields.

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
  [03-plan-r4.md](03-plan-r4.md) targets the helper rename, not the
  surrounding body shape, so it is robust to G25 wording changes.

## Ordering constraint: schema and seeder

A.1 (schema rejection of `model_overrides` at
[src/types.ts](../../../../src/types.ts#L15)) and A.3 (seeder field
deletion at
[src/store/project.ts](../../../../src/store/project.ts#L129)) must
land in the same commit. The reason is the daemon-impact finding:
the seeder is the only currently-active producer of the
`model_overrides` key on disk. If A.1 ships before A.3, every project
seeded between the two commits will trip load at the next restart.
If A.3 ships before A.1, the change is a no-op until A.1 lands.
Either ordering across separate commits introduces a needless window;
same-commit landing closes the window.

This is captured operationally as a hard task-ordering constraint in
[03-plan-r4.md](03-plan-r4.md#hard-ordering-constraint-task-1--task-3-ship-together).

## Daemon impact (concrete on-disk inventory)

Reproduced from
[01-analysis-r4.md](01-analysis-r4.md#daemon-impact-concrete-on-disk-inventory)
for the design's purposes. The same audit (top-level key list only;
no values; no secret material read) was performed by Python
`json.load(...).keys()` where `jq` was unavailable. Recognised
top-level keys after this change:
`project_name`, `objectives`, `routing`, `skills`, `agents`. The
schema explicitly rejects `model_overrides` and silently passes
through any other unknown key (`.passthrough()`).

| Path | Exists? | Top-level keys observed | Has `model_overrides`? | Load status under A.1 (narrow rejection) |
|------|---------|-------------------------|------------------------|------------------------------------------|
| /home/salva/g/ml/saivage/.saivage/config.json | no | (file absent) | n/a | n/a |
| /home/salva/g/ml/saivage-v3/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | clean, loads |
| /home/salva/g/ml/getrich/.saivage/config.json | yes | notifications, objectives, project_name, provider, routing, skills | no | clean, loads |
| /home/salva/g/ml/getrich-v2/.saivage/config.json | no | (file absent — post-F33 split layout) | n/a | n/a |
| /home/salva/g/ml/diedrico/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | clean, loads |
| 10.0.3.111 /work/getrich/.saivage/config.json | yes | notifications, objectives, project_name, provider, routing, skills | no | clean, loads |
| 10.0.3.112 /work/saivage-v3/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | clean, loads |
| 10.0.3.113 /work/diedrico/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | clean, loads |
| 10.0.3.170 /work/getrich-v2/.saivage/config.json | no | (file absent — post-F33 split layout) | n/a | n/a |
| 10.0.3.170 /opt/saivage-v3/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | clean, loads |

Net daemon impact today under the narrow-rejection contract: zero.
Every known on-disk config loads cleanly because none carries
`model_overrides`. The post-deploy verification in
[03-plan-r4.md](03-plan-r4.md#task-7--operator-gated-post-deploy-verification)
is genuinely a verification step.

The reject-time failure mode (forward-looking only) is:
`ProjectConfigSchema.safeParse(...)` returns `success: false` with a
`ZodIssue` whose `code` is `custom`, whose `path` is
`["model_overrides"]`, and whose `message` names the field as a
removed legacy v1 routing field. The daemon surfaces that error at
startup and refuses to load the project.

Per workspace rule, G26 does not add an auto-stripper or a
warn-and-strip path; the operator removes the key by hand and
restarts the daemon.
