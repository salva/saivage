# G26 — Analysis (round 3, writer Claude Opus 4.7)

Issue source: [../G26-resolver-legacy-source-tier.md](../G26-resolver-legacy-source-tier.md).
Round 2 reviewer critique: [04-review-r2.md](04-review-r2.md).

## Changes from round 2

Two reviewer items in [04-review-r2.md](04-review-r2.md):

1. Daemon-impact narrative was abstract and overstated. Round 2 said
   "every seeded project on disk carries the stub and will fail strict
   load". Round 3 enumerates every known concrete
   `.saivage/config.json` across workspace mirrors and live LXC
   containers and reports actual key-presence (key-only inspection —
   no secret material was read). The result, captured in
   [Daemon impact (concrete on-disk inventory)](#daemon-impact-concrete-on-disk-inventory)
   and threaded through [02-design-r3.md](02-design-r3.md) and
   [03-plan-r3.md](03-plan-r3.md), is that no currently-known
   `config.json` carries the legacy key. The strict-load failure is a
   future-tense risk gated on either (a) operator-edited stale configs
   or (b) the still-active seeder regenerating the stub. Round 2's
   blanket "every project will fail" framing is wrong and is replaced.

2. Several line anchors were stale. Round 3 re-derives every resolver
   anchor from the live file and updates the cross-finding links to
   point at G25's round-3 plan (the round-2 design has been superseded
   and the L226-L230 anchor cited in round 2 no longer exists). See
   [Stale anchor audit](#stale-anchor-audit-against-current-files)
   below.

The grep-gate fix from round 2 (production-scoped grep plus
runtime-built key in the schema-rejection test) is preserved
verbatim in [03-plan-r3.md](03-plan-r3.md); reviewer concern 1 from
round 1 stays addressed.

## What the resolver actually does today

The routing resolver classifies every `ResolvedModelRoute` it returns
with a `source` discriminator that is one of three string literals at
[src/routing/resolver.ts](../../../../src/routing/resolver.ts#L64-L75):

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
[src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L262)
reads, that `resolve()` falls back to at
[src/routing/resolver.ts](../../../../src/routing/resolver.ts#L108),
that `resolvePreferredModels` defers to at
[src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219),
and that `resolveSource` maps to the `"legacy"` literal at
[src/routing/resolver.ts](../../../../src/routing/resolver.ts#L266).
The schema field still lives on `ProjectConfigSchema` at
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
- The seeder still writes the empty stub at
  [src/store/project.ts](../../../../src/store/project.ts#L129). Every
  fresh project initialised against this codebase from now until G26
  lands will get the stub on disk, and under the proposed strict
  schema that stub is a load-time error. The seeder fix must therefore
  ship together with the schema fix, not in a separate commit.
- The resolver still reads any non-empty entry an operator may have
  added at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L255);
  this is the live "kept it working too" surface that the no-shim rule
  says to delete.
- The `"legacy"` literal on `ResolvedModelRoute.source` at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L75)
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

- Resolver input type, source union, merge order, and helpers
  ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L64-L75),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L105-L129),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L201-L221),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L247-L269)).
- Project schema field
  ([src/types.ts](../../../../src/types.ts#L12-L30)).
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

## Daemon impact (concrete on-disk inventory)

This section is the round-2 reviewer-required rewrite. Every known
`.saivage/config.json` was inspected by key-presence only (no secret
material was read; no values were printed). The inspection used
key-existence and emptiness checks, not value reads.

Inventory date: round-3 audit, this commit. The inspection covered the
five workspace-mirror paths called out in the round-3 input
(`saivage/`, `saivage-v3/`, `getrich/`, `getrich-v2/`, `diedrico/`
under `/home/salva/g/ml`) plus the four known Saivage LXC containers.

| Path | Exists? | Has `model_overrides`? | Strict-load status |
|------|---------|------------------------|--------------------|
| /home/salva/g/ml/saivage/.saivage/config.json | no | n/a | n/a (no project at this path) |
| /home/salva/g/ml/saivage-v3/.saivage/config.json | yes | no | clean, loads |
| /home/salva/g/ml/getrich/.saivage/config.json | yes | no | clean, loads |
| /home/salva/g/ml/getrich-v2/.saivage/config.json | no | n/a | n/a (this project uses the post-F33 split layout; routing lives elsewhere) |
| /home/salva/g/ml/diedrico/.saivage/config.json | yes | no | clean, loads |
| 10.0.3.111 /work/getrich/.saivage/config.json | yes | no | clean, loads |
| 10.0.3.112 /work/saivage-v3/.saivage/config.json | yes | no | clean, loads |
| 10.0.3.113 /work/diedrico/.saivage/config.json | yes | no | clean, loads |
| 10.0.3.170 /opt/saivage-v3/.saivage/config.json | yes | no | clean, loads |
| 10.0.3.170 /work/getrich-v2/.saivage/config.json | no | n/a | n/a (project uses post-F33 split layout) |

Net result: zero known on-disk configs currently fail strict load.
The round-2 "mass-failure on every restart" framing is wrong and is
withdrawn. The strict-load behaviour remains an architecturally
required signal under the no-shim rule, but it triggers only on
either of the two future-tense paths:

- Any operator-edited config that explicitly populates
  `model_overrides` between now and G26 landing. Per workspace rule
  (no backward compatibility, no migration shim), G26 does not add an
  auto-stripper or a warn-and-strip path; if such a config exists at
  restart time, the daemon refuses to load it with a typed Zod
  `unrecognized_keys` error pointing at `model_overrides`, and the
  operator removes the key by hand.
- Any newly-seeded project, because the seeder at
  [src/store/project.ts](../../../../src/store/project.ts#L129) still
  writes `model_overrides: {}` until Task 3 of
  [03-plan-r3.md](03-plan-r3.md) lands. The seeder fix and the schema
  fix must therefore land together; this is captured as a hard
  ordering constraint in [03-plan-r3.md](03-plan-r3.md) §"Tasks
  (sequential)".

The plan's operator-gated post-deploy check at
[03-plan-r3.md](03-plan-r3.md) Task 7 keeps its place as belt-and-
braces but is correctly framed: it is a verification step that will
return zero hits on the current fleet, not a triage step the operator
must run before every restart.

## Stale anchor audit against current files

Round-2 anchors were rechecked against the live source tree on the
day of this commit. Updates:

- `resolvePreferredModels` fallback call site is at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L108),
  not L110.
- `resolveRuntimeDefaultModels` body is at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L247-L252),
  not L249-L253.
- `resolveLegacyModels` body is at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L262),
  not L254-L260.
- `resolveSource` body stays at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L264-L269);
  unchanged from round 2.
- `ResolvedModelRoute` interface (including the `source` union) is at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L64-L75);
  the source union literal line itself remains at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L75).
- `ProjectRoutingConfigLike.model_overrides` member stays at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L55);
  unchanged from round 2.

G25 cross-references:

- Round 2 cited `G25/02-design-r2.md#L226-L230` for the "G25 preserves
  `source` as a diagnostic discriminant" claim. That round-2 design
  has been superseded by [../G25/03-plan-r3.md](../G25/03-plan-r3.md)
  and the line range no longer exists. Round 3 replaces the citation:
  the resolver-batch ordering and G26 coordination point are now read
  from [../G25/03-plan-r3.md](../G25/03-plan-r3.md#L14-L16). G25's
  round-3 design and plan do not require any particular literal set
  on `source`; G26 only narrows the union, and G25 is silent on the
  `source` field except for the rename-coordination note at
  [../G25/03-plan-r3.md](../G25/03-plan-r3.md#L16).
- G23 ([../G23/APPROVED.md](../G23/APPROVED.md#L9)) and G24
  ([../G24/APPROVED.md](../G24/APPROVED.md#L9)) anchors are unchanged.

## Sequencing constraints

All three resolver findings (G23, G24, G25) touch
[src/routing/resolver.ts](../../../../src/routing/resolver.ts).
G23 and G24 are already APPROVED
([../G23/APPROVED.md](../G23/APPROVED.md),
[../G24/APPROVED.md](../G24/APPROVED.md)). G25 has a fresh r3 plan at
[../G25/03-plan-r3.md](../G25/03-plan-r3.md) that explicitly orders
the batch G23 → G24 → G25 → G26 at
[../G25/03-plan-r3.md](../G25/03-plan-r3.md#L14-L16).

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
  and adds typed allow-list rejection
  ([../G25/03-plan-r3.md](../G25/03-plan-r3.md#L36-L45)). G25's plan
  explicitly defers the legacy source tier to G26 and only needs G26
  to rename `this.resolveLegacyModels(role)` to
  `this.resolveRuntimeDefaultModels(role)` at the
  `resolvePreferredModels` fallback call inside the G25 body
  ([../G25/03-plan-r3.md](../G25/03-plan-r3.md#L16)). G26's plan
  targets the helper rename, not the surrounding body shape, so it is
  robust to G25 wording changes.

Recommended ordering: G23 → G24 → G25 → G26. G26 is last because it
deletes vocabulary every prior resolver change has to remain aware of.
G26 is independently mergeable as long as it does not delete the
`source` field itself (only the `"legacy"` literal and its producer).

## Out-of-scope for G26

- The `source` field on `ResolvedModelRoute` is preserved. Removing it
  is a separate "do we need diagnostic provenance at all" question
  that the metaplan has not adjudicated; G25's r3 plan is silent on
  the field and does not require it to change shape
  ([../G25/03-plan-r3.md](../G25/03-plan-r3.md#L14-L16)).
- The runtime-default and routing arms are untouched. G26 only deletes
  the legacy arm.
- `dist/cli.js` is a build artefact and is regenerated by the build
  step; G26 does not patch it.
- No migration shim, no warn-and-strip path, no auto-cleanup tool.
  Operator-gated manual config edits, per the no-shim rule.

## Risks

- A future operator-edited config that adds `model_overrides` (empty
  or otherwise) between now and the G26 landing date will fail
  strict-schema load. This is the architecturally correct signal
  under the no-shim rule, and the failure is typed (Zod
  `unrecognized_keys` error pointing at `model_overrides`). Operators
  must manually remove the key before restarting the daemon. The
  current-fleet inventory in [Daemon impact (concrete on-disk
  inventory)](#daemon-impact-concrete-on-disk-inventory) shows no
  such config exists today; this risk is forward-looking only.
- Newly-seeded projects between now and Task 3 landing will carry the
  stub on disk and trip strict load. Mitigation: Task 1 (schema) and
  Task 3 (seeder) must land in the same commit, captured as an
  explicit ordering constraint in [03-plan-r3.md](03-plan-r3.md).
- G25 r3 plan is not yet approved; if its body shape changes before
  approval, the G26 plan's `resolvePreferredModels` patch site needs
  to be re-checked. Mitigation: G26 plan targets the helper rename
  only, not the body shape, so it is robust to G25 wording changes.
