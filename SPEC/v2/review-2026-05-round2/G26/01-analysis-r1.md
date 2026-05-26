# G26 — Analysis (round 1, writer Claude Opus 4.7)

Issue source: [../G26-resolver-legacy-source-tier.md](../G26-resolver-legacy-source-tier.md).

## What the resolver actually does today

The routing resolver classifies every `ResolvedModelRoute` it returns with a
`source` discriminator that is one of three string literals
([../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L70-L78)):

- `"routing"` — the role rule or its inherited profile carried any of
  `model`, `preferred_models`, `allowed_models`, or `profile`.
- `"legacy"` — the role's spec came exclusively from the optional
  `ProjectConfig.model_overrides[role]` map.
- `"runtime-default"` — the spec came from `RuntimeConfig.models[<key>]`,
  `RuntimeConfig.models.default`, or the supervisor / security role
  shortcuts.

The `"legacy"` tier is the only one that survives an explicit pre-v2
migration step: `ProjectConfig.model_overrides` is the pre-routing-profile
field that the resolver still reads at
[../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L260)
inside `resolveLegacyModels`, and that
`resolveSource`
([../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L264-L269))
maps to the `"legacy"` literal. The schema field still lives on
`ProjectConfigSchema` at
[../../../../src/types.ts](../../../../src/types.ts#L15), and the project
seeder still writes an empty `model_overrides: {}` object into every new
project at
[../../../../src/store/project.ts](../../../../src/store/project.ts#L129).

## Why it is dead weight under current rules

The workspace mandate is architecture-first with no backward compatibility
and no migration shims (top-level user instruction; restated in
[../00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) and applied throughout
the review-2026-05 metaplan). `model_overrides` is exactly the kind of
pre-v2 shim that rule forbids:

- It exists only to honour the legacy "role → modelSpec" map that
  predates the routing-profile system shipped in v2.
- No live code path emits a `model_overrides` entry: the seeder
  ([../../../../src/store/project.ts](../../../../src/store/project.ts#L129))
  writes an empty object, and nothing else in `src/` or `web/src/`
  populates the field.
- The `"legacy"` literal on `ResolvedModelRoute.source`
  ([../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L75))
  has no live consumer either: a workspace-wide grep for `"legacy"` as a
  source value returns hits only in the resolver itself, the compiled
  `dist/` artefact, and the resolver test
  ([../../../../src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28)).
- The docs guide still markets the field as "(legacy, still honored)"
  ([../../../../docs/guide/routing.md](../../../../docs/guide/routing.md#L15)),
  which is exactly the migration vocabulary the rule says to delete.

The result is a four-arm structure (routing → legacy → runtime-default →
throw) that should be a three-arm structure (routing → runtime-default →
throw). Every reader of the resolver has to load a fourth case that is
proven to never fire.

Note on the issue's "trace UI" framing: the round-1 issue document
mentions "routing trace UI". The resolver does not emit a trace anywhere
in the live codebase — `source` is just a field on the returned
`ResolvedModelRoute`. No web component, no log line, no diagnostic
reads it. Removing the `"legacy"` arm therefore needs no UI change; the
fix is entirely backend.

## Root cause

`ProjectConfig.model_overrides` is a pre-v2 routing format that was
preserved as a parallel input alongside the routing-profile schema when
v2 landed. The resolver never grew a code path that converts
`model_overrides` into a routing-profile equivalent, and the project
seeder was never updated to stop writing the empty stub. Because the
"keep it working too" branch survived the v2 cut, the source-tier union
gained a `"legacy"` literal whose only job is to identify which dead
branch produced the spec.

## What the fix has to touch

To remove the legacy tier architecturally (rather than hiding it behind
an unused field), the following surfaces all need to change in one
batch:

- Resolver type union and merge order
  ([../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L70-L78),
  [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57),
  [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L108-L131),
  [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L213-L221),
  [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L269)).
- Project schema field
  ([../../../../src/types.ts](../../../../src/types.ts#L15)).
- Project seeder default value
  ([../../../../src/store/project.ts](../../../../src/store/project.ts#L129)).
- Resolver tests for the legacy-source path
  ([../../../../src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28)).
- Routing guide that still advertises the field
  ([../../../../docs/guide/routing.md](../../../../docs/guide/routing.md#L3-L94),
  [../../../../docs/guide/providers.md](../../../../docs/guide/providers.md#L58),
  [../../../../docs/guide/config-project.md](../../../../docs/guide/config-project.md#L40-L89),
  [../../../../docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md#L68),
  [../../../../docs/guide/troubleshooting.md](../../../../docs/guide/troubleshooting.md#L11),
  [../../../../docs/guide/install-lxc.md](../../../../docs/guide/install-lxc.md#L104)).

The `docs/api/**` and `docs/.vitepress/dist/**` trees are typedoc and
VitePress build outputs (the API tree is regenerated from
`src/*.ts`; the dist tree is regenerated by `npm run build:docs`). They
are not edited by hand.

## Sequencing constraints

All three open resolver findings (G23, G24, G25) touch
[../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts).
G23 and G24 are already APPROVED
([../G23/APPROVED.md](../G23/APPROVED.md),
[../G24/APPROVED.md](../G24/APPROVED.md)). G25 has a writer plan but no
approval yet ([../G25/03-plan-r1.md](../G25/03-plan-r1.md)). All three
APPROVED docs explicitly list G26 as a coordination partner.

The hard constraints are:

- G23 introduces a synchronous cycle check in the constructor; it does
  not touch `resolveSource` or `resolveLegacyModels`. Independent of
  G26.
- G24 narrows the resolver input to a `ProjectRoutingInput` type
  derived from `ProjectConfig` and deletes
  `ProjectRoutingConfigLike`. Once G24 lands,
  [../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57)
  no longer exists; the `model_overrides?: Record<string, string>`
  member that G26 wants to delete moves into `ProjectRoutingInput`
  (still derived from `ProjectConfig`). So if G24 lands first, G26
  drops `model_overrides` from `ProjectConfigSchema`; that change
  propagates automatically through the narrowed input type. If G26
  lands first, G24 simply does not carry the field forward.
- G25 rewrites `resolvePreferredModels` and `resolvePreferredAccounts`
  and adds a typed `NoAllowedRouteMatchError`. G25's own
  [../G25/03-plan-r1.md](../G25/03-plan-r1.md) explicitly defers the
  legacy source tier to G26 (see
  [../G25/03-plan-r1.md](../G25/03-plan-r1.md#L206) and
  [../G25/02-design-r1.md](../G25/02-design-r1.md#L109)). G25 does
  touch `resolvePreferredModels` line range that ends with
  `return this.resolveLegacyModels(role);`
  ([../../../../src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219)).
  G26 renames that helper. The two changes are compatible if G25 lands
  first: G26 then just renames the call inside the new G25 body.

Recommended ordering: G23 → G24 → G25 → G26. G26 is last because it
deletes vocabulary every prior resolver change has to remain aware of.
G26 is independently mergeable as long as it does not delete the
`source` field itself (only the `"legacy"` literal and its producer).

## Out-of-scope for G26

- The `source` field on `ResolvedModelRoute` is preserved. Removing it
  is a separate "do we need diagnostic provenance at all" question that
  the metaplan has not adjudicated; G25's design preserves it as a
  diagnostic discriminant
  ([../G25/02-design-r1.md](../G25/02-design-r1.md)).
- The runtime-default and routing arms are untouched. G26 only deletes
  the legacy arm.
- `dist/cli.js` is a build artefact and is regenerated by the build
  step; G26 does not patch it.

## Risks

- Existing operator config files in containers may still carry a
  `model_overrides: {}` (or non-empty) stub from the previous seeder.
  Because the workspace rule is "no backward compatibility, no
  migration shim", G26 must reject such files at startup: Zod's
  default behaviour with `ProjectConfigSchema` (no `.passthrough()`,
  no `.strict()`) is to silently strip unknown fields. After G26, a
  legacy `model_overrides` key in `config.json` would be silently
  dropped, which is the right behaviour for an empty stub but masks
  the case where an operator actually relied on the field. The
  design must decide whether to fail loudly (recommended) or to drop
  silently. See [02-design-r1.md](02-design-r1.md).
- G25 has not yet been approved; if G25's body shape changes before
  approval, the G26 plan's `resolvePreferredModels` patch site needs
  to be re-checked. Mitigation: G26 plan targets the helper rename
  only, not the body shape, so it is robust to G25 wording changes.
