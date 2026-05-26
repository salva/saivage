# G24 — Design r2

## 0. r2 deltas vs r1

The r1 reviewer flagged three required changes in
[04-review-r1.md](04-review-r1.md). The substantive design impact is:

1. The validation-gate / fixture-strategy contradiction. r1 both kept
   a test helper that calls projectRoutingSchema.parse and asked the
   final grep to return zero hits across src/. r2 resolves this by
   choosing option (a) from the review: keep the test helper and
   restrict the grep gate to production code (exclude
   src/routing/resolver.test.ts and any other *.test.ts file). The
   rationale is below in section 3.1.
2. The allowed_models-only fixture at
   [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L127)
   is now named explicitly in section 3.1 (and in the plan), and is
   wrapped by the same routing(...) helper as the other two fixtures.
3. Working-directory and grep-path consistency moved entirely into the
   plan. Design references file paths only as repo-relative links
   under saivage/, never as bare relative paths that depend on cwd.

The chosen direction is unchanged: Proposal A. Narrow the input type
to a ProjectConfig-derived ProjectRoutingInput, cache this.routing,
delete both parses, delete ProjectRoutingConfigLike.

## 1. Goal

Eliminate the two projectRoutingSchema.parse(project.routing) calls
inside ModelRoutingResolver, make the resolver trust its input type,
and let the single existing config-load validation in
[src/store/project.ts](../../../../src/store/project.ts#L70) be the
only place the routing payload is checked in production code.

## 2. Non-goals

- Do not refactor resolveRoleRule, mergeRuleChain, source
  classification, or account-normalization beyond the lines that
  directly call projectRoutingSchema.parse.
- Do not touch runtime config (RuntimeRoutingConfigLike,
  RuntimeProviderConfigLike). Those interfaces are intentionally loose
  and are the subject of separate, not-yet-approved findings.
- Do not change loadConfig / loadProject validation semantics. The
  parse stays at load time, where it already lives.
- Do not introduce a new wrapper type, builder, or "validated routing"
  branded type. z.output<typeof projectRoutingSchema> is enough.

## 3. Proposals

### 3.1 Proposal A — Narrow the resolver's input type to the validated shape (recommended, accepted)

#### Shape

Change ModelRoutingResolver's project parameter type from the loose
ProjectRoutingConfigLike interface to a slice of ProjectConfig
(z.output of the project-config schema):

- Before:
  constructor(project: ProjectRoutingConfigLike, runtime: RuntimeRoutingConfigLike)
- After:
  constructor(project: ProjectRoutingInput, runtime: RuntimeRoutingConfigLike)

ProjectConfig already imports the same schema
([src/types.ts](../../../../src/types.ts#L7-L17)), so this introduces
no new module dependency. To avoid a circular file dependency we
declare the new alias inside
[src/routing/resolver.ts](../../../../src/routing/resolver.ts) in
resolver-local terms:

```ts
export interface ProjectRoutingInput {
  model_overrides?: Record<string, string>;
  routing?: z.output<typeof projectRoutingSchema>;
}
```

This is the same shape ProjectConfig already has. The existing
ProjectRoutingConfigLike interface is deleted (no migration shim, no
re-export). ProjectRoutingConfig (the z.infer<typeof
projectRoutingSchema> alias) stays — it is used by other modules.

#### Internal changes

- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L96-L100)
  Constructor: replace
  `const routing = project.routing ? projectRoutingSchema.parse(project.routing) : undefined;`
  with a direct assignment to a new cached field
  `this.routing = project.routing;` and use it for the profiles map
  and defaultProfile.
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L145-L148)
  resolveRoleRule: replace the second
  projectRoutingSchema.parse(this.project.routing) call with a read of
  this.routing.
- Delete the now-unused ProjectRoutingConfigLike interface
  ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L51-L54)).

After these edits, projectRoutingSchema is still exported (used by
ProjectConfigSchema in
[src/types.ts](../../../../src/types.ts#L16) and re-exported from
[src/index.ts](../../../../src/index.ts#L7)), but it is no longer
called inside resolver.ts itself.

#### Caller updates

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130):
  already passes project.config typed as ProjectConfig. No code
  change; the call type-checks against ProjectRoutingInput because
  ProjectConfig is structurally compatible.
- [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts):
  three live fixtures omit schema-filled defaults. They are explicitly
  enumerated here so the implementer cannot miss the third:
  - Profile fixture:
    [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L33-L48).
  - Direct chat fixture:
    [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L75-L82).
  - allowed_models-only regression fixture:
    [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L127).

  Resolution: add a single test-local helper in the same file that
  parses the raw literal back to the post-parse shape. Concretely:

  ```ts
  import { z } from "zod";
  import { projectRoutingSchema } from "./resolver.js";

  const routing = (
    raw: z.input<typeof projectRoutingSchema>,
  ): z.output<typeof projectRoutingSchema> =>
    projectRoutingSchema.parse(raw);
  ```

  Each of the three fixtures wraps its routing literal in
  routing({ ... }). This concentrates validation in tests where it
  belongs (test data hygiene), not in production hot paths.

#### Validation-gate consequence (option a)

Because the helper itself contains a direct projectRoutingSchema.parse
call inside src/routing/resolver.test.ts, the final-sweep grep cannot
require zero hits across all of src/. The chosen strategy is option
(a) from the r1 review:

- Final grep for projectRoutingSchema.parse must EXCLUDE test files
  (i.e. exclude src/**/*.test.ts) and assert zero PRODUCTION uses.
- A complementary grep across src/**/*.test.ts is allowed to find the
  helper exactly once, inside
  [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts).
  This is the only sanctioned residual call.

Option (b) — expand every fixture into an explicit post-parse object
literal — is rejected: it would duplicate the schema defaults at three
sites, drift if the schema gains a default in the future, and provide
zero architectural value beyond what the helper already gives.

#### Pros

- Removes both parses entirely from production code; zero per-call
  allocation, zero per-call CPU, zero per-call branching for
  validation.
- Schema becomes single-sourced at config load in production. The hot
  path trusts TypeScript, which is what TypeScript is for.
- Aligned with the finding's "remediation direction" verbatim.
- Aligned with the project rule "no migration shims, remove dead
  code".
- Deletes a misleading interface (ProjectRoutingConfigLike) that
  pretended to be loose but was really a Zod-guarded contract.

#### Cons

- Slightly tighter coupling between resolver and the project-config
  schema shape. Mitigated by the fact that resolver already OWNS the
  schema (projectRoutingSchema is defined here).
- One sanctioned residual call to projectRoutingSchema.parse remains
  inside the test helper. This is a deliberate test-hygiene trade-off,
  not a production behaviour.
- Three test-fixture sites change. Cost: one helper, one wrap each.

### 3.2 Proposal B — Parse once in the constructor, keep the loose external contract

Unchanged from r1. Keeps ProjectRoutingConfigLike, parses once in the
constructor, drops the per-call parse. Pros: zero test changes. Cons:
keeps the architectural smell (schema as input guard), keeps the
misleading interface, violates "no defensive duplication". Not
chosen.

### 3.3 Proposal C (rejected)

Pre-compute every role's NormalizedRule in the constructor so
resolve(role) becomes a single lookup. Goes beyond G24's scope, risks
stale-cache issues if runtime config later mutates, overlaps G23 /
G25 / G26. Rejected on scope-creep grounds.

## 4. Comparison and recommendation

| Axis | Proposal A | Proposal B |
|---|---|---|
| Per-call CPU / alloc removed | yes, fully | yes |
| Constructor parse removed (production) | yes | no |
| Architectural smell removed | yes | no |
| Type contract tightened | yes | no |
| Test changes | 3 fixtures + 1 helper | none |
| Project-rule alignment | full | partial |
| Risk | very low (mechanical) | very low |

**Recommendation: Proposal A.** It is the only option that fully
realises the finding's stated direction, removes the implicit
"schema-as-guard" pattern from production, and matches the project's
architecture-first rule. The test fixture work is trivial and
concentrated in the file that already owns these fixtures.

## 5. Public-surface impact

- ModelRoutingResolver constructor signature narrows; the only
  external production caller already conforms.
- ProjectRoutingConfigLike is deleted from
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L51-L54).
  It has no external consumers other than the resolver itself
  (grep confirms zero hits outside this file).
- parseAccountRef, RuntimeProviderConfigLike,
  RuntimeProviderAccountLike, projectRoutingSchema,
  routingRuleSchema, ProjectRoutingConfig, RoutingRule,
  ResolvedModelRoute, ModelRoutingResolver: unchanged exports.
- New export: ProjectRoutingInput from
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts).

## 6. Out-of-scope items recorded for downstream findings

- Whether the runtime config (RuntimeRoutingConfigLike,
  RuntimeProviderConfigLike) should also be Zod-typed → for G23 / G25
  / G26 to decide.
- Whether resolveRoleRule should be inlined or restructured →
  separate finding.
- Whether the four-source merge (routing → legacy → runtime-default)
  should be simplified → separate finding.

## 7. Validation plan (handed to plan r2)

All commands run from the saivage/ working directory. Path arguments
are relative to that cwd (src/...), never prefixed with saivage/.

- npm run typecheck — must pass; the contract change surfaces any
  silent caller drift.
- npm test -- src/routing/resolver.test.ts and
  npm test -- src/config-validation.test.ts — must pass.
- Production-code grep gate (option a):
  - grep -rn "projectRoutingSchema.parse" src --include="*.ts" --exclude="*.test.ts"
    must return zero hits.
- Sanctioned-test-helper grep:
  - grep -rn "projectRoutingSchema.parse" src --include="*.test.ts"
    must return exactly one hit, inside src/routing/resolver.test.ts.
- Dead-interface grep:
  - grep -rn "ProjectRoutingConfigLike" src — must return zero hits.
