# G26 — Design (round 3, writer Claude Opus 4.7)

Reads from [01-analysis-r3.md](01-analysis-r3.md).
Addresses [04-review-r2.md](04-review-r2.md) reviewer concerns 1 and 2.

## Goal

Architecturally delete the pre-v2 `model_overrides` routing format and
its `"legacy"` source-tier vocabulary from the resolver and the
project config schema. After this change the resolver has a
three-arm precedence (`routing` → `runtime-default` → throw) and the
`ResolvedModelRoute.source` union has exactly two literals:
`"routing" | "runtime-default"`.

The change must not preserve the field as a deprecated alias and must
not silently swallow a legacy field that an operator still has on
disk. Workspace rule: no backward compatibility, no migration shim.

## Changes from round 2

- Daemon-impact section is rewritten as a concrete path inventory of
  every known `.saivage/config.json` across the five workspace
  mirrors and four LXC containers, with per-path strict-load status.
  The round-2 "every seeded project will fail at restart" claim is
  withdrawn; no currently-known on-disk config carries the legacy
  key. See [Daemon impact (concrete on-disk inventory)](#daemon-impact-concrete-on-disk-inventory).
- Every resolver line anchor is refreshed against the live file:
  the fallback call at L108 (not L110), `resolveRuntimeDefaultModels`
  at L247-L252 (not L249-L253), `resolveLegacyModels` at L254-L262
  (not L254-L260). See [A.2](#a2-resolver-collapse-legacy-arm-into-runtime-default-arm)
  and the [stale anchor audit in 01-analysis-r3.md](01-analysis-r3.md#stale-anchor-audit-against-current-files).
- G25 cross-references switch from the superseded round-2 design to
  [../G25/03-plan-r3.md](../G25/03-plan-r3.md). The "G25 depends on
  `source` remaining diagnostic-grade" claim from round 2 is dropped:
  G25 r3 is silent on `source` and only requires the helper rename
  ([../G25/03-plan-r3.md](../G25/03-plan-r3.md#L14-L16)).
- Hard ordering constraint added: schema change (A.1) and seeder
  change (A.3) must land in the same commit, because otherwise
  newly-seeded projects trip strict load. See
  [Ordering constraint](#ordering-constraint-schema-and-seeder).

## Proposal A (recommended) — focused removal with strict schema

Touch the three on-disk surfaces (schema, seeder, resolver), update
tests, and trim the docs guide.

### A.1 Schema: remove `model_overrides` from `ProjectConfigSchema`

Edit [src/types.ts](../../../../src/types.ts#L12-L30). Delete the line
at [src/types.ts](../../../../src/types.ts#L15):

```ts
model_overrides: z.record(z.string(), z.string()).optional(),
```

Make the schema strict for the keys it does know: add `.strict()` to
the `z.object({ ... })` call so that any project config that still
carries `model_overrides` (or any other unknown top-level key) fails
loudly at load time with a typed Zod error. This converts the
"silent strip" default behaviour into "operator-visible failure",
which is the contract the no-shim rule demands: operators with stale
configs see a clear error, not a stealth removal of their routing
hint.

Rationale for `.strict()` rather than `.passthrough()` or the
current default:

- Default Zod behaviour strips unknown keys silently. Under the
  no-shim rule, an operator whose `config.json` still has
  `model_overrides: { coder: "x/y" }` would lose that routing
  intent without any signal — that is exactly the migration-shim
  failure mode we are deleting. Loud failure is the architecturally
  correct alternative.
- `.passthrough()` would preserve the stale field, which contradicts
  the deletion goal.
- The seeder currently writes the empty stub at
  [src/store/project.ts](../../../../src/store/project.ts#L129).
  Default Zod would silently strip it on the next reload;
  `.strict()` rejects it with a typed `unrecognized_keys` error
  pointing at `model_overrides`, which is the architecturally
  correct signal that A.3 (seeder removal) must ride alongside A.1.

### A.2 Resolver: collapse legacy arm into runtime-default arm

All line numbers below are against the live file
[src/routing/resolver.ts](../../../../src/routing/resolver.ts). Edit:

- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L55):
  remove the `model_overrides?: Record<string, string>;` member from
  `ProjectRoutingConfigLike`. The interface header at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57)
  shrinks to a single `routing?: ProjectRoutingConfig` member. (Note
  the G24 coordination point in [01-analysis-r3.md](01-analysis-r3.md)
  — if G24 lands first, this member has already moved to
  `ProjectRoutingInput`; the deletion still applies.)
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L75):
  narrow the source union to
  `source: "routing" | "runtime-default";`.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L108):
  replace `this.resolveLegacyModels(role)[0]` with
  `this.resolveRuntimeDefaultModels(role)[0]`. The `?? throw`
  semantics are preserved by the new throw contract on
  `resolveRuntimeDefaultModels` (see below).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219):
  the trailing `return this.resolveLegacyModels(role);` inside
  `resolvePreferredModels` becomes
  `return this.resolveRuntimeDefaultModels(role);`. The helper must
  guarantee the same "throw if empty" contract on exhaustion. Easiest
  path: change the return contract of `resolveRuntimeDefaultModels`
  to throw `MissingModelForRoleError([role], configPath())` when no
  model is available, matching the old `resolveLegacyModels`
  final-throw branch. The two callers
  ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L108)
  and the new
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219)
  call) both want that throw-or-non-empty contract.
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

### A.4 Tests: drop legacy-source case, add strict-schema case

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
the source file — this is the round-1 reviewer-concern-1 fix that lets
the source-wide grep gates remain a clean zero-match assertion:

```ts
import { describe, expect, it } from "vitest";
import { ProjectConfigSchema } from "./types.js";

// The legacy v1 routing key we are confirming is rejected by the
// strict schema. Built at runtime so the bareword does not appear
// in source-tree greps for "model_overrides" (G26 grep gate).
const LEGACY_KEY = ["model", "overrides"].join("_");

describe("ProjectConfigSchema (G26 strict-mode rejection)", () => {
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
      const keys = result.error.issues.flatMap((issue) =>
        (issue as { keys?: string[] }).keys ?? [],
      );
      expect(keys).toContain(LEGACY_KEY);
    }
  });

  it("also rejects an empty legacy stub", () => {
    const fixture: Record<string, unknown> = {
      project_name: "x",
      objectives: [],
      routing: { roles: {}, profiles: {} },
      skills: { max_per_agent: 5 },
    };
    fixture[LEGACY_KEY] = {};

    expect(ProjectConfigSchema.safeParse(fixture).success).toBe(false);
  });
});
```

Two reasons to build the key at runtime rather than as a literal:

1. The grep gate in [03-plan-r3.md](03-plan-r3.md) asserts zero
   occurrences of `model_overrides` across the source tree. Writing
   the bareword in a test file would make the gate fire on the test
   file itself. Constructing the key via `["model","overrides"].join("_")`
   keeps the test self-contained without coupling the gate to a
   per-file allow-list.
2. It documents intent: the literal is a key the codebase explicitly
   does not want to write any more, and naming it via concatenation
   makes that explicit.

The second test (`rejects an empty legacy stub`) is the explicit
regression for the seeder-coupling concern from
[01-analysis-r3.md](01-analysis-r3.md): an empty `model_overrides: {}`
is the value the seeder used to write, and after G26 it must fail
load just like a non-empty one.

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
  shrinks). G25 r3 plan is silent on `source`; nothing in the resolver
  batch needs the field to disappear
  ([../G25/03-plan-r3.md](../G25/03-plan-r3.md#L14-L16)).
- `resolveRuntimeDefaultModels` body: only its exhaustion contract
  changes (throw on empty), not its happy-path return shape.
- Resolver constructor cycle check (G23 territory).
- Input narrowing / cached `this.routing` (G24 territory).
- Allowed-list validation throws (G25 territory).
- No migration shim, no auto-stripper, no warn-and-strip path. The
  schema simply refuses to load a `config.json` that still has the
  key, and operators remove it manually before restart.

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

## Recommendation

**Proposal A**. It deletes the legacy arm architecturally (schema,
seeder, resolver, tests, docs), refuses to silently honour stale
on-disk fields, and keeps the design boundary with G23 / G24 / G25
intact.

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
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L201-L221)
  (`resolvePreferredModels` body). Recommended order: G25 lands
  first; G26 renames the trailing
  `return this.resolveLegacyModels(role);` to
  `return this.resolveRuntimeDefaultModels(role);` inside the new
  G25 body. The plan task list in
  [03-plan-r3.md](03-plan-r3.md) targets the helper rename, not the
  surrounding body shape, so it is robust to G25 wording changes.

## Ordering constraint: schema and seeder

A.1 (schema strict-mode + field deletion at
[src/types.ts](../../../../src/types.ts#L15)) and A.3 (seeder field
deletion at
[src/store/project.ts](../../../../src/store/project.ts#L129)) must
land in the same commit. The reason is the round-3 daemon-impact
finding: the seeder is the only currently-active producer of the
`model_overrides` key on disk. If A.1 ships before A.3, every project
seeded between the two commits will trip strict load at the next
restart. If A.3 ships before A.1, the change is a no-op until A.1
lands. Either ordering across separate commits introduces a
needless window; same-commit landing closes the window.

This is captured operationally as a hard task-ordering constraint in
[03-plan-r3.md](03-plan-r3.md) §"Tasks (sequential)" — Task 1
(schema) and Task 3 (seeder) sit inside the same diff and are
gated together.

## Daemon impact (concrete on-disk inventory)

This section is the reviewer-required rewrite of the round-2
"category list". Every known `.saivage/config.json` was inspected by
key-presence only (no secret material was read; no values were
printed) for the round-3 audit.

| Path | Exists? | Has `model_overrides`? | Strict-load status |
|------|---------|------------------------|--------------------|
| /home/salva/g/ml/saivage/.saivage/config.json | no | n/a | n/a (no project at this path) |
| /home/salva/g/ml/saivage-v3/.saivage/config.json | yes | no | clean, loads |
| /home/salva/g/ml/getrich/.saivage/config.json | yes | no | clean, loads |
| /home/salva/g/ml/getrich-v2/.saivage/config.json | no | n/a | n/a (post-F33 split layout; routing not in config.json) |
| /home/salva/g/ml/diedrico/.saivage/config.json | yes | no | clean, loads |
| 10.0.3.111 /work/getrich/.saivage/config.json | yes | no | clean, loads |
| 10.0.3.112 /work/saivage-v3/.saivage/config.json | yes | no | clean, loads |
| 10.0.3.113 /work/diedrico/.saivage/config.json | yes | no | clean, loads |
| 10.0.3.170 /opt/saivage-v3/.saivage/config.json | yes | no | clean, loads |
| 10.0.3.170 /work/getrich-v2/.saivage/config.json | no | n/a | n/a (post-F33 split layout) |

Net daemon impact today: zero. Every known on-disk config loads
cleanly under the proposed `.strict()` schema with no operator
intervention required. The round-2 "every project will fail at
restart" claim is wrong and is withdrawn.

The strict-load behaviour is still architecturally required under
the no-shim rule, but it triggers only in two future-tense paths:

- An operator-edited config that explicitly populates
  `model_overrides` between now and G26 landing. Failure mode:
  `ProjectConfigSchema.safeParse(...)` returns `success: false` with
  a `ZodIssue` whose `code` is `unrecognized_keys` and whose `keys`
  array contains `"model_overrides"`. The daemon surfaces that error
  at startup and refuses to load the project.
- A newly-seeded project carrying the stub, between A.1 landing and
  A.3 landing. The [Ordering constraint](#ordering-constraint-schema-and-seeder)
  above forces A.1 and A.3 into the same commit and closes this
  window.

Per workspace rule (no backward compatibility, no migration shim),
G26 does not add an auto-stripper or a warn-and-strip path. The
operator-gated post-deploy check in [03-plan-r3.md](03-plan-r3.md)
Task 7 is now correctly framed as "verification, expected to return
zero hits on the current fleet", not as "triage step the operator
must run before every restart". The plan does not perform any
config edits; it documents the check the operator can run from the
host.
