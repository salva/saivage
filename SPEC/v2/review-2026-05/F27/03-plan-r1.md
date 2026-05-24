# F27 — Plan r1 (Proposal A)

## Edit steps

1. **Create `src/auth/defaults.ts`** with the three shipped default OAuth client ids as named string exports:

   ```ts
   // src/auth/defaults.ts
   export const DEFAULT_ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
   export const DEFAULT_OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
   export const DEFAULT_GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
   ```

   No `atob(...)` — these values are intentionally public.

2. **Extend `configSchema` in [src/config.ts](src/config.ts#L34-L113)** with a new top-level `oauth` block, inserted alphabetically near `models` / `providers`:

   ```ts
   import {
     DEFAULT_ANTHROPIC_CLIENT_ID,
     DEFAULT_OPENAI_CODEX_CLIENT_ID,
     DEFAULT_GITHUB_COPILOT_CLIENT_ID,
   } from "./auth/defaults.js";
   // ...
   oauth: z
     .object({
       anthropic: z.object({ clientId: z.string().default(DEFAULT_ANTHROPIC_CLIENT_ID) }).default({}),
       openaiCodex: z.object({ clientId: z.string().default(DEFAULT_OPENAI_CODEX_CLIENT_ID) }).default({}),
       githubCopilot: z.object({ clientId: z.string().default(DEFAULT_GITHUB_COPILOT_CLIENT_ID) }).default({}),
     })
     .default({}),
   ```

   This keeps the existing pattern of `.default({})` nested object blocks (see `server`, `agent`, `runtime`, `security`, `supervisor`, `telegram`, `notifications` in the same schema).

3. **Edit [src/auth/anthropic.ts](src/auth/anthropic.ts):**
   - Delete the `// base64-decoded: ...` comment and the `const CLIENT_ID = "9d1c250a-..."` line at [src/auth/anthropic.ts](src/auth/anthropic.ts#L12-L13).
   - Add `import { loadConfig } from "../config.js";` near the existing imports.
   - At the top of `exchangeCode`, `refreshAccessToken`, and `loginAnthropic`, resolve the client id:
     ```ts
     const clientId = loadConfig().oauth.anthropic.clientId;
     ```
   - Replace the three `client_id: CLIENT_ID` / `set("client_id", CLIENT_ID)` references at [src/auth/anthropic.ts](src/auth/anthropic.ts#L57), [src/auth/anthropic.ts](src/auth/anthropic.ts#L88), [src/auth/anthropic.ts](src/auth/anthropic.ts#L170) with `clientId`.

4. **Edit [src/auth/openai-codex.ts](src/auth/openai-codex.ts):**
   - Delete `const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";` at [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L12).
   - Add `import { loadConfig } from "../config.js";`.
   - At the top of `exchangeCode`, `refreshAccessToken`, and `loginOpenAICodex`, resolve:
     ```ts
     const clientId = loadConfig().oauth.openaiCodex.clientId;
     ```
   - Replace the three references at [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L66), [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L97), [src/auth/openai-codex.ts](src/auth/openai-codex.ts#L179) with `clientId`.

5. **Edit [src/auth/github-copilot.ts](src/auth/github-copilot.ts):**
   - Delete `const CLIENT_ID = atob("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");` at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L15) (including the trailing comment).
   - Add `import { loadConfig } from "../config.js";`.
   - At the top of `startDeviceFlow` and `pollForAccessToken`, resolve:
     ```ts
     const clientId = loadConfig().oauth.githubCopilot.clientId;
     ```
   - Replace `client_id: CLIENT_ID` at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L83) and [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L137) with `clientId`.

6. **No changes to** [src/auth/index.ts](src/auth/index.ts), [src/auth/types.ts](src/auth/types.ts), [src/auth/store.ts](src/auth/store.ts), or [src/auth/pkce.ts](src/auth/pkce.ts). The public surface of the auth module does not change.

## Test strategy

### Existing coverage

- [src/auth/store.test.ts](src/auth/store.test.ts) covers profile persistence and does not exercise client ids; it will continue to pass unchanged.
- The config schema is exercised across the suite whenever `loadConfig()` runs in setup; the new `.default({})`-chained fields will populate from defaults if a test fixture supplies no `oauth` block.

### New tests

Add a single focused test file (the lightest fixture surface area; we are validating one schema path + the resolution function-call path):

**`src/auth/defaults.test.ts`** (new):

- Test 1: importing `loadConfig` against an empty `.saivage/saivage.json` resolves `.oauth.anthropic.clientId`, `.oauth.openaiCodex.clientId`, `.oauth.githubCopilot.clientId` to the constants exported from `src/auth/defaults.ts` (assert deep equality with the `DEFAULT_*` imports — do *not* hardcode the literal strings in the test, to avoid two-place drift).
- Test 2: a `saivage.json` fixture that sets `oauth.anthropic.clientId = "override-abc"` produces that override when parsed. Use a temporary directory with `SAIVAGE_ROOT` set (or `loadConfig(true, tmpDir)`), following the existing test setup idiom.
- Test 3: a `saivage.json` fixture that sets `oauth.anthropic.clientId = "${ANTHROPIC_OAUTH_CLIENT_ID}"` and `process.env.ANTHROPIC_OAUTH_CLIENT_ID = "from-env"` resolves to `"from-env"` (proves env-var interpolation still works on the new field).

We do *not* add tests that hit live OAuth endpoints; that contract is unchanged.

### Commands

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run src/auth
```

`npx vitest run src/auth` covers the new `defaults.test.ts` plus the existing `store.test.ts`.

For a full sanity sweep before merge:

```bash
npx vitest run
```

## Rollback strategy

Single commit. Revert via `git revert <sha>`. The only state-side concern is operator-supplied `oauth` overrides in `.saivage/saivage.json`, which become inert on rollback (the schema would no longer know about them, but `z.object(...).strict()` is *not* used — extra keys are ignored), so no data loss.

## Cross-issue ordering

- **Must land before F19** (provider barrel). F19 is likely to consolidate OAuth re-exports; this finding clears the way by removing the literal constants but does not pre-empt any restructuring.
- **No dependency on F15** (oauth resolution overlap). F15 is the `oauthToProviderName` mapping in [src/auth/store.ts](src/auth/store.ts#L148-L152); orthogonal.
- **Idiom should match F11** (magic constants → config). If F11 lands first, mirror its `z.object({...}).default({})` style; if F27 lands first, F11 will mirror this one. Either order is fine.
