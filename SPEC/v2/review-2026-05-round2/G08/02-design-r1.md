# G08 — Design r1

**Finding**: [../G08-seedproject-writes-saivagejson-without-schema.md](../G08-seedproject-writes-saivagejson-without-schema.md)
**Analysis**: [./01-analysis-r1.md](./01-analysis-r1.md)

Two proposals. A closes the schema bypass while keeping the seeder as the owner of runtime defaults. B retires the literal entirely and lets `SaivageConfigSchema` defaults be the single source of truth. Recommendation in §3.

Both proposals share one precondition: export the schema. Today [src/config.ts](../../../../src/config.ts#L62) declares `const configSchema` privately. Rename to `export const SaivageConfigSchema = z.object({...})` and replace internal references at [src/config.ts](../../../../src/config.ts#L194) (`export type SaivageConfig = z.infer<typeof SaivageConfigSchema>;`) and [src/config.ts](../../../../src/config.ts#L274) (`cached = SaivageConfigSchema.parse(interpolated);`).

---

## Proposal A — Validate the literal on the way to disk

### Shape

Keep the literal at [src/store/project.ts](../../../../src/store/project.ts#L135-L163) but type it as `SaivageConfig`, pass it through `writeDoc(saivageJsonPath, saivageJson, SaivageConfigSchema)`, and drop the raw `writeFile` call. The compiler now catches shape drift at edit time and the Zod parse inside `writeDoc` catches anything the type system misses (e.g. enum values, the `mcp.superRefine` cross-field rule).

The hardcoded Playwright MCP, the `localhost:8080` llamacpp baseUrl, and the `server.host = "0.0.0.0"` literal **stay**. This proposal is scoped to closing the schema bypass.

### Files touched

- [src/config.ts](../../../../src/config.ts#L62) — rename `configSchema` to `SaivageConfigSchema` and export it; update the two internal references at [src/config.ts](../../../../src/config.ts#L194) and [src/config.ts](../../../../src/config.ts#L274).
- [src/store/project.ts](../../../../src/store/project.ts#L8) — add `SaivageConfigSchema` and `type SaivageConfig` to the existing import from `../config.js`.
- [src/store/project.ts](../../../../src/store/project.ts#L135-L163) — type the literal as `const saivageJson: SaivageConfig = { ... }`; resolve the `llamacpp` baseUrl collision with `server.port` (e.g. `http://localhost:8081`) since `SaivageConfig` permits it but the literal currently emits an obviously-wrong value; replace the `await writeFile(saivageJsonPath, JSON.stringify(saivageJson, null, 2) + "\n", "utf-8")` line with `await writeDoc(saivageJsonPath, saivageJson, SaivageConfigSchema)`.
- [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91) — add a test that calls `seedProject` and then `await readDoc(join(projectRoot, ".saivage", "saivage.json"), SaivageConfigSchema)`; the read-side `parse` exercises the same contract from the test harness so a future literal drift fails the test even if the assertions in §77-91 don't cover the drifted field.

### Deletion list

- The bare `await writeFile(saivageJsonPath, JSON.stringify(saivageJson, null, 2) + "\n", "utf-8")` at [src/store/project.ts](../../../../src/store/project.ts#L163).
- No other deletions. The literal stays.

### Test impact

- One new test in [src/store/project.test.ts](../../../../src/store/project.test.ts) (`it("writes a schema-valid saivage.json")`) that round-trips the seed through `readDoc(…, SaivageConfigSchema)`.
- Existing `notifications.channels` and `min_severity` assertions still pass.
- No production-runtime tests affected.

### What this does *not* fix

- The seeder still owns runtime policy (Playwright autostart, ollama/llamacpp endpoints, server bind). The `ml-workspace-saivage-ops` workaround ("restore preserved `saivage.json` after seeding") remains necessary.
- The schema and the literal still exist in two places — every new top-level key in `SaivageConfigSchema` requires a matching edit in the literal (or a default chain) to remain non-empty. Drift between *intended* defaults and *literal* values is still possible; only structural drift is now caught.
- The Playwright MCP autostart, flagged in the finding as a policy leak, is unchanged.

---

## Proposal B — Generate the default from the schema

### Shape

Delete the literal entirely. Replace it with `const saivageJson = SaivageConfigSchema.parse({});`. Every top-level key in `SaivageConfigSchema` already has a `.default(...)` chain (verified at [src/config.ts](../../../../src/config.ts#L62-L192)), so `parse({})` produces a fully-populated `SaivageConfig` whose values are exactly the schema's documented defaults. The seeder no longer owns runtime policy; the schema does.

This implies a corresponding tightening of schema defaults so that the seeded file is operationally sound:

- `providers` stays `z.record(...).default({})` — the seeded file has `"providers": {}`, and operators add accounts via the auth flow (which already writes to `.saivage/auth-profiles.json`, not `saivage.json`). The hardcoded `anthropic: {}`, `openai: {}`, `ollama: { baseUrl: "http://localhost:11434" }`, `llamacpp: { baseUrl: "http://localhost:8080" }` entries disappear — they were never required by the schema and `loadConfig` is happy with `{}`.
- `mcpServers` stays `z.record(...).default({})` — the Playwright entry disappears. Operators add MCP servers explicitly when they need them. Closes the "Playwright autostart whether you want it or not" policy leak the finding calls out.
- `server.port` (8080), `server.host` ("0.0.0.0"), `agent.maxConcurrentAgents` (3), `notifications.channels` (["web"]), `notifications.filters.min_severity` ("info") all come from the schema defaults already declared at [src/config.ts](../../../../src/config.ts#L83-L96) and [src/config.ts](../../../../src/config.ts#L165-L172). No behaviour change at the values that matter; behaviour change at the values that were leaking from the seeder (Playwright, provider hardcoding).

Write the result via `writeDoc(saivageJsonPath, saivageJson, SaivageConfigSchema)`. The schema is the producer *and* the validator; the two-source problem disappears.

### Files touched

- [src/config.ts](../../../../src/config.ts#L62) — rename and export as in Proposal A.
- [src/store/project.ts](../../../../src/store/project.ts#L8) — add `SaivageConfigSchema` to the import.
- [src/store/project.ts](../../../../src/store/project.ts#L135-L163) — replace the entire literal with:

  ```ts
  const saivageJson = SaivageConfigSchema.parse({});
  await writeDoc(saivageJsonPath, saivageJson, SaivageConfigSchema);
  ```

- [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91) — keep the two existing assertions (they still pass — the schema defaults match); add an assertion that `cfg.providers` is `{}` and `cfg.mcpServers` is `{}` (was: contained Playwright). Add the round-trip `readDoc(…, SaivageConfigSchema)` test from Proposal A.
- Cross-finding handoff to G47 (telegram-bot auth/startup): the seeded `telegram.botToken` is now `""` (from the schema default at [src/config.ts](../../../../src/config.ts#L137-L141)) — already the case, so no regression, but call it out in the plan's cross-finding section so the G47 author knows the seed is now schema-driven.

### Deletion list

- The 28-line object literal at [src/store/project.ts](../../../../src/store/project.ts#L135-L163).
- The hardcoded Playwright `mcpServers.playwright` entry. Architecture-first: no migration shim, no "legacy seed" fallback. Existing `.saivage/saivage.json` files written by the old seeder keep their Playwright entry and continue to load (the schema permits any record of MCP servers); only new projects get the clean default.
- The hardcoded `localhost:11434` / `localhost:8080` provider baseUrls. Same logic: operator opts in via auth setup.

### Test impact

- The two existing assertions at [src/store/project.test.ts](../../../../src/store/project.test.ts#L80-L82) pass unchanged (the values come from schema defaults rather than the literal — equivalent).
- New assertion: `expect(Object.keys(cfg.providers)).toEqual([])` and `expect(Object.keys(cfg.mcpServers)).toEqual([])`. These would have failed under the old literal and document the architectural decision.
- New round-trip test as in Proposal A.
- No runtime test churn outside [src/store/project.test.ts](../../../../src/store/project.test.ts). The dispatcher, supervisor, MCP loader, etc. all already handle empty `providers` / `mcpServers` (the schema permits them; `loadConfig({})` is a valid state).
- Cross-finding tests: any existing test that relies on the Playwright MCP being present after `seedProject` would fail. A search of [src/](../../../../src/) and the workspace memory notes shows no such test — Playwright is consumed by `mcp/runtime.ts` only when present, and the test suite drives MCP servers explicitly per test.

### What this does *not* fix

- The G37-flagged stale cache in `loadConfig` is unrelated; this design uses `loadConfig` only via the test, not at seed time. G37 still wants its own fix.
- Operators who currently rely on `seedProject` to produce a Playwright entry for them must add a `.saivage/saivage.json` mcp-server entry explicitly. This is the architecture-first trade — opt-in MCP servers. The plan documents the migration as "first project to seed under the new code will not autostart Playwright; add it to `mcpServers` if needed."
- The `mcp.superRefine` cross-field rule at [src/config.ts](../../../../src/config.ts#L143-L163) is exercised by `parse({})` because the `mcp` subtree has all defaults — verified by inspection that `4 * 60 * 60 * 1000 > WALL_CLOCK_HEADROOM_MS` and `10 * 60 * 1000 ≤ shellTimeoutMs - WALL_CLOCK_HEADROOM_MS`. If those numbers ever shift, the schema would refuse `parse({})` and the seeder would throw — the *right* failure mode (caught at seed time, not at first boot).

---

## 3. Recommendation

**Adopt B.**

Per the workspace architecture-first rule, the right place for runtime defaults is the schema, not the seeder. Proposal A closes the schema bypass — the immediate correctness bug — but leaves the literal as a second source of truth for values that the schema already declares. Every future change to `notifications.channels`'s default would have to be made in two files; the workspace policy explicitly forbids that duplication. Proposal B collapses to one source: change the `.default(...)` chain in `SaivageConfigSchema`, and both the loader and the seeder pick it up automatically.

Proposal B also removes the two policy leaks the finding calls out (hardcoded Playwright autostart, hardcoded `localhost` provider endpoints) at zero additional cost — they were always wrong and the schema-driven seed never needed them.

Two implementer caveats:

1. **Schema-default audit before merge.** Because B promotes every `.default(...)` chain in [src/config.ts](../../../../src/config.ts#L62-L192) from "schema documentation" to "seed value", a pass through the schema is required to confirm each default is the value we want a fresh project to start with. The plan in [./03-plan-r1.md](./03-plan-r1.md) makes this step explicit. The known port collision (`server.port = 8080` and the now-deleted `llamacpp` literal) auto-resolves — no llamacpp entry is seeded, so no collision.
2. **No backward compat for existing files.** Existing `.saivage/saivage.json` files retain their (possibly hardcoded-Playwright) shape and keep loading. We do not rewrite them. Operators who want the clean default can `rm saivage.json && saivage init` — per the workspace policy ("no migration shims"), the framework does not do this for them.
