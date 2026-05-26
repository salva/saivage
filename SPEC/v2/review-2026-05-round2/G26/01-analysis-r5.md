# G26 — Analysis (round 5, writer Claude Opus 4.7)

Issue source: [../G26-resolver-legacy-source-tier.md](../G26-resolver-legacy-source-tier.md).
Round 4 reviewer critique: [04-review-r4.md](04-review-r4.md).

## Changes from round 4

Round 4 fixed the L108 → L110 fallback anchor and pivoted from `.strict()`
to a narrow rejection of `model_overrides` only ([01-analysis-r4.md](01-analysis-r4.md#scope-decision-narrow-rejection-not-strict)).
Reviewer accepted the narrowing intent but blocked round 4 because the
proposed mechanism (`.passthrough()` + `.superRefine`) changes
unknown-key behavior from "silently stripped on the parsed output"
(today's default Zod behavior on `z.object`) to "retained on the
parsed output" ([04-review-r4.md](04-review-r4.md#L7)). That would
expose currently-stripped keys like `notifications` and `provider`
through `runtime.project.config` ([src/store/project.ts](../../../../src/store/project.ts#L66-L70))
and `/api/debug/state` ([src/server/server.ts](../../../../src/server/server.ts#L476-L498)),
and would serialize them back if `writeDoc` is ever called on
project config ([src/store/documents.ts](../../../../src/store/documents.ts#L75-L81)).

Round 5 keeps the narrow-rejection scope and switches the mechanism
to `z.preprocess` wrapping the unchanged `z.object`. The preprocess
function inspects the raw input for the legacy key and emits a typed
Zod issue at path `["model_overrides"]`; otherwise it forwards the
raw value unchanged to the inner object schema, which retains its
default strip-unknown-keys behavior. Every other top-level key
present today (`notifications`, `provider`, anything future) keeps
exactly the live observable behavior: not declared, silently
stripped, never reaches `runtime.project.config` or
`/api/debug/state`. See
[02-design-r5.md](02-design-r5.md#a1-schema-narrow-rejection-of-model_overrides)
for the schema definition and
[02-design-r5.md](02-design-r5.md#a4-tests-drop-legacy-source-case-add-schema-rejection-cases)
for the positive regression that pins the strip semantics.

Three reviewer-required changes from [04-review-r4.md](04-review-r4.md#L13-L15)
are addressed:

1. The `.passthrough()` contract is replaced with a `z.preprocess`
   guard so the legacy key is rejected at path `["model_overrides"]`
   while every other unknown top-level key is stripped from the
   parsed output exactly as today. A positive regression in
   [02-design-r5.md](02-design-r5.md#a4-tests-drop-legacy-source-case-add-schema-rejection-cases)
   asserts that an extra unknown key (e.g. `notifications`) on a
   valid fixture parses successfully AND is absent from the parsed
   output object.
2. The daemon-impact section below now says the known on-disk
   configs still load, and their unrelated unknown keys
   (`notifications`, `provider`) remain stripped from
   `runtime.project.config` and `/api/debug/state`, not passed
   through. The forward-looking `model_overrides` rejection contract
   is unchanged.
3. Stale literal-key schema snippets and the round-4 "this is the
   final implementation… actually use this other one" self-correction
   are gone. The round-5 design and plan show one schema
   implementation only, with the legacy key built at runtime so the
   production-source grep gate stays at zero matches without a
   per-file allow-list. See
   [02-design-r5.md](02-design-r5.md#a1-schema-narrow-rejection-of-model_overrides)
   and [03-plan-r5.md](03-plan-r5.md#task-1--projectconfigschema-narrow-rejection-of-the-legacy-key).

The grep-gate fix from round 1 (production-source-scoped grep plus
runtime-built legacy key in the schema-rejection test) carries
forward unchanged.

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

Note on the issue's "trace UI" framing: the resolver does not emit a
trace anywhere in the live codebase — `source` is just a field on the
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

Every anchor used in this round was re-derived from the live source
tree on the day of this commit using the read tool. Live ranges
unchanged from round 4:

- [src/types.ts](../../../../src/types.ts#L12-L29) — `ProjectConfigSchema` body. Closing `});` is L29; `export type ProjectConfig = …` at L30.
- [src/types.ts](../../../../src/types.ts#L15) — `model_overrides` field declaration line.
- [src/store/project.ts](../../../../src/store/project.ts#L125-L133) — seeded `ProjectConfig` literal block.
- [src/store/project.ts](../../../../src/store/project.ts#L129) — `model_overrides: {},` line in seeded literal.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57) — `ProjectRoutingConfigLike` interface.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L55) — `model_overrides?: Record<string, string>;` member line.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L66-L77) — `ResolvedModelRoute` interface.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L75) — `source: "routing" | "legacy" | "runtime-default";` line.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L106-L131) — `resolve()` method body.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L110) — fallback call site: `const candidate = preferredModels[0] ?? this.resolveLegacyModels(role)[0];`.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L127) — `source: this.resolveSource(role, merged, preferredModels),` line.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L220) — `resolvePreferredModels` method body.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L219) — `return this.resolveLegacyModels(role);` trailing line.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L247-L252) — `resolveRuntimeDefaultModels` method body.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L254-L262) — `resolveLegacyModels` method body.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L264-L269) — `resolveSource` method body.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L266) — `if (this.project.model_overrides?.[role]) return "legacy";` line.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L268) — `throw new Error("unreachable: resolveLegacyModels would have thrown first");` line.
- [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28) — `"preserves legacy override and runtime fallback behavior"` test body.

Consumers that depend on the parsed-output shape:

- [src/store/documents.ts](../../../../src/store/documents.ts#L20-L23) — `readDoc` returns `schema.parse(data)`.
- [src/store/documents.ts](../../../../src/store/documents.ts#L75-L81) — `writeDoc` re-serializes the parsed value.
- [src/store/project.ts](../../../../src/store/project.ts#L66-L70) — `loadProject` stores the parsed result as `project.config`.
- [src/server/server.ts](../../../../src/server/server.ts#L476-L498) — `/api/debug/state` returns `runtime.project.config`.

These are the consumers the round-5 schema mechanism must leave
unchanged for all keys other than `model_overrides`.

## Daemon impact (concrete on-disk inventory)

Every known `.saivage/config.json` was inspected by top-level key
list only (no values; no secret material read). Inventory date:
round-4 audit, carried forward unchanged for round 5 because the
same physical files are inspected and the round-5 schema mechanism
does not change which keys load. Five workspace-mirror paths under
`/home/salva/g/ml` plus four known Saivage LXC containers were
covered. `jq` was not available on every host; Python
`json.load(...).keys()` was used in those cases.

Top-level keys recognised by the current
[`ProjectConfigSchema`](../../../../src/types.ts#L12-L29):
`project_name`, `objectives`, `model_overrides`, `routing`, `skills`,
`agents`.

| Path | Exists? | Top-level keys observed | Has model_overrides? | Load status under round-5 schema |
|------|---------|-------------------------|----------------------|-----------------------------------|
| /home/salva/g/ml/saivage/.saivage/config.json | no | (file absent) | n/a | n/a |
| /home/salva/g/ml/saivage-v3/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | loads cleanly; notifications stripped from parsed output |
| /home/salva/g/ml/getrich/.saivage/config.json | yes | notifications, objectives, project_name, provider, routing, skills | no | loads cleanly; notifications and provider stripped from parsed output |
| /home/salva/g/ml/getrich-v2/.saivage/config.json | no | (file absent — post-F33 split layout) | n/a | n/a |
| /home/salva/g/ml/diedrico/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | loads cleanly; notifications stripped from parsed output |
| 10.0.3.111 /work/getrich/.saivage/config.json | yes | notifications, objectives, project_name, provider, routing, skills | no | loads cleanly; notifications and provider stripped from parsed output |
| 10.0.3.112 /work/saivage-v3/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | loads cleanly; notifications stripped from parsed output |
| 10.0.3.113 /work/diedrico/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | loads cleanly; notifications stripped from parsed output |
| 10.0.3.170 /work/getrich-v2/.saivage/config.json | no | (file absent — post-F33 split layout) | n/a | n/a |
| 10.0.3.170 /opt/saivage-v3/.saivage/config.json | yes | notifications, objectives, project_name, skills | no | loads cleanly; notifications stripped from parsed output |

Net daemon impact under the round-5 schema mechanism:

- Zero known on-disk configs fail load; none carries
  `model_overrides`.
- For every other unknown top-level key currently present in those
  configs (`notifications`, `provider`), the round-5 schema yields
  exactly the same parsed output as today: the key is stripped, it
  does not appear in `runtime.project.config`
  ([src/store/project.ts](../../../../src/store/project.ts#L66-L70)),
  it does not appear in the `/api/debug/state` payload
  ([src/server/server.ts](../../../../src/server/server.ts#L476-L498)),
  and any future `writeDoc(configPath, project.config, ProjectConfigSchema)`
  call ([src/store/documents.ts](../../../../src/store/documents.ts#L75-L81))
  would not re-serialize it. This is the live behavior the round-4
  reviewer required round 5 to preserve.
- The post-deploy verification check in
  [03-plan-r5.md](03-plan-r5.md#task-7--operator-gated-post-deploy-verification)
  remains a true verification step (expected zero hits) rather than
  a triage step the operator must run before every restart.

The forward-looking reject-time failure mode (an operator manually
writes `model_overrides` into `.saivage/config.json` between now and
the next restart) is unchanged from round 4: typed Zod issue at path
`["model_overrides"]`, daemon refuses to load the project, operator
removes the key by hand. No auto-stripper, no warn-and-strip path.

## Scope decision: narrow rejection via preprocess, not passthrough

Round 5 narrows the schema-rejection contract from "reject any
unknown top-level key" (round 3's `.strict()`) and from "reject the
legacy key while retaining all other unknown keys" (round 4's
`.passthrough()`) to "reject specifically the legacy key while
preserving today's default strip behavior for every other unknown
key". The mechanism is `z.preprocess` wrapping the unchanged
`z.object`, not `.passthrough() + .superRefine`. The choice is
explained in [02-design-r5.md](02-design-r5.md#proposal-a-recommended-narrow-rejection-via-z-preprocess).

Reasons:

- The round-4 reviewer required the round-5 mechanism to preserve
  strip semantics for unrelated keys
  ([04-review-r4.md](04-review-r4.md#L13)). `z.preprocess` is the
  Zod-native primitive for "inspect raw input before parsing": the
  preprocess function can add a typed issue and short-circuit with
  `z.NEVER`, or pass the raw value through unchanged to the inner
  `z.object`, which then applies its default behavior (strip unknown
  keys; produce the same parsed shape as today).
- `.passthrough() + .superRefine` does not satisfy the requirement
  because the parsed output of a `.passthrough()` schema retains
  unknown keys ([04-review-r4.md](04-review-r4.md#L7)). It is
  rejected in [02-design-r5.md](02-design-r5.md#proposal-b-rejected--passthrough--superrefine).
- `.strict()` rejects all seven known on-disk configs at restart on
  unrelated keys (see daemon-impact table above). It is rejected in
  [02-design-r5.md](02-design-r5.md#proposal-c-rejected--strict).
- A `z.superRefine` directly on the `z.object` would not see the
  legacy key, because Zod's default `z.object` strips unknown keys
  before `.superRefine` runs. The inspection must happen on the raw
  input, which is exactly what `z.preprocess` is for.

The targeted-rejection contract is:

- `ProjectConfigSchema.safeParse(rawJson)` returns `success: false`
  with a typed Zod issue whose `code` is `custom`, whose `path` is
  `["model_overrides"]`, and whose `message` names the field as a
  removed legacy v1 routing field. This is the operator-visible
  signal demanded by the no-shim rule.
- Other unknown top-level keys (`notifications`, `provider`, anything
  future) are silently stripped, exactly as today. They are out of
  scope for G26.

## Sequencing constraints

All three resolver findings (G23, G24, G25) touch
[src/routing/resolver.ts](../../../../src/routing/resolver.ts).
G23 and G24 are already APPROVED
([../G23/APPROVED.md](../G23/APPROVED.md),
[../G24/APPROVED.md](../G24/APPROVED.md)). G25 has a fresh r3 plan
at [../G25/03-plan-r3.md](../G25/03-plan-r3.md) that explicitly
orders the batch G23 → G24 → G25 → G26 at
[../G25/03-plan-r3.md](../G25/03-plan-r3.md#L14-L16).

Hard constraints:

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
  [Daemon impact](#daemon-impact-concrete-on-disk-inventory) shows
  no such config exists today; this risk is forward-looking only.
- Newly-seeded projects between schema change and seeder change land
  would carry the stub on disk and trip load. Mitigation: Task 1
  (schema) and Task 3 (seeder) must land in the same commit, captured
  as an explicit ordering constraint in
  [03-plan-r5.md](03-plan-r5.md#hard-ordering-constraint-task-1--task-3-ship-together).
- G25 r3 plan is not yet approved; if its body shape changes before
  approval, the G26 plan's `resolvePreferredModels` patch site needs
  to be re-checked. Mitigation: G26 plan targets the helper rename
  only, not the body shape, so it is robust to G25 wording changes.
