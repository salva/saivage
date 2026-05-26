# G24 — Plan r1 (Proposal A)

Implements [02-design-r1.md](02-design-r1.md) Proposal A: narrow the
resolver's input type to the validated shape, delete both
`projectRoutingSchema.parse(...)` calls inside the resolver, drop the
loose `ProjectRoutingConfigLike` interface, and fix the three test
fixtures that relied on the runtime parse to fill defaults.

## Pre-flight

Confirm starting state:

- `git status` clean inside `saivage/`.
- `grep -n "projectRoutingSchema.parse" saivage/src` returns exactly
  two hits, both inside
  [src/routing/resolver.ts](src/routing/resolver.ts#L99) and
  [src/routing/resolver.ts](src/routing/resolver.ts#L147).
- `grep -rn "ProjectRoutingConfigLike" saivage/src` returns hits only
  inside [src/routing/resolver.ts](src/routing/resolver.ts).

If any of the above is false, stop and re-scope.

## Step 1 — Add the `ProjectRoutingInput` type and `routing` cache field

File: [src/routing/resolver.ts](src/routing/resolver.ts).

1. Just below the existing `ProjectRoutingConfig` type alias
   ([src/routing/resolver.ts](src/routing/resolver.ts#L31)), add:

   ```ts
   export interface ProjectRoutingInput {
     model_overrides?: Record<string, string>;
     routing?: ProjectRoutingConfig;
   }
   ```

2. Delete the `ProjectRoutingConfigLike` interface
   ([src/routing/resolver.ts](src/routing/resolver.ts#L51-L54))
   entirely. Do not re-export it under the new name.

## Step 2 — Tighten the constructor and remove the first parse

File: [src/routing/resolver.ts](src/routing/resolver.ts).

1. Update the `project` field type
   ([src/routing/resolver.ts](src/routing/resolver.ts#L88)) from
   `ProjectRoutingConfigLike` to `ProjectRoutingInput`.
2. Add a new private field next to it:
   `private readonly routing?: ProjectRoutingConfig;`
3. Update the constructor parameter type
   ([src/routing/resolver.ts](src/routing/resolver.ts#L94)) to
   `ProjectRoutingInput`.
4. In the constructor body
   ([src/routing/resolver.ts](src/routing/resolver.ts#L97-L104)),
   replace the parse line with a direct assignment:

   ```ts
   this.routing = project.routing;
   this.profiles = Object.fromEntries(
     Object.entries(this.routing?.profiles ?? {}).map(([name, rule]) => [name, normalizeRule(rule)]),
   );
   this.defaultProfile = this.routing?.default_profile;
   ```

   The local `const routing = ...` is removed; its three reads become
   `this.routing`.

## Step 3 — Remove the per-call parse in `resolveRoleRule`

File: [src/routing/resolver.ts](src/routing/resolver.ts).

In `resolveRoleRule`
([src/routing/resolver.ts](src/routing/resolver.ts#L145-L171)),
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

## Step 4 — Confirm `projectRoutingSchema.parse` no longer runs inside the resolver

Run:

```bash
grep -n "projectRoutingSchema.parse" saivage/src
```

Expected: zero hits.

## Step 5 — Fix resolver test fixtures

File: [src/routing/resolver.test.ts](src/routing/resolver.test.ts).

1. Add a fixture helper near the top of the file (after the imports):

   ```ts
   import { projectRoutingSchema } from "./resolver.js";
   const routing = (raw: z.input<typeof projectRoutingSchema>) =>
     projectRoutingSchema.parse(raw);
   ```

   (with `import { z } from "zod";` if not already present).

2. Wrap each `routing: { ... }` literal that omits defaults so that the
   fixture is the validated shape. Specifically:
   - [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L33-L48):
     `routing: routing({ profiles: { safe_coding: { ... } }, roles: { planner: "safe_coding" } })`.
   - [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L75-L82):
     `routing: routing({ roles: { chat: { ... } } })`.
   - Any other call site in the same file that uses `routing: { ... }`
     literal: wrap identically.

3. Do not change the first test case
   ([src/routing/resolver.test.ts](src/routing/resolver.test.ts#L5-L28))
   because it has no `routing` field.

## Step 6 — Verify config-validation tests untouched

File:
[src/config-validation.test.ts](src/config-validation.test.ts#L41-L128).

All six fixtures pass `{}` for the project arg. They satisfy
`ProjectRoutingInput` (both fields optional). No changes needed.

## Step 7 — Run validation gates

From `saivage/`:

```bash
npm run typecheck
npm test -- src/routing/resolver.test.ts
npm test -- src/config-validation.test.ts
npm test
```

Expected:

- `typecheck`: clean.
- Both targeted suites: green.
- Full suite: green.

If typecheck reports an error on any caller of `ModelRoutingResolver`
outside [src/server/bootstrap.ts](src/server/bootstrap.ts#L130) or the
two test files, stop. That caller is bypassing
`loadProject`/`ProjectConfigSchema` and needs to be triaged
separately — do not loosen the resolver contract to compensate.

## Step 8 — Final grep sweeps

```bash
grep -rn "ProjectRoutingConfigLike" saivage/src
grep -rn "projectRoutingSchema.parse" saivage/src
```

Both must return zero hits.

```bash
grep -rn "ProjectRoutingInput" saivage/src
```

Must return hits only inside
[src/routing/resolver.ts](src/routing/resolver.ts) (the definition).
If any consumer started importing it, that is fine — but no test or
production code should need to.

## Step 9 — Deliverable

A single commit on the G24 branch with:

- Changes to [src/routing/resolver.ts](src/routing/resolver.ts):
  remove two `projectRoutingSchema.parse(...)` calls, drop
  `ProjectRoutingConfigLike`, add `ProjectRoutingInput`, cache
  `this.routing`.
- Changes to
  [src/routing/resolver.test.ts](src/routing/resolver.test.ts):
  add `routing(...)` helper, wrap three fixtures.
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
ProjectRoutingConfigLike interface. Update the three resolver test
fixtures that depended on the resolver's defensive parse to use a
local schema-parse helper instead.
```

## Step 10 — Out-of-scope guards

Do NOT, in this commit:

- Touch `RuntimeRoutingConfigLike`, `RuntimeProviderConfigLike`, or
  `RuntimeProviderAccountLike` shapes.
- Refactor `mergeRuleChain`, `resolvePreferredModels`,
  `resolvePreferredAccounts`, or `resolveSource`.
- Add a new "validated routing" wrapper class.
- Change `loadConfig` or `loadProject` validation order.
- Touch [src/server/bootstrap.ts](src/server/bootstrap.ts) beyond what
  the type system forces (it should force nothing).

If any of those changes look attractive while reading the diff, file
them under G23 / G25 / G26 instead.
