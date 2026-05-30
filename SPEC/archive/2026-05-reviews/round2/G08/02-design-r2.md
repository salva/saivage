# G08 — Design r2

**Finding**: [../G08-seedproject-writes-saivagejson-without-schema.md](../G08-seedproject-writes-saivagejson-without-schema.md)
**Analysis**: [./01-analysis-r2.md](./01-analysis-r2.md)
**Round-1**: [02-design-r1.md](./02-design-r1.md)
**Review feedback**: [04-review-r1.md](./04-review-r1.md) (B confirmed as the right design after revisions)

Single proposal: schema-driven seed (Proposal B from r1, refined per review). Proposal A from r1 is dropped — the reviewer confirmed B is the architecture-first choice and the workspace policy forbids the two-source-of-defaults arrangement that A preserves.

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

**This is the design's central architectural commitment.** Because `SaivageConfigSchema.parse({})` flows through `writeDoc`, the fresh `saivage.json` contains every `.default(...)` value declared in [src/config.ts](../../../../src/config.ts#L62-L192). That is more than the old literal emitted. The expansion is deliberate; it is the mechanism by which the schema becomes the single source of truth for fresh-project state.

What materializes that the old literal did not:

| Subtree | Source | What appears on disk |
|---|---|---|
| `runtime` | [src/config.ts](../../../../src/config.ts#L96-L109) | `maxServices`, `restartOnCrash`, `continuousImprovement`, `healthCheckIntervalMs`, `idleShutdownMs`, `recoveryDelayMs`, `notes.volatileTtlMs` |
| `security` | [src/config.ts](../../../../src/config.ts#L111-L117) | `injectionScanner`, `maxScanLengthBytes` (`injectionModel` omitted — optional, no default) |
| `supervisor` | [src/config.ts](../../../../src/config.ts#L119-L127) | `enabled`, `intervalMs`, `consecutiveStuckVerdicts`, `logLines`, `forceCancelDelayMs` (`model` omitted) |
| `telegram` | [src/config.ts](../../../../src/config.ts#L129-L134) | `botToken: ""`, `allowedUserIds: []` |
| `mcp` | [src/config.ts](../../../../src/config.ts#L136-L162) | `shellTimeoutMs`, `shellTimeoutFloorMs`, `inProcessTimeoutMs`, `maxOutputBytes`, `maxFetchChars`, `maxDownloadBytes` |
| `oauth` | [src/config.ts](../../../../src/config.ts#L171-L186) | `anthropic.clientId`, `openaiCodex.clientId`, `githubCopilot.clientId` — values from [src/auth/defaults.ts](../../../../src/auth/defaults.ts) |

Specific notes:

- **`telegram.botToken: ""`** — the empty string is intentional on disk. Operators set the actual token via the auth flow (which writes to `.saivage/auth-profiles.json`, separate file). The presence of the empty key documents the field's existence to operators inspecting the file.
- **Public OAuth client IDs** — the three `DEFAULT_*_CLIENT_ID` constants from [src/auth/defaults.ts](../../../../src/auth/defaults.ts) are public values used in browser-visible OAuth flows; they are not secrets. Materializing them on disk lets an operator audit "what client am I authenticating as?" without reading source code.
- **`mcp.superRefine` against defaults** — [src/config.ts](../../../../src/config.ts#L143-L163) requires `shellTimeoutMs > WALL_CLOCK_HEADROOM_MS` and `shellTimeoutFloorMs ≤ shellTimeoutMs - WALL_CLOCK_HEADROOM_MS`. Verified by inspection: defaults pass. If a future schema edit breaks this, `parse({})` throws inside `writeDoc`, and the seeder fails loudly at seed time rather than at first boot.

The raw-equality test in §6 makes any future change to a `.default(...)` chain (or any addition of a new top-level key) a reviewed event — the snapshot in the test must be updated deliberately when the schema changes.

## 4. Removed policy leaks

The old literal embedded operator policy directly. The schema-driven seed removes:

- **`mcpServers.playwright`** — Playwright autostart on every fresh project, regardless of whether the project needs a browser. Operators who need Playwright add it explicitly to `mcpServers`.
- **`providers.anthropic: {}`, `providers.openai: {}`** — empty placeholders that implied "this project supports these providers" before any account was configured.
- **`providers.ollama: { baseUrl: "http://localhost:11434" }`, `providers.llamacpp: { baseUrl: "http://localhost:8080" }`** — hardcoded localhost endpoints wrong for any multi-host deployment (including the workspace's three LXC containers).
- **The latent `server.port: 8080` vs `llamacpp.baseUrl: ":8080"` collision** — auto-resolves; no llamacpp baseUrl is seeded.

Architecture-first: no fallback seed, no "legacy compatibility" branch, no migration shim. Existing `.saivage/saivage.json` files written by the old seeder retain their Playwright/provider entries and continue to load (the schema permits any record of MCP servers and providers); only newly seeded projects get the clean default. Operators who want to reset to the new defaults run `rm .saivage/saivage.json && saivage init <path>`.

## 5. Provider consumer audit (review change 2)

Deleting `providers.{anthropic,openai,ollama,llamacpp}` from the seed changes what every provider consumer sees on a fresh project. Pre-flight audit (results from grep on [src/](../../../../src/)):

- [src/providers/router.ts](../../../../src/providers/router.ts#L93) — treats `config.providers` as an arbitrary record, handles `{}` correctly.
- [src/config.test.ts](../../../../src/config.test.ts#L83-L84) — uses a hand-rolled fixture, independent of `seedProject`.
- No other producer or test asserts that `seedProject` outputs any specific provider name.

The plan re-runs the audit at implementation time as a guard against drift introduced between this design and merge. The search patterns are explicit in [03-plan-r2.md](./03-plan-r2.md). If a hit appears, the fix is to teach the consumer (or its test) to handle `providers === {}`, not to add a compatibility seed in the producer.

## 6. Test contract (review change 1)

Replace the round-1 `readDoc(path, SaivageConfigSchema)` round-trip — that test is a tautology because `writeDoc` and `readDoc` parse through the same schema, and Zod strips unknown keys.

**Primary regression guard**: raw on-disk JSON deep-equals `SaivageConfigSchema.parse({})`.

```ts
const raw = JSON.parse(await readFile(saivageJsonPath, "utf-8"));
expect(raw).toEqual(SaivageConfigSchema.parse({}));
```

This single assertion catches:

- Reintroduction of any hardcoded literal in the producer.
- A new top-level key the producer emits but the schema doesn't know about (Zod would strip it on read; raw-equality catches it).
- A `.default(...)` chain that drifts away from the seeded snapshot — fails until the test is updated, which is the deliberate-review property the reviewer asked for.
- Re-emergence of `mcpServers.playwright`, `providers.anthropic`, `providers.ollama`, etc.

**Explicit absence assertions** (named regressions the finding exists to prevent):

```ts
expect(raw.providers).toEqual({});
expect(raw.mcpServers).toEqual({});
```

Redundant with the raw-equality test above but documents the architectural intent in the test name.

**Secondary sanity check** (kept from r1):

```ts
const cfg = await readDoc(saivageJsonPath, SaivageConfigSchema);
expect(cfg).toBeDefined();
```

Confirms the seeded file passes the loader's parser. Not the regression guard.

**Existing assertions** in [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91) survive unchanged — `notifications.channels === ["web"]`, `notifications.filters.min_severity === "info"`, `cfg.models.orchestrator === undefined`. Values come from schema defaults under the new producer, so the tests pass for the same observable reason but a different mechanism.

## 7. Files touched

- [src/config.ts](../../../../src/config.ts#L62) — rename + export `SaivageConfigSchema`; update two internal references at [src/config.ts](../../../../src/config.ts#L194) and [src/config.ts](../../../../src/config.ts#L274).
- [src/store/project.ts](../../../../src/store/project.ts#L8) — add `SaivageConfigSchema` to import from `../config.js`.
- [src/store/project.ts](../../../../src/store/project.ts#L135-L163) — delete literal, replace with two-line `parse({}) + writeDoc(...)`.
- [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91) — add raw-equality test, explicit empty `providers` / `mcpServers` assertions, and the secondary `readDoc` parse. Import `readDoc` from `./documents.js`, `SaivageConfigSchema` from `../config.js`, `readFile` from `node:fs/promises`.

## 8. What this does not fix

- **G37** (config sync fs and stale cache) is unrelated; this design uses `loadConfig` only inside tests/validation, not at seed time. G37 still wants its own fix.
- **Operators relying on Playwright autostart** must add a `mcpServers.playwright` entry explicitly. This is the architecture-first trade — opt-in MCP servers. No migration shim per workspace policy.
- **`.default(...)` chain audit** — the design assumes every default currently in [src/config.ts](../../../../src/config.ts#L62-L192) is the right value for a fresh project. The plan asks the implementer to walk the schema once before merge; if a default is wrong, fix it in the schema, not in the seeder.
