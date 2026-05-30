# F33 r2 — Plan (Proposal A)

## Changes from r1

- Step 1 now states the final name is `seedProject` only (no transitional `initProject`). The barrel export change is split out as Step 2.
- New Step 2 updates `src/index.ts` to export `seedProject` instead of `initProject`.
- Step 3 (CLI) is the former Step 2.
- Step 4 (`ProjectConfigSchema` trim) explicitly migrates the single web-chat notifications consumer in `server.ts` to `runtime.config.notifications`, instead of leaving the migration "expected" but unspecified.
- Step 5 (configSchema/writeDefaultConfig) unchanged in shape; explicit confirmation that nothing else in `src/config.ts` needs reorg.
- New Step 6 cleans up the routing-resolver leftover provider path (`ProjectRoutingConfigLike.provider`, the two branches in `resolveLegacyModels` and `resolveSource`, the `"project-default"` source union member). This is the cleanup r1 missed.
- Step 7 (tests) expanded:
  - `src/config.test.ts` orchestrator assertion updated.
  - `src/routing/resolver.test.ts` `provider:` lines removed from four constructor calls.
  - `src/store/project.test.ts` migration written out, including which `defaultConfig()` features go away.
  - New seed tests now explicitly use `loadConfig(true, projectRoot)` to read `saivage.json` (since `configSchema` is not exported).
- Step 8 (sweep) widened to include `this.project.provider`, `ProjectRoutingConfigLike`, `initProject` exports, and `runtime.project.config.notifications`.

## Ordered edit steps

### Step 1 — Add `seedProject`, remove `initProject`

File: [src/store/project.ts](src/store/project.ts).

- Replace the exported `initProject(projectRoot, config: ProjectConfig)` function with `seedProject(projectRoot: string, opts: { name?: string; objectives?: string[] }): ProjectContext`. New body:
  1. Compute `saivageDir = join(projectRoot, ".saivage")`, `configPath = join(saivageDir, "config.json")`, `saivageJsonPath = join(saivageDir, "saivage.json")`.
  2. If `existsSync(configPath) || existsSync(saivageJsonPath)`, throw `Error("Project already initialized at " + saivageDir)`.
  3. Create the same directory tree currently created by `initProject` ([src/store/project.ts](src/store/project.ts#L113-L121)).
  4. Build a `ProjectConfig` literal with the post-F33 shape:
     ```ts
     const config: ProjectConfig = {
       project_name: opts.name ?? "my-project",
       objectives: opts.objectives ?? [],
       model_overrides: {},
       routing: { roles: {}, profiles: {} },
       skills: { max_per_agent: 5 },
     };
     ```
     Write via `writeDoc(configPath, config, ProjectConfigSchema)`.
  5. Build the canonical `saivage.json` literal (the body currently inside `writeDefaultConfig` at [src/config.ts](src/config.ts#L207-L235), **omitting** the `models: {}` key, since the schema now provides `.default({})` itself):
     ```ts
     const saivageJson = {
       providers: {
         anthropic: {},
         openai: {},
         ollama: { baseUrl: "http://localhost:11434" },
         llamacpp: { baseUrl: "http://localhost:8080" },
       },
       failover: {},
       modelEquivalents: {},
       server: { port: 8080, host: "0.0.0.0" },
       agent: { maxConcurrentAgents: 3 },
       notifications: {
         channels: ["web"],
         filters: { min_severity: "info", categories: [] },
       },
       mcpServers: {
         playwright: {
           command: "npx",
           args: ["-y", "@playwright/mcp@latest", "--headless"],
           env: { PLAYWRIGHT_BROWSERS_PATH: "${HOME}/.cache/ms-playwright" },
           disabled: false,
           autostart: true,
           transport: "stdio",
         },
       },
     };
     writeFileSync(saivageJsonPath, JSON.stringify(saivageJson, null, 2) + "\n", "utf-8");
     ```
  6. Call `initProjectTree(projectRoot)` (unchanged, knowledge tree out of scope).
  7. Return `loadProject(projectRoot)`.
- Delete the old `initProject` symbol. No alias.

### Step 2 — Update public barrel export

File: [src/index.ts](src/index.ts#L37-L41).

- Change:
  ```ts
  export { loadProject, discoverProject, initProject, type ProjectContext } from "./store/project.js";
  ```
  to:
  ```ts
  export { loadProject, discoverProject, seedProject, type ProjectContext } from "./store/project.js";
  ```
- Verify no external consumer in this repo imports `initProject` from the barrel: `grep -rn 'from "saivage"\|from "\.\./index' src --include='*.ts'` (expected: zero direct barrel imports of `initProject`).

### Step 3 — Update CLI

File: [src/server/cli.ts](src/server/cli.ts#L32-L75).

- Replace the dynamic import `const { initProject } = await import("../store/project.js");` with `const { seedProject } = await import("../store/project.js");`.
- Delete the entire inline `config = { ... }` literal (lines 41-65).
- Replace `const ctx = initProject(path, config);` with:
  ```ts
  const ctx = seedProject(path, { name: opts.name, objectives: opts.objectives });
  ```

### Step 4 — Trim `ProjectConfigSchema` and migrate the web-chat notifications reader

File: [src/types.ts](src/types.ts#L11-L45).

- Remove `provider: z.string().optional(),` ([src/types.ts](src/types.ts#L14)).
- Remove the entire `notifications: z.object({ ... }),` block ([src/types.ts](src/types.ts#L16-L33)).
- Resulting `ProjectConfigSchema` retains: `project_name`, `objectives`, `model_overrides`, `routing`, `skills`, `agents`.

File: [src/server/server.ts](src/server/server.ts#L734).

- Change `const filters = runtime.project.config.notifications?.filters;` to `const filters = runtime.config.notifications.filters;` (`runtime.config` is the loaded `SaivageConfig`; `notifications` always exists thanks to the schema default; `filters` is also always present). This unifies the web-chat consumer with the Telegram consumer at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L80-L84).
- If the surrounding code uses optional chaining on `notifications`, remove it: the schema guarantees presence.

### Step 5 — Trim `configSchema` and delete `writeDefaultConfig`

File: [src/config.ts](src/config.ts).

- Change `models.default({ orchestrator: "anthropic/claude-sonnet-4-20250514" })` ([src/config.ts](src/config.ts#L49)) to `.default({})`. Cross-linked to F04 but does not pre-empt F04's full fix.
- Delete `writeDefaultConfig` ([src/config.ts](src/config.ts#L204-L237)). The literal body has been moved into `seedProject` in Step 1.
- After deletion, verify that `writeFileSync`, `existsSync`, `mkdirSync` imports at [src/config.ts](src/config.ts#L2) still have other callers in the file; if not, drop the unused ones. (Spot-check: `loadConfig` uses `existsSync` and `readFileSync`; `ensureDir` uses `existsSync` and `mkdirSync`; `writeFileSync` was used only by `writeDefaultConfig` and should be removable.)

### Step 6 — Remove legacy `provider` from the routing resolver

File: [src/routing/resolver.ts](src/routing/resolver.ts).

- Remove `provider?: string;` from `ProjectRoutingConfigLike` ([src/routing/resolver.ts](src/routing/resolver.ts#L78-L82)).
- In `resolveLegacyModels` ([src/routing/resolver.ts](src/routing/resolver.ts#L276-L286)), delete:
  ```ts
  if (this.project.provider) return [this.project.provider];
  ```
  The `return ["openai-codex/gpt-5.3-codex"];` line remains (owned by F04, see Out-of-scope below).
- In `resolveSource` ([src/routing/resolver.ts](src/routing/resolver.ts#L287-L294)), delete:
  ```ts
  if (this.project.provider) return "project-default";
  ```
- Remove `"project-default"` from the `ResolvedModelRoute["source"]` union ([src/routing/resolver.ts](src/routing/resolver.ts#L99)). The union becomes `"routing" | "legacy" | "runtime-default" | "hardcoded-default"`.
- Confirm there are no other readers of `ProjectRoutingConfigLike.provider` outside this file: `grep -rn '\.project\.provider\|ProjectRoutingConfigLike' src --include='*.ts'`. Expected: zero hits after Step 6.

### Step 7 — Update tests

File: [src/store/project.test.ts](src/store/project.test.ts#L1-L113).

- Drop the `defaultConfig()` helper ([src/store/project.test.ts](src/store/project.test.ts#L31-L40)).
- Change the import at [src/store/project.test.ts](src/store/project.test.ts#L18) from `initProject, initProjectTree, loadProject` to `seedProject, initProjectTree, loadProject`.
- Remove the `ProjectConfigSchema, type ProjectConfig` import at [src/store/project.test.ts](src/store/project.test.ts#L19) — no longer used.
- Replace every `initProject(projectRoot, defaultConfig())` with `seedProject(projectRoot, { name: "test-project", objectives: ["test"] })`.
- Add two new `it(...)` blocks at the end of the `describe("initProject — knowledge tree", ...)` block (renamed to `describe("seedProject", ...)`):
  ```ts
  it("writes saivage.json with web channel and info severity", () => {
    seedProject(projectRoot, { name: "p", objectives: [] });
    const cfg = loadConfig(true, projectRoot);
    expect(cfg.notifications.channels).toEqual(["web"]);
    expect(cfg.notifications.filters.min_severity).toBe("info");
  });

  it("does not write a default orchestrator model into saivage.json", () => {
    seedProject(projectRoot, { name: "p", objectives: [] });
    const cfg = loadConfig(true, projectRoot);
    expect(cfg.models.orchestrator).toBeUndefined();
  });
  ```
  Import `loadConfig` from `../config.js` at the top of the file.

File: [src/config.test.ts](src/config.test.ts#L30-L34).

- Change `expect(config.models.orchestrator).toBe("anthropic/claude-sonnet-4-20250514");` to `expect(config.models.orchestrator).toBeUndefined();`. The schema-level orchestrator default is gone, so `loadConfig` on an empty project must produce no orchestrator entry.

File: [src/routing/resolver.test.ts](src/routing/resolver.test.ts).

- Remove the `provider: "github-copilot/gpt-5.4",` line from each of the four `new ModelRoutingResolver({...}, ...)` invocations at lines ~7, ~33, ~76, and ~106. None of the assertions in those four blocks depend on the removed `project-default` source — verified: the four blocks assert sources `legacy`, `runtime-default`, `routing`, `routing`, `runtime-default`. Nothing else in the file references `provider`.
- After the edits, `ProjectRoutingConfigLike` literals in this file contain only `model_overrides` and/or `routing` keys.

File: [src/knowledge/*.test.ts] (five files).

- No changes required. Verified during r1 that these tests call `initProjectTree(...)`, not `initProject(...)`. Re-verify with `grep -rn 'initProject\b' src/knowledge --include='*.ts'` (expected: zero hits, only `initProjectTree`).

### Step 8 — Sweep for stale references

From repo root:

```
rg -n 'writeDefaultConfig|ProjectConfigSchema.*provider|ProjectConfigSchema.*notifications|this\.project\.provider|ProjectRoutingConfigLike|\binitProject\b|runtime\.project\.config\.notifications|project-default' src
```

Expectations after Steps 1–7:

- `writeDefaultConfig`: zero hits.
- `ProjectConfigSchema.*provider`, `ProjectConfigSchema.*notifications`: zero hits.
- `this.project.provider`: zero hits.
- `ProjectRoutingConfigLike`: only definition + struct uses inside `resolver.ts`, no `.provider` member.
- `\binitProject\b`: only inside `initProjectTree` (which is a distinct function). Run `rg -n 'initProject\(' src` to confirm zero call sites of the bare function.
- `runtime.project.config.notifications`: zero hits.
- `project-default`: zero hits.

Any non-zero hit is a missed reader. Fix in this same commit; do not defer.

---

## Test strategy

**Existing tests that cover this code path:**

- [src/store/project.test.ts](src/store/project.test.ts#L1-L200) — exercise `seedProject` and `initProjectTree`.
- [src/config.test.ts](src/config.test.ts#L1-L80) — covers `loadConfig` defaults; the orchestrator-default assertion is updated.
- [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L1-L130) — covers resolver behavior; the `provider:` test inputs are dropped (no `project-default` assertion exists today; nothing else regresses).

**New tests added in Step 7:**

- `seedProject writes saivage.json with web channel and info severity`.
- `seedProject does not write a default orchestrator model into saivage.json`.

**Exact validation commands** (from `_LOOP-CONVENTIONS.md`):

```
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run src/store/project.test.ts
npx vitest run src/config.test.ts
npx vitest run src/routing/resolver.test.ts
npx vitest run            # full suite to catch any missed reader
```

Acceptance gate: typecheck clean, build clean, all three focused test files green (including the two new assertions and the updated orchestrator assertion), full Vitest suite green.

---

## Rollback strategy

Single commit. Revert via `git revert <sha>`. The change is one-direction (delete duplicate writer, delete duplicate schema block, delete legacy resolver branches) plus one rename (`initProject` -> `seedProject`); revert restores both `initProject` and `writeDefaultConfig` and the `provider` field/branches as they stood pre-change. No on-disk format reverse-migration is needed — projects regenerated after the change carry no `provider` field, and a revert reintroduces the (now-tolerated, schema-optional) field without consumers depending on it.

---

## Cross-issue ordering

- **Before:** none strictly required.
- **After / coordination:**
  - **F04** (hardcoded-default-models): F33 removes the `models.default({ orchestrator: ... })` schema literal and the CLI-literal `provider: "openai-codex/gpt-5.3-codex"`. The two hardcoded *fallbacks* (`openai-codex/gpt-5.3-codex` at [src/routing/resolver.ts](src/routing/resolver.ts#L131) and `anthropic/claude-sonnet-4-20250514` at [src/providers/router.ts](src/providers/router.ts#L204)) remain in place and are owned by F04. F33's plan is consistent with F04 landing afterward.
  - **F02** (agent-roster-drift): F33 does not change the set of model role keys (`orchestrator / planner / manager / ...`), only the default value. F02 may rename or add keys after F33; no ordering constraint.
  - **F32** (config-blocks-undocumented): F33 removes the `notifications` block from `ProjectConfigSchema`. F32's documentation pass must reflect the post-F33 shape; therefore F33 should land **before** F32.
- **Operator action required after the change:** existing projects (`.saivage/config.json` carrying `provider` or `notifications`) must be regenerated by re-running `saivage init` in a fresh directory or by manually editing the file to drop those keys. Per project guideline #1 this is the intended workflow — no migration code is added.
