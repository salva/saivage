# G36 — Analysis r1

**Finding**: [../G36-auth-store-sync-fs.md](../G36-auth-store-sync-fs.md)
**Subsystem**: auth (with cascade into providers, server bootstrap, CLI)
**Round-1 reference**: [../../review-2026-05/F22/APPROVED.md](../../review-2026-05/F22/APPROVED.md), [../../review-2026-05/F22/02-design-r2.md](../../review-2026-05/F22/02-design-r2.md)

## 1. What the finding says

`src/auth/store.ts` is the only secret-bearing on-disk store in the
codebase. F22 (round 1) migrated [src/store/documents.ts](../../../../src/store/documents.ts)
to `node:fs/promises` and pushed `await` through every caller. The
auth-profile store was excluded from that pass and still uses
`readFileSync` / `writeFileSync` / `existsSync` / `chmodSync` on the
chat-server hot path. The file holds OAuth refresh tokens; the writer
is not atomic; and concurrent writers (background token refresh during
a chat turn vs an interactive `saivage login` against the same project)
can clobber each other's updates via classic read-modify-write loss.

## 2. Sync-fs call sites in `src/auth/store.ts`

All within [src/auth/store.ts](../../../../src/auth/store.ts):

- L8 — `import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs"`.
- [src/auth/store.ts](../../../../src/auth/store.ts#L46-L57) — `loadProfiles()`:
  `existsSync(fp)` + `readFileSync(fp, "utf-8")`. Returns
  `AuthProfileStore` on every call; no in-memory cache.
- [src/auth/store.ts](../../../../src/auth/store.ts#L59-L72) — `saveProfiles(store)`:
  `writeFileSync(fp, …, { mode: 0o600 })` followed by `chmodSync(fp, 0o600)`
  to repair the mode when the file already exists. Non-atomic — a
  crash mid-write truncates `auth-profiles.json`, which locks the user
  out of every OAuth provider until they re-`login`.
- [src/auth/store.ts](../../../../src/auth/store.ts#L74-L78) — `saveProfile(key, profile)`:
  read-modify-write (`loadProfiles()` + mutate + `saveProfiles(store)`).
  No mutex around the load/store pair → concurrent refreshes or a
  `login` racing a refresh produce last-writer-wins data loss.
- [src/auth/store.ts](../../../../src/auth/store.ts#L80-L83) — `getProfileByKey(key)`:
  `loadProfiles()` on every call.
- [src/auth/store.ts](../../../../src/auth/store.ts#L92-L137) — `getOAuthApiKey(...)`:
  `loadProfiles()` at L99, `saveProfiles(store)` at L124 inside the
  refresh branch. The refresh is awaited (`await provider.refreshToken(...)`)
  but the surrounding load and persistence are sync.
- [src/auth/store.ts](../../../../src/auth/store.ts#L138-L141) — `hasOAuthCredentials(providerId)`:
  `loadProfiles()` on every call. Invoked from `ModelRouter`'s
  *constructor* (see §3) — so today the router's `new` blocks on disk.
- [src/auth/store.ts](../../../../src/auth/store.ts#L143-L147) — `hasOAuthProfile(key, ?providerId)`:
  `loadProfiles()` via `getProfileByKey`.
- [src/server/cli.ts](../../../../src/server/cli.ts#L537) — `writeFileSync(fp, JSON.stringify(store, …))`
  inside the `logout` action, bypassing the store API entirely. This is
  the second writer of `auth-profiles.json` outside `store.ts`.

There is no `existsSync`/`mkdirSync`/`unlinkSync` use elsewhere in
`src/auth/` other than the test-only `defaults.test.ts` and
`store.test.ts`.

## 3. Propagation surface — every caller cascades to `async`

Module-level free functions are exported through
[src/auth/index.ts](../../../../src/auth/index.ts#L1) as the barrel
re-export `{ getOAuthApiKey, getProfileByKey, hasOAuthCredentials, hasOAuthProfile, loadProfiles, saveProfile }`.
`saveProfiles` is internal to `store.ts` but used by `store.test.ts`.

### 3.1 `src/providers/router.ts`

- L18 — `import { getOAuthApiKey, getProfileByKey, hasOAuthCredentials } from "../auth/index.js";`
- [src/providers/router.ts](../../../../src/providers/router.ts#L184) — `getProfileByKey(options.authProfileKey)`
  inside `resolveApiKey(...)`. `resolveApiKey` is already `async`; one
  more `await` here, no signature change.
- [src/providers/router.ts](../../../../src/providers/router.ts#L730-L745) — `shouldRegisterProvider(providerName)`:
  pure sync method, calls `hasOAuthCredentials("github-copilot")` /
  `"anthropic"` / `"openai-codex"`. Invoked from
  [src/providers/router.ts](../../../../src/providers/router.ts#L91-L122)
  `initProviders(config)`, which is called from the **synchronous
  constructor** at [src/providers/router.ts](../../../../src/providers/router.ts#L88).

  Making `hasOAuthCredentials` async therefore cascades into one of:
  - turn provider registration into an `async init()` method called once
    after `new ModelRouter(config)` from bootstrap and CLI, or
  - replace the constructor with a static `async create(config)` factory.

  Either is a public-API shape change of `ModelRouter`.

### 3.2 `src/server/bootstrap.ts`

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L139) — `const router = new ModelRouter(config);`
  becomes `await ModelRouter.create(config)` (or `new ModelRouter(config); await router.init();`).
  The enclosing function is already `async`.

### 3.3 `src/server/cli.ts`

Every site below sits inside an `.action(async …)` block, so the
cascade is purely adding `await`s — no factory-on-CLI needed.

- [src/server/cli.ts](../../../../src/server/cli.ts#L290) — `models` command:
  `const router = new ModelRouter(config);` → `await ModelRouter.create(config)`.
- [src/server/cli.ts](../../../../src/server/cli.ts#L404) — `login`: imports
  `saveProfile, loadProfiles` from `auth/index.js`.
- [src/server/cli.ts](../../../../src/server/cli.ts#L464) — `saveProfile(profileKey, { … })`
  → `await saveProfile(...)`.
- [src/server/cli.ts](../../../../src/server/cli.ts#L492-L505) — `logout`:
  `const { loadProfiles } = await import("../auth/index.js");` and
  `const store = loadProfiles();` → `await loadProfiles()`.
- [src/server/cli.ts](../../../../src/server/cli.ts#L537) — the bare
  `writeFileSync(fp, JSON.stringify(store, …))` at the end of `logout`
  is the second writer of the secret file from outside `store.ts`. It
  bypasses the store API, so even after migrating `store.ts` to async
  atomic writes this site would still produce a non-atomic, non-mode-
  enforcing write. Must be replaced by a call to the store API.

### 3.4 `src/auth/store.test.ts`

- L5 imports `{ saveProfiles, loadProfiles }`; L25 calls `saveProfiles(...)`,
  L43 calls `loadProfiles()`. Convert to `await`.

### 3.5 `src/providers/router.test.ts` and friends

Tests construct `new ModelRouter(makeConfig(...))` directly at 17+ sites
(see `grep "new ModelRouter("` results) across:

- [src/providers/router.test.ts](../../../../src/providers/router.test.ts)
- [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts)
- [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts)

If router construction goes async, all these sites switch to
`await ModelRouter.create(...)`. Plus
[src/providers/router.test.ts](../../../../src/providers/router.test.ts#L464)
which seeds an `auth-profiles.json` file directly via fs to set up an
OAuth fixture — that is a test-helper detail and stays as-is (it is the
fixture, not a production write path).

## 4. Secret-handling constraints

`auth-profiles.json` stores OAuth refresh tokens issued by Anthropic,
OpenAI-Codex, and GitHub Copilot. The file is the single point at
which the daemon's ability to talk to paid LLM providers persists
across restarts. Two operational facts make the atomicity contract
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
   because `writeFileSync` only honours `mode` on file creation, not on
   overwrite. Any async replacement must preserve the
   "owner-readable-only" invariant on every write, including the first
   write that creates the file. The atomic tmp-file pattern from
   `store/documents.ts` uses `open(tmp, "w")` without a mode argument
   and produces a 0o644 file on most umasks — directly applying that
   pattern would regress the file mode.

3. **Concurrent-writer races are not a theoretical concern.** The same
   project root can be touched by:
   - a long-running daemon's background token refresh
     ([src/auth/store.ts](../../../../src/auth/store.ts#L118-L125),
     triggered during `ModelRouter.send` on the hot path), and
   - an interactive `saivage login --profile` invocation from the
     operator's shell.
   With the existing sync read-modify-write and no on-disk lock, the
   later writer overwrites the earlier writer's `profiles` map and the
   "lost" credential silently disappears.

These three constraints together — torn-write integrity, mode
preservation, and concurrent-writer serialization — are what makes a
plain "swap `Sync` for the `/promises` equivalent" insufficient.
Either the existing free functions grow an explicit atomic-write
helper that handles mode + locking, or the secret-bearing file moves
behind a single object that owns the file and serializes access.

## 5. Public surface deletions enabled by the migration

- The bare `writeFileSync(fp, …)` at
  [src/server/cli.ts](../../../../src/server/cli.ts#L537) — the only
  caller of `node:fs` against `auth-profiles.json` from outside
  `store.ts`. Replaced by a single store API call.
- The `chmodSync(fp, 0o600)` repair call at
  [src/auth/store.ts](../../../../src/auth/store.ts#L68) — replaced by
  opening the tmp file with `mode: 0o600` from the start.
- The comment block above it explaining the `writeFileSync` mode quirk
  ([src/auth/store.ts](../../../../src/auth/store.ts#L62-L65)) — obsolete
  once we drop `writeFileSync`.

## 6. Out of scope for G36

- G06 (`runtime/stash.ts` sync-fs) — independent module; same class
  bug, separate finding.
- G30 (`mcp/builtins.ts` filesystem handler sync-fs) — independent
  module; coordinate on the lint-rule banning `node:fs` outside an
  allow-list.
- G37 (`config.ts` `loadConfig` sync-fs + stale cache) — independent
  module, same migration class. If we centralize secret IO in a
  facade (Proposal B), `config.ts` can adopt the same locked-JSON-file
  primitive in its own finding.
- Secret-handling for non-OAuth credentials (`apiKey` strings in
  `saivage.json`) — those live in plain config and are out of scope
  for the auth store finding.
