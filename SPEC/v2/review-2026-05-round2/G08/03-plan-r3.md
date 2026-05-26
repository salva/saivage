# G08 — Plan r3

**Finding**: [../G08-seedproject-writes-saivagejson-without-schema.md](../G08-seedproject-writes-saivagejson-without-schema.md)
**Analysis**: [./01-analysis-r3.md](./01-analysis-r3.md)
**Design**: [./02-design-r3.md](./02-design-r3.md) — schema-driven seed.
**Round-2 plan**: [03-plan-r2.md](./03-plan-r2.md)
**Review feedback**: [04-review-r2.md](./04-review-r2.md) (3 required changes)

## r3 deltas vs r2

- **Δ1 (r2 review change 1) — Secret-handling.** Removed the proposed memory-note edit that weakened the "preserve `saivage.json` across resets" rule. Step 9 ("Cross-finding and operational notes") now keeps the existing rule and explicitly enumerates the fields per the schema that may carry secrets when populated.
- **Δ2 (r2 review change 2) — Provider-default scope.** Step 4's audit is producer-side only. A new step 8 ("Follow-up finding to file at merge") captures the router-side defaults and three external surfaces as G08-followup, with the precise file/line references the new finding will own.
- **Δ3 (r2 review change 3) — Test contract.** Step 5 replaces the r2 `expect(raw).toEqual(SaivageConfigSchema.parse({}))` test with an inline `EXPECTED_SEED` literal asserted on both sides (raw read and `parse({})`). Step 6 validation snippets are updated to match.

## Steps

1. **Export the schema.** In [src/config.ts](../../../../src/config.ts#L62), rename `const configSchema = z.object({...})` to `export const SaivageConfigSchema = z.object({...})`. Update internal references at [src/config.ts](../../../../src/config.ts#L194) (`export type SaivageConfig = z.infer<typeof SaivageConfigSchema>;`) and [src/config.ts](../../../../src/config.ts#L274) (`cached = SaivageConfigSchema.parse(interpolated);`). No other file imports `configSchema` today; type consumers continue to import `SaivageConfig`.

2. **Walk the schema-default contract.** Read [src/config.ts](../../../../src/config.ts#L62-L192) top to bottom. Confirm `SaivageConfigSchema.parse({})` produces the desired fresh-project state for every leaf with a `.default(...)`. If any default value is wrong for fresh-project use (port, host, timeout, public OAuth client ID, etc.), fix it in the schema — not in the seeder — and update `EXPECTED_SEED` in the test in the same commit. Specifically verify:

   - `runtime.*`, `security.*`, `supervisor.*`, `telegram.botToken == ""`, `telegram.allowedUserIds == []`, `mcp.*` (six numeric defaults), `oauth.{anthropic,openaiCodex,githubCopilot}.clientId` from [src/auth/defaults.ts](../../../../src/auth/defaults.ts).
   - `mcp.superRefine` cross-field check ([src/config.ts](../../../../src/config.ts#L143-L163)) passes against the default tree.

3. **Replace the seed literal.** In [src/store/project.ts](../../../../src/store/project.ts#L8), extend the import from `../config.js` to add `SaivageConfigSchema`. Then replace the entire block at [src/store/project.ts](../../../../src/store/project.ts#L135-L163) with:

   ```ts
   const saivageJson = SaivageConfigSchema.parse({});
   await writeDoc(saivageJsonPath, saivageJson, SaivageConfigSchema);
   ```

   Keep the `writeFile` import at [src/store/project.ts](../../../../src/store/project.ts#L7) — still used by `initProjectTree` for non-schema files ([src/store/project.ts](../../../../src/store/project.ts#L190-L204)).

4. **Audit producer-side consumer assumptions.** Run the following greps from `/home/salva/g/ml/saivage`:

   ```bash
   rg -n "playwright" src/ web/src/
   rg -nF 'providers.anthropic' src/ web/src/
   rg -nF 'providers.openai' src/ web/src/
   rg -nF 'providers.ollama' src/ web/src/
   rg -nF 'providers.llamacpp' src/ web/src/
   rg -nF 'config.providers' src/ web/src/
   rg -nF 'mcpServers.playwright' src/ web/src/
   rg -nF "mcpServers[\"playwright\"]" src/ web/src/
   ```

   Expected hits (verified before this plan was written):
   - [src/store/project.ts](../../../../src/store/project.ts#L137-L161) — the seed literal itself; deleted by step 3.
   - [src/providers/router.ts](../../../../src/providers/router.ts#L93) — `config.providers` treated as arbitrary record; handles `{}` correctly. No change.
   - [src/config.test.ts](../../../../src/config.test.ts#L83-L84) — hand-rolled fixture independent of `seedProject`. No change.
   - [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) — string mentions in tool descriptions; unrelated to MCP server registration. No change.

   For any **other** hit:
   - If it is a test that calls `seedProject` and then asserts a specific provider or `mcpServers.playwright` is present: fix the test to construct the fixture explicitly, in the same commit. Do not add a compatibility seed.
   - If it is production code that reads `config.providers.<name>` without a presence check: add the presence check, in the same commit. The schema-documented default is `{}`.

   **Scope reminder (Δ2):** this audit covers `config.providers` / `config.mcpServers` consumers. It does **not** cover unconditional Ollama registration at [src/providers/router.ts](../../../../src/providers/router.ts#L731-L749), the localhost fallbacks in [src/providers/ollama.ts](../../../../src/providers/ollama.ts#L20-L36) / [src/providers/llamacpp.ts](../../../../src/providers/llamacpp.ts#L10-L19), or the three external surfaces at [src/server/server.ts](../../../../src/server/server.ts#L218-L226), [src/server/cli.ts](../../../../src/server/cli.ts#L291-L296), and [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L141). Those are step 8 (follow-up finding).

5. **Update the project init test.** In [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91):

   - Keep the existing `it("writes saivage.json with web channel and info severity")` and `it("does not write a default orchestrator model into saivage.json")` blocks — they still pass.
   - Add imports at the top of the file:

     ```ts
     import { readFile } from "node:fs/promises";
     import { readDoc } from "./documents.js";
     import { SaivageConfigSchema } from "../config.js";
     import {
       DEFAULT_ANTHROPIC_CLIENT_ID,
       DEFAULT_OPENAI_CODEX_CLIENT_ID,
       DEFAULT_GITHUB_COPILOT_CLIENT_ID,
     } from "../auth/defaults.js";
     ```

   - Add an `EXPECTED_SEED` literal at module scope (above the `describe` blocks) — the full inline expected tree from [02-design-r3.md](./02-design-r3.md#L96-L141) §6.

   - Add the following tests inside the existing `describe("seedProject", ...)` block (or the equivalent describe that currently owns the L77-L91 cases):

     ```ts
     it("seeded saivage.json equals the committed EXPECTED_SEED literal", async () => {
       await seedProject(projectRoot, { name: "x", objectives: [] });
       const path = join(projectRoot, ".saivage", "saivage.json");
       const raw = JSON.parse(await readFile(path, "utf-8"));
       expect(raw).toEqual(EXPECTED_SEED);
     });

     it("SaivageConfigSchema.parse({}) equals EXPECTED_SEED (review-on-change)", () => {
       expect(SaivageConfigSchema.parse({})).toEqual(EXPECTED_SEED);
     });

     it("seeded saivage.json contains no providers or mcp servers by default", async () => {
       await seedProject(projectRoot, { name: "x", objectives: [] });
       const path = join(projectRoot, ".saivage", "saivage.json");
       const raw = JSON.parse(await readFile(path, "utf-8"));
       expect(raw.providers).toEqual({});
       expect(raw.mcpServers).toEqual({});
     });

     it("seeded saivage.json top-level keys match the schema shape", async () => {
       await seedProject(projectRoot, { name: "x", objectives: [] });
       const path = join(projectRoot, ".saivage", "saivage.json");
       const raw = JSON.parse(await readFile(path, "utf-8"));
       expect(Object.keys(raw).sort()).toEqual(Object.keys(SaivageConfigSchema.shape).sort());
     });

     it("seeded saivage.json parses through the loader contract", async () => {
       await seedProject(projectRoot, { name: "x", objectives: [] });
       const path = join(projectRoot, ".saivage", "saivage.json");
       const cfg = await readDoc(path, SaivageConfigSchema);
       expect(cfg).toBeDefined();
     });
     ```

   Test 1 is the producer-output contract. Test 2 is the review-on-change contract (Δ3): any schema-default edit fails this test until `EXPECTED_SEED` is updated, forcing a deliberate review. Tests 3 and 4 are named-regression and unknown-key guards. Test 5 is a secondary sanity check.

6. **Type-check, lint, focused unit tests, full unit tests, build.** From `/home/salva/g/ml/saivage`:

   ```bash
   npx tsc --noEmit
   npx eslint src/store/project.ts src/store/project.test.ts src/config.ts
   npx vitest run src/store/project.test.ts src/store/documents.test.ts src/config.test.ts
   npx vitest run
   npm run build
   ```

   The focused vitest run is the fast feedback loop; the full vitest run is the regression gate (the schema export rename and provider-default removal must not break unrelated tests); `npm run build` validates the production artefact used by step 7.

7. **Local seed-CLI verification.** From `/home/salva/g/ml/saivage` after step 6 succeeds:

   ```bash
   rm -rf tmp/g08-seedcheck && mkdir -p tmp/g08-seedcheck
   node dist/cli.js init tmp/g08-seedcheck

   # Producer-output + review-on-change contract.
   node -e '
     import("./dist/config.js").then(async (m) => {
       const auth = await import("./dist/auth/defaults.js");
       const fs = await import("node:fs/promises");
       const EXPECTED_SEED = {
         models: {},
         providers: {},
         failover: {},
         modelEquivalents: {},
         server: { port: 8080, host: "0.0.0.0" },
         agent: { maxConcurrentAgents: 3 },
         runtime: {
           maxServices: 50, restartOnCrash: true, continuousImprovement: true,
           healthCheckIntervalMs: 30000, idleShutdownMs: 300000, recoveryDelayMs: 60000,
           notes: { volatileTtlMs: 2 * 60 * 60 * 1000 },
         },
         security: { injectionScanner: true, maxScanLengthBytes: 100000 },
         supervisor: {
           enabled: true, intervalMs: 20 * 60 * 1000, consecutiveStuckVerdicts: 3,
           logLines: 400, forceCancelDelayMs: 600000,
         },
         telegram: { botToken: "", allowedUserIds: [] },
         mcp: {
           shellTimeoutMs: 4 * 60 * 60 * 1000, shellTimeoutFloorMs: 10 * 60 * 1000,
           inProcessTimeoutMs: 300000, maxOutputBytes: 100 * 1024,
           maxFetchChars: 200000, maxDownloadBytes: 250 * 1024 * 1024,
         },
         notifications: { channels: ["web"], filters: { min_severity: "info", categories: [] } },
         oauth: {
           anthropic: { clientId: auth.DEFAULT_ANTHROPIC_CLIENT_ID },
           openaiCodex: { clientId: auth.DEFAULT_OPENAI_CODEX_CLIENT_ID },
           githubCopilot: { clientId: auth.DEFAULT_GITHUB_COPILOT_CLIENT_ID },
         },
         mcpServers: {},
       };
       const raw = JSON.parse(await fs.readFile("tmp/g08-seedcheck/.saivage/saivage.json", "utf-8"));
       const a = JSON.stringify(raw);
       const b = JSON.stringify(EXPECTED_SEED);
       const c = JSON.stringify(m.SaivageConfigSchema.parse({}));
       if (a !== b) { console.error("raw seed != EXPECTED_SEED"); console.error("raw:", a); console.error("expected:", b); process.exit(1); }
       if (b !== c) { console.error("SaivageConfigSchema.parse({}) != EXPECTED_SEED — schema default drifted"); console.error("parse:", c); console.error("expected:", b); process.exit(1); }
       if (Object.keys(raw.providers).length !== 0) { console.error("providers not empty"); process.exit(1); }
       if (Object.keys(raw.mcpServers).length !== 0) { console.error("mcpServers not empty"); process.exit(1); }
       console.log("seed-check OK");
     });
   '

   # Loader contract — exercises loadConfig(true, seedRoot) against the freshly seeded file.
   node -e '
     import("./dist/config.js").then((m) => {
       const cfg = m.loadConfig(true, "tmp/g08-seedcheck");
       if (!cfg) { console.error("loadConfig returned falsy"); process.exit(1); }
       console.log("loadConfig OK");
     });
   '

   rm -rf tmp/g08-seedcheck
   ```

   The CLI entry point is [src/server/cli.ts](../../../../src/server/cli.ts#L33-L52) (`init <project-path>`); it calls `seedProject` from [src/store/project.ts](../../../../src/store/project.ts). The inline literal in the verification script must stay byte-identical to `EXPECTED_SEED` in [src/store/project.test.ts](../../../../src/store/project.test.ts); when one is updated as part of a schema-default change, the other must be updated in the same commit.

   **Optional, operator-approved** (not required for this finding): rebuilt artefact already exists. The harness bind-mounts the build directory, so `saivage-v3` (10.0.3.112) sees the new code on next restart. If the operator approves, `ssh root@10.0.3.112 systemctl restart saivage.service` and `curl -fsS http://10.0.3.112:8080/health`. Do **not** rerun `seedProject` against `saivage-v3` — it is initialised and re-seeding throws by design at [src/store/project.ts](../../../../src/store/project.ts#L111-L113). Do **not** restart `saivage` (10.0.3.111), `diedrico` (10.0.3.113), or `saivage-v3-getrich-v2` (10.0.3.170).

8. **File G08-followup at G08 merge.** The follow-up finding (working name: "G08-followup — unconditional provider registration and localhost fallbacks") owns:

   - [src/providers/router.ts](../../../../src/providers/router.ts#L731-L749) — `shouldRegisterProvider("ollama")` returns `true` unconditionally.
   - [src/providers/router.ts](../../../../src/providers/router.ts#L804) — `createProvider("ollama")` constructs `new OllamaProvider(baseUrl, ...)`.
   - [src/providers/ollama.ts](../../../../src/providers/ollama.ts#L20-L36) — `http://localhost:11434/v1` fallback.
   - [src/providers/llamacpp.ts](../../../../src/providers/llamacpp.ts#L10-L19) — `http://localhost:8080` fallback.
   - Three publishing surfaces: [src/server/server.ts](../../../../src/server/server.ts#L218-L226) (`GET /api/providers`), [src/server/cli.ts](../../../../src/server/cli.ts#L291-L296) (`models` CLI command), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L141) (startup log).

   File the follow-up immediately after G08 merges. Do not extend the G08 plan to touch any of the above files — the producer-path refactor and the routing-layer behavioural change are separate concerns.

9. **Cross-finding and operational notes.**

   - **F22 (round 1) — atomic writes via `writeDoc`.** Note in merge message: G08 brings `saivage.json` under the F22 invariant.
   - **F33 (round 1) — `seedProject` rename and `ProjectConfig` trim.** G08 completes F33's intent for runtime config.
   - **G37 — config sync fs and stale cache.** G37 imports `SaivageConfigSchema` (exported by step 1). Land G08 first.
   - **G47 — telegram-bot auth and startup.** The seeded `telegram.botToken = ""` is now materialised on disk. G47 should treat an empty token as operator-unconfigured and skip bot startup gracefully.
   - **`ml-workspace-saivage-ops` memory note (Δ1).** Do not edit the memory in this PR. The existing rule stands: `saivage.json` is operator-owned and sensitive — it may legitimately carry `providers.<name>.apiKey`, `providers.<name>.baseUrl`, `providers.<name>.authProfile`, `providers.<name>.accounts.*.{apiKey,baseUrl,authProfile}` per [src/config.ts](../../../../src/config.ts#L14-L17) and [src/config.ts](../../../../src/config.ts#L31-L36), and `telegram.botToken` per [src/config.ts](../../../../src/config.ts#L129-L132). Preserve `saivage.json` across reset workflows unless the operator explicitly regenerates it. The new producer writes none of these on a fresh seed; the rule protects operator-populated state, not seeded state.

## Rollback (clean revert)

- Single `git revert <merge-sha>` restores:
  - the literal at [src/store/project.ts](../../../../src/store/project.ts#L135-L163),
  - the private `configSchema` declaration at [src/config.ts](../../../../src/config.ts#L62),
  - the test additions in [src/store/project.test.ts](../../../../src/store/project.test.ts).
- Rebuild after revert: `npm run build` from `/home/salva/g/ml/saivage`.
- No on-disk schema change. Files seeded under the new code remain loadable under the old code — every emitted key is a known schema field, so the old loader accepts the new file.
- If the operator-approved restart in step 7 was exercised: `ssh root@10.0.3.112 systemctl restart saivage.service` after rebuild.

Per-step partial rollback if needed before merge:

- Revert step 3 only: keep the schema export (step 1), restore the literal. Tests added in step 5 fail; remove them in the same revert commit.
- Revert step 1 (and consequently step 3): full revert; type consumers of `SaivageConfigSchema` (none today) would break — none expected since G37 lands after G08.
