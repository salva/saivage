# G36 — Analysis r2

**Finding**: [../G36-auth-store-sync-fs.md](../G36-auth-store-sync-fs.md)
**Subsystem**: auth (with cascade into providers, server bootstrap, CLI)
**Round-2 reference**: [01-analysis-r1.md](01-analysis-r1.md), [04-review-r1.md](04-review-r1.md)
**Approved-precedent reference**: [../../review-2026-05/F22/02-design-r2.md](../../review-2026-05/F22/02-design-r2.md), [../../review-2026-05/F22/03-plan-r2.md](../../review-2026-05/F22/03-plan-r2.md)

R1 analysis is correct on the call-site enumeration. R2 only restates
what is reused as-is, fixes one line-number drift the reviewer flagged,
and re-frames the secret-handling constraints to match the change in
direction (Proposal A in design r2, not B).

## 1. What the finding says

`src/auth/store.ts` is the only secret-bearing on-disk store in the
codebase. F22 (round 1) migrated [src/store/documents.ts](../../../../src/store/documents.ts)
to `node:fs/promises` and pushed `await` through every caller. The
auth-profile store was excluded from that pass and still uses
`readFileSync` / `writeFileSync` / `existsSync` / `chmodSync` on the
chat-server hot path. The file holds OAuth refresh tokens; the writer
is not atomic; and concurrent writers (background token refresh during
a chat turn vs an interactive `saivage login` against the same
project) can clobber each other's updates via classic read-modify-write
loss.

## 2. Sync-fs call sites in `src/auth/store.ts`

All within [src/auth/store.ts](../../../../src/auth/store.ts):

- [src/auth/store.ts](../../../../src/auth/store.ts#L8) — `import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs"`.
- [src/auth/store.ts](../../../../src/auth/store.ts#L46-L57) — `loadProfiles()`:
  `existsSync(fp)` + `readFileSync(fp, "utf-8")`. Returns
  `AuthProfileStore` on every call; no in-memory cache.
- [src/auth/store.ts](../../../../src/auth/store.ts#L59-L72) — `saveProfiles(store)`:
  `writeFileSync(fp, …, { mode: 0o600 })` followed by `chmodSync(fp, 0o600)`
  to repair the mode when the file already exists. Non-atomic — a
  crash mid-write truncates `auth-profiles.json`, which locks the user
  out of every OAuth provider until they re-`login`.
- [src/auth/store.ts](../../../../src/auth/store.ts#L74-L77) — `saveProfile(key, profile)`:
  read-modify-write (`loadProfiles()` + mutate + `saveProfiles(store)`).
  No serialization around the load/store pair → concurrent refreshes
  or a `login` racing a refresh produce last-writer-wins data loss.
- [src/auth/store.ts](../../../../src/auth/store.ts#L79-L82) — `getProfileByKey(key)`:
  `loadProfiles()` on every call.
- [src/auth/store.ts](../../../../src/auth/store.ts#L92-L137) — `getOAuthApiKey(...)`:
  `loadProfiles()` at L99, `saveProfiles(store)` at L124 inside the
  refresh branch. The refresh is awaited (`await provider.refreshToken(...)`)
  but the surrounding load and persistence are sync and not serialized
  against any other writer.
- [src/auth/store.ts](../../../../src/auth/store.ts#L138-L141) — `hasOAuthCredentials(providerId)`:
  `loadProfiles()` on every call. Invoked from `ModelRouter`'s
  *constructor* (see §3) — so today the router's `new` blocks on disk.
- [src/auth/store.ts](../../../../src/auth/store.ts#L143-L147) — `hasOAuthProfile(key, ?providerId)`:
  `loadProfiles()` via `getProfileByKey`.
- [src/server/cli.ts](../../../../src/server/cli.ts#L538) — bare
  `writeFileSync(fp, JSON.stringify(store, …))` inside the `logout`
  action, bypassing the store API entirely. This is the second writer
  of `auth-profiles.json` outside `store.ts`. (R1 said L537; the
  reviewer corrected to L538 in the checkout — confirmed.)

There is no `existsSync` / `mkdirSync` / `unlinkSync` use elsewhere in
`src/auth/` other than the test-only `defaults.test.ts` and
`store.test.ts`.

## 3. Propagation surface — every caller cascades to `async`

Module-level free functions are exported through
[src/auth/index.ts](../../../../src/auth/index.ts) as the barrel
re-export `{ getOAuthApiKey, getProfileByKey, hasOAuthCredentials, hasOAuthProfile, loadProfiles, saveProfile }`.
`saveProfiles` is internal to `store.ts` but used by `store.test.ts`.

### 3.1 `src/providers/router.ts`

- [src/providers/router.ts](../../../../src/providers/router.ts#L18) — `import { getOAuthApiKey, getProfileByKey, hasOAuthCredentials } from "../auth/index.js";`.
- [src/providers/router.ts](../../../../src/providers/router.ts#L184) — `getProfileByKey(options.authProfileKey)`
  inside `resolveApiKey(...)`. `resolveApiKey` is already `async`; one
  more `await` here, no signature change.
- [src/providers/router.ts](../../../../src/providers/router.ts#L730-L745) — `shouldRegisterProvider`:
  pure sync method, calls `hasOAuthCredentials("github-copilot")` /
  `"anthropic"` / `"openai-codex"`. Invoked from
  [src/providers/router.ts](../../../../src/providers/router.ts#L91-L122)
  `initProviders(config)`, which is called from the **synchronous
  constructor** at [src/providers/router.ts](../../../../src/providers/router.ts#L88).

  Making `hasOAuthCredentials` async cascades into one of:
  - turn provider registration into an `async init()` method called
    once after `new ModelRouter(config)` from bootstrap and CLI, or
  - replace the constructor with a static `async create(config)`
    factory.

  We pick the `async init()` shape (matches `PlanService` precedent at
  [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L68)).
  Constructor stops calling `initProviders`; bootstrap and each CLI
  command that builds a router add a single `await router.init()`.

### 3.2 `src/server/bootstrap.ts`

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L139) — `const router = new ModelRouter(config);`
  becomes `const router = new ModelRouter(config); await router.init();`.
  The enclosing function is already `async`.

### 3.3 `src/server/cli.ts`

Every site below sits inside an `.action(async …)` block, so the
cascade is purely adding `await`s — no factory-on-CLI needed.

- [src/server/cli.ts](../../../../src/server/cli.ts#L290) — `models`:
  `new ModelRouter(config)` gains `await router.init()`.
- [src/server/cli.ts](../../../../src/server/cli.ts#L404) — `login`:
  imports `saveProfile, loadProfiles` from `auth/index.js`.
- [src/server/cli.ts](../../../../src/server/cli.ts#L464) —
  `saveProfile(profileKey, { … })` → `await saveProfile(...)`.
- [src/server/cli.ts](../../../../src/server/cli.ts#L492-L505) —
  `logout`: `const store = loadProfiles();` → `await loadProfiles()`.
- [src/server/cli.ts](../../../../src/server/cli.ts#L538) — the bare
  `writeFileSync(fp, JSON.stringify(store, …))` is the second writer
  of the secret file from outside `store.ts`. After this change the
  CLI calls a new locked store helper (`mutateProfiles(s => …)`),
  which serializes against every other writer and writes atomically.

### 3.4 `src/auth/store.test.ts`

- [src/auth/store.test.ts](../../../../src/auth/store.test.ts#L5) —
  imports `{ saveProfiles, loadProfiles }`; the existing 0o600 mode
  case is converted to `async () => { … }` against the new async API.
  All new concurrency and failure-injection cases live in the same
  file (we keep the `store.test.ts` filename in Proposal A — no rename).

### 3.5 `src/providers/router.test.ts` and friends

Tests construct `new ModelRouter(makeConfig(...))` directly. Confirmed
counts in this checkout (reviewer's numbers):

- [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L38-L470) — 20 sites.
- [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts#L40) — 1 site.
- [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts#L169-L221) — 4 sites.

If router construction goes async by adding `init()`, all 25 sites
gain a single `await router.init();` line — no signature change.
[src/providers/router.test.ts](../../../../src/providers/router.test.ts#L464)
seeds an `auth-profiles.json` directly via fs to set up an OAuth
fixture; in r2 that becomes
`await saveProfile("github-copilot.default", { … })` so the fixture
flows through the locked path the production code is being moved to.

## 4. Secret-handling constraints

`auth-profiles.json` stores OAuth refresh tokens issued by Anthropic,
OpenAI-Codex, and GitHub Copilot. The file is the single point at
which the daemon's ability to talk to paid LLM providers persists
across restarts. Three operational facts make the atomicity contract
hard, not soft:

1. **A truncated file = full lockout.** The current `writeFileSync`
   writes the JSON in one syscall, but on a crash between `open(O_TRUNC)`
   and `write()` the file is zero bytes long — `loadProfiles()` then
   returns `{ version: 1, profiles: {} }` (the JSON-parse `catch`
   branch), and the next `resolveApiKey` returns `null`, knocking out
   the provider for every in-flight chat. The user must re-run
   `saivage login` per provider, which requires browser-side OAuth — a
   blast much larger than the original disk hiccup.

2. **The file is mode `0o600` by contract.** The current code calls
   `writeFileSync(..., { mode: 0o600 })` *and* `chmodSync(fp, 0o600)`
   because `writeFileSync` only honours `mode` on file creation, not
   on overwrite. Any async replacement must preserve the
   "owner-readable-only" invariant on every write, including the first
   write that creates the file. The atomic tmp-file pattern from
   `store/documents.ts` uses `open(tmp, "w")` without an explicit
   mode argument; directly applying that pattern would regress the
   file mode under typical umasks. The fix is to open the tmp file
   with `open(tmp, "w", 0o600)` so the mode is set at creation and
   `chmod` is no longer needed.

3. **Concurrent-writer races are not theoretical.** Three writers can
   touch the same file simultaneously:
   - daemon background token refresh
     ([src/auth/store.ts](../../../../src/auth/store.ts#L99-L124),
     triggered during `ModelRouter.send` on the hot path),
   - operator-driven `saivage login --profile <name>` against the same
     project root, and
   - operator-driven `saivage logout [--profile|--provider]` against
     the same project root.
   Atomic rename only guarantees per-file integrity (no half-written
   bytes on disk). It does **not** prevent a stale-cache writer from
   discarding another process's already-committed mutation. Every
   mutating operation must therefore:
   1. Acquire a cross-process exclusive lock on the same path-keyed
      lockfile.
   2. **Re-read `auth-profiles.json` from disk inside that critical
      section** — never trust an in-process cache.
   3. Apply the intended mutation to the freshly read map.
   4. Write the result atomically (tmp + rename + parent-dir fsync).
   5. Release the lock.

   Re-reading inside the critical section is what design r1 missed:
   a per-instance cache made `setProfile(b)` issued by the daemon
   silently overwrite a `setProfile(a)` already committed by the CLI.
   In r2 there is **no cache**: every locked mutation reloads, so the
   only way to lose a write is for two writers to both hold the lock
   at once, which the lock itself rules out for cooperating processes.

These three constraints — torn-write integrity, mode preservation,
cross-process write serialization — are what makes a plain "swap
`Sync` for the `/promises` equivalent" insufficient. The chosen shape
is therefore the F22 pattern (free functions, in-place migration,
async cascade) plus one explicit `mutateProfiles` helper that owns the
lock-and-reread protocol.

## 5. Lock-protocol decision

Node has no first-class kernel `flock` binding in the LTS line we
target (`fs.flock` arrived in Node v22 and is still flagged in some
distributions). The chosen lock protocol is a **lockfile**, not
`flock(LOCK_EX)`:

- Acquire: `await open(lockPath, "wx", 0o600)` — `wx` means "create
  exclusive; fail with `EEXIST` if it already exists." The opened file
  handle holds the lock; we write `{pid, hostname, startedAt}` to it
  so a stale-lock check can inspect ownership.
- Wait: exponential backoff (10 ms × 1.5, cap 1 s, total ≤ 10 s) on
  `EEXIST`.
- Stale recovery (the gap r1 left open): before each retry, read the
  existing lockfile JSON. If `hostname` matches the current host and
  `process.kill(pid, 0)` throws `ESRCH`, the owning process is gone;
  `unlink(lockPath)` and retry immediately. If `hostname` differs we
  cannot prove staleness across hosts and continue to back off until
  the timeout.
- Release: `await unlink(lockPath)` in a `finally` block.
- Process-exit safety: a `process.once("exit", …)` handler unlinks
  any lockfile this process still owns, so a clean SIGTERM (the
  systemd path the three v2 daemons use) does not leave stale locks
  on the disk.

`flock(LOCK_EX)` is rejected because:
1. The Node `fs.flock` API is too new for our deployment surface
   (`saivage` 10.0.3.111 still on Node 20).
2. Going through `node-gyp` for a `flock` binding adds a native
   build dependency that the existing codebase deliberately avoids.

The lockfile protocol is "advisory" in the same sense that
kernel-`flock` is — it only protects against cooperating writers
(daemon + CLI), which is the exact threat model the finding is
about. An uncooperating third party that opens
`auth-profiles.json` with `node:fs` directly bypasses both
protocols equally; the lint rule scoped to `src/auth/**` is what
prevents that from regressing inside the codebase.

## 6. Public surface deletions enabled by the migration

- The bare `writeFileSync(fp, …)` at
  [src/server/cli.ts](../../../../src/server/cli.ts#L538) — the only
  caller of `node:fs` against `auth-profiles.json` from outside
  `store.ts`. Replaced by a single store API call.
- The `chmodSync(fp, 0o600)` repair call at
  [src/auth/store.ts](../../../../src/auth/store.ts#L68) — replaced by
  opening the tmp file with `mode: 0o600` from the start.
- The comment block above it explaining the `writeFileSync` mode quirk
  ([src/auth/store.ts](../../../../src/auth/store.ts#L62-L65)) —
  obsolete once we drop `writeFileSync`.
- The dynamic `await import("node:fs")` inside `logout` at
  [src/server/cli.ts](../../../../src/server/cli.ts#L503-L505).

## 7. Out of scope for G36

- G06 ([../G06-stash-uses-sync-fs.md](../G06-stash-uses-sync-fs.md))
  — `runtime/stash.ts` sync-fs, independent module.
- G30 ([../G30-builtins-filesystem-sync-fs.md](../G30-builtins-filesystem-sync-fs.md))
  — `mcp/builtins.ts` filesystem handler sync-fs, independent module.
  G30 r2 owns the **shared scanner** at
  `src/testing/noSyncFsScanner.ts` (see [../G30/03-plan-r2.md](../G30/03-plan-r2.md#L212-L230));
  G36 consumes that scanner from the auth-specific test added in plan
  r2 — no duplicate implementation, no repo-wide allow-list promise.
- G37 ([../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md))
  — `config.ts` sync-fs + stale cache; same migration class, separate
  finding. If G37 reaches the same `mutate-under-lock` shape, the
  helper can be factored out at that point. We do **not** pre-extract
  it now (YAGNI: one caller).
- Secret-handling for non-OAuth credentials (`apiKey` strings in
  `saivage.json`) — those live in plain config and are out of scope
  for the auth store finding.
