# F33 r1 — Plan (Proposal A)

## Ordered edit steps

### Step 1 — Add `seedProject` and rewire `initProject`

File: [src/store/project.ts](src/store/project.ts).

- Add a new exported function `seedProject(projectRoot: string, opts: { name?: string; objectives?: string[] }): ProjectContext`. It:
  1. Validates that neither `.saivage/config.json` nor `.saivage/saivage.json` already exists; throws `Error("Project already initialized at <saivageDir>")` if either does.
  2. Creates the directory tree currently created by `initProject` ([src/store/project.ts](src/store/project.ts#L110-L118)).
  3. Builds a `ProjectConfig` literal containing only `project_name`, `objectives`, `model_overrides: {}`, `routing: { roles: {}, profiles: {} }`, `skills: { max_per_agent: 5 }` — i.e., the post-F33 shape (no `provider`, no `notifications`). Writes it to `config.json` via `writeDoc(configPath, config, ProjectConfigSchema)`.
  4. Builds the canonical `saivage.json` literal currently inside `writeDefaultConfig` ([src/config.ts](src/config.ts#L209-L235)) **minus** the `models` key (which becomes `.default({})` schema-side, see Step 4) and writes it via `writeFileSync(saivageJsonPath, JSON.stringify(..., null, 2) + "\n", "utf-8")`.
  5. Calls `initProjectTree(projectRoot)` (unchanged behavior, knowledge tree out of scope per `_LOOP-CONVENTIONS.md`).
  6. Returns `loadProject(projectRoot)`.
- Rewrite `initProject` ([src/store/project.ts](src/store/project.ts#L94-L124)) to delegate to `seedProject`. Drop the `config: ProjectConfig` parameter (its only callers are the CLI, which builds the literal inline, and tests, which call `defaultConfig()` — both updated in Steps 2 and 5). Keep `initProject` exported for one round, then remove it in favor of `seedProject` as the only entry point — same commit, no compatibility window.
  - Net result: only `seedProject(projectRoot, opts)` exists at the end of Step 1.

### Step 2 — Update CLI

File: [src/server/cli.ts](src/server/cli.ts#L32-L75).

- Replace the inline `config` object literal and the `initProject(path, config)` call with:
  ```ts
  const ctx = seedProject(path, { name: opts.name, objectives: opts.objectives });
  ```
- Update the import from `../store/project.js` to import `seedProject` instead of `initProject`.

### Step 3 — Trim `ProjectConfigSchema`

File: [src/types.ts](src/types.ts#L11-L45).

- Remove the `provider: z.string().optional()` line ([src/types.ts](src/types.ts#L14)).
- Remove the entire `notifications: z.object({ ... })` block ([src/types.ts](src/types.ts#L16-L33)).
- Resulting schema retains: `project_name`, `objectives`, `model_overrides`, `routing`, `skills`, `agents`.
- Search for `.provider` and `.notifications` accesses on `ProjectContext.config` / `ProjectConfig` across `src/` and update or delete those readers as a single batch in this step. Expected concrete readers (verify with `grep -rn 'config.provider\|ctx.config.provider\|project.config.provider' src --include='*.ts'` and same for `.notifications`):
  - Notification routing wired off `ProjectConfig.notifications` — switch to reading `SaivageConfig.notifications` (loaded via `loadConfig()`).
  - Any agent dispatch that reads `ctx.config.provider` — switch to the existing routing resolver path (already keyed off `SaivageConfig.models` / project `model_overrides`).
  - If a reader cannot be cleanly migrated in this commit, file a blocker and stop; do **not** keep both fields.

### Step 4 — Trim `configSchema` and delete `writeDefaultConfig`

File: [src/config.ts](src/config.ts).

- Change `models.default({ orchestrator: "anthropic/claude-sonnet-4-20250514" })` ([src/config.ts](src/config.ts#L49)) to `.default({})`. Aligns with F04's operator directive ("no model should be hard-coded"). Cross-linked but does not pre-empt F04's full fix.
- Delete `writeDefaultConfig` ([src/config.ts](src/config.ts#L204-L237)). Move the literal body into `seedProject` as described in Step 1.
- Remove the now-unused `writeFileSync`, `existsSync`, `mkdirSync` imports if and only if no other callers in the file remain (verify before deletion).
- Remove the `writeDefaultConfig` export from any barrel file (search `grep -rn writeDefaultConfig src --include='*.ts'` — currently zero callers, so the only edit is deleting the export from `src/config.ts` itself).

### Step 5 — Update tests

File: [src/store/project.test.ts](src/store/project.test.ts).

- Drop the `defaultConfig()` helper ([src/store/project.test.ts](src/store/project.test.ts#L31-L40)) — it carries the obsolete `notifications` block.
- Replace every `initProject(projectRoot, defaultConfig())` call with `seedProject(projectRoot, { name: "test-project", objectives: ["test"] })`.
- Update the import line ([src/store/project.test.ts](src/store/project.test.ts#L18)) to import `seedProject` instead of `initProject`.
- Add one new test in the same file: `it("writes saivage.json with web channel and info severity")` — reads `.saivage/saivage.json` after `seedProject`, parses it with `configSchema`, asserts `notifications.channels` equals `["web"]` and `notifications.filters.min_severity` equals `"info"`. This pins the CLI default to a single, documented value.
- Add one new test: `it("does not write a default provider/orchestrator model")` — parses `saivage.json`, asserts `models.orchestrator` is `undefined`. Cross-link F04.
- The five `initProject(projectRoot, defaultConfig())` calls in `src/knowledge/*.test.ts` ([src/knowledge/regression.test.ts](src/knowledge/regression.test.ts#L27), [src/knowledge/concurrency.test.ts](src/knowledge/concurrency.test.ts#L31), [src/knowledge/integration.test.ts](src/knowledge/integration.test.ts#L44), [src/knowledge/eagerLoader.test.ts](src/knowledge/eagerLoader.test.ts#L15), [src/knowledge/lifecycle.archive.test.ts](src/knowledge/lifecycle.archive.test.ts#L22)) actually call `initProjectTree(...)`, not `initProject(...)`. Verified — no changes needed there.

### Step 6 — Sweep for stale references

Run from repo root:
```
rg -n 'writeDefaultConfig|ProjectConfigSchema.*provider|ProjectConfig\\b.*notifications|config\\.provider' src
```
- Expect zero hits for the first three. Any hits for `config.provider` must be replaced with `SaivageConfig.models.orchestrator` (or the equivalent routing-resolver call) in the same commit.

---

## Test strategy

**Existing tests that cover this code path:**
- [src/store/project.test.ts](src/store/project.test.ts#L1-L113) — all five `it(...)` blocks exercise `initProject` and `initProjectTree`. After Step 5 they exercise `seedProject` directly.

**New tests added in Step 5:**
- `seedProject writes saivage.json with web channel and info severity`.
- `seedProject does not write a default provider/orchestrator model`.

**Exact validation commands** (from `_LOOP-CONVENTIONS.md`):

```
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run src/store/project.test.ts
npx vitest run src/knowledge
npx vitest run            # full suite to catch any reader of config.provider / config.notifications missed in Step 3
```

Acceptance gate: typecheck clean, build clean, all of `src/store/project.test.ts` green (including the two new assertions), full Vitest suite green.

---

## Rollback strategy

Single commit. Revert via `git revert <sha>`. Because the change is purely additive in one direction (delete the duplicate writer, delete the duplicate schema block) and the new `seedProject` is the canonical entry point, revert restores both `initProject` and `writeDefaultConfig` as they stood pre-change. No on-disk format reverse-migration is needed — projects regenerated after the change carry no `provider` field, and a revert reintroduces the (now-tolerated, schema-optional) field without consumers depending on it.

---

## Cross-issue ordering

- **Before:** none strictly required. The change is self-contained.
- **After / coordination:**
  - **F04** (hardcoded-default-models): F33 removes the `models.default({ orchestrator: ... })` schema literal. F04's own plan should account for this — when F04 lands, there is no schema-level orchestrator default left to also remove. If F04 lands first, this plan's Step 4 line "change `models.default(...)` to `.default({})`" becomes a no-op and is dropped.
  - **F02** (agent-roster-drift): F33 does not change the *set* of model role keys (`orchestrator / planner / manager / ...`), only the default value. F02 may rename or add keys after F33; no ordering constraint.
  - **F32** (config-blocks-undocumented): F33 removes the `notifications` block from `ProjectConfigSchema`. F32's documentation pass must reflect the post-F33 shape; therefore F33 should land **before** F32.
- **Operator action required after the change:** existing projects (`.saivage/config.json` carrying `provider` or `notifications`) must be regenerated by re-running `saivage init` in a fresh directory or by manually editing the file to drop those keys. Per project guideline #1 this is the intended workflow — no migration code is added.
