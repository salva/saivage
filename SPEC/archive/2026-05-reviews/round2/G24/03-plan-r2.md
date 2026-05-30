# G24 — Plan r2 (Proposal A)

Implements [02-design-r2.md](02-design-r2.md) Proposal A: narrow the
resolver's input type to the validated shape, delete both
projectRoutingSchema.parse(...) calls inside the resolver, drop the
loose ProjectRoutingConfigLike interface, and fix the three test
fixtures that relied on the runtime parse to fill defaults.

## 0. r2 deltas vs r1

Three changes vs [03-plan-r1.md](03-plan-r1.md), all driven by
[04-review-r1.md](04-review-r1.md):

1. Validation gate is split into a production gate and a test-helper
   gate. The production gate asserts zero
   projectRoutingSchema.parse hits in non-test src/ code; the
   test-helper gate asserts exactly one hit inside
   src/routing/resolver.test.ts. r1 asked for zero across all src/,
   which was unreachable while the helper exists. See Steps 4 and 8.
2. Step 5 now enumerates all THREE fixtures, including the
   allowed_models-only regression at
   [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L127),
   and states explicitly that it is wrapped by the routing(...) helper.
3. Working directory is fixed to saivage/ throughout. Every command in
   this plan uses cwd = saivage/ and path arguments relative to that
   cwd (src/..., never saivage/src/...). The earlier
   "grep saivage/src" examples have been corrected.

## Pre-flight

Working directory: saivage/.

Confirm starting state from saivage/:

- git status clean.
- grep -n "projectRoutingSchema.parse" src returns exactly two hits,
  both inside
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L99)
  and
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L147).
- grep -rn "ProjectRoutingConfigLike" src returns hits only inside
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts).

If any of the above is false, stop and re-scope.

## Step 1 — Add the ProjectRoutingInput type

File:
[src/routing/resolver.ts](../../../../src/routing/resolver.ts).

1. Just below the existing ProjectRoutingConfig type alias
   ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L31)),
   add:

   ```ts
   export interface ProjectRoutingInput {
     model_overrides?: Record<string, string>;
     routing?: z.output<typeof projectRoutingSchema>;
   }
   ```

   (z is already imported by the resolver; if not, add
   import { z } from "zod"; alongside the existing imports.)

2. Delete the ProjectRoutingConfigLike interface
   ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L51-L54))
   entirely. Do not re-export it under the new name.

## Step 2 — Tighten the constructor and remove the first parse

File:
[src/routing/resolver.ts](../../../../src/routing/resolver.ts).

1. Update the project field type
   ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L88))
   from ProjectRoutingConfigLike to ProjectRoutingInput.
2. Add a new private cached field next to it:
   private readonly routing?: ProjectRoutingConfig;
3. Update the constructor parameter type
   ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L94))
   to ProjectRoutingInput.
4. In the constructor body
   ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L97-L104)),
   replace the parse line with a direct assignment to the cached
   field:

   ```ts
   this.routing = project.routing;
   this.profiles = Object.fromEntries(
     Object.entries(this.routing?.profiles ?? {}).map(([name, rule]) => [name, normalizeRule(rule)]),
   );
   this.defaultProfile = this.routing?.default_profile;
   ```

   The local const routing = ... is removed; its three reads become
   this.routing.

## Step 3 — Remove the per-call parse in resolveRoleRule

File:
[src/routing/resolver.ts](../../../../src/routing/resolver.ts).

In resolveRoleRule
([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L145-L171)),
replace

```ts
const routing = this.project.routing ? projectRoutingSchema.parse(this.project.routing) : undefined;
const roleEntry = routing?.roles?.[role] ?? routing?.roles?.default;
```

with

```ts
const roleEntry = this.routing?.roles?.[role] ?? this.routing?.roles?.default;
```

Everything below this line is unchanged.

## Step 4 — Production-code parse gate

From saivage/:

```bash
grep -rn "projectRoutingSchema.parse" src --include="*.ts" --exclude="*.test.ts"
```

Expected: zero hits.

This is the production gate. It is intentionally narrower than r1's
"zero across all src/" because Step 5 introduces a sanctioned helper
in src/routing/resolver.test.ts. The test-helper gate is Step 8.

## Step 5 — Fix resolver test fixtures (all three)

File:
[src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts).

1. Add a fixture helper near the top of the file (after the existing
   imports):

   ```ts
   import { z } from "zod";
   import { projectRoutingSchema } from "./resolver.js";

   const routing = (
     raw: z.input<typeof projectRoutingSchema>,
   ): z.output<typeof projectRoutingSchema> =>
     projectRoutingSchema.parse(raw);
   ```

   This is the ONE sanctioned residual call to
   projectRoutingSchema.parse anywhere in src/.

2. Wrap each routing: { ... } literal that omits defaults so that the
   fixture is the post-parse shape. There are exactly three such
   sites; all three MUST be updated:

   - Profile fixture at
     [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L33-L48):
     change `routing: { profiles: { ... }, roles: { planner: "safe_coding" } }`
     to
     `routing: routing({ profiles: { ... }, roles: { planner: "safe_coding" } })`.
   - Direct chat fixture at
     [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L75-L82):
     change `routing: { roles: { chat: { ... } } }` to
     `routing: routing({ roles: { chat: { ... } } })`.
   - allowed_models-only regression fixture at
     [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L121-L127):
     change
     `routing: { roles: { coder: { allowed_models: ["github-copilot/gpt-5.4"] } } }`
     to
     `routing: routing({ roles: { coder: { allowed_models: ["github-copilot/gpt-5.4"] } } })`.

   All three fixtures use the same helper. Option (a) from
   [04-review-r1.md](04-review-r1.md) is the chosen strategy; option
   (b) (expand to explicit post-parse literals) is rejected — see
   [02-design-r2.md](02-design-r2.md#3-proposals).

3. Do not change the first test case
   ([src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28))
   because it has no routing field.

## Step 6 — Verify config-validation tests untouched

File:
[src/config-validation.test.ts](../../../../src/config-validation.test.ts#L41-L128).

All six fixtures pass {} for the project arg. They satisfy
ProjectRoutingInput (both fields optional). No changes needed.

## Step 7 — Run validation gates

From saivage/:

```bash
npm run typecheck
npm test -- src/routing/resolver.test.ts
npm test -- src/config-validation.test.ts
npm test
```

Expected:

- typecheck: clean.
- Both targeted suites: green.
- Full suite: green.

If typecheck reports an error on any caller of ModelRoutingResolver
outside
[src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L130)
or the two test files, stop. That caller is bypassing
loadProject / ProjectConfigSchema and needs to be triaged separately
— do not loosen the resolver contract to compensate.

## Step 8 — Final grep sweeps

All commands from saivage/.

Production-code gate (must be empty):

```bash
grep -rn "projectRoutingSchema.parse" src --include="*.ts" --exclude="*.test.ts"
```

Expected: zero hits.

Test-helper gate (must be exactly one hit, inside the sanctioned
helper):

```bash
grep -rn "projectRoutingSchema.parse" src --include="*.test.ts"
```

Expected: exactly one hit, in
[src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts)
(the helper added in Step 5.1). If any other test file matches, stop
and remove that hit — only the resolver test file owns this helper.

Dead-interface gate (must be empty):

```bash
grep -rn "ProjectRoutingConfigLike" src
```

Expected: zero hits.

New-input-type sanity check (definition-only):

```bash
grep -rn "ProjectRoutingInput" src
```

Expected: hits only inside
[src/routing/resolver.ts](../../../../src/routing/resolver.ts) (the
definition). If any consumer started importing it, that is fine — but
no test or production code is required to.

## Step 9 — Deliverable

A single commit on the G24 branch with:

- Changes to
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts):
  remove two projectRoutingSchema.parse(...) calls, drop
  ProjectRoutingConfigLike, add ProjectRoutingInput, cache
  this.routing.
- Changes to
  [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts):
  add routing(...) helper, wrap three fixtures (L33-L48, L75-L82,
  L121-L127).
- No changes elsewhere.

Commit message:

```
G24: drop redundant projectRoutingSchema parses in resolver

The routing schema is already validated by ProjectConfigSchema at
config load (src/store/project.ts loadProject -> readDoc). The
resolver's constructor and resolveRoleRule both re-parsed the same
payload on every call, allocating a fresh deep copy on the hot path
and masking the fact that the public input type was effectively any.

Narrow ModelRoutingResolver's project parameter to a ProjectConfig-
derived slice (ProjectRoutingInput), cache the validated routing in
the constructor, and delete both parses. Drop the misleading
ProjectRoutingConfigLike interface. Update all three resolver test
fixtures that depended on the resolver's defensive parse to use a
local schema-parse helper instead.
```

## Step 10 — Out-of-scope guards

Do NOT, in this commit:

- Touch RuntimeRoutingConfigLike, RuntimeProviderConfigLike, or
  RuntimeProviderAccountLike shapes.
- Refactor mergeRuleChain, resolvePreferredModels,
  resolvePreferredAccounts, or resolveSource.
- Add a new "validated routing" wrapper class.
- Change loadConfig or loadProject validation order.
- Touch
  [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts)
  beyond what the type system forces (it should force nothing).

If any of those changes look attractive while reading the diff, file
them under G23 / G25 / G26 instead.
