# G08 — Plan r2

**Finding**: [../G08-seedproject-writes-saivagejson-without-schema.md](../G08-seedproject-writes-saivagejson-without-schema.md)
**Analysis**: [./01-analysis-r2.md](./01-analysis-r2.md)
**Design**: [./02-design-r2.md](./02-design-r2.md) — schema-driven seed.
**Round-1**: [03-plan-r1.md](./03-plan-r1.md)
**Review feedback**: [04-review-r1.md](./04-review-r1.md) (4 required changes)

## Steps

1. **Export the schema.** In [src/config.ts](../../../../src/config.ts#L62), rename `const configSchema = z.object({...})` to `export const SaivageConfigSchema = z.object({...})`. Update internal references at [src/config.ts](../../../../src/config.ts#L194) (`export type SaivageConfig = z.infer<typeof SaivageConfigSchema>;`) and [src/config.ts](../../../../src/config.ts#L274) (`cached = SaivageConfigSchema.parse(interpolated);`). No other file imports `configSchema` today; type consumers continue to import `SaivageConfig`.

2. **Walk the schema-default contract.** Read [src/config.ts](../../../../src/config.ts#L62-L192) top to bottom. Confirm `SaivageConfigSchema.parse({})` produces the desired fresh-project state for every leaf with a `.default(...)`. The full materialized tree is documented in [02-design-r2.md](./02-design-r2.md#L29-L47) §3. If any default value is wrong for fresh-project use (port, host, timeout, public OAuth client ID, etc.), fix it in the schema — not in the seeder — before continuing. Specifically verify:

   - `runtime.*`, `security.*`, `supervisor.*`, `telegram.botToken == ""`, `telegram.allowedUserIds == []`, `mcp.*` (six numeric defaults), `oauth.{anthropic,openaiCodex,githubCopilot}.clientId` from [src/auth/defaults.ts](../../../../src/auth/defaults.ts).
   - `mcp.superRefine` cross-field check ([src/config.ts](../../../../src/config.ts#L143-L163)) passes against the default tree.

3. **Replace the seed literal.** In [src/store/project.ts](../../../../src/store/project.ts#L8), extend the import from `../config.js` to add `SaivageConfigSchema`. Then replace the entire block at [src/store/project.ts](../../../../src/store/project.ts#L135-L163) with:

   ```ts
   const saivageJson = SaivageConfigSchema.parse({});
   await writeDoc(saivageJsonPath, saivageJson, SaivageConfigSchema);
   ```

   Keep the `writeFile` import at [src/store/project.ts](../../../../src/store/project.ts#L7) — still used by `initProjectTree` for non-schema files ([src/store/project.ts](../../../../src/store/project.ts#L190-L204)).

4. **Audit stale producer-state assumptions (review change 2).** Run the following greps from `/home/salva/g/ml/saivage`:

   ```bash
   rg -n "playwright" src/ web/src/
   rg -nF 'providers.anthropic' src/ web/src/
   rg -nF 'providers.openai' src/ web/src/
   rg -nF 'providers.ollama' src/ web/src/
   rg -nF 'providers.llamacpp' src/ web/src/
   rg -nF 'config.providers' src/ web/src/
   rg -nF 'mcpServers.playwright' src/ web/src/
   rg -nF 'mcpServers["playwright"]' src/ web/src/
   ```

   Expected hits (verified before this plan was written):
   - [src/store/project.ts](../../../../src/store/project.ts#L137-L161) — the seed literal itself; deleted by step 3.
   - [src/providers/router.ts](../../../../src/providers/router.ts#L93) — `config.providers` treated as arbitrary record; handles `{}` correctly. No change.
   - [src/config.test.ts](../../../../src/config.test.ts#L83-L84) — hand-rolled fixture independent of `seedProject`. No change.
   - [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L683) — string mention in a tool description; unrelated to MCP server registration. No change.

   For any **other** hit:
   - If it is a test that calls `seedProject` and then asserts a specific provider or `mcpServers.playwright` is present: fix the test to construct the fixture explicitly, in the same commit. Do not add a compatibility seed.
   - If it is production code that reads `config.providers.<name>` without a presence check: add the presence check, in the same commit. The schema-documented default is `{}`.

5. **Update the project init test (review changes 1 and 3).** In [src/store/project.test.ts](../../../../src/store/project.test.ts#L77-L91):

   - Keep the existing `it("writes saivage.json with web channel and info severity")` and `it("does not write a default orchestrator model into saivage.json")` blocks — they still pass.
   - Add imports: `readDoc` from `./documents.js`, `SaivageConfigSchema` from `../config.js`, `readFile` from `node:fs/promises`.
   - Add three new tests:

     ```ts
     it("seeded saivage.json equals SaivageConfigSchema.parse({})", async () => {
       await seedProject(projectRoot, { name: "x", objectives: [] });
       const path = join(projectRoot, ".saivage", "saivage.json");
       const raw = JSON.parse(await readFile(path, "utf-8"));
       expect(raw).toEqual(SaivageConfigSchema.parse({}));
     });

     it("seeded saivage.json contains no providers or mcp servers by default", async () => {
       await seedProject(projectRoot, { name: "x", objectives: [] });
       const path = join(projectRoot, ".saivage", "saivage.json");
       const raw = JSON.parse(await readFile(path, "utf-8"));
       expect(raw.providers).toEqual({});
       expect(raw.mcpServers).toEqual({});
     });

     it("seeded saivage.json parses through the loader contract", async () => {
       await seedProject(projectRoot, { name: "x", objectives: [] });
       const path = join(projectRoot, ".saivage", "saivage.json");
       const cfg = await readDoc(path, SaivageConfigSchema);
       expect(cfg).toBeDefined();
     });
     ```

   The first test is the regression guard. The second documents the named policy regressions. The third is a secondary sanity check.

6. **Type-check, lint, unit-test.** From `/home/salva/g/ml/saivage`:
   - `npx tsc --noEmit`
   - `npx eslint src/store/project.ts src/store/project.test.ts src/config.ts`
   - `npx vitest run src/store/project.test.ts src/store/documents.test.ts src/config.test.ts`
   - `npx vitest run` — full suite must remain green after the schema export rename and provider-default removal.

7. **Build.** `npm run build` from `/home/salva/g/ml/saivage`.

## Validation (review change 4)

**Required**: local, seed-focused. Proves the new producer, not an existing project's loader.

From `/home/salva/g/ml/saivage` after step 7 succeeds:

```bash
rm -rf tmp/g08-seedcheck && mkdir -p tmp/g08-seedcheck
node dist/cli.js init tmp/g08-seedcheck

# Raw-equality contract — the primary guard, run outside vitest as belt-and-braces.
node -e '
  import("./dist/config.js").then(async (m) => {
    const fs = await import("node:fs/promises");
    const raw = JSON.parse(await fs.readFile("tmp/g08-seedcheck/.saivage/saivage.json", "utf-8"));
    const expected = m.SaivageConfigSchema.parse({});
    const a = JSON.stringify(raw);
    const b = JSON.stringify(expected);
    if (a !== b) {
      console.error("raw seed != SaivageConfigSchema.parse({})");
      console.error("raw:", a);
      console.error("expected:", b);
      process.exit(1);
    }
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

The CLI entry point is [src/server/cli.ts](../../../../src/server/cli.ts#L33-L52) (`init <project-path>`); it calls `seedProject` from [src/store/project.ts](../../../../src/store/project.ts).

**Optional, operator-approved** (not required for this finding): smoke-check that the rename did not regress the loader against an existing project.

- Rebuild has already happened in step 7.
- Existing `.saivage/saivage.json` files on `saivage-v3` were written by the old seeder and retain the Playwright/provider entries. The loader still accepts them (the schema permits any record shape).
- `ssh root@10.0.3.112 systemctl restart saivage.service` and `curl -fsS http://10.0.3.112:8080/health` only after operator approval, per workspace handoff. Do **not** rerun `seedProject` against `saivage-v3` — it is initialised and re-seeding throws by design at [src/store/project.ts](../../../../src/store/project.ts#L111-L113).
- Do **not** restart `saivage` (10.0.3.111), `diedrico` (10.0.3.113), or `saivage-v3-getrich-v2` (10.0.3.170). The rebuild is visible to them via bind mount; they own unrelated long-running stage state.

## Rollback

- Single `git revert <merge-sha>` restores the literal at [src/store/project.ts](../../../../src/store/project.ts#L135-L163), the private `configSchema`, and the test edit. Rebuild; optionally `ssh root@10.0.3.112 systemctl restart saivage.service` if step 7-optional was exercised.
- No on-disk schema change. Files seeded under the new code remain loadable under the old code — the old loader accepts the new file (every emitted key is a known schema field).
- Per-step partial rollback:
  - Revert step 3 only: keep the schema export, restore the literal. Tests added in step 5 fail; remove them.
  - Revert step 1 (and consequently step 3): full revert.

## Cross-finding

- **G37 — config sync fs and stale cache.** G37 will rewrite `loadConfig`'s sync `readFileSync` path. G37 imports `SaivageConfigSchema` (exported by step 1). Land G08 first so G37 has a stable name.
- **F22 (round 1) — atomic writes via `writeDoc`.** G08 brings `saivage.json` under the F22 invariant. Note in merge message.
- **F33 (round 1) — `seedProject` rename and `ProjectConfig` trim.** G08 completes F33's intent for runtime config.
- **G47 — telegram-bot auth and startup.** The seeded `telegram.botToken = ""` is now materialized on disk. G47 should treat an empty token as operator-unconfigured and skip bot startup gracefully.
- **`ml-workspace-saivage-ops` memory note.** After validation passes, update the note: the seeder no longer clobbers MCP server policy or provider endpoints; the "restore preserved `saivage.json` after seeding" workaround applies only to auth-bearing fields (`providers.<name>.accounts.*.apiKey`, `telegram.botToken` value), which never lived in `saivage.json` under the new producer in the first place.
