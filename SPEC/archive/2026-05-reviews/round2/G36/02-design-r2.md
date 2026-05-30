# G36 — Design r2

**Finding**: [../G36-auth-store-sync-fs.md](../G36-auth-store-sync-fs.md)
**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)
**Round-1 reference**: [../../review-2026-05/F22/02-design-r2.md](../../review-2026-05/F22/02-design-r2.md) (Proposal A landed for `store/documents.ts`)
**Reviewer feedback**: [04-review-r1.md](04-review-r1.md)

## Direction change vs r1

R1 recommended Proposal B (`SecretStore` class with in-memory cache).
The reviewer identified that the cache **still loses cross-process
writes**: lock+cache without re-read-under-lock means a stale-cache
writer commits a map that overwrites another process's already
committed mutation, exactly the bug the finding flagged. The reviewer
also called out the speculative future-secret-framework framing and an
`InMemorySecretStore` exported from the production barrel as
test-only public API.

**R2 picks Proposal A.** Smaller in-place shape: keep free functions,
migrate them to `node:fs/promises`, add **one** explicit
`mutateProfiles(fn)` helper that does locked read-modify-write. No
cache, no class, no `SecretStoreLike` interface in production code.
Tests use a local structural fake against the function-level surface
when they want to avoid disk; the helper itself is the single chokepoint
that owns the lock-and-reread protocol.

The previous Proposal B section is dropped entirely. The reviewer's
guidance to "narrow the architectural claim" makes the class shape
not just larger but also harder to reason about correctly — Proposal A
is the right answer and there is no follow-up framework work implied
by it.

---

## Proposal A — In-place async-fs migration with locked read-modify-write helper

### Scope

Rewrite [src/auth/store.ts](../../../../src/auth/store.ts) to use
`node:fs/promises`. Every exported function becomes `async`. The
public barrel in [src/auth/index.ts](../../../../src/auth/index.ts)
re-exports the new async signatures. One new private helper
(`mutateProfiles`) and one new exported mutating helper
(`removeProfiles`) absorb every multi-step "read map, mutate map,
write map" path. There is no in-memory cache; every locked critical
section reloads from disk.

### New module-level helpers

```ts
// Atomic write: tmp file is created with mode 0o600 so no chmod is
// ever needed; rename gives all-or-nothing replacement; parent-dir
// fsync flushes the rename entry. Mirrors the F22 pattern but with
// the explicit secret-mode argument.
async function writeProfilesAtomically(store: AuthProfileStore): Promise<void>;

// Cross-process lock via lockfile. See Analysis r2 §5 for the
// protocol decision (open(wx) lockfile, not flock(LOCK_EX)) and the
// stale-lock recovery story.
async function withProfilesLock<T>(fn: () => Promise<T>): Promise<T>;

// THE chokepoint. Acquires the lock, RELOADS profiles from disk
// inside the critical section, hands them to `fn`, writes the
// returned store atomically, releases the lock. Every mutating
// operation goes through this — no other writer is permitted.
async function mutateProfiles(
  fn: (current: AuthProfileStore) => AuthProfileStore | Promise<AuthProfileStore>,
): Promise<void>;
```

### Files touched

- [src/auth/store.ts](../../../../src/auth/store.ts) — full rewrite.
  - Drop the `node:fs` import. Use `node:fs/promises`
    (`readFile`, `writeFile`, `rename`, `unlink`, `open`, `mkdir`,
    `stat`) and `node:os` (`hostname`) only.
  - Add the three helpers above.
  - `loadProfiles(): Promise<AuthProfileStore>` — read-only. Uses
    `readFile(fp, "utf-8")` inside `try/catch (ENOENT → empty store,
    JSON-parse error → empty store)`. **No lock**: readers tolerate
    seeing either the pre-rename or post-rename file (rename is
    atomic), and a stale-but-valid map is harmless because every
    *write* path will reload under lock.
  - `saveProfiles(store)` — sole purpose is the 0o600-mode unit test
    assertion. Implemented as
    `await mutateProfiles(_ => store)`; it is no longer used by
    production code (callers below take the typed mutating helpers).
  - `saveProfile(key, profile)` →
    `await mutateProfiles(s => { s.profiles[key] = profile; return s; })`.
  - `getProfileByKey(key)` → still a pure read; calls
    `await loadProfiles()`.
  - `hasOAuthCredentials(providerId)`, `hasOAuthProfile(key, ?providerId)`
    → async reads; same shape.
  - `getOAuthApiKey(...)` — the refresh branch becomes
    ```ts
    const refreshed = await provider.refreshToken(profile, ...);
    await mutateProfiles((latest) => {
      const cur = latest.profiles[key];
      if (!cur) return latest;
      latest.profiles[key] = { ...cur, access: refreshed.access,
        refresh: refreshed.refresh, expires: refreshed.expires };
      return latest;
    });
    ```
    Note the reload-inside-mutateProfiles is what closes the race:
    if the CLI just committed a new profile `b`, `latest` will
    contain `b`; merging the refreshed `a` will not drop it.
  - **New** `removeProfiles(predicate: (key, profile) => boolean): Promise<number>` —
    one helper used by CLI `logout` for all three modes (single key,
    by provider, all). Returns the number of entries removed.
- [src/auth/index.ts](../../../../src/auth/index.ts) — re-export list
  gains `removeProfiles`; everything else stays.
- [src/providers/router.ts](../../../../src/providers/router.ts):
  - L184 `getProfileByKey(...)` → `await getProfileByKey(...)`. Already
    inside `async resolveApiKey`.
  - L730-L745 `hasOAuthCredentials(...)` inside the sync method
    `shouldRegisterProvider`. Becomes `async`. Cascades into
    `initProviders` becoming `async`. The constructor stops calling
    `initProviders`; new `async init(): Promise<void>` method is
    added (same pattern as `PlanService` at
    [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L68)).
    The constructor still assigns fields. Equivalence-index
    computations stay in `init()` because they depend on
    `this.providers`.
- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L139):
  `const router = new ModelRouter(config); await router.init();`.
- [src/server/cli.ts](../../../../src/server/cli.ts):
  - L290 (`models` command): `new ModelRouter(config); await router.init();`.
  - L404 (`login` import line): `saveProfile, loadProfiles` stay; no
    change beyond the `await` cascade.
  - L464 (`login`): `saveProfile(profileKey, { … })` →
    `await saveProfile(profileKey, { … })`.
  - L492-L539 (`logout`): drop the `await import("node:fs")` and the
    inline `writeFileSync`. Rewrite the body to call the new typed
    helpers — `removeProfiles((k) => k === profileKey)` for the
    `--profile` mode, `removeProfiles((_, p) => p.provider === providerId)`
    for the `--provider` mode, and `removeProfiles(() => true)` for
    the bare logout. All three use the same locked path the daemon
    uses; the CLI never touches `node:fs` against the secret file
    again.
- [src/auth/store.test.ts](../../../../src/auth/store.test.ts) — rewrites
  per the test-impact list below. **Filename stays**; we are not
  introducing a class so there is no `secret-store.test.ts`.
- [src/providers/router.test.ts](../../../../src/providers/router.test.ts),
  [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts),
  [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts) —
  each `new ModelRouter(makeConfig(...))` site (25 occurrences total
  per analysis r2 §3.5) becomes
  `const router = new ModelRouter(makeConfig(...)); await router.init();`.
  The fixture at
  [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L464)
  that seeds `auth-profiles.json` directly via fs switches to
  `await saveProfile("github-copilot.default", { … })` so the test
  exercises the locked path.

### Lock protocol (concrete)

```ts
const LOCK_NAME = "auth-profiles.json.lock";

async function withProfilesLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = saivageDir();
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, LOCK_NAME);
  const startedWaiting = Date.now();
  let delay = 10;
  let handle: FileHandle | null = null;
  while (handle === null) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (err) {
      if (!isErrnoCode(err, "EEXIST")) throw err;
      if (await tryReclaimStaleLock(lockPath)) continue;
      if (Date.now() - startedWaiting > 10_000) {
        throw new Error(`[auth] timed out acquiring ${lockPath}`);
      }
      await sleep(delay);
      delay = Math.min(Math.floor(delay * 1.5), 1_000);
    }
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: Date.now() }),
      "utf-8",
    );
    await handle.close();
    registerExitCleanup(lockPath);
    return await fn();
  } finally {
    try { await unlink(lockPath); } catch { /* already gone */ }
    unregisterExitCleanup(lockPath);
  }
}
```

`tryReclaimStaleLock(lockPath)` reads the file, parses
`{pid, hostname, startedAt}`, checks `hostname === os.hostname()`, then
calls `process.kill(pid, 0)`; on `ESRCH` it `unlink`s the lockfile and
returns `true`. Any I/O or parse error returns `false` (treat as
"owned by an active writer" and back off).

`registerExitCleanup` keeps a module-level `Set<string>` of lockfiles
this process is holding; on first call it installs
`process.once("exit", …)` and `process.once("SIGTERM", …)` handlers
that synchronously `fs.unlinkSync` everything in the set. The
`unlinkSync` is acceptable here — process exit is the one place sync
fs is unavoidable (event loop is shutting down) and the lint rule's
allow-list covers it via an inline `// eslint-disable-next-line`
on this one statement (justification in source comment).

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
  [src/server/cli.ts](../../../../src/server/cli.ts#L538) and its
  dynamic `await import("node:fs")` at L503-L505.

### Public API impact

- Every exported function in `auth/store.ts` returns `Promise<T>`.
- One new export: `removeProfiles(predicate): Promise<number>`.
- `ModelRouter` gains `init(): Promise<void>`. Construction is
  two-phase (`new …; await router.init()`).
- **No new types in the production barrel.** No `SecretStore` class.
  No `SecretStoreLike` interface. No `InMemorySecretStore`. The
  reviewer's narrowing requirement is satisfied by keeping the
  surface identical in shape to the F22 documents-store migration —
  free functions, in-place, async cascade only.

### Test impact

`src/auth/store.test.ts` is rewritten end-to-end. New cases (all
deterministic, all reviewer-required):

1. **0o600 mode preserved on create and overwrite** (kept from r1;
   converted to `async () => { … }`). Asserts `(stat.mode & 0o777) === 0o600`
   after a first `saveProfile` and after a second `saveProfile`
   against the same file.
2. **Cross-process concurrent write of distinct keys**. Use
   `child_process.fork` against a tiny in-test helper script that
   imports the production `saveProfile` and mutates one key. From the
   parent: pre-seed profile `a` via `saveProfile("a", …)`, then in
   parallel fork two children — child 1 calls `saveProfile("b", …)`,
   child 2 calls `saveProfile("a", { …refreshed })`. Wait for both
   exits, then read `auth-profiles.json` from the parent and assert
   that *both* `a` (refreshed) and `b` are present.
3. **Cross-process write of distinct keys, swapped order**. Same as
   above but with the actors swapped (mutate `a` first, then `b`).
   Catches order-sensitivity in the lock acquisition path.
4. **Failure injection: `writeFile` throws on tmp**. Mock
   `node:fs/promises.writeFile` to throw on the next call; preseed
   a known store; call `saveProfile`; assert the call rejects, that
   `auth-profiles.json` still contains the preseeded state, and that
   no `*.tmp` files remain in `.saivage/`.
5. **Failure injection: `rename` throws**. Same shape — mock
   `rename` to throw; assert the original file is intact, the tmp
   file is cleaned up by the `finally` branch, and the lock is
   released (a subsequent `saveProfile` succeeds without timing out).
6. **Stale-lock reclaim**. Create `auth-profiles.json.lock` manually
   with JSON `{pid: 999999, hostname: os.hostname(), startedAt: 0}`
   (PID guaranteed not to exist). Call `saveProfile(...)` and assert
   it completes within 200 ms (no backoff timeout) and the resulting
   file contains the new profile.
7. **Empty store load**. No file present, `loadProfiles()` resolves
   to `{ version: 1, profiles: {} }`.
8. **Lint-rule scope check**. Imports
   `scanForSyncFs` from
   [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts)
   (the helper landed by G30 r2; see
   [../G30/03-plan-r2.md](../G30/03-plan-r2.md#L212-L230))
   and asserts no `node:fs` sync API is used anywhere in `src/auth/**`.

**Dropped from r1**: the `handle.sync()`-throws torn-write test. The
reviewer correctly noted that `fsync` failure is not a torn write —
F22's accepted atomic pattern at
[src/store/documents.ts](../../../../src/store/documents.ts#L72-L79)
tolerates it and proceeds with the rename. We tolerate it the same
way; there is no behaviour worth asserting there.

**Test fake guidance.** Where router tests want to exercise a known
auth state without touching disk, they construct a structural fake
that satisfies the call surface they actually use (`saveProfile`,
`loadProfiles`, `getProfileByKey`) by `vi.mock(...)` against
`../auth/index.js`. This fake is local to each test file — there is
no `InMemorySecretStore` shipped from production.

### Risk

1. **Sync `unlinkSync` on process exit.** The exit cleanup must be
   synchronous because the event loop has already stopped accepting
   work. Mitigated by:
   - inline `// eslint-disable-next-line no-restricted-imports` on the
     single line and a one-line comment explaining the exit-path
     justification,
   - keeping the path set tiny (only lockfiles this process is
     currently holding), and
   - the lockfile-protocol stale-recovery story (analysis r2 §5) which
     means even a missed unlink only delays the next writer by one
     `process.kill(pid, 0)` probe.
2. **Cross-process tests rely on `child_process.fork`.** Vitest
   tolerates this fine; the helper script is shipped as
   `src/auth/__fixtures__/concurrent-writer.ts` (compiled by `tsc`
   into `dist/` like every other source file). The reviewer's
   alternative ("two `SecretStore` instances on the same temp dir")
   is not available in Proposal A because there is no `SecretStore`
   instance to construct twice — the only honest way to exercise the
   cross-process invariant is with two processes.
3. **`init()` cascade.** 25 router-construction sites in tests +
   bootstrap + 2 CLI commands. All mechanical, all caught by `tsc`
   when `hasOAuthCredentials` becomes `Promise<boolean>`.

### What it does NOT do (deliberately)

- **No class.** No `SecretStore`, no `SecretStoreLike` interface, no
  generic `LockedJsonFile<T>` primitive. The reviewer's narrowing
  guidance is satisfied: `auth/store.ts` stays the smallest unit
  needed for the concrete invariants. If G37 lands the same shape
  for `config.ts`, the helper can be extracted then.
- **No production fake.** No `InMemorySecretStore` shipped from the
  auth barrel. Tests that want to avoid disk use `vi.mock` against
  the barrel; a structural fake is one file's local concern.
- **No repo-wide allow-list promise.** The lint rule scope (next
  section) is `src/auth/**` only. G06/G30/G37 own their own modules
  and the shared scanner from G30 r2 is the coordination point.

---

## Coordination

- **Lint rule (this finding).** Add a `no-restricted-imports` rule in
  `eslint.config.js` scoped exactly to `src/auth/**` (NOT repo-wide)
  forbidding `node:fs` (and bare `fs`); allow `node:fs/promises`.
- **Shared scanner.** Consume
  [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts)
  landed by [../G30/03-plan-r2.md](../G30/03-plan-r2.md#L212-L230)
  from the new `src/auth/no-sync-fs.test.ts` (test case 8 above).
  This gives us a deterministic CI assertion identical in spirit to
  the lint rule, without G36 owning a duplicate scanner implementation
  and without claiming an allow-list for files outside `src/auth/**`.
- **G06 / G30 / G37.** Independent modules; each owns its own
  migration. We do NOT promise a repo-wide `node:fs` ban in this
  finding. The non-test `node:fs` imports the reviewer enumerated
  ([src/agents/base.ts](../../../../src/agents/base.ts#L7),
  [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L9),
  [src/repo-layout/contract.ts](../../../../src/repo-layout/contract.ts#L29),
  [src/knowledge/builtinWalker.ts](../../../../src/knowledge/builtinWalker.ts#L13),
  [src/knowledge/store.ts](../../../../src/knowledge/store.ts#L14-L18),
  [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L15),
  [src/runtime/recovery.ts](../../../../src/runtime/recovery.ts#L8-L13),
  [src/config.ts](../../../../src/config.ts#L2),
  [src/runtime/stash.ts](../../../../src/runtime/stash.ts#L6),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L18-L26),
  [src/auth/store.ts](../../../../src/auth/store.ts#L8))
  are owned by other findings or by deliberate sync-on-startup
  contracts; G36 does not block on them.
- **F22 round-1.** Proposal A preserves F22's atomic-rename pattern
  verbatim; the difference is the explicit `mode: 0o600` on tmp-file
  creation (`writeDoc` does not expose this) and the locked
  read-modify-write helper. No `documents.ts` changes.

## Recommendation

**Proposal A.** Smaller in-place migration with one explicit
locked-RMW helper, no cache. Closes the F22 regression for
`auth/store.ts`, preserves the 0o600 contract, and eliminates the
cross-process lost-update race via reload-under-lock — the precise
invariant the reviewer required.
