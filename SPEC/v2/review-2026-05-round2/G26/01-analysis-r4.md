# G26 — Analysis (round 4, writer Claude Opus 4.7)

Issue source: [../G26-resolver-legacy-source-tier.md](../G26-resolver-legacy-source-tier.md).
Round 3 reviewer critique: [04-review-r3.md](04-review-r3.md).

## Changes from round 3

Two reviewer items in [04-review-r3.md](04-review-r3.md) carry over:

1. The round-3 daemon-impact inventory only checked whether
   `model_overrides` was present in each enumerated config, but the
   round-3 design also proposed `.strict()` on
   `ProjectConfigSchema`. `.strict()` rejects ANY unknown top-level
   key, not just the legacy one. The round-3 "every known config
   loads cleanly" conclusion is therefore wrong for the round-3
   proposal as stated. Round 4 re-runs the audit by listing actual
   top-level keys per config (no values) and either (a) narrows the
   schema change to reject only the legacy key, or (b) accepts the
   broader rejection and documents the full cleanup list. Round 4
   picks option (a) and explains the boundary in
   [Scope decision: narrow rejection, not .strict()](#scope-decision-narrow-rejection-not-strict).
2. The L108 fallback-call anchor was wrong. The live file has
   `const merged = …` at L108 and the `?? this.resolveLegacyModels(role)[0]`
   fallback at L110. Round 4 re-derives every resolver anchor from
   the live file with the read tool and records the verified ranges
   in [Verified anchors](#verified-anchors-pre-flight-gate).

The grep-gate fix from round 1 (production-scoped grep plus
runtime-built legacy key in the schema-rejection test) is preserved
in [03-plan-r4.md](03-plan-r4.md); reviewer concern 1 from round 1
stays addressed.

## What the resolver actually does today

The routing resolver classifies every `ResolvedModelRoute` it returns
with a `source` discriminator that is one of three string literals at
[src/routing/resolver.ts](../../../../src/routing/resolver.ts#L66-L77):

- `"routing"` — the role rule or its inherited profile carried any of
  `model`, `preferred_models`, `allowed_models`, or `profile`.
- `"legacy"` — the role's spec came exclusively from the optional
  `ProjectConfig.model_overrides[role]` map.
- `"runtime-default"` — the spec came from `RuntimeConfig.models[<key>]`,
  `RuntimeConfig.models.default`, or the supervisor / security role
  shortcuts.

The `"legacy"` tier is the only one that ships a pre-v2 migration
arm. `ProjectConfig.model_overrides` is the pre-routing-profile field
that `resolveLegacyModels` at
[src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L262)
reads, that `resolve()` falls back to at
[src/routing/resolver.ts](../../../../src/routing/resolver.ts#L110),
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
restated in [../00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md) and
applied throughout the review-2026-05 metaplan). `model_overrides` is
exactly the kind of pre-v2 routing input that rule forbids:

- It exists only to honour the legacy "role → modelSpec" map that
  predates the routing-profile system shipped in v2.
- The seeder still writes the empty stub at
  [src/store/project.ts](../../../../src/store/project.ts#L129).
  Every fresh project initialised against this codebase from now
  until G26 lands will get the stub on disk; the schema change must
  therefore ship together with the seeder change.
- The resolver still reads any non-empty entry an operator may have
  added at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L255);
  this is the live "kept it working too" surface that the no-shim
  rule says to delete.
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
diagnostic reads it. Removing the `"legacy"` arm therefore needs no
UI change; the fix is entirely backend.

## Root cause

`ProjectConfig.model_overrides` is a pre-v2 routing format that was
preserved as a parallel input alongside the routing-profile schema
when v2 landed. The resolver never grew a code path that converts
`model_overrides` into a routing-profile equivalent, and the project
seeder was never updated to stop writing the empty stub. Because the
"keep it working too" branch survived the v2 cut, the source-tier
union gained a `"legacy"` literal whose only job is to identify which
legacy-by-policy branch produced the spec.

## What the fix has to touch

To remove the legacy tier architecturally (rather than hiding it
behind an unused field), the following surfaces all need to change in
one batch:

- Resolver input type, source union, merge order, and helpers
  ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L66-L77),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L106-L131),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L220),
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L247-L269)).
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

## Verified anchors (pre-flight gate)

Every anchor used in this round's analysis, design, and plan was
re-derived from the live source tree on the day of this commit using
the read tool, not from prior-round documents. Verified ranges:

- [src/types.ts](../../../../src/types.ts#L12-L29) — `ProjectConfigSchema` body (was L12-L30; closing `});` is L29, the `export type` is L30 and is not part of the schema literal).
- [src/types.ts](../../../../src/types.ts#L15) — `model_overrides` field declaration line (unchanged).
- [src/store/project.ts](../../../../src/store/project.ts#L125-L133) — seeded `ProjectConfig` literal block (unchanged).
- [src/store/project.ts](../../../../src/store/project.ts#L129) — `model_overrides: {},` line in seeded literal (unchanged).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57) — `ProjectRoutingConfigLike` interface (unchanged).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L55) — `model_overrides?: Record<string, string>;` member line (unchanged).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L66-L77) — `ResolvedModelRoute` interface (was L64-L75; the interface declaration begins at L66 and the closing `}` is at L77).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L75) — `source: "routing" | "legacy" | "runtime-default";` line (unchanged).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L106-L131) — `resolve()` method body (was L105-L129; the method header is L106 and the closing `}` is L131).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L110) — **fallback call site**: `const candidate = preferredModels[0] ?? this.resolveLegacyModels(role)[0];`. This is the round-3 blocker. The round-3 docs cited L108; live file has `const merged = this.mergeRuleChain(roleRule.rule);` at L108 and the fallback call on L110.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L127) — `source: this.resolveSource(role, merged, preferredModels),` call inside `resolve()`'s return (unchanged).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L220) — `resolvePreferredModels` method body (was L201-L221; the method header is L204 and the closing `}` is L220).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219) — `return this.resolveLegacyModels(role);` trailing line inside `resolvePreferredModels` (unchanged).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L247-L252) — `resolveRuntimeDefaultModels` method body (unchanged from round 3).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L262) — `resolveLegacyModels` method body (unchanged from round 3).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L264-L269) — `resolveSource` method body (unchanged from round 3).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L266) — `if (this.project.model_overrides?.[role]) return "legacy";` line (unchanged).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L268) — `throw new Error("unreachable: resolveLegacyModels would have thrown first");` line (unchanged).
- [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28) — `"preserves legacy override and runtime fallback behavior"` test body (unchanged; verified `});` at L28 with the next `it(...)` starting at L30).

The L108→L110 correction is the only ranged anchor change with a
review-level consequence; the resolvePreferredModels span correction
(L201-L221 → L204-L220) and the resolve-method span correction
(L105-L129 → L106-L131) and the ResolvedModelRoute span correction
(L64-L75 → L66-L77) and the ProjectConfigSchema span correction
(L12-L30 → L12-L29) are pre-flight tidy-ups so every anchor in this
round is reviewer-verifiable against the live file.

G25 cross-references stay unchanged from round 3: the resolver-batch
ordering and G26 coordination point are read from
[../G25/03-plan-r3.md](../G25/03-plan-r3.md#L14-L16). G25's r3 design
and plan do not require any particular literal set on `source`; G26
only narrows the union, and G25 is silent on the `source` field
except for the helper-rename coordination note at
[../G25/03-plan-r3.md](../G25/03-plan-r3.md#L16). G23 and G24 anchors
([../G23/APPROVED.md](../G23/APPROVED.md#L9),
[../G24/APPROVED.md](../G24/APPROVED.md#L9)) are unchanged.

## Daemon impact (concrete on-disk inventory)

This section is the round-3 reviewer-required rewrite. Every known
`.saivage/config.json` was inspected by top-level key list only (no
values; no secret material was read). Inventory date: round-4 audit,
this commit. Five workspace-mirror paths under `/home/salva/g/ml`
plus four known Saivage LXC containers were covered. `jq` was not
available on every host; Python `json.load(...).keys()` was used in
those cases.

Top-level keys recognised by the current
[`ProjectConfigSchema`](../../../../src/types.ts#L12-L29):
`project_name`, `objectives`, `model_overrides`, `routing`, `skills`,
`agents`.

| Path | Exists? | Top-level keys observed | Has `model_overrides`? | Strict-load status (if `.strict()` proposed in round 3 were used) |
|------|---------|-------------------------|------------------------|-------------------------------------------------------------------|
| /home/salva/g/ml/saivage/.saivage/config.json | no | (file absent) | n/a | n/a (no project at this path) |
| /home/salva/g/ml/saivage-v3/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | strict-load-fails-with-key-notifications |
| /home/salva/g/ml/getrich/.saivage/config.json | yes | notifications, objectives, project_name, provider, routing, skills | no | strict-load-fails-with-keys-notifications-and-provider |
| /home/salva/g/ml/getrich-v2/.saivage/config.json | no | (file absent — post-F33 split layout) | n/a | n/a |
| /home/salva/g/ml/diedrico/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | strict-load-fails-with-key-notifications |
| 10.0.3.111 /work/getrich/.saivage/config.json | yes | notifications, objectives, project_name, provider, routing, skills | no | strict-load-fails-with-keys-notifications-and-provider |
| 10.0.3.112 /work/saivage-v3/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | strict-load-fails-with-key-notifications |
| 10.0.3.113 /work/diedrico/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | strict-load-fails-with-key-notifications |
| 10.0.3.170 /work/getrich-v2/.saivage/config.json | no | (file absent — post-F33 split layout) | n/a | n/a |
| 10.0.3.170 /opt/saivage-v3/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | strict-load-fails-with-key-notifications |

Net result for the round-3 `.strict()` proposal: seven of seven
existing configs would be rejected at restart, all because of
`notifications` (and `provider` on the two GetRich-v1 configs). Zero
of them carry `model_overrides`. The round-3 conclusion ("no current
config fails strict load") is therefore wrong for the round-3
proposal as written.

The fields tripping `.strict()` are unrelated to the G26 finding:

- `notifications` is the in-use notifications-channel block written
  by the daemon. The current `ProjectConfigSchema` does not declare
  it, so default Zod silently strips it on load. Whether it should
  be promoted to a first-class schema field is a separate finding,
  not part of G26's scope (G26 is "remove the legacy v1 routing
  tier").
- `provider` is a legacy GetRich-v1 single-provider block that the
  Saivage v2 schema also does not declare. Whether it should be
  declared or migrated away is, again, outside G26's scope.

## Scope decision: narrow rejection, not `.strict()`

Round 4 narrows the schema-rejection contract from "reject any
unknown top-level key" (round 3's `.strict()`) to "reject specifically
the legacy `model_overrides` key, with a typed Zod error". Reasons:

- Reviewer's first option in [04-review-r3.md](04-review-r3.md) was
  exactly this: "make the design intentionally reject only the legacy
  key while preserving current unknown-key behavior". The
  daemon-impact inventory makes that the right scope choice: the
  blast radius of `.strict()` is dominated by `notifications` and
  `provider`, neither of which is a G26 concern.
- The no-shim / no-backward-compatibility rule applies to
  `model_overrides`: it is an actively read pre-v2 routing field. It
  does not apply to fields like `notifications` whose schema-side
  status is "not yet declared, silently stripped today"; tightening
  those is a schema-completeness question that deserves its own
  review item.
- The round-3 `.strict()` proposal also coupled G26 to an unrelated
  fleet-wide cleanup ("operators must remove notifications and
  provider before restart"). Architecture-first does not mean
  bundling unrelated cleanup into the smallest finding that triggered
  the audit; it means owning each architectural cut at the right
  scope.

The targeted-rejection contract is:

- `ProjectConfigSchema.safeParse(...)` returns `success: false` with
  a typed Zod issue whose `path` is `["model_overrides"]` and whose
  message names the field as a removed legacy v1 routing field. This
  is the operator-visible signal demanded by the no-shim rule.
- Other unknown top-level keys (`notifications`, `provider`, anything
  future) are silently stripped, exactly as today. They are out of
  scope.

Concretely, the schema changes to declare its known fields, marks
itself `.passthrough()` so a `superRefine` can still inspect for the
legacy key, and adds a single `superRefine` that fires only on
`model_overrides`. See
[02-design-r4.md](02-design-r4.md#a1-schema-narrow-rejection-of-model_overrides).

Daemon-impact conclusion under the narrow-rejection contract: zero
known on-disk configs fail load (none carry `model_overrides`), and
the post-deploy verification check in
[03-plan-r4.md](03-plan-r4.md#task-7--operator-gated-post-deploy-verification)
is again a true verification step (expected zero hits), not a triage
step the operator must run before every restart.

## Sequencing constraints

All three resolver findings (G23, G24, G25) touch
[src/routing/resolver.ts](../../../../src/routing/resolver.ts).
G23 and G24 are already APPROVED
([../G23/APPROVED.md](../G23/APPROVED.md),
[../G24/APPROVED.md](../G24/APPROVED.md)). G25 has a fresh r3 plan
at [../G25/03-plan-r3.md](../G25/03-plan-r3.md) that explicitly
orders the batch G23 → G24 → G25 → G26 at
[../G25/03-plan-r3.md](../G25/03-plan-r3.md#L14-L16).

The hard constraints are:

- G23 introduces a synchronous cycle check in the constructor; it
  does not touch `resolveSource` or `resolveLegacyModels`.
  Independent of G26.
- G24 narrows the resolver input to a `ProjectRoutingInput` type
  derived from `ProjectConfig` and deletes `ProjectRoutingConfigLike`.
  Once G24 lands,
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57)
  no longer exists; the `model_overrides?: Record<string, string>;`
  member that G26 wants to delete moves into `ProjectRoutingInput`
  (still derived from `ProjectConfig`). If G24 lands first, G26
  drops `model_overrides` from `ProjectConfigSchema`; that change
  propagates automatically through the narrowed input type. If G26
  lands first, G24 simply does not carry the field forward.
- G25 rewrites `resolvePreferredModels` and `resolvePreferredAccounts`
  and adds typed allow-list rejection
  ([../G25/03-plan-r3.md](../G25/03-plan-r3.md#L36-L45)). G25's plan
  explicitly defers the legacy source tier to G26 and only needs G26
  to rename the trailing `this.resolveLegacyModels(role)` call inside
  `resolvePreferredModels` to `this.resolveRuntimeDefaultModels(role)`
  ([../G25/03-plan-r3.md](../G25/03-plan-r3.md#L16)). G26's plan
  targets the helper rename, not the surrounding body shape, so it is
  robust to G25 wording changes.

Recommended ordering: G23 → G24 → G25 → G26. G26 is last because it
deletes vocabulary every prior resolver change has to remain aware
of. G26 is independently mergeable as long as it does not delete the
`source` field itself (only the `"legacy"` literal and its producer).

## Out-of-scope for G26

- The `source` field on `ResolvedModelRoute` is preserved. Removing
  it is a separate "do we need diagnostic provenance at all" question
  that the metaplan has not adjudicated; G25's r3 plan is silent on
  the field and does not require it to change shape
  ([../G25/03-plan-r3.md](../G25/03-plan-r3.md#L14-L16)).
- Schema completeness for `notifications`, `provider`, or any other
  currently-silently-stripped top-level key. Round-4 inventory makes
  the case for a follow-on finding, not for widening G26.
- The runtime-default and routing arms are untouched. G26 only
  deletes the legacy arm.
- `dist/cli.js` is a build artefact and is regenerated by the build
  step; G26 does not patch it.
- No migration shim, no warn-and-strip path, no auto-cleanup tool.
  Operator-gated manual config edits, per the no-shim rule.

## Risks

- A future operator-edited config that adds `model_overrides` (empty
  or otherwise) between now and the G26 landing date will fail
  load. This is the architecturally correct signal under the no-shim
  rule, and the failure is typed (Zod custom issue at path
  `["model_overrides"]`). Operators manually remove the key before
  restarting the daemon. The current-fleet inventory in
  [Daemon impact (concrete on-disk inventory)](#daemon-impact-concrete-on-disk-inventory)
  shows no such config exists today; this risk is forward-looking
  only.
- Newly-seeded projects between schema change and seeder change land
  would carry the stub on disk and trip load. Mitigation: Task 1
  (schema) and Task 3 (seeder) must land in the same commit, captured
  as an explicit ordering constraint in
  [03-plan-r4.md](03-plan-r4.md#hard-ordering-constraint-task-1--task-3-ship-together).
- G25 r3 plan is not yet approved; if its body shape changes before
  approval, the G26 plan's `resolvePreferredModels` patch site needs
  to be re-checked. Mitigation: G26 plan targets the helper rename
  only, not the body shape, so it is robust to G25 wording changes.
