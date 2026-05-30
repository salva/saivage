# G08 — Analysis r1

**Finding**: [../G08-seedproject-writes-saivagejson-without-schema.md](../G08-seedproject-writes-saivagejson-without-schema.md)
**Subsystem**: store (project init)
**Round-1 reference**: F33 renamed `initProject` → `seedProject` and trimmed `ProjectConfig` to project-scoped fields; the `saivage.json` seeding path inside `seedProject` was carried over verbatim from `initProject` and never reconciled with the round-1 `writeDoc(path, value, Schema)` discipline.

## 1. Where the bypass lives

`seedProject` writes two canonical config files:

- Project config: [src/store/project.ts](../../../../src/store/project.ts#L132) — `await writeDoc(configPath, config, ProjectConfigSchema);`. Typed (`const config: ProjectConfig`), validated by the same Zod schema the loader uses on read, atomic via the `writeDoc` rename dance in [src/store/documents.ts](../../../../src/store/documents.ts#L1-L40).
- Runtime config: [src/store/project.ts](../../../../src/store/project.ts#L135-L163) — a bare object literal serialised with `JSON.stringify` and written through `writeFile` directly. No type annotation. No `parse`. No `writeDoc`.

`writeFile` is imported at [src/store/project.ts](../../../../src/store/project.ts#L7) from `node:fs/promises` and used only by this seed path and by `initProjectTree` for the empty index/audit/.gitignore files (where the absence of a schema is fine — those are not config documents). Removing the `saivage.json` raw write leaves `writeFile` still needed for the index/audit files, so the import stays.

## 2. The schema the seed bypasses

The runtime config schema is declared in [src/config.ts](../../../../src/config.ts#L62-L192) as `const configSchema` (module-private) with `export type SaivageConfig = z.infer<typeof configSchema>` at [src/config.ts](../../../../src/config.ts#L194). Read-side validation lives in `loadConfig` at [src/config.ts](../../../../src/config.ts#L274) — `cached = configSchema.parse(interpolated);`. The schema is the single source of truth for shape and is consumed exactly once (on load); the writer is the only producer that creates the file from scratch and it never sees the schema.

Three structural consequences:

- The schema name in the finding (`SaivageConfigSchema`) does not exist as an exported symbol. To pass the seed through the schema the const must be exported (`export const SaivageConfigSchema = configSchema;` or renamed). This is a precondition for either proposal in the design document.
- The seed literal has no type annotation. TypeScript treats it as a fresh structural type. Drift between literal and schema is a fact about strings (`"min_severity"`, `"web"`) that the compiler never checks.
- `loadConfig` is cached at [src/config.ts](../../../../src/config.ts#L268-L276). A bad seed survives the seeding process (no read) and only surfaces on the next cold start when the loader throws a Zod error during `bootstrap`. The unit tests in [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91) happen to call `loadConfig(true, projectRoot)` after seeding and so would catch *some* shape drift today, but only the two fields they assert on (`notifications.channels`, `notifications.filters.min_severity`, absence of `models.orchestrator`). Adding or renaming any other field in `configSchema` would not break these tests.

## 3. What can drift, concretely

The literal at [src/store/project.ts](../../../../src/store/project.ts#L135-L163) names ten keys (`providers`, `failover`, `modelEquivalents`, `server`, `agent`, `notifications`, `mcpServers`) and inlines values for nested ones. The schema declares fifteen top-level keys at [src/config.ts](../../../../src/config.ts#L62-L192): `models`, `providers`, `failover`, `modelEquivalents`, `server`, `agent`, `runtime`, `security`, `supervisor`, `telegram`, `mcp`, `notifications`, `oauth`, `mcpServers`, plus a `superRefine` on `mcp`. Each subtree carries its own defaults.

Drift modes that the bypass cannot catch:

- **Rename**: `notifications.filters.min_severity` → `notifications.filters.minSeverity` (or similar snake/camel migration). The literal keeps the old key; the loader, after the schema change, parses it through the new schema which silently drops the unknown key and substitutes the default. The seeded file is now semantically wrong on first read (`"info"` instead of operator-chosen value) with no signal at seed time.
- **Constriction**: a future change tightens `mcp.shellTimeoutMs` via `superRefine` (already present at [src/config.ts](../../../../src/config.ts#L143-L163)). The literal does not set `mcp` at all, so `configSchema.parse({})` would produce the default which today satisfies the refinement — but a tightened floor against a smaller default would fail at load. The seed would not catch the regression even though the loader will.
- **Expansion with a required field**: any new top-level key added without a `.default(...)` chain (currently every key has one, but the precedent is one line of human discipline) makes the literal-derived file fail `parse` at load. The seed succeeds; the agent boot fails seconds later in a separate code path with a Zod error message naming the new key, not the seeder.
- **Port collision**: `server.port = 8080` and `llamacpp.baseUrl = "http://localhost:8080"` collide. The schema does not (and arguably should not) refuse this, but the value is silently wrong for any colocated llama.cpp + Saivage deployment. Pure policy, see §4.
- **Provider hardcoding**: the literal includes `providers: { anthropic: {}, openai: {}, ollama: {...}, llamacpp: {...} }`. Each empty `{}` is parsed through `runtimeProviderConfigSchema` at [src/config.ts](../../../../src/config.ts#L31-L36) and acquires `priority: 100`, `accounts: {}`. That is operator policy (which providers exist on this project) being baked into the seeder.

## 4. Policy leaks (related but separable)

These are not schema bypasses; they are decisions that the seeder makes on behalf of every project that ever calls `seedProject`:

- **MCP autostart**: the literal hardcodes a Playwright MCP server entry with `disabled: false, autostart: true`. Every fresh project gets a browser autostart whether the project needs one or not. Cross-finding with G12 (prompt-injection cop fail-open silent): combined attack-surface expansion that an operator did not opt into.
- **Server bind**: `server.host = "0.0.0.0"` plus `server.port = 8080`. Acceptable as a *schema* default but the seeder bakes it into the file, so an operator who wants `127.0.0.1` has to delete and re-write rather than override at runtime.
- **Provider baseUrls**: hardcoded `localhost:11434` (ollama) and `localhost:8080` (llamacpp). Wrong for every multi-host deployment, including the `saivage-v3` / `saivage-v3-getrich-v2` LXC pair where the providers may live in a third container.

The first proposal in the design keeps these literals and just validates them. The second proposal removes them entirely by deferring to schema defaults — operators add what they need.

## 5. Test gap

[src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91) has exactly two assertions on `saivage.json`:

- `cfg.notifications.channels === ["web"]`
- `cfg.notifications.filters.min_severity === "info"`
- `cfg.models.orchestrator === undefined`

That's it. There is no test that the seed parses successfully through `configSchema` end-to-end (the assertions happen to call `loadConfig(true, …)` which performs the parse as a side effect, so a parse-failing seed would throw during `loadConfig` and fail the suite — but only because of those incidental calls, not because of a contract). No test pins the on-disk shape against the schema generally. No test fails if the literal grows a typo in `runtime.notes.volatileTtlMs`. No test asserts that the seed contains *no* keys outside the schema (Zod strips unknown keys by default, so even a typo'd key passes silently).

## 6. Cross-links

- **F22 (round 1) — atomic writes via `writeDoc`.** This file undermines that invariant for the single most security-sensitive config in the project. The fix is one `writeDoc` call away.
- **F33 (round 1) — `initProject` → `seedProject`.** The bypass predates F33 and survived the rename because F33 was scoped to `ProjectConfig` shape only.
- **G37 — config sync fs and stale cache.** G37 will rewrite `loadConfig`'s I/O path; this fix should land first so the rewrite has a producer that actually emits schema-valid documents.
- **`ml-workspace-saivage-ops` memory note**: "When resetting GetRich v2 Saivage state, `initProjectTree`/seed helpers can clobber `.saivage/saivage.json`; restore preserved `saivage.json` and `auth-profiles.json` after seeding." That workaround exists because the seeder owns runtime policy. Proposal B in the design removes the need for the workaround entirely; Proposal A only narrows it.
