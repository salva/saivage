# G36 — Design r1

**Finding**: [../G36-auth-store-sync-fs.md](../G36-auth-store-sync-fs.md)
**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)
**Round-1 reference**: [../../review-2026-05/F22/02-design-r2.md](../../review-2026-05/F22/02-design-r2.md) (proposal A landed for `store/documents.ts`)

Two proposals, ordered by blast radius (smallest first). Recommendation
is **Proposal B**.

---

## Proposal A — In-place async-fs migration of `auth/store.ts` with explicit atomic-write helper

### Scope

Rewrite [src/auth/store.ts](../../../../src/auth/store.ts) to use
`node:fs/promises`. Every exported function becomes `async`. The
public barrel in [src/auth/index.ts](../../../../src/auth/index.ts#L1)
re-exports the new async signatures.

Atomic write is implemented inline (not via `writeDoc` from
`store/documents.ts`) because we need to pass an explicit `mode: 0o600`
on tmp-file creation — `writeDoc` does not expose that knob and adding
it for one caller couples the generic helper to a secret-handling
concern.

### Files touched

- [src/auth/store.ts](../../../../src/auth/store.ts) — full rewrite.
  - Drop the `node:fs` import entirely. Use
    `node:fs/promises` (`readFile`, `rename`, `open`, `mkdir`) only.
  - New private helper `writeProfilesAtomically(store)`:
    1. `await mkdir(saivageDir(), { recursive: true })`.
    2. `const tmp = \`${fp}.${process.pid}.${Date.now()}.tmp\``.
    3. `const handle = await open(tmp, "w", 0o600)` — mode is set at
       creation so we never need `chmod` again.
    4. `await handle.writeFile(JSON.stringify(store, null, 2) + "\n", "utf-8")`.
    5. `try { await handle.sync(); } catch { /* tmpfs / Windows */ }`.
    6. `await handle.close()`.
    7. `await rename(tmp, fp)`.
    8. parent-dir fsync (same try/finally pattern as
       [src/store/documents.ts](../../../../src/store/documents.ts#L95-L102)).
  - `loadProfiles` becomes `async`; uses `readFile(fp, "utf-8")`
    inside `try/catch (ENOENT)` instead of `existsSync` + `readFileSync`.
  - `saveProfiles`, `saveProfile`, `getProfileByKey`,
    `hasOAuthCredentials`, `hasOAuthProfile`, `getOAuthApiKey` all
    become `async`.
- [src/auth/index.ts](../../../../src/auth/index.ts#L1) — re-export
  list unchanged at source level; consumers see new async signatures.
- [src/providers/router.ts](../../../../src/providers/router.ts):
  - L184 `getProfileByKey(...)` → `await getProfileByKey(...)`. Already
    inside `async resolveApiKey`.
  - L737/L739/L743 `hasOAuthCredentials(...)` inside the sync method
    `shouldRegisterProvider`. Two equivalent options; we pick **(b)**:
    - (a) Wrap `shouldRegisterProvider` and `initProviders` as `async`;
      replace `new ModelRouter(config)` with a static
      `async create(config): Promise<ModelRouter>` factory.
    - (b) Keep the constructor pure (assigns fields only); move
      provider registration into a new
      `async init(): Promise<void>` method called once from bootstrap
      and from each CLI command that constructs a router. This matches
      the F22 pattern used for `PlanService` ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L68)).

    We pick (b). Adds three lines:
    `async init(): Promise<void> { await this.initProviders(this.config); … }`.
    The constructor stops calling `initProviders`. The four equivalence-
    index computations stay in `init()` because they depend on
    `this.providers`.
- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L139):
  `const router = new ModelRouter(config); await router.init();`.
- [src/server/cli.ts](../../../../src/server/cli.ts):
  - L290 (`models` command): `const router = new ModelRouter(config); await router.init();`.
  - L417 (`login`): `getOAuthProvider` is unchanged (provider-registry
    is sync). `saveProfile(profileKey, { … })` → `await saveProfile(...)`.
  - L505 (`logout`): `const store = await loadProfiles();`.
  - L532-L539 (`logout` tail): delete the inline
    `writeFileSync(fp, JSON.stringify(store, …))` and the
    `const { writeFileSync } = await import("node:fs");` import; replace
    with `await saveProfiles(store);` re-imported from `auth/index.js`.
- [src/auth/store.test.ts](../../../../src/auth/store.test.ts) —
  add `await`; switch to `async () => { … }` for the `it("writes
  auth-profiles.json with owner-only mode", …)` body.
- [src/providers/router.test.ts](../../../../src/providers/router.test.ts),
  [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts),
  [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts) —
  every `new ModelRouter(makeConfig(...))` site (17 occurrences) becomes
  `const router = new ModelRouter(makeConfig(...)); await router.init();`.

### Deletion list

- `import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs"`
  at [src/auth/store.ts](../../../../src/auth/store.ts#L8).
- The `chmodSync(fp, 0o600)` repair call at
  [src/auth/store.ts](../../../../src/auth/store.ts#L68) and the
  surrounding try/catch.
- The comment block at
  [src/auth/store.ts](../../../../src/auth/store.ts#L62-L65) about
  `writeFileSync` mode quirks.
- The inline `writeFileSync` at
  [src/server/cli.ts](../../../../src/server/cli.ts#L537) and its
  dynamic `await import("node:fs")` at L503.

### Public API impact

- Every exported function in `auth/store.ts` returns `Promise<T>`.
- `ModelRouter` gains `init(): Promise<void>`. Construction is
  two-phase (`new …; await router.init()`).
- No new API in `auth/store.ts`; `getOAuthApiKey` already returned a
  `Promise`, the others now match.

### Test impact

- `store.test.ts`: one `await` cascade.
- Three router test files: ~17 sites add `await router.init()`.
- No new tests required for Proposal A — atomicity-on-crash is hard to
  unit-test deterministically; the tmp+rename pattern is already
  validated by the F22 documents-store coverage.

### What it does NOT solve

- The concurrent-writer race in
  [Analysis §4 point 3](01-analysis-r1.md#4-secret-handling-constraints).
  Two `saveProfile(...)` calls in flight at the same time still issue
  two independent `loadProfiles` reads, two independent mutated maps,
  and two independent renames — the second rename wins and the first
  writer's profile is lost. Atomic rename only guarantees per-file
  integrity, not last-writer-wins on the JSON content.
- The per-call disk hit on `resolveApiKey` (every router send still
  triggers a `loadProfiles` from disk). The original finding's
  remediation bullet asked for an in-memory cache invalidated on mtime
  change; Proposal A leaves that on the table.

### Recommendation note

A is the minimum fix that closes the literal F22 regression. It does
not solve the two non-trivial correctness properties the issue file
flags (atomic-write integrity is solved; concurrent-writer loss is
not). Accept A only if we are prepared to land Proposal B's secret-
store work as a follow-up finding; otherwise B is the right shape.

---

## Proposal B — Centralize secret-bearing IO in a `SecretStore` facade (RECOMMENDED)

### Scope

Replace the module-level free functions with a single class
`SecretStore` that owns `auth-profiles.json` exclusively. Every
secret-bearing read or write in the codebase goes through one
instance per project root. The instance:

1. Holds an in-memory cache of the parsed `AuthProfileStore`,
   populated on first load and write-through on every mutation. No
   mtime poll; the singleton is the only writer in-process, and we
   guard against the rare CLI-vs-daemon cross-process race via
   `flock` (see §Risk).
2. Serializes concurrent writes from the same process via an internal
   mutex (a one-deep promise chain — `this.writeQueue = this.writeQueue.then(next)`).
   This eliminates the read-modify-write loss between background
   token refresh and interactive `login`.
3. Writes atomically via the same tmp + `open(…, "w", 0o600)` +
   `handle.sync` + `rename` + parent-dir-fsync pattern proposed in A,
   so file integrity and mode are both correct on every write.
4. Acquires a POSIX advisory lock (`flock(LOCK_EX)`) on
   `auth-profiles.json.lock` for the duration of each write, so a
   `saivage login` invoked from the operator's shell against the same
   project root as a running daemon cannot interleave with the
   daemon's background refresh. On Windows we degrade to "in-process
   mutex only" with a one-line warning, matching how
   [src/store/documents.ts](../../../../src/store/documents.ts#L95-L102)
   already handles platform fsync differences.

### Files touched

- **New** `src/auth/secret-store.ts` (~180 lines):

  ```ts
  export class SecretStore {
    static forProject(saivageDir: string): SecretStore;
    init(): Promise<void>;                     // first load
    getProfile(key: string): Promise<AuthProfile | null>;
    listProfiles(): Promise<Record<string, AuthProfile>>;
    setProfile(key: string, profile: AuthProfile): Promise<void>;
    removeProfile(key: string): Promise<boolean>;
    removeProfilesFor(providerId: string): Promise<number>;
    clearAll(): Promise<number>;
    hasAnyForProvider(providerId: string): Promise<boolean>;
    resolveApiKey(providerId: string, options: ResolveOpts, registry: OAuthProviderRegistry): Promise<string | null>;
  }
  ```

  The `resolveApiKey` method absorbs the refresh-aware logic currently
  in `getOAuthApiKey`. The provider registry (`openaiCodexOAuthProvider`
  etc.) is injected so the secret-store has no static dependency on
  the OAuth driver files.

- [src/auth/store.ts](../../../../src/auth/store.ts) — DELETE the
  free functions `loadProfiles`, `saveProfiles`, `saveProfile`,
  `getProfileByKey`, `hasOAuthCredentials`, `hasOAuthProfile`,
  `getOAuthApiKey`. Keep only the provider registry helpers
  `getOAuthProvider`, `getOAuthProviders` (those have no fs at all).
  Net file shrinks from ~150 lines to ~30.

- [src/auth/index.ts](../../../../src/auth/index.ts#L1) — re-export
  `SecretStore` and the two registry helpers; delete the six
  free-function re-exports.

- [src/providers/router.ts](../../../../src/providers/router.ts):
  - Constructor signature changes:
    `new ModelRouter(config, secretStore: SecretStore)`.
  - L18 import becomes
    `import type { SecretStore } from "../auth/index.js";`. The three
    free-function imports are deleted.
  - `resolveApiKey` (L170-L200): calls
    `this.secretStore.resolveApiKey(oauthId, …)` and
    `this.secretStore.getProfile(options.authProfileKey)`.
  - `shouldRegisterProvider` (L730-L745) becomes `async` and calls
    `await this.secretStore.hasAnyForProvider("github-copilot")` etc.
    Cascades into `initProviders` becoming `async`. The constructor
    stays pure; an `init()` method is added (same pattern as
    Proposal A). The cache inside `SecretStore` means
    `hasAnyForProvider` is a `Promise<boolean>` that resolves
    synchronously after the first `init()` — no per-call disk hit.

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L139):

  ```ts
  const secretStore = SecretStore.forProject(project.saivageDir);
  await secretStore.init();
  const router = new ModelRouter(config, secretStore);
  await router.init();
  ```

- [src/server/cli.ts](../../../../src/server/cli.ts):
  - L290 (`models` command): construct `SecretStore` then router.
  - L404-L490 (`login`): replace `saveProfile(profileKey, …)` with
    `await SecretStore.forProject(saivageDir()).setProfile(profileKey, …)`.
  - L492-L539 (`logout`): use
    `await store.removeProfile(key)` /
    `await store.removeProfilesFor(providerId)` /
    `await store.clearAll()`. The inline `writeFileSync` at L537
    disappears completely — there is no fs import in the action
    anymore.

- [src/auth/store.test.ts](../../../../src/auth/store.test.ts) →
  RENAMED to [src/auth/secret-store.test.ts] and rewritten. Existing
  "writes auth-profiles.json with owner-only mode" assertion is kept;
  new tests added for:
  - concurrent `setProfile` of different keys collapses to one final
    file containing both;
  - concurrent `setProfile` of the same key is serialized — last call
    wins, no torn writes;
  - `removeProfile` of a nonexistent key returns `false` without
    rewriting the file.

- [src/providers/router.test.ts](../../../../src/providers/router.test.ts),
  [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts),
  [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts) —
  every `new ModelRouter(makeConfig(...))` site adds an injected
  `SecretStore` (either a real one against a `mkdtemp` directory, or
  a `makeFakeSecretStore()` helper that the test file defines once).

### Deletion list

- Six free functions in
  [src/auth/store.ts](../../../../src/auth/store.ts) (`loadProfiles`,
  `saveProfiles`, `saveProfile`, `getProfileByKey`,
  `hasOAuthCredentials`, `hasOAuthProfile`, `getOAuthApiKey`).
- Their six re-exports from
  [src/auth/index.ts](../../../../src/auth/index.ts#L1).
- The bare `writeFileSync(fp, …)` at
  [src/server/cli.ts](../../../../src/server/cli.ts#L537) and its
  `await import("node:fs")`.
- The `chmodSync` repair, mode comment, and `existsSync` import use
  enumerated under Proposal A.
- The `PROVIDER_TO_OAUTH` map in
  [src/providers/router.ts](../../../../src/providers/router.ts#L62-L67)
  moves into `secret-store.ts` (it is now data the `SecretStore` needs
  to bridge Saivage provider names to OAuth driver ids). The router
  loses the import.

### Public API impact

- New: `SecretStore` class (the only public secret-handling type).
- Removed: six free functions in the auth barrel.
- Changed: `ModelRouter` constructor takes a second arg `secretStore:
  SecretStore` and the `init(): Promise<void>` method is added.

### Test impact

- `store.test.ts` → rewritten as `secret-store.test.ts` (~3 new tests:
  concurrent set, mode preservation, missing-file load).
- Router tests: one helper `makeFakeSecretStore()` shared across the
  three router test files; ~20 sites updated.
- New test: `secret-store-concurrency.test.ts` exercises two
  concurrent `setProfile` calls and asserts both updates survive
  (regression coverage for the read-modify-write race).

### Risk

1. **`flock` cross-process exclusivity.** Node has no first-class
   `flock` binding; we use `fs/promises.open(lockPath, "wx")` with an
   exponential-backoff retry. This is "advisory" and a malicious
   second process can still bypass it — fine, the lock is for
   cooperating processes only (operator's `saivage login` vs
   daemon's background refresh).
2. **Singleton lifecycle.** The `forProject` cache is keyed by
   absolute `saivageDir`. Two different projects in the same process
   (currently never happens, but the CLI's `inspect` subcommand has
   loaded multiple roots in the past) keep separate instances. No
   global mutable state.
3. **Test fakes can drift from real `SecretStore`.** Mitigated by
   exporting an `InMemorySecretStore` from `auth/secret-store.ts`
   alongside the real class, used by all router tests. One source of
   truth for the fake.
4. **Wider blast.** Proposal B touches more files than A
   (`secret-store.ts` is new, router constructor signature changes,
   three test files add a fixture). All changes are mechanical and
   `tsc` catches missed call sites — there is no `any` cast on the
   path.

### What it enables

- A single chokepoint for every future secret-bearing file: API key
  exports, MCP service tokens, anything else. New secret-bearing IO
  must use `SecretStore.forProject(...)` — enforce via a CI grep that
  bans `node:fs` imports in any file matching `auth-profiles.json` /
  `secrets` / `tokens` substrings.
- Round-2 [G37](../G37-config-sync-fs-and-stale-cache.md) can adopt
  the same `LockedJsonFile<T>` primitive (extracted from inside
  `SecretStore`) for `loadConfig` if it ends up with the same
  invalidation requirement. We don't extract it now (YAGNI — one
  caller); if G37 lands the same shape we factor it out then.
- Concurrent-writer loss disappears as a correctness property of the
  type, not as a discipline operators have to follow.

### What it forbids

- Any module other than `secret-store.ts` reading or writing
  `auth-profiles.json` via `node:fs`. Enforced by removing the free
  functions and by the CI grep.

### Recommendation note

B solves both atomicity *and* concurrent-writer loss. Its extra cost
over A is ~180 new lines (`secret-store.ts`) + one constructor-signature
change on `ModelRouter`. The constructor change is mechanical; the
180 lines are mostly the file-locking and mutex plumbing that the
issue file's "atomic-write requirement is hard" note already implied
we owe.

---

## Recommendation

**Proposal B.** The finding explicitly calls out two failure modes
that Proposal A leaves on the table — non-atomic writes risking a
provider lockout, and concurrent refresh racing chat-turn-triggered
writes. The project guideline of architecture-first / no backward
compat means we should not land A and then immediately need to repeat
the migration through a new SecretStore in a follow-up; doing it once,
with the chokepoint type that absorbs the race fix, is the
architecturally correct shape.

**Ordering vs siblings:**
- G36 (this) lands first; defines `SecretStore`.
- G37 (config) can reuse the inner `LockedJsonFile` primitive if its
  own design needs the same write-through cache + mtime
  invalidation; if G37 follows B's shape we factor the primitive out
  at that point.
- G06 (`runtime/stash.ts`) and G30 (`mcp/builtins.ts`) are independent
  modules; they share only the lint rule (`node:fs` forbidden outside
  an allow-list) which we land alongside G36 — once `auth/store.ts`
  itself is on `fs/promises`, the allow-list contains only
  `runtime/recovery.ts` (lock-file `openSync("wx")`, justified
  round-1) and the test fixtures.
