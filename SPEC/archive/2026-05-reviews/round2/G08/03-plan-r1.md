# G08 — Plan r1

**Finding**: [../G08-seedproject-writes-saivagejson-without-schema.md](../G08-seedproject-writes-saivagejson-without-schema.md)
**Analysis**: [./01-analysis-r1.md](./01-analysis-r1.md)
**Design**: [./02-design-r1.md](./02-design-r1.md) — Proposal B (schema-driven seed).

## Steps

1. **Export the schema.** In [src/config.ts](../../../../src/config.ts#L62), rename `const configSchema = z.object({...})` to `export const SaivageConfigSchema = z.object({...})`. Update internal references at [src/config.ts](../../../../src/config.ts#L194) (`export type SaivageConfig = z.infer<typeof SaivageConfigSchema>;`) and [src/config.ts](../../../../src/config.ts#L274) (`cached = SaivageConfigSchema.parse(interpolated);`). No other file currently imports `configSchema` (it was private); type consumers continue to import `SaivageConfig`.

2. **Audit the schema defaults.** Read [src/config.ts](../../../../src/config.ts#L62-L192) top-to-bottom and confirm that `SaivageConfigSchema.parse({})` yields a `SaivageConfig` whose every leaf value is what a fresh project should start with. Specifically: `server.port = 8080`, `server.host = "0.0.0.0"`, `agent.maxConcurrentAgents = 3`, `notifications.channels = ["web"]`, `notifications.filters.min_severity = "info"`, `notifications.filters.categories = []`, `providers = {}`, `mcpServers = {}`, `failover = {}`, `modelEquivalents = {}`, `models = {}`, `telegram.botToken = ""`, `oauth.{anthropic,openaiCodex,githubCopilot}.clientId = DEFAULT_*` from [src/auth/defaults.ts](../../../../src/auth/defaults.ts). If any default is wrong for fresh-project use, fix it in the schema (not in the seed) before continuing.

3. **Verify the `mcp.superRefine` accepts the default.** [src/config.ts](../../../../src/config.ts#L143-L163) imposes `mcp.shellTimeoutMs > WALL_CLOCK_HEADROOM_MS` and `mcp.shellTimeoutFloorMs ≤ mcp.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS`. Current defaults: `shellTimeoutMs = 4 * 60 * 60 * 1000 = 14_400_000`, `shellTimeoutFloorMs = 10 * 60 * 1000 = 600_000`, `WALL_CLOCK_HEADROOM_MS` from [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts). Run a one-line `node` check (`node -e "import('./dist/config.js').then(m => console.log(m.SaivageConfigSchema.parse({})))"`) after step 1 + build to confirm `parse({})` does not throw.

4. **Replace the seed literal.** In [src/store/project.ts](../../../../src/store/project.ts#L8), extend the import: `import { ... } from "./documents.js";` already imports `writeDoc`; add `import { SaivageConfigSchema } from "../config.js";`. Then replace the entire block at [src/store/project.ts](../../../../src/store/project.ts#L135-L163) with:

   ```ts
   const saivageJson = SaivageConfigSchema.parse({});
   await writeDoc(saivageJsonPath, saivageJson, SaivageConfigSchema);
   ```

5. **Delete the now-unused `writeFile` reference?** No — `writeFile` is still used by `initProjectTree` at [src/store/project.ts](../../../../src/store/project.ts#L190-L204) for the `index.json`, `audit.jsonl`, and `.gitignore` files (which are not schema documents). Keep the import.

6. **Update the project init test.** In [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91), keep the existing `it("writes saivage.json with web channel and info severity")` and `it("does not write a default orchestrator model into saivage.json")` blocks (they still pass — values come from schema defaults). Add:

   - `it("seeded saivage.json round-trips through SaivageConfigSchema")` — `await seedProject(...); const cfg = await readDoc(join(projectRoot, ".saivage", "saivage.json"), SaivageConfigSchema); expect(cfg).toBeDefined();`. The implicit `parse` inside `readDoc` is the regression guard.
   - `it("does not seed any MCP servers by default")` — `expect(Object.keys(cfg.mcpServers)).toEqual([]);`. Documents the policy decision.
   - `it("does not seed any providers by default")` — `expect(Object.keys(cfg.providers)).toEqual([]);`. Same.

   Imports: add `readDoc` from `./documents.js` and `SaivageConfigSchema` from `../config.js`.

7. **Search for stale Playwright-MCP assumptions.** Run `rg -n "playwright" src/ web/src/` and verify no test or runtime path *asserts* the presence of a Playwright MCP entry after `seedProject`. (Per the analysis, none exist — the MCP runtime in [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts) iterates `mcpServers` so an empty record is a no-op.) If a hit appears, fix it in the same commit; do not add a migration shim.

8. **Type-check, lint, unit-test.** From `/home/salva/g/ml/saivage`:
   - `npx tsc --noEmit`
   - `npx eslint src/store/project.ts src/store/project.test.ts src/config.ts`
   - `npx vitest run src/store/project.test.ts src/store/documents.test.ts`
   - `npx vitest run` (full suite — config / providers / runtime tests must remain green after the schema export rename).

## Validation

- **Unit**: the four `seedProject` assertions in [src/store/project.test.ts](../../../../src/store/project.test.ts) (two existing, two new from step 6) plus the new round-trip test must pass. Full-suite vitest must remain green.
- **Build**: `npm run build` from `/home/salva/g/ml/saivage` succeeds.
- **Sandbox seed check**: in a host shell, `mkdir -p tmp/g08-seedcheck && cd tmp/g08-seedcheck && node ../../dist/cli.js init .` (or whichever CLI subcommand reaches `seedProject` per [src/server/cli.ts](../../../../src/server/cli.ts#L41-L45)). Inspect the written `.saivage/saivage.json`: it must contain `providers: {}` and `mcpServers: {}` and no Playwright entry. Delete `tmp/g08-seedcheck` afterwards.
- **Live, manual, against `saivage-v3` only** (per workspace handoff — `saivage-v3` 10.0.3.112 is the v2-on-v3 harness and the safe target for v2 changes):
  1. Read [/home/salva/g/ml/saivage-v3/.saivage/saivage.json](../../../../../saivage-v3/.saivage/saivage.json) ownership via `stat` (do **not** print contents — file is provider/auth-bearing per workspace memory).
  2. Rebuild: `cd /home/salva/g/ml/saivage && npm run build`.
  3. `ssh root@10.0.3.112 systemctl restart saivage.service`.
  4. `curl -fsS http://10.0.3.112:8080/health` → 200.
  5. Confirm the existing `.saivage/saivage.json` (created under the old seeder) still loads — `loadConfig` parses it through the schema; the rename does not change parser shape, so this is a smoke check that nothing else regressed.
  6. Do **not** rerun `seedProject` against `saivage-v3` — the project is already initialised and re-seeding throws by design at [src/store/project.ts](../../../../src/store/project.ts#L111-L113).
- **Do not** restart `saivage` (10.0.3.111), `diedrico` (10.0.3.113), or `saivage-v3-getrich-v2` (10.0.3.170) for this finding. All three share the bind-mounted `/home/salva/g/ml/saivage` source so the rebuild is visible to them; they own unrelated long-running stage state per the workspace handoff and must only be restarted with operator approval against their own runtime-state checkpoints.

## Rollback

- Single `git revert <merge-sha>` restores the literal at [src/store/project.ts](../../../../src/store/project.ts#L135-L163), the private `configSchema`, and the four-line test edit. Rebuild and `ssh root@10.0.3.112 systemctl restart saivage.service`. No on-disk schema change — existing `.saivage/saivage.json` files written under the old or new code load identically (the schema is unchanged in shape; only the producer changed).
- Per-step partial rollback:
  - Revert step 4 only (keep the schema export): the seeder reverts to the literal; the export is harmless and useful for other call sites.
  - Revert step 1 only (and consequently step 4): full revert.
- No data-format rollback. The seeder produces files that the loader has always accepted; we only changed *which* fields the seeder emits, not their permitted shape.

## Cross-finding

- **G37 — config sync fs and stale cache.** G37 will replace `loadConfig`'s `readFileSync` with the async store. This plan exports `SaivageConfigSchema` and that is exactly the schema G37 needs to keep validating after its refactor. Land G08 first so G37 imports a stable name.
- **F22 (round 1) — atomic writes via `writeDoc`.** G08 brings `saivage.json` under the F22 invariant. Note the alignment in the merge commit message so a future auditor sees the linkage.
- **F33 (round 1) — `seedProject` rename and `ProjectConfig` trim.** G08 is the second half of F33's intended cleanup: F33 fixed `ProjectConfig`; G08 fixes the runtime-config seed. After both, every config file the seeder writes is schema-validated on the way to disk.
- **G47 — telegram-bot auth and startup issues.** The seeded `telegram.botToken` is now `""` from the schema default at [src/config.ts](../../../../src/config.ts#L137-L141) (unchanged in value, but now sourced from the schema rather than absent from the literal). G47's author should be aware that an operator-empty token field will be present in every freshly seeded file.
- **`ml-workspace-saivage-ops` memory note**: the "restore preserved `saivage.json` after seeding" workaround for GetRich-v2 resets is narrower after this change — the seeder no longer clobbers MCP server policy or provider endpoints. The auth-bearing fields (`providers.<name>.accounts.*.apiKey`, `telegram.botToken`) are still operator-owned and must still be preserved across a reset. Update the memory note in a follow-up only after the live validation in §Validation confirms the new seed.
