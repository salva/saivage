# G24 — Design r1

## 1. Goal

Eliminate the two `projectRoutingSchema.parse(project.routing)` calls
inside `ModelRoutingResolver`, make the resolver trust its input type,
and let the single existing config-load validation in
[src/store/project.ts](src/store/project.ts#L70) be the only place the
routing payload is checked.

## 2. Non-goals

- Do not refactor `resolveRoleRule`, `mergeRuleChain`, source
  classification, or account-normalization beyond the lines that
  directly call `projectRoutingSchema.parse`.
- Do not touch runtime config (`RuntimeRoutingConfigLike`,
  `RuntimeProviderConfigLike`). Those interfaces are intentionally
  loose and are the subject of separate, not-yet-approved findings.
- Do not change `loadConfig` / `loadProject` validation semantics. The
  parse stays at load time, where it already lives.
- Do not introduce a new wrapper type, builder, or "validated routing"
  branded type. `z.output<typeof projectRoutingSchema>` is enough.

## 3. Proposals

### 3.1 Proposal A — Narrow the resolver's input type to the validated shape (recommended)

#### Shape

Change `ModelRoutingResolver`'s `project` parameter type from the loose
`ProjectRoutingConfigLike` interface to a slice of `ProjectConfig`
(z.output of the project-config schema):

```ts
// before
constructor(project: ProjectRoutingConfigLike, runtime: RuntimeRoutingConfigLike)

// after
type ProjectRoutingInput = Pick<ProjectConfig, "model_overrides" | "routing">;
constructor(project: ProjectRoutingInput, runtime: RuntimeRoutingConfigLike)
```

`ProjectConfig` already imports the same schema
([src/types.ts](src/types.ts#L7-L17)), so this introduces no new module
dependency direction beyond `routing → types`. There is already a
`types → routing` import for the schema itself; to avoid a circular
file dependency we export the new alias from
[src/routing/resolver.ts](src/routing/resolver.ts#L1) as:

```ts
export type ProjectRoutingInput = {
  model_overrides?: Record<string, string>;
  routing?: z.output<typeof projectRoutingSchema>;
};
```

i.e. the same shape `ProjectConfig` already has, expressed in
resolver-local terms so the resolver does not import from `types.ts`.
The existing `ProjectRoutingConfigLike` interface is deleted (no
migration shim, no re-export). `ProjectRoutingConfig` (the
`z.infer<typeof projectRoutingSchema>` alias) stays — it is the same
shape and used by other modules.

#### Internal changes

- [src/routing/resolver.ts](src/routing/resolver.ts#L97-L104)
  Constructor: replace
  `const routing = project.routing ? projectRoutingSchema.parse(project.routing) : undefined;`
  with `const routing = project.routing;` and use it as-is.
- [src/routing/resolver.ts](src/routing/resolver.ts#L145-L171)
  `resolveRoleRule`: cache the routing reference once in the
  constructor as `this.routing: ProjectRoutingConfig | undefined`, and
  replace the second parse with `this.routing`.
- Delete the now-unused `ProjectRoutingConfigLike` interface
  ([src/routing/resolver.ts](src/routing/resolver.ts#L51-L54)).

After these edits, `projectRoutingSchema` is still exported (it is
used by `ProjectConfigSchema` in
[src/types.ts](src/types.ts#L16) and re-exported from
[src/index.ts](src/index.ts#L7)), but it is no longer called inside
`resolver.ts` itself.

#### Caller updates

- [src/server/bootstrap.ts](src/server/bootstrap.ts#L130): already
  passes `project.config` typed as `ProjectConfig`. No code change;
  the call type-checks against `ProjectRoutingInput` because
  `ProjectConfig` is structurally compatible.
- [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L31-L100):
  the two literals that omit `routing.profiles` / `routing.roles` must
  satisfy the validated shape post-change. Add a one-line test helper
  in the same file:

  ```ts
  import { projectRoutingSchema } from "./resolver.js";
  const routing = (raw: unknown) => projectRoutingSchema.parse(raw);
  ```

  and use it to build the `routing` field for each fixture that needs
  defaults. This concentrates the validation in tests where it
  belongs (test data hygiene), not in production hot paths.

#### Pros

- Removes both parses entirely; zero per-call allocation, zero per-call
  CPU, zero per-call branching for validation.
- Schema becomes single-sourced at config load. The hot path trusts
  TypeScript, which is what TypeScript is for.
- Aligned with the finding's "remediation direction" verbatim.
- Aligned with the project rule "no migration shims, remove dead code".
- Deletes a misleading interface (`ProjectRoutingConfigLike`) that
  pretended to be loose but was really a Zod-guarded contract.

#### Cons

- Slightly tighter coupling between resolver and the project-config
  schema shape. Mitigated by the fact that resolver already OWNS the
  schema (`projectRoutingSchema` is defined here).
- Three test-fixture sites change. Cost: one helper, two-line edits
  each.

### 3.2 Proposal B — Parse once in the constructor, keep the loose external contract

#### Shape

Keep `ProjectRoutingConfigLike` as the public type. Change the
constructor to parse the routing exactly once and store the result on
`this`. Remove the per-call parse from `resolveRoleRule`.

```ts
private readonly routing?: ProjectRoutingConfig;

constructor(project: ProjectRoutingConfigLike, runtime: RuntimeRoutingConfigLike) {
  this.project = project;
  this.runtime = runtime;
  this.routing = project.routing ? projectRoutingSchema.parse(project.routing) : undefined;
  this.profiles = Object.fromEntries(
    Object.entries(this.routing?.profiles ?? {}).map(([name, rule]) => [name, normalizeRule(rule)]),
  );
  this.defaultProfile = this.routing?.default_profile;
}
```

`resolveRoleRule` reads `this.routing` instead of re-parsing.

#### Pros

- Minimal code churn: one parse remains, on the cold path
  (construction).
- Zero test changes — fixtures still get defaults filled by the
  surviving constructor parse.
- Still removes the hot-path cost (the L147 parse).

#### Cons

- Keeps the schema as a runtime guard for an input that is *already*
  validated upstream. This is the architectural smell the finding
  flags, and Proposal B only addresses the perf half.
- `ProjectRoutingConfigLike` survives as a misleading "loose-looking"
  interface that is really a covertly-validated contract.
- Violates the project rule "no defensive duplication" — we keep a
  guard that has no producer of bad data.
- Does not change anything for future callers of `resolveRoleRule`-
  shaped methods (e.g., a future `resolveAll()`); they would still
  benefit from a type-narrowed contract that B does not provide.

### 3.3 Proposal C (rejected) — Compile routing into a fully pre-normalized internal table at construction

Pre-compute every role's `NormalizedRule` in the constructor so
`resolve(role)` becomes a single lookup. This goes beyond G24's scope
(it changes the merge/resolve algorithm, not the parse pattern),
overlaps with G23 / G25 / G26 territory, and risks creating a stale
cache if the runtime config is later allowed to mutate. Rejected on
scope-creep grounds; revisit only if the related findings approve.

## 4. Comparison and recommendation

| Axis | Proposal A | Proposal B |
|---|---|---|
| Per-call CPU / alloc removed | yes, fully | yes |
| Constructor parse removed | yes | no (one parse remains) |
| Architectural smell removed | yes | no |
| Type contract tightened | yes | no |
| Test changes | three fixtures + 1 helper | none |
| Project-rule alignment | full | partial |
| Risk | very low (mechanical) | very low |

**Recommendation: Proposal A.** It is the only option that fully
realises the finding's stated direction, removes the implicit
"schema-as-guard" pattern, and matches the project's architecture-first
rule. The test fixture work is trivial and concentrated in the file
that already owns these fixtures.

## 5. Public-surface impact

- `ModelRoutingResolver` constructor signature narrows; the only
  external production caller already conforms.
- `ProjectRoutingConfigLike` is deleted from
  [src/routing/resolver.ts](src/routing/resolver.ts#L51-L54). It has
  no external consumers other than the resolver itself
  (grep confirms zero hits outside this file).
- `parseAccountRef`, `RuntimeProviderConfigLike`,
  `RuntimeProviderAccountLike`, `projectRoutingSchema`,
  `routingRuleSchema`, `ProjectRoutingConfig`, `RoutingRule`,
  `ResolvedModelRoute`, `ModelRoutingResolver`: unchanged exports.

## 6. Out-of-scope items recorded for downstream findings

- Whether the runtime config (`RuntimeRoutingConfigLike`,
  `RuntimeProviderConfigLike`) should also be Zod-typed → for G23 /
  G25 / G26 to decide.
- Whether `resolveRoleRule` should be inlined or restructured →
  separate finding.
- Whether the four-source merge (`routing → legacy → runtime-default`)
  should be simplified → separate finding.

## 7. Validation plan (handed to plan r1)

- `npm run typecheck` in `saivage/`: must pass; the contract change
  surfaces any silent caller drift.
- `npm test -- src/routing/resolver.test.ts` and
  `src/config-validation.test.ts`: must pass.
- Manual: grep `projectRoutingSchema.parse` inside `src/`; the only
  surviving call site must be inside Zod's own machinery via
  `readDoc(configPath, ProjectConfigSchema)` (transitive). Direct
  uses of `projectRoutingSchema.parse` in `src/` must drop to zero.
