# G36 — Design r3

**Finding**: [../G36-auth-store-sync-fs.md](../G36-auth-store-sync-fs.md)
**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)
**Round references**: [02-design-r2.md](02-design-r2.md), [04-review-r2.md](04-review-r2.md)
**Approved-precedent reference**: [../../review-2026-05/F22/02-design-r2.md](../../review-2026-05/F22/02-design-r2.md) (Proposal A landed for `store/documents.ts`)

## Round 3 deltas

Reviewer r2 ([04-review-r2.md](04-review-r2.md)) accepted Proposal A
and every r1-required change; the only remaining issue is the
execution path for the cross-process concurrency tests. R2's design
("`child_process.fork` against
`src/auth/__fixtures__/concurrent-writer.ts`, compiled by `tsc` into
`dist/`") does not match the actual build:
[tsup.config.ts](../../../../tsup.config.ts#L4-L9) has a single entry
and emits only `dist/cli.js`. R3 keeps the same Proposal A shape and
the same test cases, but pins the fork-execution path to **`tsx`**
([package.json](../../../../package.json#L47), already a dev dep) so
no build step is required and no new tsup entries are needed.

Two concrete edits versus design r2:

- **Test impact, case 2 & 3** (`Cross-process concurrent write`):
  fork target is the `.ts` source file
  `src/auth/__fixtures__/concurrent-writer.ts`, invoked via
  `child_process.fork(fixturePath, [], { execArgv: ["--import", "tsx"] })`.
  No `dist/` artefact is involved, no `__fixtures__` carve-out is
  needed in `tsup.config.ts`, no per-test `tsc` step is added.
- **Risk #2** (cross-process tests rely on `child_process.fork`):
  unchanged in shape; the runtime path is `tsx` via `--import`, which
  vitest already uses for its own test-file loading, so the dev-tool
  surface does not grow.

The remainder of the design — file-level changes, lock protocol,
deletions, public API impact, the other six test cases, the
coordination story — is identical to r2.

---

## Direction (unchanged from r2)

Proposal A: keep free functions, migrate them to `node:fs/promises`,
add **one** explicit `mutateProfiles(fn)` helper that does locked
read-modify-write. No cache, no class, no `SecretStoreLike` interface
in production code. The previous Proposal B (`SecretStore` class with
in-memory cache) was dropped in r2 because the cache reintroduced the
lost-update race.

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
async function writeProfilesAtomically(store: AuthProfileStore): Promise<void>;

async function withProfilesLock<T>(fn: () => Promise<T>): Promise<T>;

async function mutateProfiles(
  fn: (current: AuthProfileStore) => AuthProfileStore | Promise<AuthProfileStore>,
): Promise<void>;
```

Semantics:

- `writeProfilesAtomically` — tmp file created with mode `0o600` so no
  chmod is ever needed; rename gives all-or-nothing replacement;
  parent-dir fsync flushes the rename entry. Mirrors F22.
- `withProfilesLock` — cross-process lock via lockfile (analysis r3
  §5).
- `mutateProfiles` — the chokepoint. Acquires the lock, **reloads
  profiles from disk inside the critical section**, hands them to
  `fn`, writes the returned store atomically, releases the lock.

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
    production code.
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
  - **New** `removeProfiles(predicate: (key, profile) => boolean): Promise<number>` —
    one helper used by CLI `logout` for all three modes (single key,
    by provider, all). Returns the number of entries removed.
- [src/auth/index.ts](../../../../src/auth/index.ts) — re-export list
  gains `removeProfiles`; everything else stays.
- [src/providers/router.ts](../../../../src/providers/router.ts):
  - L184 `getProfileByKey(...)` → `await getProfileByKey(...)`.
  - L730-L745 `hasOAuthCredentials(...)` inside the sync method
    `shouldRegisterProvider`. Becomes `async`. Cascades into
    `initProviders` becoming `async`. The constructor stops calling
    `initProviders`; new `async init(): Promise<void>` method is
    added (same pattern as `PlanService` at
    [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L68)).
    Equivalence-index computations move into `init()` because they
    depend on `this.providers`.
- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L139):
  `const router = new ModelRouter(config); await router.init();`.
- [src/server/cli.ts](../../../../src/server/cli.ts):
  - L290 (`models`): `new ModelRouter(config); await router.init();`.
  - L404 (`login` import line): `saveProfile, loadProfiles` stay.
  - L464 (`login`): `await saveProfile(profileKey, { … })`.
  - L492-L539 (`logout`): drop the `await import("node:fs")` and the
    inline `writeFileSync`. Rewrite to call `removeProfiles` for all
    three modes (single key, by provider, all). The CLI never touches
    `node:fs` against the secret file again.
- [src/auth/store.test.ts](../../../../src/auth/store.test.ts) —
  rewrites per the test-impact list below. Filename stays.
- New file [src/auth/__fixtures__/concurrent-writer.ts](../../../../src/auth/__fixtures__/concurrent-writer.ts) —
  fork target for test cases 2 & 3. Source-only TypeScript file;
  executed by the child via `tsx` (see Test impact below).
- [src/providers/router.test.ts](../../../../src/providers/router.test.ts),
  [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts),
  [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts) —
  each `new ModelRouter(makeConfig(...))` site (25 occurrences total)
  becomes `…; await router.init();`. Fixture at
  [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L464)
  switches to `await saveProfile("github-copilot.default", { … })`.

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
returns `true`. Any I/O or parse error returns `false`.

`registerExitCleanup` keeps a module-level `Set<string>` of lockfiles
this process holds; on first call it installs `process.once("exit", …)`
and `process.once("SIGTERM", …)` handlers that synchronously
`fs.unlinkSync` everything in the set. The `unlinkSync` is acceptable
here — process exit is the one place sync fs is unavoidable — and is
permitted via an inline `// eslint-disable-next-line no-restricted-imports`
on the single line.

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
  No `SecretStoreLike` interface. No `InMemorySecretStore`.

### Test impact

`src/auth/store.test.ts` is rewritten end-to-end. All eight cases are
deterministic and reviewer-required.

1. **0o600 mode preserved on create and overwrite** (kept from r1;
   converted to `async () => { … }`). Asserts
   `(stat.mode & 0o777) === 0o600` after a first `saveProfile` and
   after a second `saveProfile` against the same file.
2. **Cross-process concurrent write of distinct keys (r3 path).**
   The fixture is the `.ts` source file
   `src/auth/__fixtures__/concurrent-writer.ts`. The parent preseeds
   profile `a` via `await saveProfile("a", buildProfile())`, then
   forks two children:
   ```ts
   import { fork } from "node:child_process";
   const fixture = fileURLToPath(new URL("./__fixtures__/concurrent-writer.ts", import.meta.url));
   const child = fork(fixture, [], {
     execArgv: ["--import", "tsx"],
     env: {
       ...process.env,
       SAIVAGE_PROJECT_ROOT: tmpRoot,
       SAIVAGE_TARGET_KEY: "b",
       SAIVAGE_TARGET_BODY_BASE64: Buffer.from(JSON.stringify(buildProfile()), "utf-8").toString("base64"),
     },
   });
   ```
   `await Promise.all([waitForExit(child1), waitForExit(child2)])`;
   then the parent reads via `await loadProfiles()` and asserts both
   `a` (refreshed) and `b` exist.
3. **Cross-process write of distinct keys, swapped order** — same
   shape, actors swapped. Catches order-sensitivity in lock
   acquisition.
4. **Failure injection: `writeFile` throws on tmp.** Mock
   `node:fs/promises.writeFile` to throw on the next call; preseed a
   known store; call `saveProfile`; assert the call rejects, that
   `auth-profiles.json` still contains the preseeded state (byte
   compare), and that no `*.tmp` files remain in `.saivage/`.
5. **Failure injection: `rename` throws.** Same shape — mock `rename`
   to throw; assert the original file is intact, the tmp file is
   cleaned up by the `finally` branch, and the lock is released (a
   subsequent `saveProfile` succeeds within 200 ms).
6. **Stale-lock reclaim.** Create `auth-profiles.json.lock` manually
   with JSON `{pid: 999999, hostname: os.hostname(), startedAt: 0}`.
   Call `saveProfile(...)` and assert it completes within 200 ms and
   the resulting file contains the new profile.
7. **Empty store load.** No file present, `loadProfiles()` resolves to
   `{ version: 1, profiles: {} }`.
8. **Lint-rule scope check.** Imports `scanForSyncFs` from
   [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts)
   (helper landed by G30 r2; see
   [../G30/03-plan-r2.md](../G30/03-plan-r2.md#L212-L230)) and asserts
   no `node:fs` sync API is used anywhere in `src/auth/**`.

Fixture body (the file new at
`src/auth/__fixtures__/concurrent-writer.ts`):

```ts
import { saveProfile } from "../index.js";
const key = process.env.SAIVAGE_TARGET_KEY!;
const body = JSON.parse(
  Buffer.from(process.env.SAIVAGE_TARGET_BODY_BASE64!, "base64").toString("utf-8"),
);
await saveProfile(key, body);
```

Top-level await is fine — `tsconfig.json`'s `module: "node16"` plus
`tsx`'s ESM loader both accept it. The file is `.ts` only; it is
never emitted into `dist/` because tsup has no `auth/` entry.

**Test fake guidance.** Where router tests want to exercise a known
auth state without touching disk, they `vi.mock(...)` against
`../auth/index.js` with a local structural fake. No
`InMemorySecretStore` is shipped from production.

### Risk

1. **Sync `unlinkSync` on process exit.** Mitigated by inline
   eslint-disable + a one-line comment explaining the exit-path
   justification, by keeping the set tiny (only locks this process
   holds), and by the lockfile-protocol stale-recovery story which
   means a missed unlink only delays the next writer by one
   `process.kill(pid, 0)` probe.
2. **Cross-process tests rely on `child_process.fork` via tsx.** Vitest
   already runs through `tsx`; passing `--import tsx` to the forked
   child reuses the same loader the test harness uses, so no new
   dev-time runtime is introduced. Failure modes are deterministic:
   if `tsx` ever becomes unavailable, all vitest runs fail first, so
   the tests cannot silently regress to "fixture didn't run."
3. **`init()` cascade.** 25 router-construction sites in tests +
   bootstrap + 2 CLI commands. All mechanical, all caught by `tsc`
   when `hasOAuthCredentials` becomes `Promise<boolean>`.

### What it does NOT do (deliberately)

- **No class.** No `SecretStore`, no `SecretStoreLike` interface, no
  generic `LockedJsonFile<T>` primitive.
- **No production fake.** No `InMemorySecretStore` shipped from the
  auth barrel. Tests that want to avoid disk use `vi.mock` against
  the barrel.
- **No repo-wide allow-list promise.** The lint rule scope is
  `src/auth/**` only.
- **No tsup entry for the fixture.** `tsup` keeps its single
  `src/server/cli.ts` entry; the fixture lives in `src/` for `tsc`
  type-checking but never reaches `dist/`. Forks execute it via
  `tsx` directly against the source file.

---

## Coordination

- **Lint rule (this finding).** Add a `no-restricted-imports` rule in
  `eslint.config.js` scoped exactly to `src/auth/**` (NOT repo-wide)
  forbidding `node:fs` (and bare `fs`); allow `node:fs/promises`.
- **Shared scanner.** Consume
  [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts)
  landed by [../G30/03-plan-r2.md](../G30/03-plan-r2.md#L212-L230)
  from `src/auth/store.test.ts` case 8.
- **G06 / G30 / G37.** Independent modules.
- **F22 round-1.** Proposal A preserves F22's atomic-rename pattern
  verbatim; the differences are the explicit `mode: 0o600` on
  tmp-file creation and the locked read-modify-write helper.

## Recommendation

**Proposal A.** Same as r2, with the fork-execution path pinned to
`tsx --import` so the test plan matches the actual build (which emits
only `dist/cli.js`).
