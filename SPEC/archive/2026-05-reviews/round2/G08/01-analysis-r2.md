# G08 — Analysis r2

**Finding**: [../G08-seedproject-writes-saivagejson-without-schema.md](../G08-seedproject-writes-saivagejson-without-schema.md)
**Round-1**: [01-analysis-r1.md](./01-analysis-r1.md)
**Review feedback**: [04-review-r1.md](./04-review-r1.md) (CHANGES_REQUESTED, 4 items)

Round-1 analysis is structurally accurate (bypass location, schema declared private, drift modes, policy leaks, test gap). r2 adds the missing pieces the reviewer flagged: a raw on-disk contract, a provider-side audit, and an explicit statement of what schema defaults will become on-disk seed values once the producer is the schema itself.

## 1. Where the bypass lives (unchanged from r1)

- Project config: [src/store/project.ts](../../../../src/store/project.ts#L132) — schema-validated via `writeDoc(..., ProjectConfigSchema)`.
- Runtime config: [src/store/project.ts](../../../../src/store/project.ts#L135-L163) — 28-line untyped object literal serialised with raw `writeFile`. No `parse`, no `writeDoc`.

The schema lives at [src/config.ts](../../../../src/config.ts#L62-L192) as `const configSchema` (module-private), `export type SaivageConfig = z.infer<typeof configSchema>` at [src/config.ts](../../../../src/config.ts#L194), parsed on read at [src/config.ts](../../../../src/config.ts#L274). The schema must be exported as `SaivageConfigSchema` before the seeder can call `parse({})` against it.

## 2. The raw-default contract (new in r2 — addresses review change 1)

The test the round-1 plan proposed (`readDoc(path, SaivageConfigSchema)` after `seedProject`) is a tautology under Proposal B: `writeDoc` parses the input through the same schema before serialising ([src/store/documents.ts](../../../../src/store/documents.ts#L64-L82)), and `readDoc` parses it again on the way back in ([src/store/documents.ts](../../../../src/store/documents.ts#L18-L22)). Both ends use the same schema and Zod strips unknown keys by default, so the test passes even if the producer accidentally emits extra keys or drifts toward a non-default value.

The contract that actually catches drift is **raw bytes on disk equal `SaivageConfigSchema.parse({})`**. Two reads:

- `JSON.parse(await readFile(path, "utf-8"))` — the literal on-disk shape, no schema involvement on the test side.
- `SaivageConfigSchema.parse({})` — the schema's view of "an empty project's config".

If these are deeply equal, the producer is the schema (no hidden literal, no extra seeded key, no missing default branch). If they diverge, somebody added a non-schema-driven side effect to the producer.

Three explicit absence assertions ride on the same raw read:

- `raw.mcpServers` exists and equals `{}` — old Playwright entry is gone.
- `raw.providers` exists and equals `{}` — old `anthropic / openai / ollama / llamacpp` entries are gone.
- No top-level keys outside `Object.keys(SaivageConfigSchema.shape)`. (Unknown keys would be stripped on read, so a producer typo can only be caught at the raw layer.)

The `readDoc(..., SaivageConfigSchema)` test stays as a secondary sanity check that the seeded file passes the loader's parser, but it is not the regression guard.

## 3. Full-default materialization is intentional (new in r2 — addresses review change 3)

Round-1 design said the seed would emit "the values that matter" ([02-design-r1.md](./02-design-r1.md#L56-L58)). After review, the correct statement is: **the seed emits the full `SaivageConfigSchema.parse({})` tree, by construction.** Because the producer is `parse({})` written through `writeDoc`, every subtree in [src/config.ts](../../../../src/config.ts#L62-L192) that carries a `.default(...)` chain materialises on disk. That includes subtrees the old literal did not touch at all:

- `runtime` — [src/config.ts](../../../../src/config.ts#L96-L109): `maxServices: 50`, `restartOnCrash: true`, `continuousImprovement: true`, `healthCheckIntervalMs: 30_000`, `idleShutdownMs: 300_000`, `recoveryDelayMs: 60_000`, `notes.volatileTtlMs: 7_200_000`.
- `security` — [src/config.ts](../../../../src/config.ts#L111-L117): `injectionScanner: true`, `maxScanLengthBytes: 100_000`. `injectionModel` is optional, omitted.
- `supervisor` — [src/config.ts](../../../../src/config.ts#L119-L127): `enabled: true`, `intervalMs: 1_200_000`, `consecutiveStuckVerdicts: 3`, `logLines: 400`, `forceCancelDelayMs: 600_000`. `model` optional, omitted.
- `telegram` — [src/config.ts](../../../../src/config.ts#L129-L134): `botToken: ""`, `allowedUserIds: []`. The empty token is operator policy made explicit on disk.
- `mcp` — [src/config.ts](../../../../src/config.ts#L136-L162): six numeric defaults, plus the `superRefine` cross-field check fires against the default tree (verified: `4 * 60 * 60 * 1000 > WALL_CLOCK_HEADROOM_MS` and `10 * 60 * 1000 ≤ 14_400_000 - WALL_CLOCK_HEADROOM_MS`).
- `oauth` — [src/config.ts](../../../../src/config.ts#L171-L186): three public client IDs sourced from [src/auth/defaults.ts](../../../../src/auth/defaults.ts) — `DEFAULT_ANTHROPIC_CLIENT_ID`, `DEFAULT_OPENAI_CODEX_CLIENT_ID`, `DEFAULT_GITHUB_COPILOT_CLIENT_ID`. These are not secrets (they are OAuth public client IDs visible in browser flows), but they will now appear in every freshly seeded `saivage.json`.

This is the desired architecture: the schema is the single source of fresh-project state, and "what does a new project look like?" is answered by reading [src/config.ts](../../../../src/config.ts#L62-L192) top to bottom. The raw-equality test from §2 turns any future change to a `.default(...)` chain into a deliberate, reviewed event (the test fails until the reviewer either updates the expected snapshot in the test or rejects the schema-default edit).

What the seed does **not** materialize:

- `optional()` leaves with no default — `models.*`, `security.injectionModel`, `supervisor.model`. These remain absent from the file. The schema-parse leaves them `undefined`.
- Auth credentials — `providers.<name>.accounts.*.apiKey`, `telegram.botToken` value, OAuth tokens. These never lived in `saivage.json` in the first place; they live in `.saivage/auth-profiles.json` under the auth flow, which is unaffected by this finding.

## 4. Provider-consumer audit (new in r2 — addresses review change 2)

Round-1 plan searched only for `playwright`. That misses half the cleanup: deleting `providers.{anthropic,openai,ollama,llamacpp}` from the seed changes what every provider consumer sees on a freshly seeded project. Pre-flight grep results from [src/](../../../../src/):

- [src/providers/router.ts](../../../../src/providers/router.ts#L93) — `this.providerConfigs = config.providers as Record<string, RuntimeProviderConfigLike>;`. Treats `providers` as an arbitrary record. Empty record is a valid state (the router routes by lookup; missing entries surface as routing failures at call time, not at load). No fix needed; behaviour is identical to a user-edited `saivage.json` that lists no providers.
- [src/config.test.ts](../../../../src/config.test.ts#L83-L84) — asserts `config.providers["github-copilot"]?.defaultAccount === "main"` against a hand-rolled fixture in the test, not against a `seedProject` output. Independent of the seeder. No fix needed.

The audit must also cover indirect assumptions that the round-1 plan did not list:

- Any test that calls `seedProject(...)` and then assumes `cfg.providers.anthropic` (or any other name) is present. Grep for `providers.anthropic`, `providers.openai`, `providers.ollama`, `providers.llamacpp`, `providers["...]"` in `src/**/*.test.ts`.
- Any test that asserts `mcpServers.playwright` exists after seeding.
- Web UI code that defaults a provider picker to "anthropic exists because the seed put it there" rather than "anthropic exists because the user configured it".

Pre-flight grep confirms the only direct hit is the seeder literal itself ([src/store/project.ts](../../../../src/store/project.ts#L137-L161)) and the `config.test.ts` fixture (independent of `seedProject`). No production consumer assumes a freshly seeded project has any provider or MCP server present. The plan still runs the audit explicitly as a guard against drift introduced between r1 design and merge.

If the audit surfaces a consumer that assumes seeded providers exist, the architecture-first fix is to teach the consumer to handle `{}` (the schema's documented default), not to add a "compatibility seed" in the producer.

## 5. Test gap (refined from r1)

Round-1 listed three existing assertions and proposed a `readDoc` round-trip test. r2 replaces the round-trip with the raw-equality contract:

Existing in [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91):

- `cfg.notifications.channels === ["web"]` — survives unchanged (schema default).
- `cfg.notifications.filters.min_severity === "info"` — survives unchanged (schema default).
- `cfg.models.orchestrator === undefined` — survives unchanged (optional, no default).

New regression guards:

- **Raw JSON equals `SaivageConfigSchema.parse({})`**. Single deep-equal assertion against the raw read. Catches unknown keys, missing defaults, accidental literal reintroduction, port collisions if the schema ever encodes one, and any future schema-default edit that lands without a test update.
- **`raw.providers` deep-equals `{}`** and **`raw.mcpServers` deep-equals `{}`**. Explicit absence of the old seeded policy, even if the raw-equality test above already covers them transitively — these two are the named regressions the finding exists to prevent.
- **`Object.keys(raw).sort()` equals `Object.keys(SaivageConfigSchema.shape).sort()`** (after filtering optional-no-default leaves at the top level — none today, but the assertion documents the contract). Catches a producer that emits a key the schema does not know about.
- **`readDoc(path, SaivageConfigSchema)` parses cleanly**. Secondary sanity check that the loader still accepts what the seeder writes.

## 6. Cross-links (unchanged structurally)

- **F22 (round 1) — atomic writes via `writeDoc`.** This finding extends F22 to `saivage.json`.
- **F33 (round 1) — `seedProject` rename.** This finding completes F33's intent for runtime config.
- **G37 — config sync fs and stale cache.** G37 depends on `SaivageConfigSchema` being exported; land G08 first.
- **G47 — telegram-bot auth and startup.** Seeded `telegram.botToken = ""` is now materialized; G47 should treat the empty-string token as "operator-empty" and not crash on it.
- **`ml-workspace-saivage-ops` memory note** — the "restore preserved `saivage.json` after seeding" workaround stays for auth-bearing fields (provider account tokens, telegram bot token value) but the producer no longer clobbers MCP server policy or provider endpoints. Update the memory note only after the seed-check validation in the plan passes.
