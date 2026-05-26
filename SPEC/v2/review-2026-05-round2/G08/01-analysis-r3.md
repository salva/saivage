# G08 — Analysis r3

**Finding**: [../G08-seedproject-writes-saivagejson-without-schema.md](../G08-seedproject-writes-saivagejson-without-schema.md)
**Round-1**: [01-analysis-r1.md](./01-analysis-r1.md)
**Round-2**: [01-analysis-r2.md](./01-analysis-r2.md)
**Review feedback**: [04-review-r2.md](./04-review-r2.md) (CHANGES_REQUESTED, 3 items)

Direction unchanged from r2: Proposal B, schema-driven seed. r3 corrects three substantive errors in r2: the secret-handling claim was wrong, the provider-default audit scope was overstated, and the raw-equality test did not actually enforce review-on-change.

## r3 deltas vs r2

- **Δ1 (r2 review change 1) — Secrets / auth-bearing data in saivage.json.** r2 §3 and §6 claimed provider apiKey, telegram.botToken value, and OAuth tokens never lived in `saivage.json` and that the memory note's "restore preserved `saivage.json` after seeding" workaround applies only to fields that never lived there. That contradicts the schema. Corrected in §3 ("Empty default vs. operator-owned file") and §6 ("Cross-links").

- **Δ2 (r2 review change 2) — Provider-default audit scope.** r2 §4 claimed "no production consumer assumes a freshly seeded project has any provider or MCP server present" and treated the seeded-literal cleanup as removing the hardcoded localhost endpoints. Corrected in §4 ("Provider-consumer audit, corrected scope"): G08 removes persisted provider policy from newly seeded `saivage.json` only; the router still registers Ollama unconditionally and Ollama / llama.cpp still default to localhost in the provider classes. Cross-linked to a new follow-up finding (G08-followup), not folded into G08 — see §4 for the justification.

- **Δ3 (r2 review change 3) — Raw-default test is now a real review-on-change contract.** r2 §2 compared `JSON.parse(raw)` to `SaivageConfigSchema.parse({})` in the test; both sides move together when a `.default(...)` chain changes, so schema-default edits passed silently. Corrected in §2 ("The raw-default contract") and §5 ("Test gap"): the regression guard is an inline literal expected-tree committed into the test file; schema-default changes force a deliberate snapshot update.

## 1. Where the bypass lives (unchanged from r2)

- Project config: [src/store/project.ts](../../../../src/store/project.ts#L132) — schema-validated via `writeDoc(..., ProjectConfigSchema)`.
- Runtime config: [src/store/project.ts](../../../../src/store/project.ts#L135-L163) — 28-line untyped object literal serialised with raw `writeFile`. No `parse`, no `writeDoc`.

The schema lives at [src/config.ts](../../../../src/config.ts#L62-L192) as `const configSchema` (module-private), `export type SaivageConfig = z.infer<typeof configSchema>` at [src/config.ts](../../../../src/config.ts#L194), parsed on read at [src/config.ts](../../../../src/config.ts#L274). The schema must be exported as `SaivageConfigSchema` before the seeder can call `parse({})` against it.

## 2. The raw-default contract (corrected)

The test the round-1 plan proposed (`readDoc(path, SaivageConfigSchema)` after `seedProject`) is a tautology under Proposal B: `writeDoc` parses input through the schema before serialising ([src/store/documents.ts](../../../../src/store/documents.ts#L64-L82)), and `readDoc` parses again on the way back in ([src/store/documents.ts](../../../../src/store/documents.ts#L18-L22)). Both ends use the same schema and Zod strips unknown keys by default.

r2 replaced this with `expect(raw).toEqual(SaivageConfigSchema.parse({}))`. That catches a producer that diverges from the schema (good), but it does **not** make schema-default edits a reviewed event: both sides of the comparison move together when a `.default(...)` chain changes. r2's "deliberate review" claim was unsupported.

r3 changes the contract: the expected tree is a **literal object** committed inline in the test file, listing every default value. Concretely:

```ts
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

The three OAuth client IDs are imported from [src/auth/defaults.ts](../../../../src/auth/defaults.ts) by symbol, not duplicated as raw strings — they are public values but they belong to the auth subsystem, and importing them keeps the test honest if the underlying constant is rotated.

The test asserts two things from this literal:

1. `JSON.parse(await readFile(saivageJsonPath, "utf-8"))` deep-equals `EXPECTED_SEED`. This is the producer-output contract.
2. `SaivageConfigSchema.parse({})` deep-equals `EXPECTED_SEED`. This is the review-on-change contract: changing any `.default(...)` chain in [src/config.ts](../../../../src/config.ts#L62-L192) makes this assertion fail until `EXPECTED_SEED` is updated, forcing the change through code review.

Three explicit absence assertions ride on the same raw read for self-documentation:

- `raw.mcpServers` equals `{}` — old Playwright entry is gone.
- `raw.providers` equals `{}` — old `anthropic / openai / ollama / llamacpp` entries are gone.
- `Object.keys(raw).sort()` equals `Object.keys(SaivageConfigSchema.shape).sort()` filtered to fields without `.default(...)` excluded (today: none) — catches a producer that emits a top-level key the schema does not know about (Zod would strip such keys on read, so only the raw layer can detect this).

The `readDoc(..., SaivageConfigSchema)` parse stays as a secondary sanity check that the seeded file passes the loader; it is no longer the regression guard.

## 3. Empty default vs. operator-owned file (corrected)

r2 made a security claim that does not survive a schema read. The actual schema permits secrets and auth-adjacent routing data inside `saivage.json`:

- [src/config.ts](../../../../src/config.ts#L14-L29) — `runtimeProviderAccountSchema` declares `apiKey` (optional), `baseUrl` (optional), `authProfile` (optional) per account.
- [src/config.ts](../../../../src/config.ts#L31-L36) — `runtimeProviderConfigSchema` extends the account schema (same three fields at the provider top level) and adds `accounts: z.record(...)`.
- [src/config.ts](../../../../src/config.ts#L76) — `providers: z.record(z.string(), runtimeProviderConfigSchema).default({})` puts the whole tree under `SaivageConfig.providers`.
- [src/config.ts](../../../../src/config.ts#L129-L134) — `telegram.botToken: z.string().default("")` puts the bot token value (when set) directly into `saivage.json`.

The new seed writes the schema defaults: `providers: {}` and `telegram.botToken: ""`. Both are empty by construction; the freshly seeded file contains zero auth-bearing data. **But that is a property of the new producer, not of the file format.** Existing operator-owned `saivage.json` files on the harnesses may contain populated `apiKey`, `baseUrl`, `authProfile`, or `telegram.botToken` values, and the schema allows new operators to populate them later as well (the auth flow stores OAuth tokens in `.saivage/auth-profiles.json`, but static API keys and bot-token values are operator-permitted in `saivage.json`).

Consequence for the workspace memory note (`ml-workspace-saivage-ops`):

- **r2's proposed memory update is wrong and must not land.** It told future operators that `saivage.json` never contains secrets and so the "restore preserved `saivage.json` after seeding" workaround only protects fields that never lived there. That weakens an existing operational safeguard.
- **r3 keeps the existing rule**: treat `saivage.json` as sensitive (it may contain provider apiKey/baseUrl/authProfile and `telegram.botToken`), and preserve it across reset workflows unless the operator explicitly regenerates it. After G08 lands, the workaround applies to the same fields it always did, plus the new on-disk presence of empty `telegram.botToken: ""` and empty `providers: {}` in freshly seeded files. The plan does **not** edit user memory; if the memory needs any update it is to emphasise the rule, not to relax it.

## 4. Provider-consumer audit, corrected scope (review change 2)

r2 §4 said "no production consumer assumes a freshly seeded project has any provider or MCP server present". That is true for `saivage.json`-driven consumers (router treats `config.providers` as an arbitrary record, [src/providers/router.ts](../../../../src/providers/router.ts#L93)), but it overstated what the change accomplishes. The system has **registered-provider defaults outside the seed file** that survive G08 unchanged:

- [src/providers/router.ts](../../../../src/providers/router.ts#L731-L749) — `shouldRegisterProvider("ollama")` returns `true` unconditionally; Ollama is always registered regardless of `config.providers`.
- [src/providers/router.ts](../../../../src/providers/router.ts#L804) — `createProvider("ollama")` constructs `new OllamaProvider(baseUrl, ...)`. With `providers.ollama` absent (the new seed), `baseUrl` is `undefined` and Ollama falls back to its own default.
- [src/providers/ollama.ts](../../../../src/providers/ollama.ts#L20-L36) — `OllamaProvider` defaults to `http://localhost:11434/v1` when `baseUrl` and `OLLAMA_BASE_URL` are unset.
- [src/providers/llamacpp.ts](../../../../src/providers/llamacpp.ts#L10-L19) — `LlamaCppProvider` constructor defaults to `http://localhost:8080` when both `baseUrl` and `LLAMACPP_BASE_URL` are unset. (`shouldRegisterProvider("llamacpp")` at [src/providers/router.ts](../../../../src/providers/router.ts#L747-L748) does require some signal, so llama.cpp is only registered when configured; but if it is registered without an explicit `baseUrl`, it still falls back to localhost.)

These defaults surface through three external interfaces, all visible on a freshly seeded project:

- [src/server/server.ts](../../../../src/server/server.ts#L218-L226) — `GET /api/providers` walks `router.listProviders()` and reports each registered provider plus its model list.
- [src/server/cli.ts](../../../../src/server/cli.ts#L291-L296) — the `models` CLI command iterates `router.listProviders()` and prints each one.
- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L141) — startup logs `Providers: ${router.listProviders().join(", ")}` and the list includes `ollama` even with `providers: {}`.

**Precise G08 scope, corrected**: G08 removes the seeded provider policy literal from newly seeded `saivage.json` only — that is, the `providers.{anthropic, openai, ollama, llamacpp}` placeholders and their hardcoded `baseUrl` strings. G08 does **not** remove unconditional Ollama registration in the router, does **not** remove localhost defaults in `OllamaProvider` / `LlamaCppProvider`, and does **not** change `/api/providers`, the CLI `models` command, or the bootstrap startup log behaviour.

**Decision: cross-link to a follow-up, do not extend G08.** Justification:

- The router-side defaults are an independent design choice (unconditional `ollama` registration, baseUrl fallback to localhost in the provider class) that exists for legitimate operator convenience on single-host installs. Removing them changes the runtime contract for every existing project, not just newly seeded ones.
- G08's scope as filed is the schema-bypass at the seeder's write path. Folding router and provider-class changes into G08 turns a small, well-scoped refactor into a behavioural change across three external interfaces and would force re-review of the entire routing layer.
- The architecture-first rule does not require collapsing unrelated findings; it requires not preserving the broken layer. G08 keeps the seeder layer broken-free; the router layer is a separate finding worth filing.

A new finding (working name: G08-followup, to be filed alongside the G08 merge) covers the router-side defaults and the three external surfaces. Until that finding lands, operators inspecting a freshly seeded project will see `ollama` in the provider list with a localhost endpoint — a behaviour change from r2's implied claim, but identical to the current pre-G08 behaviour for projects whose operator never edits `providers.ollama`.

The producer-side audit (the only audit G08 actually owns) is documented in §5.

## 5. Test gap and producer-side audit (refined)

Producer-side audit — what changes when the seed stops emitting `providers.{anthropic,openai,ollama,llamacpp}` and `mcpServers.playwright`:

- [src/providers/router.ts](../../../../src/providers/router.ts#L93) — `this.providerConfigs = config.providers`; arbitrary-record handling, `{}` is valid. No fix.
- [src/config.test.ts](../../../../src/config.test.ts#L83-L84) — hand-rolled fixture, independent of `seedProject`. No fix.
- [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) — any string reference to `playwright` is in tool descriptions, not registration. No fix.
- The plan re-runs the audit at implementation time as a drift guard (grep patterns enumerated in [03-plan-r3.md](./03-plan-r3.md)).

Test contract — what the new tests assert:

Existing in [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91) (survive unchanged): `cfg.notifications.channels === ["web"]`, `cfg.notifications.filters.min_severity === "info"`, `cfg.models.orchestrator === undefined`.

New (§2):

- **`raw === EXPECTED_SEED`** (inline literal). Producer-output contract.
- **`SaivageConfigSchema.parse({}) === EXPECTED_SEED`**. Review-on-change contract.
- **`raw.providers === {}` and `raw.mcpServers === {}`**. Named-regression documentation.
- **Top-level keys match `SaivageConfigSchema.shape`**. Catches a producer emitting an unknown key.
- **`readDoc(saivageJsonPath, SaivageConfigSchema)` parses without throwing**. Secondary sanity check.

## 6. Cross-links

- **F22 (round 1) — atomic writes via `writeDoc`.** G08 extends F22 to `saivage.json`.
- **F33 (round 1) — `seedProject` rename.** G08 completes F33's intent for runtime config.
- **G37 — config sync fs and stale cache.** G37 depends on `SaivageConfigSchema` being exported; land G08 first.
- **G47 — telegram-bot auth and startup.** Seeded `telegram.botToken = ""` is now explicit on disk. G47 should treat the empty-string token as operator-unconfigured and skip bot startup gracefully.
- **G08-followup (new, to be filed)** — unconditional Ollama registration in [src/providers/router.ts](../../../../src/providers/router.ts#L731-L749), localhost fallback in [src/providers/ollama.ts](../../../../src/providers/ollama.ts#L20-L36) and [src/providers/llamacpp.ts](../../../../src/providers/llamacpp.ts#L10-L19), and the three surfaces that publish them: [src/server/server.ts](../../../../src/server/server.ts#L218-L226), [src/server/cli.ts](../../../../src/server/cli.ts#L291-L296), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L141).
- **`ml-workspace-saivage-ops` memory note.** Do not weaken the "preserve `saivage.json` across resets" rule. `saivage.json` can contain `providers.<name>.apiKey`, `providers.<name>.accounts.*.apiKey`, `providers.<name>.baseUrl`, `providers.<name>.authProfile`, and `telegram.botToken` per [src/config.ts](../../../../src/config.ts#L14-L17), [src/config.ts](../../../../src/config.ts#L76), and [src/config.ts](../../../../src/config.ts#L129-L132); these may carry secrets or auth-adjacent routing the operator has set. The new producer writes none of them on a fresh seed, but the file remains operator-owned and sensitive once populated. The plan does not edit memory.
