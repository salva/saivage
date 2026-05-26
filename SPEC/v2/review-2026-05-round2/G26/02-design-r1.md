# G26 — Design (round 1, writer Claude Opus 4.7)

Reads from [01-analysis-r1.md](01-analysis-r1.md).

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

## Proposal A (recommended) — focused removal with strict schema

Touch the three on-disk surfaces (schema, seeder, resolver), update
tests, and trim the docs guide.

### A.1 Schema: remove `model_overrides` from `ProjectConfigSchema`

Edit
[../../../../src/types.ts](../../../../src/types.ts#L11-L29). Delete
the line at
[../../../../src/types.ts](../../../../src/types.ts#L15):

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

If [src/types.ts](../../../../src/types.ts) imports any types from
upstream that previously satisfied the optional `model_overrides`
slot, none of them feed back into the schema; this is a pure
removal.

### A.2 Resolver: collapse legacy arm into runtime-default arm

Edit [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts):

- L54-L57:
  remove the `model_overrides?: Record<string, string>;` member from
  `ProjectRoutingConfigLike`. (Note the G24 coordination point in
  01-analysis-r1.md — if G24 lands first, this member has already
  moved to `ProjectRoutingInput`; the deletion still applies.)
- L70-L78:
  narrow the source union to
  `source: "routing" | "runtime-default";`.
- L108-L131
  (`resolve`): replace `this.resolveLegacyModels(role)[0]` with
  `this.resolveRuntimeDefaultModels(role)[0]`. The `?? throw`
  semantics are unchanged because `resolveRuntimeDefaultModels`
  returns `string[]` and the caller already throws
  `MissingModelForRoleError` when the candidate is `undefined`.
- L213-L221
  (`resolvePreferredModels`): the trailing
  `return this.resolveLegacyModels(role);`
  becomes
  `return this.resolveRuntimeDefaultModels(role);` and the helper
  must therefore guarantee the same "throw if empty" contract on
  exhaustion. Easiest path: change the return contract of
  `resolveRuntimeDefaultModels` to throw
  `MissingModelForRoleError([role], configPath())` when no model is
  available, matching the old `resolveLegacyModels` final-throw
  branch. The two existing callers
  ([../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L110)
  and the new
  [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219)
  call) both want that throw-or-non-empty contract.
- L254-L260:
  delete the entire `resolveLegacyModels` method.
- L264-L269:
  rewrite `resolveSource` so it no longer branches on
  `model_overrides`:

  ```ts
  private resolveSource(role: string, rule: NormalizedRule): ResolvedModelRoute["source"] {
    if (rule.model || rule.preferredModels.length || rule.allowedModels?.length || rule.profile) return "routing";
    return "runtime-default";
  }
  ```

  Drop the third argument `preferredModels` from the signature —
  it was passed in but never read by the existing body
  ([../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L264)).
  Update the single call site
  ([../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L127))
  to match. Drop the unreachable `throw new Error("unreachable: …")`
  line: with the legacy arm gone and
  `resolveRuntimeDefaultModels` now responsible for the missing-role
  throw at `resolve()`'s call site, `resolveSource` is total.

### A.3 Seeder: stop writing `model_overrides`

Edit
[../../../../src/store/project.ts](../../../../src/store/project.ts#L125-L132).
Delete the `model_overrides: {},` line so the seeded
`ProjectConfig` literal no longer carries the stub. Because the
schema in A.1 will now reject the unknown key, the seeder must not
keep writing it.

### A.4 Tests: drop legacy-source case, add strict-schema case

Edit
[../../../../src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28).
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
because the behaviour disappears from the resolver.

Add one regression test in
[../../../../src/types.ts](../../../../src/types.ts) coverage (the
existing
[../../../../src/config-validation.ts](../../../../src/config-validation.ts)
suite is the closest neighbour; if no test for
`ProjectConfigSchema` exists yet, add a one-file test
[../../../../src/types.test.ts](../../../../src/types.test.ts) — but
only if the grep gate in the plan shows no existing schema test).
The new test asserts that a `ProjectConfig` carrying
`model_overrides` is rejected by `ProjectConfigSchema.safeParse`.

### A.5 Docs: drop legacy field from the routing guide

Edit the routing guide so it no longer markets `model_overrides`:

- [../../../../docs/guide/routing.md](../../../../docs/guide/routing.md#L3):
  drop the "For non-trivial deployments, plain `model_overrides`…"
  framing; rewrite as "Saivage ships a `ModelRoutingResolver` that…".
- [../../../../docs/guide/routing.md](../../../../docs/guide/routing.md#L15):
  remove the bullet `- ProjectConfig.model_overrides (legacy, still
  honored)`.
- [../../../../docs/guide/routing.md](../../../../docs/guide/routing.md#L73):
  remove the "If still missing fields, fall back to
  `model_overrides[<role>]`…" step from the resolution algorithm; the
  algorithm becomes (1) role rule lookup, (2) merge with referenced
  profile, (3) fall back to `RuntimeConfig.models[<role>]` /
  `RuntimeConfig.models.default`, (4) validate, (5) emit.
- [../../../../docs/guide/routing.md](../../../../docs/guide/routing.md#L94):
  remove the "Mix of cheap & smart models → use `model_overrides`"
  bullet; the equivalent routing-profile recipe (`profiles: { cheap:
  { … } }` with `roles: { … }`) is already documented above on the
  same page.
- [../../../../docs/guide/providers.md](../../../../docs/guide/providers.md#L58):
  remove the `ProjectConfig.model_overrides[<role>]` line from the
  precedence list.
- [../../../../docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md#L68):
  remove the "Project-level `model_overrides` take …" clause.
- [../../../../docs/guide/config-project.md](../../../../docs/guide/config-project.md#L40-L89):
  delete the `model_overrides` JSON example and its table row.
- [../../../../docs/guide/troubleshooting.md](../../../../docs/guide/troubleshooting.md#L11):
  reword the "update `model_overrides`" advice to "update the routing
  profile".
- [../../../../docs/guide/install-lxc.md](../../../../docs/guide/install-lxc.md#L104):
  remove the `"model_overrides": {},` line from the sample seeded
  config.

`docs/api/**` is typedoc-generated from `src/*.ts`; regenerating
those files is a build step, not a manual edit. The
`docs/.vitepress/dist/**` tree is the VitePress static build output;
it regenerates on `npm run build:docs`.

### A.6 What is explicitly not touched

- `ResolvedModelRoute.source` itself: kept (only its literal set
  shrinks). G25 depends on `source` remaining diagnostic-grade.
- `resolveRuntimeDefaultModels` body: unchanged except for the new
  throw contract.
- Resolver constructor cycle check (G23 territory).
- Input narrowing / cached `this.routing` (G24 territory).
- Allowed-list validation throws (G25 territory).

## Proposal B — also delete the `source` field

A more aggressive cut: delete `source` from `ResolvedModelRoute`
entirely and stop computing it. The grep in
[01-analysis-r1.md](01-analysis-r1.md) shows no live consumer reads
`source` outside the resolver test file. If `source` carries no
operational signal, the `resolveSource` helper and the union
literal are themselves dead code.

Rejected because:

- G25 design relies on `source` as a diagnostic discriminant for
  classifying `allowed_models`-only rules as routing-derived
  ([../G25/02-design-r1.md](../G25/02-design-r1.md)). Deleting the
  field invalidates that classification before G25 reviewers can
  weigh in.
- The field is small and clearly documented. Removing it adds
  cross-finding risk that does not belong inside a low-severity
  dead-code finding.
- Even if the field has no current consumer, it is a sensible
  observability hook for future routing telemetry (e.g. a `/api/state`
  field reporting which spec source produced each role's model).
  Deleting it now is a one-way door.

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
  [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57)
  (`ProjectRoutingConfigLike` deletion + `model_overrides` member
  deletion). Both findings agree the member should disappear; the
  later finding in the merge order simply removes whatever survives.
  Recommended order: G24 lands first; G26 then has nothing to delete
  at this site.
- G25 (analysis only): collision on
  [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L213-L221)
  (`resolvePreferredModels` body). Recommended order: G25 lands
  first; G26 renames the trailing
  `return this.resolveLegacyModels(role);` to
  `return this.resolveRuntimeDefaultModels(role);` inside the new
  G25 body. The plan task list in
  [03-plan-r1.md](03-plan-r1.md) targets the helper rename, not the
  surrounding body shape, so it is robust to G25 rewording.

## Daemon impact

None for any project whose `config.json` has an empty or absent
`model_overrides` field — which is every project the seeder has
created since v2 shipped. Projects with a non-empty
`model_overrides` map will fail loudly at config load (Zod strict
mode), forcing the operator to migrate to the routing-profile
format. The error is typed and shows the offending field name,
which is the architecturally correct signal under the no-shim
rule. Any saivage-v3 restart remains operator-gated per the
workspace handoff.
