# G26 — Design (round 2, writer Claude Opus 4.7)

Reads from [01-analysis-r2.md](01-analysis-r2.md).
Addresses [04-review-r1.md](04-review-r1.md) reviewer concerns 1 and 2.

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

## Changes from round 1

- Daemon-impact framing is rewritten: every seeded project today
  carries `model_overrides: {}` on disk and will fail strict-schema
  load until an operator removes the key by hand. The "no daemon
  impact for projects with an empty stub" claim is gone. See
  [Daemon impact](#daemon-impact) below.
- The schema-rejection test fixture is now constructed via runtime
  property assignment so the literal token `model_overrides` does
  not appear in the source-only grep gates. See
  [A.4](#a4-tests-drop-legacy-source-case-add-strict-schema-case) and
  the grep-gate redesign in [03-plan-r2.md](03-plan-r2.md).
- Analysis no longer claims the legacy arm is "proven to never fire";
  the design now treats it as a live legacy production input that
  must be removed and rejected.

## Proposal A (recommended) — focused removal with strict schema

Touch the three on-disk surfaces (schema, seeder, resolver), update
tests, and trim the docs guide.

### A.1 Schema: remove `model_overrides` from `ProjectConfigSchema`

Edit [src/types.ts](../../../../src/types.ts#L12-L29). Delete the line
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
- The empty stub case is not benign: every project the seeder has
  created since v2 ships carries `model_overrides: {}` on disk
  ([src/store/project.ts](../../../../src/store/project.ts#L125-L133)).
  Default Zod would silently strip it; `.strict()` rejects it with
  a typed `unrecognized_keys` error pointing at `model_overrides`,
  which is the architecturally correct signal that the operator
  must remove the key.

### A.2 Resolver: collapse legacy arm into runtime-default arm

Edit [src/routing/resolver.ts](../../../../src/routing/resolver.ts):

- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57):
  remove the `model_overrides?: Record<string, string>;` member from
  `ProjectRoutingConfigLike`. (Note the G24 coordination point in
  [01-analysis-r2.md](01-analysis-r2.md) — if G24 lands first, this
  member has already moved to `ProjectRoutingInput`; the deletion
  still applies.)
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L75):
  narrow the source union to
  `source: "routing" | "runtime-default";`.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L110):
  replace `this.resolveLegacyModels(role)[0]` with
  `this.resolveRuntimeDefaultModels(role)[0]`. The `?? throw`
  semantics are unchanged because `resolveRuntimeDefaultModels`
  returns `string[]` and the caller already throws
  `MissingModelForRoleError` when the candidate is `undefined`.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219):
  the trailing `return this.resolveLegacyModels(role);` becomes
  `return this.resolveRuntimeDefaultModels(role);` and the helper
  must therefore guarantee the same "throw if empty" contract on
  exhaustion. Easiest path: change the return contract of
  `resolveRuntimeDefaultModels` to throw
  `MissingModelForRoleError([role], configPath())` when no model is
  available, matching the old `resolveLegacyModels` final-throw
  branch. The two existing callers
  ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L110)
  and the new
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219)
  call) both want that throw-or-non-empty contract.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L260):
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
  `throw new Error("unreachable: …")` line: with the legacy arm gone
  and `resolveRuntimeDefaultModels` now responsible for the
  missing-role throw at `resolve()`'s call site, `resolveSource` is
  total.

### A.3 Seeder: stop writing `model_overrides`

Edit
[src/store/project.ts](../../../../src/store/project.ts#L125-L133).
Delete the `model_overrides: {},` line so the seeded
`ProjectConfig` literal no longer carries the stub. Because the
schema in A.1 will now reject the unknown key, the seeder must not
keep writing it.

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
the source file — this is the reviewer-concern-1 fix that lets the
source-wide grep gates remain a clean zero-match assertion:

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

1. The grep gate in [03-plan-r2.md](03-plan-r2.md) asserts zero
   occurrences of `model_overrides` across the source tree. Writing
   the bareword in a test file would make the gate fire on the test
   file itself. Constructing the key via `["model","overrides"].join("_")`
   keeps the test self-contained without coupling the gate to a
   per-file allow-list. (An alternative — narrowing the grep to
   non-test paths — is also documented in the plan as a belt-and-braces
   measure, but the runtime-built key keeps the test honest if anyone
   later widens the grep scope.)
2. It documents intent: the literal is a key the codebase explicitly
   does not want to write any more, and naming it via concatenation
   makes that explicit.

The second test (`rejects an empty legacy stub`) is the explicit
regression for the daemon-impact concern from
[01-analysis-r2.md](01-analysis-r2.md): an empty `model_overrides: {}`
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
  shrinks). G25 depends on `source` remaining diagnostic-grade.
- `resolveRuntimeDefaultModels` body: unchanged except for the new
  throw contract on exhaustion.
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

- G25 design relies on `source` as a diagnostic discriminant for
  classifying `allowed_models`-only rules as routing-derived
  ([../G25/02-design-r2.md](../G25/02-design-r2.md#L226-L230)).
  Deleting the field invalidates that classification before G25
  reviewers can weigh in.
- The field is small and clearly documented. Removing it adds
  cross-finding risk that does not belong inside a low-severity
  dead-code finding.
- Even if the field has no current consumer, it is a sensible
  observability hook for future routing telemetry (e.g. a
  `/api/state` field reporting which spec source produced each
  role's model). Deleting it now is a one-way door.

If the metaplan later decides telemetry is not coming, a follow-on
finding can delete the field cleanly. G26 should not be that
finding.

## Recommendation

**Proposal A**. It deletes the legacy arm architecturally (schema,
seeder, resolver, tests, docs), refuses to silently honour stale
on-disk fields, and keeps the design boundary with G23 / G24 / G25
intact.

## Sequencing constraints (restated)

- G23 (APPROVED): independent. No collision.
- G24 (APPROVED): collision on
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57)
  (`ProjectRoutingConfigLike` deletion + `model_overrides` member
  deletion). Both findings agree the member should disappear; the
  later finding in the merge order simply removes whatever survives.
  Recommended order: G24 lands first; G26 then has nothing to delete
  at this site.
- G25 (design r2, not yet approved): collision on
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L221)
  (`resolvePreferredModels` body). Recommended order: G25 lands
  first; G26 renames the trailing
  `return this.resolveLegacyModels(role);` to
  `return this.resolveRuntimeDefaultModels(role);` inside the new
  G25 body. The plan task list in
  [03-plan-r2.md](03-plan-r2.md) targets the helper rename, not the
  surrounding body shape, so it is robust to G25 wording changes.

## Daemon impact

Non-trivial and operator-gated. This is the round-2 correction to the
round-1 "none for empty stubs" claim.

Because the seeder at
[src/store/project.ts](../../../../src/store/project.ts#L129) writes
`model_overrides: {}` into the seeded `config.json` of every project,
every Saivage project that has been initialised against this codebase
since v2 shipped has the empty stub persisted on disk. Under the new
`.strict()` schema, the empty stub is rejected at config load.

After G26 ships, the following will fail to load until an operator
edits the config:

- The seeded `config.json` inside every container that runs a Saivage
  project (the v2 harness at `10.0.3.111`, the v3 harness at
  `10.0.3.112`, the v3-on-getrich-v2 deployment at `10.0.3.170`, the
  diedrico harness at `10.0.3.113`).
- Any local target-project `config.json` checked into a developer
  workspace.
- Any hand-edited operator config that explicitly populated the field
  to route a role.

Failure mode: `ProjectConfigSchema.safeParse(...)` returns
`success: false` with a `ZodIssue` whose `code` is
`unrecognized_keys` and whose `keys` array contains
`"model_overrides"`. The daemon surfaces that error at startup and
refuses to load the project, instead of silently dropping the field.
Operators see the offending key name in the error message.

Per workspace rule (no backward compatibility, no migration shim),
G26 does not add an auto-stripper or a warn-and-strip path. The
operator action required after G26 lands is a manual edit removing
the `model_overrides` key from each affected `config.json`. The plan
in [03-plan-r2.md](03-plan-r2.md) calls out that action as
operator-gated post-deploy work, consistent with the workspace
handoff's restart-gating policy. The plan does not perform the edits;
it documents the check the operator can run from the host.
