# G36 — Plan r1

**Finding**: [../G36-auth-store-sync-fs.md](../G36-auth-store-sync-fs.md)
**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)
**Design**: [02-design-r1.md](02-design-r1.md) — Proposal B (recommended)

## Sequenced steps

1. **Create the SecretStore module.**
   Add new file `src/auth/secret-store.ts` with:
   - `class SecretStore` (single per `saivageDir`, cached via
     `private static instances = new Map<string, SecretStore>()`,
     accessed through `SecretStore.forProject(saivageDir)`).
   - `private cache: AuthProfileStore | null = null` (set on `init()`,
     write-through on every mutation).
   - `private writeQueue: Promise<void> = Promise.resolve()` for
     in-process serialization.
   - `private async withLock<T>(fn: () => Promise<T>): Promise<T>` —
     acquires `auth-profiles.json.lock` via
     `open(lockPath, "wx")` with exponential backoff (10 ms × 1.5,
     cap 1 s, total 10 s); releases via `unlink`. Process-exit handler
     unlinks the lock if held.
   - `private async writeAtomic(store: AuthProfileStore): Promise<void>`:
     `open(tmp, "w", 0o600)` → `writeFile(payload)` → `handle.sync()` →
     `handle.close()` → `rename(tmp, fp)` → parent-dir-fsync (mirrors
     [src/store/documents.ts](../../../../src/store/documents.ts#L83-L102)).
   - Public methods exactly as listed in
     [02-design-r1.md §Proposal B Files touched](02-design-r1.md#files-touched).
   - Also export `class InMemorySecretStore implements SecretStoreLike`
     for tests (no-op `init`, in-process map, no fs at all).
   - Move the `PROVIDER_TO_OAUTH` map from
     [src/providers/router.ts](../../../../src/providers/router.ts#L62-L67)
     into this file as a private constant used by `resolveApiKey`.

2. **Shrink `src/auth/store.ts`.**
   Delete `loadProfiles`, `saveProfiles`, `saveProfile`,
   `getProfileByKey`, `hasOAuthCredentials`, `hasOAuthProfile`,
   `getOAuthApiKey`, and the `readFileSync` / `writeFileSync` /
   `existsSync` / `chmodSync` import. Keep only `providers` map,
   `getOAuthProvider`, `getOAuthProviders`, and `storePath()` (the
   path helper moves into `secret-store.ts`; we delete it from
   `store.ts`). Final `store.ts` is the OAuth provider registry only.

3. **Update the auth barrel.**
   In [src/auth/index.ts](../../../../src/auth/index.ts#L1):
   ```ts
   export { getOAuthProvider, getOAuthProviders } from "./store.js";
   export { SecretStore, InMemorySecretStore } from "./secret-store.js";
   export type { SecretStoreLike } from "./secret-store.js";
   export type { OAuthProviderDef, OAuthCredentials, OAuthLoginCallbacks, AuthProfile, AuthProfileStore } from "./types.js";
   ```
   Delete the `loadProfiles, saveProfile, getProfileByKey,
   hasOAuthCredentials, hasOAuthProfile, getOAuthApiKey` re-exports.

4. **Switch the router to inject `SecretStore`.**
   In [src/providers/router.ts](../../../../src/providers/router.ts):
   - Drop the three free-function imports at L18; add
     `import type { SecretStoreLike } from "../auth/index.js";`.
   - Add `private secretStore: SecretStoreLike` field.
   - Constructor signature: `constructor(config: SaivageConfig, secretStore: SecretStoreLike)`.
     Constructor body assigns fields only; provider registration moves
     to a new `async init(): Promise<void>` method that calls
     `await this.initProvidersAsync(this.config)` and then
     `this.discoverModelEquivalents()` / `mergeEquivalenceIndexes(...)`.
   - `initProvidersAsync` is the body of today's `initProviders` with
     `shouldRegisterProvider` awaited.
   - `shouldRegisterProvider` becomes `async`, awaits
     `this.secretStore.hasAnyForProvider("github-copilot")` etc.
   - `resolveApiKey` calls `await this.secretStore.getProfile(...)` and
     `await this.secretStore.resolveApiKey(oauthId, …, this.providerRegistry)`
     (where `providerRegistry` is just `getOAuthProvider`/`getOAuthProviders`
     passed by reference).
   - Delete `PROVIDER_TO_OAUTH` at L62-L67 (moved in step 1).

5. **Wire the bootstrap.**
   In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L139):
   ```ts
   const secretStore = SecretStore.forProject(project.saivageDir);
   await secretStore.init();
   const router = new ModelRouter(config, secretStore);
   await router.init();
   await router.inspectUsageAtStartup();
   ```
   Add `import { SecretStore } from "../auth/index.js";`.

6. **Update CLI subcommands.**
   In [src/server/cli.ts](../../../../src/server/cli.ts):
   - L290 (`models`): same `SecretStore.forProject` + `router.init()`
     wiring as bootstrap.
   - L404 (`login`): replace
     `const { getOAuthProvider, saveProfile, loadProfiles } = await import("../auth/index.js");`
     with
     `const { getOAuthProvider, SecretStore } = await import("../auth/index.js");`.
     L464 `saveProfile(profileKey, { … })` →
     `const secretStore = SecretStore.forProject(saivageDir()); await secretStore.setProfile(profileKey, { … });`.
   - L492-L539 (`logout`): drop the `await import("node:fs")` at L503,
     drop the `writeFileSync` at L537 and the `await import("../config.js")`
     at L535-L536 that pulls in `saivageDir`. Rewrite the action body to
     use a single `SecretStore`:
     ```ts
     const secretStore = SecretStore.forProject(saivageDir());
     const store = await secretStore.listProfiles();
     if (profileKey) {
       const removed = await secretStore.removeProfile(profileKey);
       if (!removed) { console.log(`No credentials found for profile ${profileKey}.`); return; }
       console.log(`Removed credential profile ${profileKey}.`);
     } else if (providerId) {
       const n = await secretStore.removeProfilesFor(providerId);
       if (n === 0) { console.log(`No credentials found for ${providerId}.`); return; }
       console.log(`Removed ${n} credential(s) for ${providerId}.`);
     } else {
       const n = await secretStore.clearAll();
       if (n === 0) { console.log("No stored credentials."); return; }
       console.log(`Removed all ${n} credential(s).`);
     }
     console.log("Restart the service to apply changes.");
     ```

7. **Rewrite the auth store test.**
   Rename
   [src/auth/store.test.ts](../../../../src/auth/store.test.ts) →
   `src/auth/secret-store.test.ts`. Cases:
   - existing "writes auth-profiles.json with owner-only mode" stays;
     converted to `async () => { … }`.
   - new "rejects torn writes": kill the tmp file mid-write (mock
     `handle.sync` to throw) and assert `auth-profiles.json` is
     unchanged.
   - new "serializes concurrent setProfile of distinct keys": fire two
     `setProfile` calls in parallel, await both, assert both keys
     present in the on-disk file.
   - new "serializes concurrent setProfile of the same key": fire two
     `setProfile` calls in parallel with different values, await both,
     assert exactly one wins and the file is well-formed JSON (no
     interleave).
   - new "loadProfiles returns empty store on missing file": no file
     present, `listProfiles()` returns `{}`.
   - new "cross-process advisory lock retried": create the lock file
     manually, start `setProfile`, then `unlink` the lock after 50 ms,
     assert the call eventually completes.

8. **Update router test fixtures.**
   In [src/providers/router.test.ts](../../../../src/providers/router.test.ts),
   [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts),
   [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts) —
   add (or share via a `tests/_helpers/secret-store-fixture.ts`)
   ```ts
   const secretStore = new InMemorySecretStore();
   const router = new ModelRouter(makeConfig({...}), secretStore);
   await router.init();
   ```
   The existing L464 fixture in `router.test.ts` that seeds an
   `auth-profiles.json` directly via fs becomes
   `await secretStore.setProfile("github-copilot.default", { … })` —
   no fs in the test.

9. **Add the lint rule.**
   In `eslint.config.js`, add a `no-restricted-imports` rule for
   `node:fs` scoped to `src/auth/**` (allow `node:fs/promises` only).
   This matches the round-1 F22 enforcement style and locks in the
   "no sync fs in auth/" invariant.

10. **Build + typecheck + tests.**
    ```
    cd /home/salva/g/ml/saivage
    npx tsc --noEmit
    npx vitest run src/auth src/providers src/server
    npm run build
    ```
    Targeted suites first to surface missed `await`s; full suite at
    the end.

## Validation

- `npx tsc --noEmit` clean — TypeScript catches every missed `await`
  because the auth methods now return `Promise<T>` and the router
  constructor takes a new required argument.
- `npx vitest run src/auth/secret-store.test.ts` — all six cases pass,
  including the two concurrency cases.
- `npx vitest run src/providers` — router/copilot/model-capabilities
  suites pass with `InMemorySecretStore`.
- `grep -RE "readFileSync|writeFileSync|chmodSync|existsSync" saivage/src/auth/` —
  empty. The lint rule from step 9 enforces this in CI.
- `grep -RE "auth-profiles\.json" saivage/src/ | grep -v test` — only
  hits `src/auth/secret-store.ts` (the path helper) and
  `src/server/server.ts:351` (the `HIDDEN_FILES` set, intentional).
- Manual probe on a live daemon after deploy (see Rollback for the
  per-container procedure):
  ```bash
  ssh root@10.0.3.113 'curl -fsS http://127.0.0.1:8080/health'
  ssh root@10.0.3.113 'journalctl -u saivage.service --since "5 minutes ago" | grep -i "Refreshing OAuth"'
  ```
  Expected: `/health` returns 200; OAuth refresh log lines look
  unchanged in shape; no `EACCES` / `ENOENT` / `Unexpected end of JSON`
  errors after a deliberate test refresh.
- Concurrent-writer regression check on a scratch container: run two
  `saivage login --provider anthropic --profile a` /
  `saivage login --provider anthropic --profile b` invocations in
  parallel against the same `.saivage/` and confirm both profiles
  exist in `auth-profiles.json` after both complete.

## Rollback

NO `git reset --hard`. Three daemons hold this file open via long-
running processes:

- `saivage` (10.0.3.111) — old v2 on GetRich.
- `diedrico` (10.0.3.113) — v2 harness on `/work/diedrico`.
- `saivage-v3` (10.0.3.112) — v2 harness on `/work/saivage-v3`.

Each runs `node dist/cli.js serve <project>` as a systemd unit; killing
the process mid-write *with the current sync code* would risk
truncating `auth-profiles.json`. The Proposal B atomic-write path
makes interruption safe, but rollback to pre-G36 code re-introduces
the truncation hazard until the daemon is stopped.

### Procedure

1. Land the change on a feature branch; do not merge to main until
   step 4 succeeds on `diedrico` (lowest blast radius — no live
   GetRich work).
2. Deploy to **diedrico first**:
   ```
   ssh root@10.0.3.113 'systemctl stop saivage.service'
   # build artifact already bind-mounted from host /home/salva/g/ml/saivage
   ssh root@10.0.3.113 'systemctl start saivage.service'
   ssh root@10.0.3.113 'systemctl status saivage.service --no-pager'
   curl -fsS http://10.0.3.113:8080/health
   ```
   Soak ≥10 minutes; tail `journalctl -u saivage.service -f` for
   `Refreshing OAuth` events; manually trigger a chat turn that
   forces a token refresh (any expired profile).
3. If diedrico is healthy, deploy to **saivage-v3** next (v2 harness,
   no production user traffic), same procedure against 10.0.3.112.
4. If saivage-v3 is healthy, deploy to **saivage** (10.0.3.111) last.
5. **On regression**: do NOT `git reset --hard`. Instead:
   ```
   git revert <merge-commit> -m 1
   git push
   ```
   Then re-run the deploy procedure in the same order
   (diedrico → saivage-v3 → saivage). Before restarting each daemon,
   `cp -a <project>/.saivage/auth-profiles.json <project>/.saivage/auth-profiles.json.preG36-bak`
   so we have a known-good snapshot of the file's contents (the
   operator does not view the file; the copy is owner-only and stays
   on the container). On revert success, delete the `.preG36-bak`
   copies.
6. If the regression is the `flock` cross-process lock (step 1
   risk), the daemon will log
   `[secret-store] could not acquire lock for ${path}: timeout` and
   refuse the write — in that case manually
   `rm <project>/.saivage/auth-profiles.json.lock` on the affected
   container; the next call recovers.

## Cross-finding coordination

- **G06** ([../G06-stash-uses-sync-fs.md](../G06-stash-uses-sync-fs.md)) —
  independent module (`runtime/stash.ts`). G06's plan can land in
  parallel with G36 — no shared files. Both findings should land
  together with the lint rule (`no-restricted-imports node:fs` in
  `src/runtime/` and `src/auth/`) so the F22 regression class cannot
  reappear in either subsystem.
- **G30** ([../G30-builtins-filesystem-sync-fs.md](../G30-builtins-filesystem-sync-fs.md)) —
  independent module (`mcp/builtins.ts`). Same as G06; shares the
  lint rule but no files. Land in parallel.
- **G37** ([../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md)) —
  `config.ts`. G37 will likely want a write-through cache + mtime
  invalidation + atomic write — the same shape as `SecretStore`'s
  private helpers. **Do not pre-emptively extract** a `LockedJsonFile`
  primitive from `SecretStore` as part of G36; wait until G37's
  design lands and confirms the shape. If G37 picks the same shape,
  extract at that time. (YAGNI: one caller does not justify the
  generic.)
- **F22 round-1** — Proposal B preserves F22's atomic-rename pattern
  verbatim for the on-disk write; the difference is the explicit
  `mode: 0o600` on tmp-file creation (`writeDoc` does not expose this)
  and the in-process write-queue. No `documents.ts` changes.
