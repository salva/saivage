# G08 — Design r3

**Finding**: [../G08-seedproject-writes-saivagejson-without-schema.md](../G08-seedproject-writes-saivagejson-without-schema.md)
**Analysis**: [./01-analysis-r3.md](./01-analysis-r3.md)
**Round-1 design**: [02-design-r1.md](./02-design-r1.md)
**Round-2 design**: [02-design-r2.md](./02-design-r2.md)
**Review feedback**: [04-review-r2.md](./04-review-r2.md)

Direction unchanged from r2: Proposal B, schema-driven seed. Proposal A from r1 stays dropped. r3 narrows the scope claim, hardens the test contract, and corrects the secret-handling guidance.

## r3 deltas vs r2

- **Δ1 (r2 review change 1) — Secret-handling guidance.** r2 §4 framed the removal of seeded provider entries as removing the localhost endpoints from the system, and r2 elsewhere implied `saivage.json` is non-sensitive. Corrected in §4 ("Removed policy leaks, with corrected scope") and §8 ("What this does not fix"): `saivage.json` may carry apiKey/baseUrl/authProfile/botToken per the schema; the new seed writes none of them, but the file remains operator-owned and sensitive.

- **Δ2 (r2 review change 2) — Provider-default scope.** r2 implied G08 closed the hardcoded-localhost problem entirely. Corrected in §4 and §5 ("Provider consumer audit, corrected scope"): the seeder is fixed; the router-side unconditional Ollama registration and the provider-class localhost fallbacks are out of scope and tracked under a separate follow-up finding cross-linked here.

- **Δ3 (r2 review change 3) — Test contract.** r2's `expect(raw).toEqual(SaivageConfigSchema.parse({}))` did not enforce review-on-change. Corrected in §6 ("Test contract"): the expected tree is an inline literal `EXPECTED_SEED` committed in the test file; schema-default edits force a deliberate snapshot update.

## 1. Precondition: export the schema

[src/config.ts](../../../../src/config.ts#L62) declares `const configSchema` privately. Rename to `export const SaivageConfigSchema = z.object({...})` and update the two internal references:

- [src/config.ts](../../../../src/config.ts#L194): `export type SaivageConfig = z.infer<typeof SaivageConfigSchema>;`
- [src/config.ts](../../../../src/config.ts#L274): `cached = SaivageConfigSchema.parse(interpolated);`

No external file currently imports `configSchema` (private), so the rename has no other callers. Type consumers continue to import `SaivageConfig`.

## 2. Replace the seed literal with a schema-derived default

Delete the entire 28-line literal at [src/store/project.ts](../../../../src/store/project.ts#L135-L163) and replace with:

```ts
const saivageJson = SaivageConfigSchema.parse({});
await writeDoc(saivageJsonPath, saivageJson, SaivageConfigSchema);
```

The seeder no longer owns any runtime default. The producer (`SaivageConfigSchema.parse({})`) and the validator inside `writeDoc` are the same schema, so there is no possible drift between what the seed emits and what the loader accepts.

The `writeFile` import at [src/store/project.ts](../../../../src/store/project.ts#L7) stays — it is still used by `initProjectTree` for `index.json`, `audit.jsonl`, and `.gitignore` (non-schema artifacts).

## 3. Full schema-default serialization is the intended on-disk seed

**This is the design's central architectural commitment.** Because `SaivageConfigSchema.parse({})` flows through `writeDoc`, the fresh `saivage.json` contains every `.default(...)` value declared in [src/config.ts](../../../../src/config.ts#L62-L192).

What materializes that the old literal did not:

| Subtree | Source | What appears on disk |
|---|---|---|
| `models` | [src/config.ts](../../../../src/config.ts#L63-L74) | `{}` (no defaults for any role) |
| `runtime` | [src/config.ts](../../../../src/config.ts#L96-L109) | `maxServices`, `restartOnCrash`, `continuousImprovement`, `healthCheckIntervalMs`, `idleShutdownMs`, `recoveryDelayMs`, `notes.volatileTtlMs` |
| `security` | [src/config.ts](../../../../src/config.ts#L111-L117) | `injectionScanner`, `maxScanLengthBytes` (`injectionModel` omitted — optional, no default) |
| `supervisor` | [src/config.ts](../../../../src/config.ts#L119-L127) | `enabled`, `intervalMs`, `consecutiveStuckVerdicts`, `logLines`, `forceCancelDelayMs` (`model` omitted) |
| `telegram` | [src/config.ts](../../../../src/config.ts#L129-L134) | `botToken: ""`, `allowedUserIds: []` |
| `mcp` | [src/config.ts](../../../../src/config.ts#L136-L162) | `shellTimeoutMs`, `shellTimeoutFloorMs`, `inProcessTimeoutMs`, `maxOutputBytes`, `maxFetchChars`, `maxDownloadBytes` |
| `oauth` | [src/config.ts](../../../../src/config.ts#L171-L186) | `anthropic.clientId`, `openaiCodex.clientId`, `githubCopilot.clientId` from [src/auth/defaults.ts](../../../../src/auth/defaults.ts) |

Specific notes:

- **`telegram.botToken: ""`** is intentional on disk. The empty string documents the field's existence; the operator-set value (when configured) is written back into the same key. The bot token is a secret when populated — see §4.
- **Public OAuth client IDs** are not secrets (they are visible in browser OAuth flows), but materialising them on disk lets an operator audit "what client am I authenticating as?".
- **`mcp.superRefine` against defaults** ([src/config.ts](../../../../src/config.ts#L143-L163)) passes by inspection: `shellTimeoutMs (14_400_000) > WALL_CLOCK_HEADROOM_MS` and `shellTimeoutFloorMs (600_000) ≤ shellTimeoutMs - WALL_CLOCK_HEADROOM_MS`. If a future schema edit breaks this, `parse({})` throws inside `writeDoc` and the seeder fails at seed time.

## 4. Removed policy leaks, with corrected scope

The schema-driven seed removes the **persisted policy literal** from the produced file:

- **`mcpServers.playwright`** — Playwright autostart on every fresh project. Operators who need Playwright add it explicitly to `mcpServers`.
- **`providers.anthropic: {}`, `providers.openai: {}`** — empty placeholders.
- **`providers.ollama: { baseUrl: "http://localhost:11434" }`, `providers.llamacpp: { baseUrl: "http://localhost:8080" }`** — hardcoded localhost endpoints inside the seed file.
- **The latent `server.port: 8080` vs `llamacpp.baseUrl: ":8080"` collision in the seed.** Auto-resolves because no llamacpp baseUrl is seeded.

**What this design does NOT remove** (corrected from r2):

- **Unconditional Ollama registration** at [src/providers/router.ts](../../../../src/providers/router.ts#L731-L749) — `shouldRegisterProvider("ollama")` returns `true` regardless of `config.providers`.
- **Localhost fallback in OllamaProvider** at [src/providers/ollama.ts](../../../../src/providers/ollama.ts#L20-L36) — when `baseUrl` is unset, defaults to `http://localhost:11434/v1`.
- **Localhost fallback in LlamaCppProvider** at [src/providers/llamacpp.ts](../../../../src/providers/llamacpp.ts#L10-L19) — when both `baseUrl` and `LLAMACPP_BASE_URL` are unset, defaults to `http://localhost:8080`.
- **Three external surfaces** that publish the registered-provider list: [src/server/server.ts](../../../../src/server/server.ts#L218-L226) (`GET /api/providers`), [src/server/cli.ts](../../../../src/server/cli.ts#L291-L296) (`models` CLI command), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L141) (startup log).

Consequence on a freshly seeded project after G08 lands: `saivage.json` contains `providers: {}`, but the runtime still registers `ollama` and (if env-configured) `llamacpp`, and both still fall back to localhost endpoints unless the operator sets `OLLAMA_BASE_URL` / `LLAMACPP_BASE_URL` or populates the corresponding `providers.<name>.baseUrl`. These are tracked under **G08-followup** (new finding, to be filed with the G08 merge); folding them into G08 would expand a producer-path refactor into a routing-layer behavioural change.

**Secret-handling guidance** (corrected from r2):

`saivage.json` may legitimately carry secrets and auth-adjacent routing data per its schema:

- [src/config.ts](../../../../src/config.ts#L14-L17) — provider account: `apiKey`, `baseUrl`, `authProfile` (all optional but allowed).
- [src/config.ts](../../../../src/config.ts#L31-L36) — top-level provider config inherits the same three fields plus an `accounts` record.
- [src/config.ts](../../../../src/config.ts#L76) — `providers: z.record(...)` is part of `SaivageConfig`.
- [src/config.ts](../../../../src/config.ts#L129-L132) — `telegram.botToken: z.string().default("")` is also part of `SaivageConfig`.

The new seed writes `providers: {}` and `telegram.botToken: ""`, so a **freshly seeded** file contains no secrets. Once the operator configures providers or the Telegram bot, the file becomes sensitive: it may hold static `apiKey` values, custom `baseUrl` routing, OAuth profile references, and the bot token value. The existing operational rule — treat `saivage.json` as sensitive; preserve it across reset workflows unless the operator explicitly regenerates it — stays unchanged after G08.

Architecture-first: no fallback seed, no "legacy compatibility" branch, no migration shim. Existing `.saivage/saivage.json` files written by the old seeder retain their Playwright/provider entries and continue to load. Operators who want to reset to the new defaults run `rm .saivage/saivage.json && saivage init <path>` — and preserve any apiKey/baseUrl/botToken they want to keep, per the unchanged operational rule.

## 5. Provider consumer audit, corrected scope (review change 2)

The audit G08 owns is the **producer-side** audit: who reads `config.providers` or `config.mcpServers` and assumes a specific seeded key exists. Pre-flight grep results:

- [src/providers/router.ts](../../../../src/providers/router.ts#L93) — `config.providers` as arbitrary record, handles `{}` correctly. No change.
- [src/config.test.ts](../../../../src/config.test.ts#L83-L84) — hand-rolled fixture, independent of `seedProject`. No change.
- No other producer or test asserts that `seedProject` outputs any specific provider name.

The plan re-runs the audit at implementation time as a drift guard. If a hit appears, the fix is to teach the consumer (or its test) to handle the schema default `{}`, not to add a compatibility seed in the producer.

The **router-side** audit (unconditional Ollama registration, localhost fallbacks, three external surfaces) is **out of scope for G08** by the cross-link in §4. The plan in [03-plan-r3.md](./03-plan-r3.md) does not change router or provider code and does not test the three external surfaces; those are G08-followup work.

## 6. Test contract (review change 3)

Replace the round-1 `readDoc(path, SaivageConfigSchema)` round-trip (tautology) and the r2 `expect(raw).toEqual(SaivageConfigSchema.parse({}))` (does not enforce review-on-change). The r3 contract uses an **inline literal expected tree** committed in the test file:

```ts
import {
  DEFAULT_ANTHROPIC_CLIENT_ID,
  DEFAULT_OPENAI_CODEX_CLIENT_ID,
  DEFAULT_GITHUB_COPILOT_CLIENT_ID,
} from "../auth/defaults.js";
import { SaivageConfigSchema } from "../config.js";

const EXPECTED_SEED = {
  models: {},
  providers: {},
  failover: {},
  modelEquivalents: {},
  server: { port: 8080, host: "0.0.0.0" },
  agent: { maxConcurrentAgents: 3 },
  runtime: {
    maxServices: 50,
    restartOnCrash: true,
    continuousImprovement: true,
    healthCheckIntervalMs: 30_000,
    idleShutdownMs: 300_000,
    recoveryDelayMs: 60_000,
    notes: { volatileTtlMs: 2 * 60 * 60 * 1000 },
  },
  security: { injectionScanner: true, maxScanLengthBytes: 100_000 },
  supervisor: {
    enabled: true,
    intervalMs: 20 * 60 * 1000,
    consecutiveStuckVerdicts: 3,
    logLines: 400,
    forceCancelDelayMs: 600_000,
  },
  telegram: { botToken: "", allowedUserIds: [] },
  mcp: {
    shellTimeoutMs: 4 * 60 * 60 * 1000,
    shellTimeoutFloorMs: 10 * 60 * 1000,
    inProcessTimeoutMs: 300_000,
    maxOutputBytes: 100 * 1024,
    maxFetchChars: 200_000,
    maxDownloadBytes: 250 * 1024 * 1024,
  },
  notifications: { channels: ["web"], filters: { min_severity: "info", categories: [] } },
  oauth: {
    anthropic: { clientId: DEFAULT_ANTHROPIC_CLIENT_ID },
    openaiCodex: { clientId: DEFAULT_OPENAI_CODEX_CLIENT_ID },
    githubCopilot: { clientId: DEFAULT_GITHUB_COPILOT_CLIENT_ID },
  },
  mcpServers: {},
};
```

The test asserts:

1. **Producer-output contract.** `JSON.parse(await readFile(saivageJsonPath, "utf-8"))` deep-equals `EXPECTED_SEED`. Catches a producer that diverges from the literal in any direction.
2. **Review-on-change contract.** `SaivageConfigSchema.parse({})` deep-equals `EXPECTED_SEED`. Any change to a `.default(...)` chain in [src/config.ts](../../../../src/config.ts#L62-L192) makes this fail; updating `EXPECTED_SEED` is the deliberate-review act.
3. **Named-regression assertions.** `raw.providers` deep-equals `{}` and `raw.mcpServers` deep-equals `{}`. Redundant with assertion 1 but documents the architectural intent the finding exists to prevent.
4. **Unknown-key guard.** `Object.keys(raw).sort()` deep-equals `Object.keys(SaivageConfigSchema.shape).sort()`. Catches a producer that emits a top-level key the schema does not know about (Zod strips such keys on read; only the raw layer can detect this).
5. **Secondary sanity check.** `readDoc(saivageJsonPath, SaivageConfigSchema)` parses without throwing.

OAuth client IDs are imported from [src/auth/defaults.ts](../../../../src/auth/defaults.ts) by symbol, not duplicated as raw strings. Existing assertions in [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91) survive unchanged.

## 7. Files touched

- [src/config.ts](../../../../src/config.ts#L62) — rename + export `SaivageConfigSchema`; update two internal references at [src/config.ts](../../../../src/config.ts#L194) and [src/config.ts](../../../../src/config.ts#L274).
- [src/store/project.ts](../../../../src/store/project.ts#L8) — add `SaivageConfigSchema` to import from `../config.js`.
- [src/store/project.ts](../../../../src/store/project.ts#L135-L163) — delete literal, replace with two-line `parse({}) + writeDoc(...)`.
- [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91) — add the `EXPECTED_SEED` literal, raw-equality assertions, parse-equals-literal assertion, named-regression assertions, top-level-key check, secondary `readDoc` parse. Add imports: `readDoc` from `./documents.js`, `SaivageConfigSchema` from `../config.js`, the three `DEFAULT_*_CLIENT_ID` from `../auth/defaults.js`, `readFile` from `node:fs/promises`.

## 8. What this does not fix

- **Router-side defaults (G08-followup).** Unconditional Ollama registration at [src/providers/router.ts](../../../../src/providers/router.ts#L731-L749), localhost fallbacks in [src/providers/ollama.ts](../../../../src/providers/ollama.ts#L20-L36) and [src/providers/llamacpp.ts](../../../../src/providers/llamacpp.ts#L10-L19), and the three publishing surfaces at [src/server/server.ts](../../../../src/server/server.ts#L218-L226), [src/server/cli.ts](../../../../src/server/cli.ts#L291-L296), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L141). File as a follow-up at G08 merge.
- **G37** (config sync fs and stale cache) — unrelated; G37 imports `SaivageConfigSchema` after G08 lands.
- **Operators relying on Playwright autostart** — must add a `mcpServers.playwright` entry explicitly. Architecture-first, opt-in MCP servers, no shim.
- **Secret-handling rule** — unchanged. `saivage.json` may carry `providers.<name>.apiKey`, `providers.<name>.baseUrl`, `providers.<name>.authProfile`, `providers.<name>.accounts.*.{apiKey,baseUrl,authProfile}`, and `telegram.botToken` once the operator populates them. The "preserve `saivage.json` across reset workflows unless the operator explicitly regenerates it" rule applies as before.
- **`.default(...)` chain audit** — the design assumes every current default is correct for fresh projects. The plan asks the implementer to walk the schema once before merge; if a default is wrong, fix it in the schema (which will fail the `EXPECTED_SEED` assertion and force a reviewed update), not in the seeder.
