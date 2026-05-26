# G24 — Analysis r2

## 1. Finding under review

[../G24-resolver-redundant-zod-parse.md](../G24-resolver-redundant-zod-parse.md):
the routing resolver invokes projectRoutingSchema.parse(project.routing)
twice per resolve() call even though the caller has already validated
the same payload at config-load time.

## 2. r2 deltas vs r1

This analysis is unchanged in its functional claims. The r1 reviewer
([04-review-r1.md](04-review-r1.md)) confirmed that the analysis
correctly identifies:

- The two live duplicate parses at
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L96-L100)
  and
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L145-L148).
- The production validation path:
  [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L120-L130)
  → [src/store/project.ts](../../../../src/store/project.ts#L66-L70)
  → [src/types.ts](../../../../src/types.ts#L12-L17).
- The scope discipline of leaving G23 / G25 / G26 territory alone.

The only substantive r2 change is to section 4 (Caller inventory): the
allowed_models-only fixture at
[src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L127)
must be enumerated explicitly. The r1 analysis covered it implicitly
under "three test fixtures use object literals with routing"; r2 names
it. The fixture-strategy choice and the grep-gate / working-directory
fixes belong to the design and plan documents, not analysis.

## 3. Functional analysis (what actually happens today)

### 3.1 Where the parses live

- Constructor parse:
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L99)
  — runs once per ModelRoutingResolver instance. Its only consumers are
  this.profiles and this.defaultProfile
  ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L100-L104)).
  The parsed routing.roles field is discarded.
- Per-call parse:
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L147)
  inside resolveRoleRule, which runs on every resolve(role). The
  resolver is invoked once per LLM call by BaseAgent.callProvider
  (via the model router), so this is on the hot path. Only
  routing.roles[role] is consumed
  ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L148-L171));
  the profiles and default_profile fields are re-parsed and thrown
  away.

### 3.2 What guarantees validation

The same routing object is validated exactly once at config load:
[src/store/project.ts](../../../../src/store/project.ts#L70) calls
readDoc(configPath, ProjectConfigSchema), and ProjectConfigSchema
embeds routing: projectRoutingSchema.optional()
([src/types.ts](../../../../src/types.ts#L12-L17)). The single caller in
production code
([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L120-L130))
passes project.config straight from that validated loadProject
result. Tests build literal objects that already conform to the schema
shape.

### 3.3 What the per-call parse actually buys

Three things, all of them either redundant or harmful:

1. Re-validation of an already-validated payload (redundant).
2. A fresh deep-copy of the routing object on every resolve()
   (Zod .parse rebuilds the output object), so identity-based
   reasoning in tests or future caches is impossible.
3. A silent fallback contract: any caller can pass { routing: <any> }
   because the schema is the only guard. The TypeScript signature says
   ProjectRoutingConfigLike with routing?: ProjectRoutingConfig, but
   that promise is not enforced — it is "checked" at runtime by the
   resolver itself, masking caller-side type drift.

### 3.4 Hot-path cost

projectRoutingSchema is a small object schema (three keys, two
records), so per-call CPU is modest. However:

- resolve() is invoked at least once per LLM request, and the resolver
  outlives a bootstrap (one instance per process). So the parse runs
  N times where N is the total LLM-call count for the process
  lifetime, not once.
- The parse allocates fresh Record objects for profiles and roles,
  plus a fresh RoutingRule per entry. This is hot in the routing tests
  and in long-running supervisor/worker loops.

The cost is "low" per finding G24's severity tag, but the architectural
smell — schema as input guard on a hot path — is the bigger problem.

## 4. Constraints and project rules

- Architecture-first, no backward compatibility, no migration shims:
  do not keep both a loose external contract and a hidden validation
  guard "just in case".
- Remove dead code: if a Zod parse exists only to defend the hot path
  from callers that don't exist, delete it.
- No over-engineering: do not introduce a new "validated routing"
  wrapper type when z.output<typeof projectRoutingSchema> already
  exists.
- Stay inside subsystem boundary: routing only. Do not touch runtime
  provider / account schemas (those are loose by intent and partially
  the territory of G23 / G25 / G26, not yet approved).

## 5. Caller inventory (what would need to change)

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130)
  — passes project.config. Already typed as ProjectConfig. No runtime
  change.
- [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts)
  — exactly three live routing literals that omit defaults:
  - Profile fixture:
    [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L33-L48)
    (omits routing.default_profile and per-rule defaults).
  - Direct chat fixture:
    [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L75-L82)
    (omits routing.profiles, default_profile, and per-rule defaults
    for preferred_models / preferred_accounts).
  - allowed_models-only regression fixture:
    [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L127)
    (omits routing.profiles, default_profile, and per-rule defaults
    for preferred_models / preferred_accounts; relies on
    routingRuleSchema defaults to fill them when the resolver parses).

  All three are accepted today because the resolver re-parses and the
  schema fills defaults. Once the resolver-side parse is removed,
  these fixtures must arrive at the resolver constructor already in
  the post-parse (output) shape. r2 enumerates the third fixture
  explicitly to close the "any other call site" gap flagged in the r1
  review.
- [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L41-L128)
  — six fixtures, all pass {} (no routing). Unaffected.

## 6. Cross-link discipline (avoiding scope creep)

- G23, G25, G26 are listed as related in the subsystem map but not
  approved. This finding addresses ONLY the redundant Zod parse. It
  does not refactor resolveRoleRule, mergeRuleChain, source
  classification, or account normalization — even though the same
  function is touched.
- The finding's "one level up" suggestion ("move the parse into the
  configuration loader") is already partially true: the parse runs in
  readDoc(...) at load. What is missing is removing the resolver's
  duplicate parses and tightening the input type to match. That is the
  scope of this fix.

## 7. Risk profile

- Behavioural risk: very low. The schema in the loader is identical to
  the one re-applied by the resolver, so removing the resolver-side
  parse changes nothing for valid input.
- Test risk: localised. Three test cases in resolver.test.ts
  (lines L33-L48, L75-L82, L121-L127) need their fixtures normalised
  once.
- Public-API risk: ModelRoutingResolver's constructor signature
  narrows from ProjectRoutingConfigLike to a ProjectConfig-derived
  slice. The only external production caller already provides that
  shape.
