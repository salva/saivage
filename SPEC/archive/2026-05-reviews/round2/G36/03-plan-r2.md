# G36 — Plan r2

**Finding**: [../G36-auth-store-sync-fs.md](../G36-auth-store-sync-fs.md)
**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)
**Design**: [02-design-r2.md](02-design-r2.md) — Proposal A (in-place
async + locked read-modify-write helper, no cache, no class)
**Reviewer feedback**: [04-review-r1.md](04-review-r1.md)

## Sequenced steps

1. **Rewrite `src/auth/store.ts` end-to-end.**
   Replace the file's contents with the Proposal A shape from
   [02-design-r2.md §Files touched](02-design-r2.md#files-touched):
   - Drop `import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs"`
     ([src/auth/store.ts](../../../../src/auth/store.ts#L8)).
   - Imports become
     `import { readFile, writeFile, rename, unlink, mkdir, open, stat, FileHandle } from "node:fs/promises";`
     and `import { hostname } from "node:os";` plus the existing
     `node:path` / `../config.js` / `../log.js` / OAuth provider
     imports.
   - Add the helpers from
     [02-design-r2.md §New module-level helpers](02-design-r2.md#new-module-level-helpers):
     `writeProfilesAtomically(store)`, `withProfilesLock(fn)`,
     `mutateProfiles(fn)`. Inline `tryReclaimStaleLock(lockPath)`
     and the `registerExitCleanup` / `unregisterExitCleanup` pair
     (module-level `Set<string>`, `process.once("exit", …)` +
     `process.once("SIGTERM", …)` handlers that call `fs.unlinkSync`
     on the held lockfiles; the single `unlinkSync` line carries an
     inline `// eslint-disable-next-line no-restricted-imports` with
     a one-line comment that this is the exit-path exception).
   - Convert exported reads (`loadProfiles`, `getProfileByKey`,
     `hasOAuthCredentials`, `hasOAuthProfile`) to `async` with
     `readFile(fp, "utf-8")` inside `try/catch (ENOENT → empty,
     JSON-parse error → empty)`.
   - Convert writes to go through `mutateProfiles`:
     - `saveProfiles(store)` → `await mutateProfiles(_ => store)`
       (kept only because the 0o600 unit test asserts via this
       function; production code goes through `saveProfile` and
       `removeProfiles` from here on).
     - `saveProfile(key, profile)` →
       `await mutateProfiles(s => { s.profiles[key] = profile; return s; })`.
     - `getOAuthApiKey`'s refresh branch (currently at
       [src/auth/store.ts](../../../../src/auth/store.ts#L99-L124))
       → `await mutateProfiles(latest => { …merge refreshed access
       fields into latest.profiles[key]… return latest; })`. The
       reload-under-lock inside `mutateProfiles` is what makes
       refresh-vs-login race-free.
   - Add new export:
     ```ts
     export async function removeProfiles(
       predicate: (key: string, profile: AuthProfile) => boolean,
     ): Promise<number>;
     ```
     Implementation: `await mutateProfiles(s => { … delete matching
     keys, count removed, return s; })`. Returns the count.
   - Keep the provider-registry helpers (`getOAuthProvider`,
     `getOAuthProviders`, the `providers` Map) verbatim — no fs there.
   - Internal `storePath()` stays.

2. **Update the auth barrel.**
   In [src/auth/index.ts](../../../../src/auth/index.ts), add
   `removeProfiles` to the re-export list. Keep every other name. No
   `SecretStore` / `SecretStoreLike` / `InMemorySecretStore`
   re-exports (those types do not exist in r2).

3. **Cascade `await` through the router.**
   In [src/providers/router.ts](../../../../src/providers/router.ts):
   - L184 inside `resolveApiKey` —
     `const profile = await getProfileByKey(options.authProfileKey);`.
   - `shouldRegisterProvider` (currently L730-L745) becomes `async`
     and `await`s `hasOAuthCredentials(...)` for `github-copilot`,
     `anthropic`, `openai-codex`.
   - `initProviders` (currently L91-L122) becomes `async`; renamed in
     place to `private async initProviders(config: SaivageConfig): Promise<void>`.
   - The constructor at L88 stops calling `initProviders`. Body is
     left assigning fields only.
   - Add `public async init(): Promise<void> { await this.initProviders(this.config); /* …existing post-init equivalence-index work… */ }`.
     The four equivalence-index computations move out of the
     constructor and into `init()` (they depend on `this.providers`,
     which is now populated only after `initProviders` resolves).

4. **Wire bootstrap.**
   In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L139):
   ```ts
   const router = new ModelRouter(config);
   await router.init();
   await router.inspectUsageAtStartup();
   ```
   No new imports beyond what's already there.

5. **Update CLI subcommands.**
   In [src/server/cli.ts](../../../../src/server/cli.ts):
   - L290 (`models` command): same two-line shape as bootstrap —
     `new ModelRouter(config); await router.init();`.
   - L404 (`login` action's dynamic import): keep
     `getOAuthProvider, saveProfile, loadProfiles` in the import; add
     no new names.
   - L464: `await saveProfile(profileKey, { … });`.
   - L492-L539 (`logout`): rewrite the body to:
     ```ts
     const { removeProfiles } = await import("../auth/index.js");
     if (profileKey) {
       const n = await removeProfiles((k) => k === profileKey);
       if (n === 0) { console.log(`No credentials found for profile ${profileKey}.`); return; }
       console.log(`Removed credential profile ${profileKey}.`);
     } else if (providerId) {
       const n = await removeProfiles((_, p) => p.provider === providerId);
       if (n === 0) { console.log(`No credentials found for ${providerId}.`); return; }
       console.log(`Removed ${n} credential(s) for ${providerId}.`);
     } else {
       const n = await removeProfiles(() => true);
       if (n === 0) { console.log("No stored credentials."); return; }
       console.log(`Removed all ${n} credential(s).`);
     }
     console.log("Restart the service to apply changes.");
     ```
     Delete the `await import("node:fs")` at L503-L505, the
     `await import("../config.js")` at L535-L536 that pulled in
     `saivageDir` for the inline write, and the `writeFileSync(fp, …)`
     at L538. The CLI never imports `node:fs` against
     `auth-profiles.json` again.

6. **Rewrite `src/auth/store.test.ts`.**
   Replace the existing file with the eight cases listed in
   [02-design-r2.md §Test impact](02-design-r2.md#test-impact). No
   filename change. Specifically:
   - Case 1 — 0o600 on create and overwrite (kept from r1; async).
   - Case 2 — cross-process distinct keys: parent preseeds `a` via
     `await saveProfile("a", buildProfile())`, then
     `child_process.fork` twice against
     `src/auth/__fixtures__/concurrent-writer.ts` with env vars
     `SAIVAGE_PROJECT_ROOT` and `SAIVAGE_TARGET_KEY` /
     `SAIVAGE_TARGET_BODY_BASE64` so the child knows which key to
     write. `await Promise.all(both)`; then read the file from the
     parent (`await loadProfiles()`) and assert both `a` (refreshed)
     and `b` exist.
   - Case 3 — same as case 2 with the actors swapped.
   - Case 4 — `vi.spyOn(fsPromises, "writeFile").mockRejectedValueOnce(...)`;
     assert `saveProfile` rejects, `auth-profiles.json` byte-identical
     to preseed (via `readFile` + buffer compare), no `*.tmp` files
     remain in `.saivage/` (via `readdir`).
   - Case 5 — same shape for `rename`. Add explicit follow-up
     `await saveProfile("x", buildProfile())` that resolves cleanly
     within 200 ms to prove the lock was released.
   - Case 6 — stale-lock reclaim: pre-create
     `auth-profiles.json.lock` with
     `{ pid: 999999, hostname: os.hostname(), startedAt: 0 }`; call
     `saveProfile` and assert it completes within 200 ms and the
     resulting file contains the new profile.
   - Case 7 — empty-store load: assert `(await loadProfiles())` deep-
     equals `{ version: 1, profiles: {} }` when no file is present.
   - Case 8 — sync-fs scope check:
     ```ts
     import { scanForSyncFs } from "../testing/noSyncFsScanner.js";
     const hits = await scanForSyncFs({ roots: ["src/auth"] });
     expect(hits).toEqual([]);
     ```
     (Helper landed by [../G30/03-plan-r2.md](../G30/03-plan-r2.md#L212-L230);
     G36 only consumes it.)
   - The setup helper for every case uses
     `mkdtempSync(join(tmpdir(), "saivage-auth-"))` for the
     `.saivage` root and `process.env.SAIVAGE_PROJECT_ROOT = …` to
     point `saivageDir()` at the temp dir; `afterEach` restores the
     env var and `rm -rf`s the temp dir.

   **Dropped from r1**: the `handle.sync` torn-write case (reviewer
   noted it is not a torn write). The 0o600 mode case is kept and
   converted to async.

7. **Add the fixture script.**
   New file `src/auth/__fixtures__/concurrent-writer.ts`:
   ```ts
   import { saveProfile } from "../index.js";
   const key = process.env.SAIVAGE_TARGET_KEY!;
   const profile = JSON.parse(Buffer.from(process.env.SAIVAGE_TARGET_BODY_BASE64!, "base64").toString("utf-8"));
   await saveProfile(key, profile);
   ```
   Top-level await is fine — the file compiles under the existing
   `tsconfig.json` `module: "node16"` setting. The fixture is
   excluded from production bundles by the existing
   `__fixtures__` carve-out in
   [tsup.config.ts](../../../../tsup.config.ts) (verify during
   step 11; if no carve-out exists, add `__fixtures__/**` to the
   `tsup` `external` / `exclude` list).

8. **Update router test fixtures.**
   In each of
   [src/providers/router.test.ts](../../../../src/providers/router.test.ts),
   [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts),
   [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts) —
   25 sites total per [01-analysis-r2.md §3.5](01-analysis-r2.md#35-srcprovidersroutertestts-and-friends):
   each `const router = new ModelRouter(makeConfig(...));` gains a
   following `await router.init();`. The enclosing test bodies are
   already `async` (every `it(..., async () => {...})` block in those
   files; verify before touching).
   The fs-fixture at
   [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L464)
   becomes
   `await saveProfile("github-copilot.default", { … });` — the import
   is one line at the top of the file.

9. **Add the lint rule (scoped to `src/auth/**` only).**
   In `eslint.config.js`, append an override block:
   ```js
   {
     files: ["src/auth/**/*.{ts,tsx}"],
     rules: {
       "no-restricted-imports": ["error", {
         paths: [
           { name: "node:fs", message: "Use node:fs/promises in src/auth/. Sync fs is banned here (G36)." },
           { name: "fs", message: "Use node:fs/promises in src/auth/. Sync fs is banned here (G36)." },
         ],
       }],
     },
   },
   ```
   **No repo-wide rule.** G06/G30/G37 own their own modules. The
   shared scanner from G30 r2
   ([src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts))
   is consumed by test case 8 above for the same scope.

10. **Build + typecheck + tests.**
    ```
    cd /home/salva/g/ml/saivage
    npx tsc --noEmit
    npx vitest run src/auth src/providers src/server
    npm run build
    npx eslint src/auth
    ```
    Targeted suites first to surface missed `await`s and lint
    regressions; full suite at the end (`npm test`).

11. **Verify the `__fixtures__` carve-out.**
    Run `npm run build` and inspect `dist/` for
    `auth/__fixtures__/concurrent-writer.js`. It MUST be emitted (the
    forked child needs to execute it). Tests run `tsx` directly
    against the `.ts` source for unit suites, but the fork target in
    case 2 / case 3 uses the `dist/` path to avoid pulling `tsx` into
    the child runtime. Confirm by `node -e "require.resolve('./dist/auth/__fixtures__/concurrent-writer.js')"`.

## Validation

- `npx tsc --noEmit` clean — TypeScript catches every missed `await`
  because the auth functions now return `Promise<T>` and
  `shouldRegisterProvider` returns `Promise<boolean>`.
- `npx vitest run src/auth/store.test.ts` — all eight cases pass.
- `npx vitest run src/providers` — router/copilot/model-capabilities
  suites pass after the `await router.init();` cascade.
- `npx eslint src/auth` — clean; the new rule fires on any
  `from "node:fs"` import inside `src/auth/**` (verified by
  temporarily reintroducing one and confirming the failure).
- `grep -RE "readFileSync|writeFileSync|chmodSync|existsSync" saivage/src/auth/` —
  empty.
- `grep -RE "auth-profiles\.json" saivage/src/ | grep -v test | grep -v __fixtures__` —
  only hits `src/auth/store.ts` (the `storePath` helper) and
  `src/server/server.ts:351` (the `HIDDEN_FILES` set; intentional).
- Manual probe on a live daemon after deploy (see Rollback for the
  per-container procedure):
  ```bash
  ssh root@10.0.3.113 'curl -fsS http://127.0.0.1:8080/health'
  ssh root@10.0.3.113 'journalctl -u saivage.service --since "5 minutes ago" | grep -i "Refreshing OAuth"'
  ```
  Expected: `/health` returns 200; OAuth refresh log lines look
  unchanged in shape; no `EACCES` / `ENOENT` / `Unexpected end of JSON`
  / `timed out acquiring .*auth-profiles.json.lock` errors after a
  deliberate test refresh.
- Concurrent-writer regression check on a scratch container: from
  two separate SSH sessions on `diedrico`, run two non-OAuth
  `node -e "import('/opt/saivage/dist/auth/index.js').then(m => m.saveProfile(process.argv[1], {...}))" <key>`
  invocations in parallel against the same `.saivage/` and confirm
  both keys exist in `auth-profiles.json` after both complete (do
  NOT print the file contents).

## Rollback

NO `git reset --hard`. Three daemons hold this file open via long-
running processes:

- `saivage` (10.0.3.111) — old v2 on GetRich.
- `diedrico` (10.0.3.113) — v2 harness on `/work/diedrico`.
- `saivage-v3` (10.0.3.112) — v2 harness on `/work/saivage-v3`.

Each runs `node dist/cli.js serve <project>` as a systemd unit;
killing the process mid-write *with the current sync code* would risk
truncating `auth-profiles.json`. The Proposal A atomic-write path
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
6. If the regression is the lockfile acquisition path, the daemon
   will log
   `[auth] timed out acquiring .../auth-profiles.json.lock` and
   refuse the write. Diagnose by reading the lockfile's JSON
   (`{pid, hostname, startedAt}`) on the affected container; if the
   PID is gone the stale-recovery branch failed — manually
   `rm <project>/.saivage/auth-profiles.json.lock` and the next call
   recovers. If the PID is live, identify the blocking process
   (likely a hung daemon thread) and `systemctl restart saivage.service`.

## Cross-finding coordination

- **G06** ([../G06-stash-uses-sync-fs.md](../G06-stash-uses-sync-fs.md))
  — independent module (`runtime/stash.ts`). Different
  invariants (no secrets, single writer), so G06 picks its own
  locking story. The only shared artefact is the scanner from
  G30 r2 (next bullet).
- **G30** ([../G30-builtins-filesystem-sync-fs.md](../G30-builtins-filesystem-sync-fs.md))
  — owns
  [src/testing/noSyncFsScanner.ts](../../../../src/testing/noSyncFsScanner.ts)
  (see [../G30/03-plan-r2.md](../G30/03-plan-r2.md#L212-L230)). G36
  consumes that helper from test case 8 only — no duplicate scanner
  implementation, no repo-wide allow-list promise.
- **G37** ([../G37-config-sync-fs-and-stale-cache.md](../G37-config-sync-fs-and-stale-cache.md))
  — `config.ts`. G37 will likely want a mutate-under-lock helper
  with the same shape as `mutateProfiles`. **Do not pre-emptively
  extract** the helper from `auth/store.ts` as part of G36; wait
  until G37's design lands and confirms the shape. If G37 picks the
  same shape, extract at that time. (YAGNI: one caller does not
  justify the generic.)
- **F22 round-1** — Proposal A preserves F22's atomic-rename pattern
  verbatim for the on-disk write; the difference is the explicit
  `mode: 0o600` on tmp-file creation (`writeDoc` does not expose
  this) and the `mutateProfiles` wrapper. No `documents.ts` changes.
