# F15 — Plan r1 (Proposal A)

## Ordered edit steps

1. **[src/server/bootstrap.ts](src/server/bootstrap.ts)** — delete the eager OAuth injection.
   - Remove the `await injectOAuthTokens(router);` line at [bootstrap.ts#L135](src/server/bootstrap.ts#L135). Keep the surrounding lines intact: `new ModelRouter(config)` immediately followed by `await router.inspectUsageAtStartup();`.
   - Remove the `async function injectOAuthTokens(router: ModelRouter): Promise<void> { … }` definition at [bootstrap.ts#L740-L762](src/server/bootstrap.ts#L740-L762).
   - Remove the now-unused `getOAuthApiKey` and `hasOAuthCredentials` symbols from the import at [bootstrap.ts#L13](src/server/bootstrap.ts#L13) (`import { getOAuthApiKey, hasOAuthCredentials } from "../auth/index.js";`). Verify they have no other use in this file with `grep -n "getOAuthApiKey\|hasOAuthCredentials" src/server/bootstrap.ts` — if both are gone, drop the whole import line; otherwise keep only the surviving symbol.
   - If `ModelRouter` is only imported for the deleted function's parameter type (it is not — bootstrap also constructs `new ModelRouter`), leave its import alone.

2. **[src/providers/router.ts](src/providers/router.ts)** — drop the unused `OAUTH_TO_PI` map.
   - Remove the `OAUTH_TO_PI` declaration and its preceding comment at [router.ts#L57-L62](src/providers/router.ts#L57-L62). No other code in the repo references it (verified by `grep -rn "OAUTH_TO_PI" src/`).
   - Keep `PROVIDER_TO_OAUTH` as the canonical provider-name → OAuth-id mapping at [router.ts#L64-L71](src/providers/router.ts#L64-L71). No change.

3. **[src/auth/store.ts](src/auth/store.ts) + [src/auth/index.ts](src/auth/index.ts)** — delete the dead `oauthToProviderName` helper.
   - Remove the `oauthToProviderName` function at [store.ts#L154-L158](src/auth/store.ts#L154-L158) along with its docblock at [store.ts#L149-L153](src/auth/store.ts#L149-L153).
   - Remove `oauthToProviderName` from the barrel re-export in [index.ts#L1](src/auth/index.ts#L1).
   - Verify no other call sites with `grep -rn "oauthToProviderName" src/ web/ tests/`. There are none today (router uses its own `PROVIDER_TO_OAUTH`); this guards against re-introduction.

4. **Search for leftover references.**
   - `grep -rn "injectOAuthTokens" src/` — must return zero matches.
   - `grep -rn "OAUTH_TO_PI" src/` — must return zero matches.
   - `grep -rn "oauthToProviderName" src/ web/` — must return zero matches.

## Test strategy

### Existing tests that exercise the lazy path

- [src/providers/router.test.ts](src/providers/router.test.ts) — `resolveApiKey("github-copilot", { accountRef: … })` is asserted at [router.test.ts#L443-L444](src/providers/router.test.ts#L443-L444). These remain the regression coverage for the lazy path and must still pass unchanged.
- [src/auth/store.test.ts](src/auth/store.test.ts) — covers profile load/save/refresh. Confirm no test references `oauthToProviderName`; if any does, delete those assertions (they test dead code).

### New tests

Add one focused test to `src/providers/router.test.ts` (or a new `src/server/bootstrap.test.ts` if none exists for bootstrap) asserting that after `new ModelRouter(config)` is constructed with an OAuth profile present on disk and no eager injection, the first call to `router.resolveApiKey(providerName)` still returns the profile's access token. This pins the behaviour the deleted `injectOAuthTokens` was relying on and prevents anyone from re-introducing eager injection later under the guise of "warming the cache". Use the existing `store.test.ts` fixture pattern (temp `.saivage/auth-profiles.json` via `tmp` directory) for the OAuth side, and rely on the existing `PiAiProvider`/`CopilotProvider` constructors without mocking.

If a bootstrap-level integration test exists, drop any line that asserts the `[v2] OAuth credentials loaded for ${providerName}` log message.

### Commands

Run from the repo root `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run src/providers/router.test.ts
npx vitest run src/auth/store.test.ts
npx vitest run src/server   # if/when bootstrap tests exist
npx vitest run              # full suite as the final gate
```

Expected: all green. The build must succeed because `tsup` bundles `bootstrap.ts`; an unused-import lint or `noUnusedLocals` failure here means step 1's import pruning was incomplete.

### Manual smoke check (optional, only if test coverage feels thin)

With a real `.saivage/auth-profiles.json` present, start the server (`node dist/cli.js serve <project>`) and confirm:
- The `[v2] OAuth credentials loaded for …` log line no longer appears.
- The first chat request through any agent still succeeds (the lazy path resolves and sets the key).
- The `[router] Loaded startup usage snapshots …` line still appears, since `inspectUsageAtStartup` still calls `resolveApiKey` per candidate.

## Rollback strategy

Single commit. `git revert <sha>` restores `injectOAuthTokens`, the call site, `OAUTH_TO_PI`, and `oauthToProviderName`. No data migration, no on-disk format change, no schema change — `auth-profiles.json` format is untouched.

## Cross-issue ordering

- **Independent of F27** (OAuth client IDs in source). F15 can land before or after F27. F15 does not introduce or remove any `CLIENT_ID` reference; it only deletes a redundant resolution path and a dead helper.
- **Independent of other router-touching findings** in the inventory, because the surface change is confined to deleting one bootstrap helper, one router constant, and one auth-store helper — none of which other findings depend on.
- Should land **before** any future finding that targets the shared-`setApiKey` race / per-call API key threading (Proposal B in this finding's design): removing the eager writer first makes that follow-up a single-direction refactor.
