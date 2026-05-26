# G26 — Analysis (round 2, writer Claude Opus 4.7)

Issue source: [../G26-resolver-legacy-source-tier.md](../G26-resolver-legacy-source-tier.md).
Round 1 reviewer critique: [04-review-r1.md](04-review-r1.md).

## Changes from round 1

Reviewer concern 2 ("production-deadness and daemon-impact framing is
internally inconsistent") is addressed in this round. Round 1 said the
legacy arm was "proven to never fire" and that the daemon impact for
empty stubs was "none". Both statements are wrong:

- `model_overrides` is a live accepted production input. The schema
  accepts it at [src/types.ts](../../../../src/types.ts#L12-L16), the
  seeder writes `model_overrides: {}` into every new project at
  [src/store/project.ts](../../../../src/store/project.ts#L125-L133),
  and the resolver consumes any non-empty values at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L260)
  and tags the result `"legacy"` at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L264-L269).
  The legacy arm would fire today for any operator-edited config that
  carries a non-empty `model_overrides[<role>]` map. The fact that no
  in-repo seeder writes a non-empty value is not the same as the arm
  being dead. It is a live legacy input that the no-shim rule says to
  remove and reject, not a never-firing branch.
- Under the proposed `.strict()` behaviour at the
  [ProjectConfigSchema](../../../../src/types.ts#L12-L29) `z.object({…})`
  call, every existing on-disk `config.json` whose seeded
  `model_overrides: {}` stub has not been hand-removed will fail config
  load. "Empty stub" is not a free pass — Zod strict mode rejects the
  unknown key regardless of its value. The daemon impact is therefore
  non-trivial and operator-gated, not "none".

Reviewer concern 1 (grep gates collide with required schema-rejection
test) is structural and is addressed in [03-plan-r2.md](03-plan-r2.md);
the analysis is unchanged on that axis.

## What the resolver actually does today

The routing resolver classifies every `ResolvedModelRoute` it returns
with a `source` discriminator that is one of three string literals
([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L66-L78)):

- `"routing"` — the role rule or its inherited profile carried any of
  `model`, `preferred_models`, `allowed_models`, or `profile`.
- `"legacy"` — the role's spec came exclusively from the optional
  `ProjectConfig.model_overrides[role]` map.
- `"runtime-default"` — the spec came from `RuntimeConfig.models[<key>]`,
  `RuntimeConfig.models.default`, or the supervisor / security role
  shortcuts.

The `"legacy"` tier is the only one that ships a pre-v2 migration arm.
`ProjectConfig.model_overrides` is the pre-routing-profile field that
`resolveLegacyModels` at
[src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L260)
reads, and that `resolveSource` at
[src/routing/resolver.ts](../../../../src/routing/resolver.ts#L264-L269)
maps to the `"legacy"` literal. The schema field still lives on
`ProjectConfigSchema` at
[src/types.ts](../../../../src/types.ts#L15), and the project seeder
still writes an empty `model_overrides: {}` object into every new
project at [src/store/project.ts](../../../../src/store/project.ts#L129).

## Why it is a legacy input that must be removed (and rejected)

The workspace mandate is architecture-first with no backward
compatibility and no migration shims (top-level user instruction;
restated in [../00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) and applied
throughout the review-2026-05 metaplan). `model_overrides` is exactly
the kind of pre-v2 routing input that rule forbids:

- It exists only to honour the legacy "role → modelSpec" map that
  predates the routing-profile system shipped in v2.
- The seeder writes the empty stub
  ([src/store/project.ts](../../../../src/store/project.ts#L129)) and
  the resolver still reads any non-empty entry an operator may have
  added; this is the live "kept it working too" surface that the
  no-shim rule says to delete.
- The `"legacy"` literal on `ResolvedModelRoute.source`
  ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L75))
  has no consumer outside the resolver itself, the compiled `dist/`
  artefact, and the resolver test at
  [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28).
- The docs guide still markets the field as "(legacy, still honored)"
  at [docs/guide/routing.md](../../../../docs/guide/routing.md#L15),
  which is exactly the migration vocabulary the rule says to delete.

The result is a four-arm structure (routing → legacy → runtime-default
→ throw) that should be a three-arm structure (routing →
runtime-default → throw). Once `model_overrides` is gone from the
schema and the seeder, the resolver no longer needs a tier whose only
job is to identify which dead-by-policy branch produced the spec.

Note on the issue's "trace UI" framing: the round-1 issue document
mentions "routing trace UI". The resolver does not emit a trace
anywhere in the live codebase — `source` is just a field on the
returned `ResolvedModelRoute`. No web component, no log line, no
diagnostic reads it. Removing the `"legacy"` arm therefore needs no UI
change; the fix is entirely backend.

## Root cause

`ProjectConfig.model_overrides` is a pre-v2 routing format that was
preserved as a parallel input alongside the routing-profile schema when
v2 landed. The resolver never grew a code path that converts
`model_overrides` into a routing-profile equivalent, and the project
seeder was never updated to stop writing the empty stub. Because the
"keep it working too" branch survived the v2 cut, the source-tier union
gained a `"legacy"` literal whose only job is to identify which
legacy-by-policy branch produced the spec.

## What the fix has to touch

To remove the legacy tier architecturally (rather than hiding it behind
an unused field), the following surfaces all need to change in one
batch:

- Resolver type union and merge order
  ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L66-L78),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L108-L131),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L221),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L249-L269)).
- Project schema field
  ([src/types.ts](../../../../src/types.ts#L12-L29)).
- Project seeder default value
  ([src/store/project.ts](../../../../src/store/project.ts#L125-L133)).
- Resolver tests for the legacy-source path
  ([src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28)).
- Routing guide and neighbouring docs that still advertise the field
  ([docs/guide/routing.md](../../../../docs/guide/routing.md#L3-L94),
  [docs/guide/providers.md](../../../../docs/guide/providers.md#L58),
  [docs/guide/config-project.md](../../../../docs/guide/config-project.md#L40-L89),
  [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md#L68),
  [docs/guide/troubleshooting.md](../../../../docs/guide/troubleshooting.md#L11),
  [docs/guide/install-lxc.md](../../../../docs/guide/install-lxc.md#L104)).

The `docs/api/**` and `docs/.vitepress/dist/**` trees are typedoc and
VitePress build outputs. They are not edited by hand.

## On-disk impact: every seeded project today carries the stub

This is the round-2 correction to the daemon-impact framing.

Because the seeder at
[src/store/project.ts](../../../../src/store/project.ts#L129)
unconditionally writes `model_overrides: {}` into the seeded
`config.json`, every Saivage project that has been initialised against
this codebase since v2 shipped has an empty `model_overrides` key
persisted on disk. Under the design's proposed `.strict()` schema, the
empty stub is rejected at config load with a typed Zod error. There is
no value of `model_overrides` that the new schema accepts — empty,
non-empty, or anything else.

This means at minimum the following on-disk configs will fail to load
after G26 ships, until an operator removes the key:

- The seeded `config.json` inside every container that runs a Saivage
  project (the v2 harness, the v3-on-getrich-v2 deployment, the
  diedrico harness — see the workspace handoff for the current set).
- Any local target-project `config.json` checked into a developer
  workspace.
- Any hand-edited operator config that explicitly populated the field
  to route a role.

The failure mode is loud and typed:
`ProjectConfigSchema.safeParse(...).error` carries
`code: "unrecognized_keys"` with `keys: ["model_overrides"]`. The
daemon refuses to start the project rather than silently dropping the
field, which is the contract the no-shim rule demands. Operators see
the offending key name in the error and remove it by hand.

Per workspace rule (no backward compatibility, no migration shim), G26
does not add an auto-stripper, does not warn-and-strip, and does not
ship a one-shot migration tool. The operator action required after
this lands is a manual edit removing the key from each affected
`config.json`. The plan in [03-plan-r2.md](03-plan-r2.md) calls out
that action as operator-gated post-deploy work, consistent with the
workspace handoff's restart-gating policy.

## Sequencing constraints

All three open resolver findings (G23, G24, G25) touch
[src/routing/resolver.ts](../../../../src/routing/resolver.ts).
G23 and G24 are already APPROVED
([../G23/APPROVED.md](../G23/APPROVED.md),
[../G24/APPROVED.md](../G24/APPROVED.md)). G25 has a writer plan but no
approval yet ([../G25/02-design-r2.md](../G25/02-design-r2.md)). All
three APPROVED docs explicitly list G26 as a coordination partner.

The hard constraints are:

- G23 introduces a synchronous cycle check in the constructor; it does
  not touch `resolveSource` or `resolveLegacyModels`. Independent of
  G26.
- G24 narrows the resolver input to a `ProjectRoutingInput` type
  derived from `ProjectConfig` and deletes `ProjectRoutingConfigLike`.
  Once G24 lands,
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57)
  no longer exists; the `model_overrides?: Record<string, string>`
  member that G26 wants to delete moves into `ProjectRoutingInput`
  (still derived from `ProjectConfig`). So if G24 lands first, G26
  drops `model_overrides` from `ProjectConfigSchema`; that change
  propagates automatically through the narrowed input type. If G26
  lands first, G24 simply does not carry the field forward.
- G25 rewrites `resolvePreferredModels` and `resolvePreferredAccounts`
  and adds typed allow-list rejection. G25's own
  [../G25/02-design-r2.md](../G25/02-design-r2.md#L226-L230) preserves
  `ResolvedModelRoute.source` as the diagnostic discriminant for
  allow-list-only rules and explicitly defers the legacy source tier
  to G26. G25 does touch the `resolvePreferredModels` line range that
  ends with `return this.resolveLegacyModels(role);`
  ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219)).
  G26 renames that helper. The two changes are compatible if G25 lands
  first: G26 then just renames the call inside the new G25 body.

Recommended ordering: G23 → G24 → G25 → G26. G26 is last because it
deletes vocabulary every prior resolver change has to remain aware of.
G26 is independently mergeable as long as it does not delete the
`source` field itself (only the `"legacy"` literal and its producer).

## Out-of-scope for G26

- The `source` field on `ResolvedModelRoute` is preserved. Removing it
  is a separate "do we need diagnostic provenance at all" question
  that the metaplan has not adjudicated; G25's design preserves it as
  a diagnostic discriminant
  ([../G25/02-design-r2.md](../G25/02-design-r2.md#L226-L230)).
- The runtime-default and routing arms are untouched. G26 only deletes
  the legacy arm.
- `dist/cli.js` is a build artefact and is regenerated by the build
  step; G26 does not patch it.
- No migration shim, no warn-and-strip path, no auto-cleanup tool.
  Operator-gated manual config edits, per the no-shim rule.

## Risks

- Operator configs carrying `model_overrides` (empty or otherwise)
  will fail strict-schema load after G26 ships. This is the
  architecturally correct signal under the no-shim rule, and the
  failure is typed (Zod `unrecognized_keys` error pointing at
  `model_overrides`). Operators must manually remove the key from
  each affected `config.json` before restarting the daemon. See the
  on-disk impact section above.
- G25 has not yet been approved; if G25's body shape changes before
  approval, the G26 plan's `resolvePreferredModels` patch site needs
  to be re-checked. Mitigation: G26 plan targets the helper rename
  only, not the body shape, so it is robust to G25 wording changes.
