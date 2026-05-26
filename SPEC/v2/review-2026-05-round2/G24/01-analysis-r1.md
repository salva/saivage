# G24 — Analysis r1

## 1. Finding under review

[../G24-resolver-redundant-zod-parse.md](../G24-resolver-redundant-zod-parse.md):
the routing resolver invokes `projectRoutingSchema.parse(project.routing)`
twice per `resolve()` call even though the caller has already validated
the same payload at config-load time.

## 2. Functional analysis (what actually happens today)

### 2.1 Where the parses live

- Constructor parse: [src/routing/resolver.ts](src/routing/resolver.ts#L99)
  — runs once per `ModelRoutingResolver` instance. Its only consumers are
  `this.profiles` and `this.defaultProfile`
  ([src/routing/resolver.ts](src/routing/resolver.ts#L100-L104)). The
  parsed `routing.roles` field is discarded.
- Per-call parse: [src/routing/resolver.ts](src/routing/resolver.ts#L147)
  inside `resolveRoleRule`, which runs on every `resolve(role)`. The
  resolver is invoked once per LLM call by `BaseAgent.callProvider`
  (via the model router), so this is on the hot path. Only
  `routing.roles[role]` is consumed
  ([src/routing/resolver.ts](src/routing/resolver.ts#L148-L171)); the
  `profiles` and `default_profile` fields are re-parsed and thrown
  away.

### 2.2 What guarantees validation

The same `routing` object is validated exactly once at config load:
[src/store/project.ts](src/store/project.ts#L70) calls
`readDoc(configPath, ProjectConfigSchema)`, and `ProjectConfigSchema`
embeds `routing: projectRoutingSchema.optional()`
([src/types.ts](src/types.ts#L12-L17)). The single caller in production
code ([src/server/bootstrap.ts](src/server/bootstrap.ts#L120-L130))
passes `project.config` straight from that validated `loadProject`
result. Tests build literal objects that already conform to the schema
shape.

### 2.3 What the per-call parse actually buys

Three things, all of them either redundant or harmful:

1. Re-validation of an already-validated payload (redundant).
2. A fresh deep-copy of the routing object on every `resolve()`
   (Zod `.parse` rebuilds the output object), so identity-based
   reasoning in tests or future caches is impossible.
3. A silent fallback contract: any caller can pass `{ routing: <any> }`
   because the schema is the only guard. The TypeScript signature
   already says `ProjectRoutingConfigLike` with `routing?:
   ProjectRoutingConfig`, but that promise is not enforced — it is
   "checked" at runtime by the resolver itself, masking caller-side
   type drift.

### 2.4 Hot-path cost

`projectRoutingSchema` is a small object schema (three keys, two
records), so per-call CPU is modest. However:

- `resolve()` is invoked at least once per LLM request, and the
  resolver outlives a bootstrap (one instance per process). So the
  parse runs N times where N is the total LLM-call count for the
  process lifetime, not once.
- The parse allocates fresh `Record` objects for `profiles` and
  `roles`, plus a fresh `RoutingRule` per entry. This is hot in the
  routing tests and in long-running supervisor/worker loops.

The cost is "low" per finding G24's severity tag, but the architectural
smell — schema as input guard on a hot path — is the bigger problem.

## 3. Constraints and project rules

- Architecture-first, no backward compatibility, no migration shims:
  do not keep both a loose external contract and a hidden validation
  guard "just in case".
- Remove dead code: if a Zod parse exists only to defend the hot path
  from callers that don't exist, delete it.
- No over-engineering: do not introduce a new "validated routing"
  wrapper type when `z.output<typeof projectRoutingSchema>` already
  exists.
- Stay inside subsystem boundary: routing only. Do not touch runtime
  provider / account schemas (those are loose by intent and partially
  the territory of G23 / G25 / G26, not yet approved).

## 4. Caller inventory (what would need to change)

- [src/server/bootstrap.ts](src/server/bootstrap.ts#L130) — passes
  `project.config`. Already typed as `ProjectConfig`. No runtime
  change.
- [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L6-L100)
  — three test fixtures use object literals with `routing: {...}`. Two
  of them omit `profiles` / `roles` / `preferred_models` defaults.
  These literals are accepted today because the resolver re-parses and
  the schema fills defaults; once we drop the parse, fixtures must
  provide the post-parse shape (either explicitly or via a single
  helper that runs `projectRoutingSchema.parse(...)` in the test).
- [src/config-validation.test.ts](src/config-validation.test.ts#L41-L128)
  — six fixtures, all pass `{}` (no `routing`). Unaffected.

## 5. Cross-link discipline (avoiding scope creep)

- G23, G25, G26 are listed as related in the subsystem map but not
  approved. This finding addresses ONLY the redundant Zod parse. It
  does not refactor `resolveRoleRule`, `mergeRuleChain`, source
  classification, or account normalization — even though the same
  function is touched.
- The finding's "one level up" suggestion ("move the parse into the
  configuration loader") is already partially true: the parse runs in
  `readDoc(...)` at load. What is missing is removing the resolver's
  duplicate parses and tightening the input type to match. That is the
  scope of this fix.

## 6. Risk profile

- Behavioural risk: very low. The schema in the loader is identical to
  the one re-applied by the resolver, so removing the resolver-side
  parse changes nothing for valid input.
- Test risk: localised. Three test cases in resolver.test.ts need
  their fixtures normalised once (either inline or via a tiny
  `parseRouting` helper that calls the schema).
- Public-API risk: `ModelRoutingResolver`'s constructor signature
  narrows from `ProjectRoutingConfigLike` to a `ProjectConfig`-derived
  slice. The only external production caller already provides that
  shape.
