# Saivage v2 — Skill + Memory: Implementation Plan

Status: DRAFT (Phase C, round 3)
Author: Claude Opus 4.7 (writer)
Date: 2026-05-23

Source of truth: [01-DESIGN.md](01-DESIGN.md) (ACCEPTED). Requirements: [00-FUNCTIONAL-ANALYSIS.md §4](00-FUNCTIONAL-ANALYSIS.md). All §-references below cite the design unless prefixed `FA§`.

Round-2 note: This revision incorporates the round-1 reviewer findings (see §11). The most significant structural changes are: (a) a new WI-06 introduces a `ToolCallContext` through the MCP runtime + dispatcher so the permissions engine (WI-04) can actually be enforced inside handlers; (b) three new WIs (WI-10 project init, WI-11 lifecycle archival hooks, WI-12 `/api/mcp/tools` route) supply prerequisites that round-1 silently assumed; (c) the new MCP services register under their **final** wire names `skills` and `memory` (no transient `knowledge.*` namespace) and are flag-gated so they never coexist with the old handlers; (d) the `.runtime.pid` multi-instance defense is dropped (design §K rejects cross-process scope). WI count: 21.

---

## §1. Build-safe ordering

Six milestones. The implementer runs `pnpm test` after every WI; the suite stays green at every checkpoint. Design §J.3 prescribes the same shape; this plan splits it into commit-sized WIs and adds the milestones the design omits (runtime context propagation, project init, lifecycle hooks, smoke route, test seeding, cutover, doc updates, deletions).

**M1 — Scaffold (additive only; old paths still authoritative).**
1. **WI-01** Add `src/knowledge/types.ts` (Zod schemas). Pure types; importable but unused.
2. **WI-02** Add `src/security/secrets.ts` (heuristics + `BLOCKED_PATH` table). Unit-tested in isolation.
3. **WI-03** Add `src/knowledge/store.ts` (`writeRecordAtomic`, `appendJsonlAtomic`, `rebuildIndex`, per-record mutex map, per-scope index mutex, two-key supersede lock). No call sites.
4. **WI-04** Add `src/knowledge/permissions.ts` (per-role × per-op ACL matrix from §F; Y† worker-scope predicate).
5. **WI-05** Add `src/knowledge/loader.ts` (`resolveEagerRecords`, `reinjectSurvivors`, canonical normalization, `search_*` scoring, read-time redaction helper). No call sites; `src/skills/loader.ts` still owns prompt injection.
6. **WI-06** Thread `ToolCallContext` (role/agentId/stageId/channelId/projectRoot) through `src/mcp/runtime.ts`, `src/runtime/dispatcher.ts`, and `src/agents/base.ts` so MCP handlers can enforce role/scope rules. Strictly additive: existing handlers ignore the new field; tests for legacy handlers stay green.

**M2 — MCP surface (additive; new services flag-gated under final wire names `skills` and `memory`; old handlers still serve agents).**
7. **WI-07** Add 8 skill tools (`create_skill`…`search_skills`) on the in-process service `skills`, routed through WI-03/04/06. **Registration is gated by a module-private flag `useKnowledgeLoader` defaulting to `false`**; with the flag off the legacy `skillsHandler` continues to serve. With the flag on (test-only override in M2), the new handler **replaces** the legacy one — duplicate flat tool names are prevented by mutually-exclusive registration, never by coexistence (reviewer's open-item decision: no transient `knowledge.*` prefix).
8. **WI-08** Add 8 memory tools (`create_memory`…`search_memories`) on the in-process service `memory` under the same `useKnowledgeLoader` flag, replacing the `available:false` stub when the flag is on.
9. **WI-09** Add `src/chat/slashCommands.ts` parser + Chat agent hook (read-only; `/remember` and `/forget` route to Planner via existing inter-agent message path).

**M3 — Cutover prerequisites + cutover (BaseAgent flips to the new loader; old path deleted in the same commit).**
10. **WI-10** **Project init.** Extend `src/store/project.ts` to create the `.saivage/{skills,memory}/{project,stages,sessions}/` tree on `initProjectTree`, seed each leaf with `index.json` (`{ skills: [] }` / `{ memories: [], topic_map: {} }`), create an empty `audit.jsonl`, and append `skills/` + `memory/` ignore policy to `.saivage/.gitignore` (FR-21 — project/stage trees are git-trackable; session trees are ignored). Add `memory` to `ProjectContext.paths`.
11. **WI-11** **Lifecycle archival hooks.** Add hook points where the runtime already knows a stage or chat session has terminally closed: archive active stage-scoped records into `.saivage/{skills,memory}/stages/<stage_id>/` on `plan_complete_stage` (and on stage abort), and archive session-scoped records on chat channel close. Hooks call into `src/knowledge/lifecycle.ts` (new module) which is a no-op when `useKnowledgeLoader=false` (build-safe).
12. **WI-12** **`/api/mcp/tools` HTTP route.** Add `GET /api/mcp/tools` in `src/server/server.ts` returning the result of `runtime.mcpRuntime.getAllTools()` (minus the handler refs; JSON-safe projection only). Used by the Phase D cutover smoke (§6.2) and by debug tooling. Token-protected like every other `/api/*` route.
13. **WI-13** Add `BaseAgent`-side eager-injection wiring guarded by the same module-private `useKnowledgeLoader` flag (still `false` by default). Flag is not in config, not in `saivage.json`.
14. **WI-14** Add `BaseAgent` survivor-reinjection (§E.1) and Planner pre-compaction nudge (§E.2), both behind the same flag.
15. **WI-15** Add `fsGuard` rule rejecting `write_file` under `.saivage/{skills,memory}/` (closes FA §1.6.4 escape hatch). Tested directly; flag-independent (purely additive — old path doesn't write there either).
16. **WI-16** **Cutover commit.** Flip `useKnowledgeLoader` default to `true`; in the **same commit**, delete `src/skills/loader.ts`, the legacy `skillsHandler` registration, the `memoryTools` `available:false` stub, the `indexTools` stub, the flag constant + both code branches that read it, and the four built-in `SKILL.md`s from `skills/<topic>/`. Move them to `skills/builtin/<topic>/SKILL.md` with YAML frontmatter (§J.1, FR-31a). Update `tsup.config.ts` to bundle `skills/builtin/**` into `dist/skills/builtin/**` (FR-24). This is the largest WI; everything required to make `pnpm test` green is in one commit.

**M4 — Schema cleanup (delete obsolete types now that no consumer exists).**
17. **WI-17** Delete `SkillEntrySchema`, `SkillIndexSchema`, `SkillMatchContext` (with `tools`/`filePaths`), and any `MemoryEntrySchema`/`IndexEntrySchema` stubs from `src/types.ts §10`. Update imports.

**M5 — Tests (§I).** Tests for each module land **inside** the WI that creates the module (e.g., WI-01 ships `types.test.ts`); this milestone covers the cross-cutting tests that need multiple modules.
18. **WI-18** Integration tests: MCP round-trips for all 16 tools via the role-aware `callTool(serviceName, toolName, args, ctx)` path, error taxonomy assertions (§C.3), all **15** error codes.
19. **WI-19** Concurrency tests (FR-29, FR-31g): per-record mutex serialization, per-scope index mutex (two distinct creates → both in index), supersede two-key rollback, sweeper-vs-author race, parallel `create_memory` index integrity.
20. **WI-20** Agent-level tests: eager injection per role, stage-scope archival on stage terminal (via WI-11 hook), session archival on channel close, compaction survivor reinjection, FR-16 Planner pre-compaction nudge, Chat `/remember` indirection.
21. **WI-21** Regression-pin tests FR-31a..g (one test per defect, suffixed with the FR-31 letter, per §I last bullet); FR-31a's prod-bundle assertion lives in a separate `pnpm test:bundle` script and is **not** invoked by the default `vitest run`.

**M6 — Docs (Phase E preview list only).** §7 enumerates the spec files to update. **No doc edits in this plan** — Phase E owns them.

Justification: M1's modules are leaves and the runtime-context plumbing (WI-06) is additive; M2's services register under final names but are gated off, so no flat-namespace collision can occur; M3's three new prerequisite WIs (10/11/12) make WI-16 buildable — the cutover can rely on initialized trees, lifecycle hooks, and a real smoke endpoint; M4 deletes types only after M3 removed all readers; M5 cross-cuts; M6 is preview.

---

## §2. Pre-flight (engineer runs once)

```bash
# 1. Clean working tree.
cd /home/salva/g/ml/saivage
git status                              # must be clean
git checkout -b feat/skills-memory

# 2. Verify baseline green.
pnpm install                            # or npm ci; see package.json
pnpm test                               # vitest run; record pass count
pnpm build                              # tsup + web build

# 3. Snapshot live deployments (Phase D will compare against these).
#    Classic LXC ops per workspace handoff; one container per row.
for c in saivage saivage-v3 diedrico; do
  sudo lxc-attach -n "$c" -- bash -c '
    ls -la /work/*/.saivage/ 2>/dev/null;
    find /work/*/.saivage/skills /work/*/.saivage/memory \
      -maxdepth 3 2>/dev/null
  ' > tmp/cutover-snapshot-$c.txt
done

# 4. Confirm FA §1.4 finding still holds (0 skill data on any live host).
grep -l 'index.json' tmp/cutover-snapshot-*.txt    # expect: no output
```

Do NOT modify live state in pre-flight. Snapshots are reference only.

---

## §3. Work items

Conventions: roles abbreviated as in §C.1 (Pl/Mg/Co/Re/Da/In/Rv/De/Ch). Every WI ends with `pnpm test && pnpm build` green unless flagged.

### M1 — Scaffold

#### WI-01 Add knowledge types

- **Goal**: Zod schemas `SkillRecord`, `MemoryRecord`, `AuditEntry`, `RecordBase` with `(scope, scope_ref)` refinement (§B.1).
- **Files touched**:
  - [NEW] `src/knowledge/types.ts`
  - [NEW] `src/knowledge/types.test.ts`
- **Acceptance**:
  - All schemas exported; round-trip `parse(stringify(record))` for valid fixtures of every (kind, scope) combo. (FR-2)
  - `scope_ref` refinement rejects `{scope:"stage", scope_ref: undefined}`. (FR-2, FR-4)
  - Lifecycle enum matches §B.2 states. (FR-3)
- **Tests added**:
  - `types.test.ts`: parametrized parse/reject table (§I unit-schema bullet).
- **Build-safe?** yes (additive, zero consumers).
- **Depends on**: none.
- **Reverts cleanly**: yes.
- **Estimated diff**: S.

#### WI-02 Add secret scanner

- **Goal**: `src/security/secrets.ts` exposes `scanForSecrets(text)` returning `{matches:[{field,span}]}`, `redact(text, matches)` returning the input with each match replaced by `[REDACTED]`, and `isBlockedPath(path)`. Heuristics enumerated in §C.3 "Security".
- **Files touched**:
  - [NEW] `src/security/secrets.ts`
  - [NEW] `src/security/secrets.test.ts`
- **Acceptance**:
  - Every heuristic in §C.3 (provider shapes, env-style + entropy, literal markers) has a positive synthetic fixture and a near-miss negative. (FR-27)
  - `isBlockedPath` returns `true` for each path in the §C.3 blocked-paths list. (FR-27)
  - `redact` substitutes every match with `[REDACTED]` and returns `redacted_spans:[…]` metadata; round-trips a fixture body that contains two non-overlapping matches. (FR-27, design §C.3 read-time redaction)
  - No real secrets in fixtures.
- **Tests added**: `secrets.test.ts` — heuristic table + path table + redaction table.
- **Build-safe?** yes.
- **Depends on**: none.
- **Reverts cleanly**: yes.
- **Estimated diff**: S.

#### WI-03 Add knowledge store primitives

- **Goal**: `src/knowledge/store.ts` with `writeRecordAtomic`, `appendJsonlAtomic`, `rebuildIndex`, per-record mutex map (§C.3), **per-scope index mutex** (covers distinct-record writes that share an `index.json`), supersede two-key lock with rollback.
- **Files touched**:
  - [NEW] `src/knowledge/store.ts`
  - [NEW] `src/knowledge/store.test.ts`
  - [MODIFY] `src/store/documents.ts` — only if `writeDoc` is not already exported sufficiently (read-only inspection first; design says re-use as-is).
- **Acceptance**:
  - `writeRecordAtomic` happy path + `INVALID_SCOPE_REF` + `SECRET_DETECTED` rejection paths each emit one audit line. (FR-28, FR-27)
  - `appendJsonlAtomic` enforces 2048 B cap with `…[truncated]` suffix; reader tolerates partial trailing line. (§C.3)
  - `rebuildIndex` idempotent on shuffled-records-dir input. (§C.3)
  - Per-record mutex: two overlapping `update`s on same id execute in arrival order; both succeed; final state == second write. (FR-29)
  - **Per-scope index mutex**: two distinct `create_memory` calls in the same scope serialize their `rebuildIndex` writes; final `index.json` lists both records. (FR-29, FR-31g — this is the round-1 reviewer's blocking concern)
  - Supersede two-key lock: step-3 failure rolls back NEW record (`unlink` body + json); audit has `outcome:"rejected"`. (FR-29)
  - Loader repair: if NEW.supersedes points to OLD without matching `superseded_by`, next mutating access patches OLD. (§C.3)
  - All **15** error codes from design §C.3 have at least one path that returns them somewhere across `store.test.ts` and the M2 service tests (counted, not just listed).
- **Tests added**: `store.test.ts` — per-record mutex, per-scope index mutex, rollback, audit/index-rebuild error paths.
- **Build-safe?** yes.
- **Depends on**: WI-01, WI-02.
- **Reverts cleanly**: yes.
- **Estimated diff**: M.
- **Explicitly NOT included** (round-2 change): no `.saivage/.runtime.pid` cross-process defense. Design §K rejects cross-process concurrency; runtime already has a project-level single-instance guard via `src/runtime/recovery.ts` and `src/server/bootstrap.ts`. (Round-1 reviewer open-item ruling.)

#### WI-04 Add permissions engine

- **Goal**: `src/knowledge/permissions.ts` exporting `canCall(role, op, kind) → boolean` and `checkScope(role, scope, scope_ref, ctx) → null | ErrorCode`. Tables hard-coded from §F.
- **Files touched**:
  - [NEW] `src/knowledge/permissions.ts`
  - [NEW] `src/knowledge/permissions.test.ts`
- **Acceptance**:
  - Every cell of §F matrix has a positive and negative test (one test row per (role, op, kind) combination). (FR-6, FR-31e(i))
  - Y† worker scope: Coder `create_memory` with `scope:"project"` → `UNAUTHORIZED_SCOPE`; with `scope:"stage"` + matching `scope_ref` → OK.
- **Tests added**: `permissions.test.ts` — parametrized matrix.
- **Build-safe?** yes.
- **Depends on**: WI-01.
- **Reverts cleanly**: yes.
- **Estimated diff**: S.

#### WI-05 Add knowledge loader

- **Goal**: `src/knowledge/loader.ts` with `resolveEagerRecords`, `reinjectSurvivors`, canonical normalization, scoring (§D.1, D.2, D.3), and a `redactForRead(record) → record'` helper that re-scans body/keys/topic with WI-02 and replaces matches with `[REDACTED]`, returning `redacted_spans:[…]` to the caller. No call sites yet.
- **Files touched**:
  - [NEW] `src/knowledge/loader.ts`
  - [NEW] `src/knowledge/loader.test.ts`
  - [NEW] `src/knowledge/builtinWalker.ts` (frontmatter parser for `skills/builtin/**/SKILL.md`; works in src + dist per FR-24 — fixture-tested with a temp dir, not the real bundle yet).
- **Acceptance**:
  - Survivor sub-budget unconditional; oversized survivor at load time → quarantined; id surfaces in `oversized_survivors:[…]`. (FR-15, §D.2)
  - Ordinary budget caps at 2048 tokens; dropped ids appear in `omitted:[…]`. (FR-11)
  - `target_agents` filter + scope filter (via directory provenance) applied. (FR-12)
  - Trigger scoring only honors `keyword:`/`tag:`/`agent:`; `tool:`/`path:` ignored. (FR-13, §D.4)
  - Canonical normalization: NFC + lower + strip-punct + collapse-ws; tests with unicode/case/punct fixtures. (§D.3)
  - `search_*` ordering: score desc → updated_at desc → id asc. (§D.3)
  - `redactForRead`: feeding a record whose persisted body contains a real-shaped secret (corrupted-on-disk fixture that bypassed write-time scanning) returns a record with the match replaced and `redacted_spans` populated. (FR-27 read-time, design §C.3)
  - `builtinWalker` reads frontmatter from a fixture dir (tests both `src`-shaped and `dist`-shaped layouts). (FR-24, FR-31a — full prod-bundle assertion deferred to WI-21.)
- **Tests added**: `loader.test.ts` — eager budget, survivors, scope filter, scoring, redact-on-read; `builtinWalker.test.ts` — frontmatter walk.
- **Build-safe?** yes (no consumers yet).
- **Depends on**: WI-01, WI-02, WI-03.
- **Reverts cleanly**: yes.
- **Estimated diff**: M.

#### WI-06 Thread `ToolCallContext` through MCP runtime + dispatcher

- **Goal**: Round-1 blocking issue 1 (round-2 wrong-fix). The permissions engine (WI-04) is unreachable unless MCP handlers see who is calling. Add a typed `ToolCallContext = { role: AgentRole; agentId: string; stageId?: string; channelId?: string; sessionId?: string; projectRoot: string; author: string }` and thread it through the **real** call path, anchored at each source-of-truth.

  **Propagation chain (verified against current code).** None of `stageId`, `channelId`, `author` lives on `AgentContext` today (`src/agents/types.ts` L38-58 has `project`, `router`, `mcpRuntime`, `agentId`, `role`, `modelSpec`, `authProfileKey`, `accountRef`, `startupDirectives` — and nothing else). Round-2's WI-06 was wrong to claim the dispatcher could derive them from `AgentContext` alone. The fix is to extend `AgentContext` and populate it at every construction site:

  1. **`stageId` source of truth = the input that spawns the agent.**
     - Workers (Co/Re/Da/Rv): `WorkerInput.stageId` (`src/agents/types.ts` L65-67). The spawner in `src/server/bootstrap.ts` `createChildSpawner` (L268-310) already reads `workerInput.stageId` and calls `tracker.setCurrentStage(workerInput.stageId)` — that same value must be copied into `ctx.stageId` for each of `coder`, `researcher`, `data_agent`, `reviewer` cases.
     - Manager: `managerInput.stage.id` (already used at `bootstrap.ts` L301).
     - Planner: at `runPlanner()` in `src/server/bootstrap.ts` (~L455-470), read `runtime.tracker` current stage (the recovery tracker's `currentStageId` field — `src/runtime/recovery.ts` L338, L374) and seed `ctx.stageId` from it. Planner-spawned children inherit through the parent ctx, then are overwritten by the child's own input.
     - Chat: `stageId` is intentionally `undefined` (chat sessions are not stage-scoped).
  2. **`channelId` + `sessionId` source of truth = `ChatInput`** (`src/agents/types.ts` L73-76: `channel: string; sessionId: string`).
     - Web chat: `src/server/server.ts` ~L680-690 builds the chat `ctx` and constructs `ChatAgent(ctx, { channel: "web", sessionId }, …)`. The new fix copies `channel`/`sessionId` into `ctx.channelId`/`ctx.sessionId` **before** the `ChatAgent` constructor runs.
     - Telegram chat: `src/server/telegram-bot.ts` ~L87 (`new ChatAgent(…)`) — analogous.
     - All non-chat agents leave `channelId`/`sessionId` unset.
  3. **`author` derivation.** `author = `${role}/${agentId}`` (always available on `AgentContext`). The dispatcher synthesizes it.
  4. **`projectRoot` source of truth = `ctx.project.root`** (already on `ProjectContext`, exposed via `loadProject`).

  Once `AgentContext` carries those fields, `Dispatcher.executeLocalTool` (`src/runtime/dispatcher.ts` L150-205, currently calls `this.mcpRuntime.callTool(toolEntry.service, tc.name, args)` at L196 with no ctx) builds the `ToolCallContext` from the supplied `ctx: AgentContext` and forwards it:

  ```ts
  // In src/runtime/dispatcher.ts, executeLocalTool:
  const toolCtx: ToolCallContext = {
    role: ctx.role,
    agentId: ctx.agentId,
    stageId: ctx.stageId,
    channelId: ctx.channelId,
    sessionId: ctx.sessionId,
    projectRoot: ctx.project.root,
    author: `${ctx.role}/${ctx.agentId}`,
  };
  const result = await this.mcpRuntime.callTool(toolEntry.service, tc.name, args, toolCtx);
  ```

  `InProcessToolHandler` becomes `(args, ctx) => Promise<…>`; `MCPRuntime.callTool(service, tool, args, ctx)` accepts and forwards the new arg. Existing handlers in `src/mcp/builtins.ts` and `src/mcp/plan-server.ts` adopt the new signature trivially (most ignore `ctx`); a `withContext(handler)` wrapper in `src/mcp/toolContext.ts` covers handlers that the writer judges cleaner to leave at the old shape.

- **Files touched**:
  - [MODIFY] `src/agents/types.ts` — extend `AgentContext` with `stageId?: string`, `channelId?: string`, `sessionId?: string`. Update jsdoc to mark them as runtime-populated by the spawner.
  - [MODIFY] `src/server/bootstrap.ts` — in `createChildSpawner` (~L268-330) inside the `manager`/`coder`/`researcher`/`data_agent`/`reviewer` cases, set `ctx.stageId = managerInput.stage.id` / `workerInput.stageId` before passing `ctx` to the agent constructor. In `runPlanner` (~L450-475), seed `ctx.stageId` from `runtime.tracker.currentStageId` (expose via a getter if not already public).
  - [MODIFY] `src/runtime/recovery.ts` — add a `getCurrentStage(): string | null` getter on the tracker class (`currentStageId` is currently private at L338); used by `runPlanner` to seed Planner ctx.
  - [MODIFY] `src/server/server.ts` — at the WebSocket handler (~L677-695), set `ctx.channelId = "web"` and `ctx.sessionId = sessionId` **before** constructing `ChatAgent`.
  - [MODIFY] `src/server/telegram-bot.ts` — at the ChatAgent construction site (~L87), set `ctx.channelId = "telegram"` and `ctx.sessionId = <telegram-thread-id>` analogously.
  - [MODIFY] `src/mcp/runtime.ts` — `InProcessToolHandler` signature gains `(args, ctx?: ToolCallContext)`; `callTool(service, tool, args, ctx?)` forwards `ctx`; `getAllTools()` projection unchanged.
  - [MODIFY] `src/runtime/dispatcher.ts` — at `executeLocalTool` (~L196), build `toolCtx` from `ctx: AgentContext` per the snippet above; pass it as 4th arg to `mcpRuntime.callTool`.
  - [MODIFY] `src/agents/base.ts` — role-to-tool catalog computation reads the §F ACL matrix (via `permissions.canCall`) for the 16 new tool names; legacy tools keep current visibility.
  - [MODIFY] every existing in-process tool registration in `src/mcp/builtins.ts` and `src/mcp/plan-server.ts` — adjust handler signatures to accept the optional second arg `ctx` (most ignore it).
  - [MODIFY] `src/agents/agents.test.ts` — the `makeChatContext`/`makeReviewerContext` helpers (~L538, L582) must populate `stageId`/`channelId`/`sessionId` where applicable so that flag-on tests (M2+) see a realistic ctx.
  - [MODIFY] `src/agents/conversation-snapshot.test.ts` — `makeContext` (~L45) extended similarly.
  - [NEW] `src/mcp/toolContext.ts` — `ToolCallContext` type + a `withContext(handler)` wrapper for legacy handlers that have no use for ctx.
  - [NEW] `src/mcp/toolContext.test.ts`
  - [MODIFY] `src/mcp/runtime.test.ts` — assert ctx propagation end-to-end through the in-process runtime.
- **Acceptance**:
  - Existing MCP suite green (legacy handlers ignore the new `ctx` arg). (Build-safety guarantee.)
  - **Spawned-worker test**: a real `createChildSpawner` invocation for `role:"coder"` with `workerInput.stageId:"stg-X"` produces a `ctx: AgentContext` whose `stageId === "stg-X"`; a probe MCP handler registered for the test asserts `toolCtx.stageId === "stg-X"` and `toolCtx.author === "coder/<agentId>"`. (FR-6 prerequisite; FR-31e(i))
  - **Spawned-Planner test**: with the recovery tracker preloaded to `currentStageId:"stg-Y"`, `runPlanner` seeds `ctx.stageId === "stg-Y"`; probe handler asserts `toolCtx.stageId === "stg-Y"`. (FR-31e(i) — worker Y† scope rule depends on this.)
  - **Web-chat test**: a real WebSocket connect path (or a `server.test.ts` integration substitute) constructs a `ChatAgent` whose `ctx.channelId === "web"` and `ctx.sessionId === <gen>`; a probe handler asserts the same on `toolCtx`. (§F session-scope authorization)
  - **Telegram-chat test**: analogous, with `ctx.channelId === "telegram"`.
  - Tool catalog for each role (computed in `base.ts`) matches §F for the 16 new tool names when those tools are registered (M2). With M2 not yet landed, catalog is unchanged.
- **Tests added**: `toolContext.test.ts`; extensions to `runtime.test.ts`, `agents.test.ts` (spawner stageId test + ChatAgent channelId test), and `server.test.ts` (web-chat propagation).
- **Build-safe?** yes (additive ctx arg with default behavior; legacy handlers unaffected; legacy spawner sites that don't populate the new fields leave them `undefined`, which permission checks for project/built-in scopes do not consult).
- **Depends on**: WI-04 (for the role-to-tool catalog computation; ACL tables imported but not yet exercised at runtime).
- **Reverts cleanly**: yes; revert restores the old 2-arg handler shape and the smaller `AgentContext`.
- **Estimated diff**: M+.

### M2 — MCP surface

#### WI-07 Register `skills` MCP service (flag-gated, final wire name)

- **Goal**: 8 skill MCP tools (§C.1 first 8 rows) on the in-process service named **`skills`** (final wire name; reviewer's open-item ruling: no transient `knowledge.*` prefix), routed through WI-03/04/06. Registration is gated by a module-private flag in `src/mcp/builtins.ts` named `useKnowledgeLoader` (same flag WI-13/16 use for BaseAgent), defaulting to `false`. With the flag off, the legacy `skillsHandler` is registered as today. With the flag on (test-only override in M2), the new handler **replaces** the legacy one — never coexists with it. This is how the "duplicate flat tool names" collision (round-1 blocking issue 2) is prevented.
- **Files touched**:
  - [MODIFY] `src/mcp/builtins.ts` — add the `useKnowledgeLoader` module-private flag; replace the unconditional legacy `skillsHandler` `registerInProcess("skills", …)` call (~L1163) with a flag branch.
  - [NEW] `src/mcp/knowledgeSkills.ts` — handler module (thin adapters per design §C.1 "5–10-line adapters"). Each tool calls `permissions.canCall` + `permissions.checkScope` against `ctx.role`/`ctx.stageId`/`ctx.channelId` before invoking the store; read tools call `loader.redactForRead`.
  - [NEW] `src/mcp/knowledgeSkills.test.ts`
- **Acceptance**:
  - With `useKnowledgeLoader=false`: legacy `skillsHandler` still serves; existing `builtins.test.ts` skills assertions unchanged.
  - With `useKnowledgeLoader=true` (test override): every new skill tool round-trips. (FR-6, FR-7)
  - `EMPTY_REASON`, `NAME_COLLISION`, `INVALID_SUPERSEDE_SCOPE`, `OVERSIZED_SURVIVOR` each have one assertion. (§C.3)
  - `UNAUTHORIZED_ROLE` is raised **at the MCP runtime entry point** (via the WI-06 context + WI-04 engine) for every denied (role, tool) cell from §F skill columns, not at handler convention. (FR-31e(i))
  - Triggerless skill: `create_skill` with `triggers:[]` succeeds; `search_skills` finds it; eager injection does not. (FR-8)
  - **Read-time redaction (round-1 blocking 8)**: a hand-crafted on-disk skill body containing a secret-shaped string is returned by `read_skill` and `search_skills` with the match replaced by `[REDACTED]` and `redacted_spans` populated. (FR-27, design §C.3)
- **Tests added**: `knowledgeSkills.test.ts`.
- **Build-safe?** yes (flag off = identical to baseline; flag on never co-registers).
- **Depends on**: WI-03, WI-04, WI-06.
- **Reverts cleanly**: yes.
- **Estimated diff**: M.

#### WI-08 Register `memory` MCP service (flag-gated, final wire name)

- **Goal**: 8 memory MCP tools (§C.1 last 8 rows) on the in-process service named **`memory`** (final wire name; replaces the `available:false` stub when the flag is on; never coexists with it). Same `useKnowledgeLoader` flag as WI-07.
- **Files touched**:
  - [MODIFY] `src/mcp/builtins.ts` — replace the unconditional `memoryTools` stub registration (~L1167) with a flag branch identical in shape to WI-07.
  - [NEW] `src/mcp/knowledgeMemory.ts`
  - [NEW] `src/mcp/knowledgeMemory.test.ts`
- **Acceptance**:
  - With `useKnowledgeLoader=false`: stub still served as today.
  - With `useKnowledgeLoader=true` (test override): all 8 tools round-trip. (FR-6, FR-7, FR-14)
  - `TOPIC_COLLISION`, `UNAUTHORIZED_SCOPE` (Co `scope:"project"`), `INVALID_SUPERSEDE_TARGET` (supersede already-superseded), and `BLOCKED_PATH` (a body containing a `.env`-style path in the body text, plus a `body_path` write that points at `.env`) each have one assertion. (Round-1 non-blocking 3 fix: the design's `source_ref` is `{kind,id}`, not a path; `BLOCKED_PATH` therefore triggers on body-text path scanning and on `body_path` inputs, not on `source_ref` strings.)
  - `get_memory({topic})` walks supersession chain to head; returns null if head not active. (FR-18, §D.3)
  - `list_memories({older_than_days})` enumeration. (FR-19)
  - Workers (Co/Re) cannot call `supersede_memory`/`archive_memory`/`delete_memory` — `UNAUTHORIZED_ROLE` is raised at the runtime entry. (§F, FR-31e(i))
  - **Read-time redaction (round-1 blocking 8)**: `get_memory` and `search_memories` re-scan and redact. (FR-27, design §C.3)
- **Tests added**: `knowledgeMemory.test.ts`.
- **Build-safe?** yes (same gating as WI-07).
- **Depends on**: WI-03, WI-04, WI-06.
- **Reverts cleanly**: yes.
- **Estimated diff**: M.

#### WI-09 Chat slash-command parser

- **Goal**: `src/chat/slashCommands.ts` parses the seven commands in §H.1 and routes to MCP read tools (or, for `/remember`/`/forget`, to a Planner inter-agent message).
- **Files touched**:
  - [NEW] `src/chat/slashCommands.ts`
  - [NEW] `src/chat/slashCommands.test.ts`
  - [MODIFY] `src/agents/chat.ts` — pre-LLM message handler hooks the parser.
- **Acceptance**:
  - `/skills list`, `/skills show`, `/memories list`, `/memories show`, `/memories search` each map onto the correct MCP read tool (via the flag-aware runtime — when flag off they go to legacy stubs/handler, when flag on to the new services). (FR-22)
  - `/remember <text>` enqueues an inter-agent message to Planner; `/forget <id>` confirms then enqueues an `archive_memory` request. Chat never calls a write tool directly. (§H.1, §F)
  - Parser does NOT read `.saivage` directly (regression-pin for FA §1.6.4 escape hatch).
- **Tests added**: `slashCommands.test.ts`.
- **Build-safe?** yes; old Chat behavior intact when commands are absent.
- **Depends on**: WI-07, WI-08.
- **Reverts cleanly**: yes.
- **Estimated diff**: S.

### M3 — Cutover prerequisites + cutover

#### WI-10 Project init for knowledge trees

- **Goal**: Round-1 blocking issue 3. `saivage init` must create the accepted `.saivage/{skills,memory}/{project,stages,sessions}/` tree, seed empty indexes, create empty `audit.jsonl` per scope, and update `.saivage/.gitignore` so session-scoped trees are git-ignored while project + stage trees are tracked (FR-21). Also adds a `memory` key to `ProjectContext.paths` so downstream code can resolve memory paths via `loadProject(root).paths.memory`.
- **Files touched**:
  - [MODIFY] `src/store/project.ts` — extend `initProjectTree`/`loadProject` to add the new tree and `paths.memory`; update `.gitignore` template.
  - [MODIFY] `src/store/project.test.ts` — fresh init + reload assertions.
- **Acceptance**:
  - After `initProjectTree(root)`:
    - `<root>/.saivage/skills/{project,stages,sessions}/` and `<root>/.saivage/memory/{project,stages,sessions}/` exist.
    - `skills/project/index.json` contains `{"skills":[]}`; `memory/project/index.json` contains `{"memories":[],"topic_map":{}}`. (FR-1)
    - `skills/project/audit.jsonl` and `memory/project/audit.jsonl` exist and are empty.
    - `.saivage/.gitignore` still contains `tmp/`, plus a new line `skills/sessions/` and `memory/sessions/` (FR-21 — session scope is not git-trackable; project + stage are).
  - `loadProject(root).paths.memory` resolves to `<root>/.saivage/memory`.
  - Re-running `initProjectTree` on an already-initialized tree is idempotent: no overwrites, no errors.
- **Tests added**: extensions to `project.test.ts`.
- **Build-safe?** yes (additive paths; no consumer yet at this point — WI-07/08 only write into these paths once the flag flips).
- **Depends on**: none (independent of WI-06/07/08 type-wise; logically ordered here because cutover smoke depends on it).
- **Reverts cleanly**: yes.
- **Estimated diff**: S.

#### WI-11 Lifecycle archival hooks

- **Goal**: Round-1 blocking issue 4. FR-9 requires stage-scoped records to archive at stage terminal and (by symmetry, design §B.4) session-scoped records to archive at chat channel close. Today nothing wires this. Add a single `src/knowledge/lifecycle.ts` module exporting `archiveStage(projectRoot, stageId)` and `archiveSession(projectRoot, channelId)`, and call them from the runtime points that already detect those events.
- **Files touched**:
  - [NEW] `src/knowledge/lifecycle.ts`
  - [NEW] `src/knowledge/lifecycle.test.ts`
  - [MODIFY] `src/mcp/plan-server.ts` — at the end of `plan_complete_stage` (and the stage-abort path), call `archiveStage` for the just-closed stage when `useKnowledgeLoader` is on; no-op otherwise.
  - [MODIFY] `src/server/bootstrap.ts` — if any post-`plan_complete_stage` runtime state is updated here, mirror the hook; otherwise no change.
  - [MODIFY] `src/agents/chat.ts` — at the "Channel closed" log point (~L222), call `archiveSession` for the closing channel when flag is on; no-op otherwise.
- **Acceptance**:
  - `archiveStage` moves active records under `.saivage/{skills,memory}/stages/<stage_id>/` to a sibling `archive/` subdir, updates each record's lifecycle to `archived`, appends one audit line each, and rebuilds the scope index — under the per-scope index mutex.
  - `archiveSession` analogous, for `sessions/<channel_id>/`.
  - Idempotent: a second call on the same stage/channel is a no-op (records already `archived`).
  - **Non-injection**: after `archiveStage`, `resolveEagerRecords` for the next stage does not include the archived records. (FR-9)
  - Hooks are flag-gated: with `useKnowledgeLoader=false`, every hook function is a no-op so M3 prerequisites can land before cutover without changing behavior.
- **Tests added**: `lifecycle.test.ts` (idempotence, non-injection, audit shape).
- **Build-safe?** yes.
- **Depends on**: WI-03, WI-10.
- **Reverts cleanly**: yes.
- **Estimated diff**: M.

#### WI-12 `GET /api/mcp/tools` HTTP route

- **Goal**: Round-1 blocking issue 6 + open-item ruling. The Phase D smoke (§6.2) needs to verify the new tool surface is registered after the cutover; the server has no such route today (confirmed via `grep -nE 'app\.(get|post)' src/server/server.ts`). Add `GET /api/mcp/tools` returning a JSON-safe projection of `runtime.mcpRuntime.getAllTools()` (`name`, `service`, `description`, `inputSchema`, `available`; **no** handler refs). Same token gate as every other `/api/*` route (the `onRequest` hook in `src/server/server.ts` covers `/api/*`).
- **Files touched**:
  - [MODIFY] `src/server/server.ts` — add the route alongside `/api/config` (~L211).
  - [MODIFY] `src/server/server.test.ts` (or `bootstrap.test.ts` — whichever already runs Fastify integration) — assert route returns 200 with a JSON array of tools and 401 without the token (when configured).
- **Acceptance**:
  - With `useKnowledgeLoader=false` (pre-cutover): response includes legacy `read_skill`, `list_skills`, etc., plus the legacy `memory`/`index` `available:false` stubs.
  - With `useKnowledgeLoader=true` (post-cutover, simulated in test by registering the new services): response includes all 16 new tools under services `skills` and `memory`; legacy stub tool names are absent.
  - Token enforcement matches existing `/api/*` behavior.
- **Tests added**: extension to existing server test.
- **Build-safe?** yes.
- **Depends on**: none code-wise; logically WI-07/WI-08 must exist before the post-cutover assertion is meaningful.
- **Reverts cleanly**: yes.
- **Estimated diff**: S.

#### WI-13 BaseAgent eager-injection wiring (flag-gated)

- **Goal**: `BaseAgent` ctor calls `resolveEagerRecords` when `useKnowledgeLoader` is true, else current `resolveSkills`. Same module-private flag as WI-07/08 (no config exposure — design §J.3 "local sequencing for the implementer").
- **Files touched**:
  - [MODIFY] `src/agents/base.ts` — add the flag branch, the new injected-block formatter (§D.6). Pass `ToolCallContext` through to the loader if it needs project root / role.
- **Acceptance**:
  - With flag off: behavior bit-identical to baseline (existing `agents.test.ts` still passes unmodified). (Build-safety guarantee.)
  - With flag on (a temp test-only override): seeded records produce the §D.6 block with header and budget usage. (FR-10)
- **Tests added**: none new (covered by WI-20 with flag-on harness).
- **Build-safe?** yes.
- **Depends on**: WI-05, WI-06, WI-07, WI-08, WI-10.
- **Reverts cleanly**: yes.
- **Estimated diff**: S.

#### WI-14 BaseAgent compaction integration (flag-gated)

- **Goal**: Implement §E.1 `reinjectSurvivors` and §E.2 pre-compaction nudge inside `BaseAgent`, both behind `useKnowledgeLoader`.
- **Files touched**:
  - [MODIFY] `src/agents/base.ts` — post-`compactConversation` block injection; pre-`shouldCompact` Planner hook (5-turn cap; `onCompactionHookComplete` test hook per §E.2).
  - [MODIFY] `src/runtime/compaction.ts` — **read-only inspection**: confirm `compactConversation` stays a pure history→summary fn. If anything in this WI requires a signature change, STOP and flag the reviewer (design §E.1 forbids touching it).
- **Acceptance**:
  - Survivors reinjected as one user-role block after compaction (flag on); never dropped by budget (FR-15).
  - Planner pre-compaction nudge emits one user message; `create_memory` round-trips through `executeToolCall` with audit; capped at 5 turns; non-Planner skips. (FR-16, §E.2)
  - `compaction.ts` signature unchanged (read-only check via `git diff src/runtime/compaction.ts`).
- **Tests added**: none new here (WI-20 covers).
- **Build-safe?** yes (flag off = no-op).
- **Depends on**: WI-13.
- **Reverts cleanly**: yes.
- **Estimated diff**: M.

#### WI-15 `fsGuard` rejects writes under `.saivage/{skills,memory}/`

- **Goal**: Generic `write_file` MCP tool rejects target paths under those two trees regardless of role. Closes FA §1.6.4.
- **Files touched**:
  - [MODIFY] `src/mcp/builtins.ts` — `write_file` handler adds path check before delegating; uses error code `BLOCKED_PATH`.
  - [NEW] `src/mcp/fsGuard.test.ts`
- **Acceptance**:
  - Any role's `write_file` targeting `<project>/.saivage/skills/…` or `<project>/.saivage/memory/…` returns `BLOCKED_PATH`. (FR-27)
  - Writes outside those trees unchanged.
- **Tests added**: `fsGuard.test.ts`.
- **Build-safe?** yes.
- **Depends on**: none (independent; can be done in M1 in principle but listed here for thematic grouping).
- **Reverts cleanly**: yes.
- **Estimated diff**: S.

#### WI-16 Cutover commit (point of no return)

- **Goal**: Single atomic commit that flips the loader, deletes the old path, moves built-ins, and updates bundling. Implements design §J.3 steps 6–8.
- **Files touched**:
  - [MODIFY] `src/agents/base.ts` — flip `useKnowledgeLoader` default to true; delete the branch; delete the flag constant; remove all imports of `resolveSkills`/`formatSkillsForPrompt`.
  - [MODIFY] `src/mcp/builtins.ts` — flip the same flag default; delete legacy `skillsHandler` (~L1060-…), `memoryTools` stub (~L1132), `indexTools` stub (~L1139), and the now-dead flag branches.
  - [MODIFY] `src/mcp/plan-server.ts`, `src/agents/chat.ts` — delete the `if (useKnowledgeLoader)` guards added by WI-11; lifecycle hooks become unconditional.
  - [DELETE] `src/skills/loader.ts`
  - [DELETE] `src/skills/` (directory now empty)
  - [MODIFY] `src/agents/agents.test.ts` — delete tests that assert `resolveSkills`/`formatSkillsForPrompt`/`SkillIndexSchema` behavior; replace with WI-21 regression-pin tests (cross-reference, not duplicated here).
  - [MODIFY] `src/mcp/builtins.test.ts` — delete tests asserting current `read_skill` path-traversal and `unavailable` stubs.
  - [DELETE] `skills/coding/SKILL.md`
  - [DELETE] `skills/planning/SKILL.md`
  - [DELETE] `skills/research/SKILL.md`
  - [DELETE] `skills/mcp-authoring/SKILL.md`
  - [NEW] `skills/builtin/coding/SKILL.md`
  - [NEW] `skills/builtin/planning/SKILL.md`
  - [NEW] `skills/builtin/research/SKILL.md`
  - [NEW] `skills/builtin/mcp-authoring/SKILL.md`
  - [MODIFY] `tsup.config.ts` — copy `skills/builtin/**` → `dist/skills/builtin/**` so the bundled runtime finds them (FR-24, FR-31a).
  - [MODIFY] `package.json` — add `"test:bundle": "pnpm build && vitest run -t 'fr31a'"` (or equivalent) so the prod-bundle assertion is opt-in, not baked into the default `vitest run` (round-1 non-blocking 5).
- **Acceptance**:
  - `git grep resolveSkills` → empty.
  - `git grep formatSkillsForPrompt` → empty.
  - `git grep SkillEntrySchema` → only `src/types.ts` (deleted in WI-17).
  - `git grep -E '\"knowledge\\.(skills|memory)\"'` → empty (final wire names are `skills` and `memory`).
  - `pnpm build && node dist/cli.js --version` runs without error; the built-in walker (WI-05) finds 4 built-in skills under `dist/skills/builtin/`. (FR-24)
  - `pnpm test` green. `pnpm test:bundle` green after `pnpm build`.
  - Cutover-time stage-scoped or session-scoped records do NOT exist on any host (verified in pre-flight snapshots).
- **Tests added**: none new in this WI (M5 covers).
- **Build-safe?** **YES — but ONLY because the deletion and the flip happen in the same commit.** No intermediate state is build-safe.
- **Depends on**: WI-09, WI-10, WI-11, WI-12, WI-13, WI-14, WI-15.
- **Reverts cleanly**: yes via `git revert`; restores old loader + tests + `SKILL.md`s. The WI is intentionally one commit precisely so revert is a single operation.
- **Estimated diff**: L (>800 LoC of deletions + moves). Round-2 note: the round-1 reviewer flagged this WI as too large once the missing prerequisites are added. Those prerequisites are now their own WIs (WI-06, WI-10, WI-11, WI-12), so WI-16 is reduced to "final atomic deletion/swap + built-in move + bundle update", which the writer judges appropriate to keep as one commit.

### M4 — Schema cleanup

#### WI-17 Delete obsolete schemas from `src/types.ts`

- **Goal**: Remove `SkillEntrySchema`, `SkillIndexSchema`, `SkillMatchContext` (and its `tools`/`filePaths` fields), `MemoryEntrySchema` (if present), `IndexEntrySchema` (if present) — §J.1.
- **Files touched**:
  - [MODIFY] `src/types.ts` — delete §10 block.
  - [MODIFY] any remaining importers (expected: zero after WI-16; verify with `git grep`).
- **Acceptance**:
  - `git grep -E 'SkillEntrySchema|SkillIndexSchema|SkillMatchContext|MemoryEntrySchema|IndexEntrySchema'` → empty.
  - `pnpm build && pnpm test` green.
- **Tests added**: none.
- **Build-safe?** yes (WI-16 removed last consumer).
- **Depends on**: WI-16.
- **Reverts cleanly**: yes.
- **Estimated diff**: S.

### M5 — Cross-cutting tests

#### WI-18 MCP integration test suite

- **Goal**: One `*.integration.test.ts` exercising tool round-trips through the real role-aware `MCPRuntime.callTool(service, tool, args, ctx)` path.
- **Files touched**:
  - [NEW] `src/knowledge/integration.test.ts` (covers both services + cross-service flows).
- **Acceptance**:
  - All 16 tools called at least once with each authorized role via a real `ToolCallContext`; one `UNAUTHORIZED_ROLE` assertion per denied cell, raised by the runtime entry layer (not handler convention). (FR-6, FR-31e(i))
  - All **15** error codes from design §C.3 asserted at least once (`UNAUTHORIZED_ROLE`, `UNAUTHORIZED_SCOPE`, `NOT_FOUND`, `EMPTY_REASON`, `INVALID_SCOPE_REF`, `INVALID_SUPERSEDE_TARGET`, `TOPIC_COLLISION`, `NAME_COLLISION`, `INVALID_SUPERSEDE_SCOPE`, `SECRET_DETECTED`, `BLOCKED_PATH`, `BODY_PATH_BROKEN`, `OVERSIZED_SURVIVOR`, `MALFORMED_AUDIT_LINE`, `INDEX_REBUILD_FAILED`). (Round-1 non-blocking 2 fix.)
  - `memory`/`index` legacy stub paths now return `NOT_FOUND` (the stubs are gone). (FR-31e(ii))
- **Tests added**: `integration.test.ts` (one file, ~300 lines of fixtures).
- **Build-safe?** yes.
- **Depends on**: WI-16.
- **Reverts cleanly**: yes.
- **Estimated diff**: M.

#### WI-19 Concurrency test suite

- **Goal**: FR-29 + §I concurrency bullets.
- **Files touched**:
  - [NEW] `src/knowledge/concurrency.test.ts`
- **Acceptance**:
  - Two parallel `create_memory` (distinct ids, same scope) → `index.json` lists both; no torn write. **Pinned by the per-scope index mutex from WI-03**, not by hope. (FR-29, FR-31g — round-1 blocking 5)
  - Two parallel `update_memory` (same id) → both succeed; final state == arrival-order second write; one audit line per call. (FR-29)
  - Supersede two-key lock: simulated step-3 failure (inject `EIO` on OLD write) → NEW record body unlinked, OLD untouched, one `rejected` audit. (§C.3)
  - Sweeper expiry races author update: under lock, sweeper re-reads, observes `status != active`, skips silently. (G.2)
  - Loader repair: hand-craft a tree with NEW.supersedes→OLD but OLD.superseded_by unset; next mutating access patches OLD.
- **Tests added**: `concurrency.test.ts`.
- **Build-safe?** yes.
- **Depends on**: WI-16.
- **Reverts cleanly**: yes.
- **Estimated diff**: M.

#### WI-20 Agent-level tests

- **Goal**: §I "Agent-level" bullets.
- **Files touched**:
  - [NEW] `src/agents/knowledge.agent.test.ts`
- **Acceptance**:
  - Per role, seeded records produce expected eager-injection block (per-record-per-role parametrized). (FR-10, FR-12)
  - Stage record archived on stage terminal hook (WI-11); NOT injected in next stage. (FR-9)
  - Session record archived on channel close hook (WI-11); NOT injected in next session.
  - `omitted:[…]` header populated when ordinary budget exceeded; survivors uncapped. (FR-11, FR-15)
  - Force `shouldCompact`; assert pre-compaction nudge message emitted; Planner's `create_memory` writes audit; survivors reinjected post-compaction; non-Planner skips hook; 5-turn cap enforced. (FR-16)
  - Chat `/memories list` returns rows; `/remember` does NOT call write tool — instead emits inter-agent message to Planner (assert via mock dispatcher). (FR-22, §H.1)
- **Tests added**: `knowledge.agent.test.ts`.
- **Build-safe?** yes.
- **Depends on**: WI-16.
- **Reverts cleanly**: yes.
- **Estimated diff**: M.

#### WI-21 Regression-pin tests (FR-31a..g)

- **Goal**: One test per defect, suffixed with the FR-31 letter (§I "Regression-pin"). Pins built-in loading in prod-bundle layout (FR-31a) but **does not** run a full `pnpm build` inside `vitest run` (round-1 non-blocking 5 fix).
- **Files touched**:
  - [NEW] `src/knowledge/regression.test.ts`
- **Acceptance**:
  - `fr31a`: when `dist/skills/builtin/` exists (i.e., a `pnpm build` has run), invoke the loader against it and assert all 4 built-ins parse; **otherwise the test is `test.skip` with an explicit message** pointing at `pnpm test:bundle`. The src-shaped frontmatter walk is covered unconditionally in WI-05. CI invokes `pnpm build && pnpm test:bundle` (the new script from WI-16) before/alongside `pnpm test`. (FR-24, FR-31a)
  - `fr31b`: `create_skill` with `triggers:[]` + `target_agents:[]` → record findable by `search_skills`; not unmatchable. (FR-31b)
  - `fr31c`: `update_skill` refreshes `updated_at`, appends audit line with `reason`, regenerates `index.json` row. (FR-31c)
  - `fr31d`: skill body at non-default `body_path` (e.g., nested dir) readable via `read_skill`. (FR-31d)
  - `fr31e_i`: Mg/De/Ch `create_skill`/`update_skill` → `UNAUTHORIZED_ROLE` from MCP runtime (via WI-06 context + WI-04 engine), not from handler. (FR-31e(i))
  - `fr31e_ii`: enumerate role tool catalogs; assert no `memory_*`/`index_*` legacy stub names appear. (FR-31e(ii))
  - `fr31f` (write rejection): `create_memory` body containing `sk-AAAA…BBBB` → `SECRET_DETECTED`; `reason` does not echo the match; one `rejected` audit. (FR-27, FR-31f)
  - `fr31f_read` (read-time redaction, round-1 blocking 8): a record with a secret-shaped body on disk → `read_skill`/`get_memory`/`search_*` return the body with `[REDACTED]` substituted and `redacted_spans` populated. (FR-27)
  - `fr31g`: two parallel writes to same scope dir → either two distinct records or one deterministic winner; `index.json` always parseable; both records present when both writes succeed (per-scope index mutex, WI-03). (FR-31g)
  - §5.12 boundary: `plan-history.json` round-trip — replay representative history, assert Planner-recovery fields are history-derived, not duplicated in memory.
- **Tests added**: `regression.test.ts`.
- **Build-safe?** yes.
- **Depends on**: WI-16.
- **Reverts cleanly**: yes.
- **Estimated diff**: M.

---

## §4. Deletions catalogue

| Item | WI | Justification (design §) |
|---|---|---|
| `src/skills/loader.ts` (file) | WI-16 | §J.1 — replaced by `src/knowledge/loader.ts`. |
| `src/skills/` (directory) | WI-16 | Empty after loader deletion. |
| `skillsHandler` in `src/mcp/builtins.ts` (~L1060-1130) | WI-16 | §J.1 — replaced by `knowledgeSkills.ts` under final service name `skills`. |
| `memoryTools` stub (~L1132) | WI-16 | §J.1 — `available:false` stub replaced by real service under final name `memory`. |
| `indexTools` stub (~L1139) | WI-16 | §J.1 + OOS-1 — full-text/vector search out of scope. |
| `mcpRuntime.registerInProcess("skills"…)` (L1163, legacy) | WI-16 | Replaced by new flag-gated registration that re-uses the same wire name. |
| `mcpRuntime.registerInProcess("memory"…)` (L1167, stub) | WI-16 | Replaced by new flag-gated registration that re-uses the same wire name. |
| `mcpRuntime.registerInProcess("index"…)` (L1168, stub) | WI-16 | OOS-1 — never re-registered. |
| `useKnowledgeLoader` flag constant (`src/agents/base.ts` + `src/mcp/builtins.ts`) | WI-16 | Cutover commit removes the flag and the now-dead `if (!useKnowledgeLoader)` branches. |
| `if (useKnowledgeLoader)` guards in `src/mcp/plan-server.ts` and `src/agents/chat.ts` (WI-11 hooks) | WI-16 | Hooks become unconditional after cutover. |
| `SkillEntrySchema` (`src/types.ts` §10) | WI-17 | §J.1 — replaced by `SkillRecord`. |
| `SkillIndexSchema` (`src/types.ts` §10) | WI-17 | §J.1 — replaced by per-kind index projection. |
| `SkillMatchContext` (`src/types.ts` §10), incl. `tools`/`filePaths` fields | WI-17 | §D.4 — `tool:`/`path:` triggers removed. |
| `MemoryEntrySchema` (if present in `src/types.ts`) | WI-17 | §J.1 — stub never reachable. |
| `IndexEntrySchema` (if present in `src/types.ts`) | WI-17 | OOS-1. |
| `skills/coding/SKILL.md` | WI-16 | §J.1 — moved to `skills/builtin/coding/SKILL.md`. |
| `skills/planning/SKILL.md` | WI-16 | §J.1 — moved. |
| `skills/research/SKILL.md` | WI-16 | §J.1 — moved. |
| `skills/mcp-authoring/SKILL.md` | WI-16 | §J.1 — moved. |
| Tests in `src/agents/agents.test.ts` asserting `resolveSkills`/`formatSkillsForPrompt`/`SkillIndexSchema` | WI-16 | §I last bullet — replaced by WI-21 regression-pin suite. |
| Tests in `src/mcp/builtins.test.ts` asserting current `read_skill` path-traversal and `unavailable` stub catalog behavior | WI-16 | §I last bullet — replaced by WI-18 + WI-21. |

Symbols **kept** (explicitly NOT deleted, despite name overlap): the `skills` and `memory` MCP **service names** themselves (re-used for the new handlers under their final wire names per the round-1 reviewer open-item ruling, so tests, agents, and docs do not have to update wire names); `writeDoc`/`readDoc` in `src/store/documents.ts` (re-used by `writeRecordAtomic`); `NoteManager` (OOS-10); `compaction.ts` (§E.1 forbids changing it).

Note on built-in paths: round-2 correction normalizes all references from `saivage/skills/…` to the repo-relative `skills/…`. The legacy built-ins today live at `skills/coding/SKILL.md` etc. (verified via `ls skills/`).

---

## §5. Test plan

Tests land **inside the WI that owns the code**, except the cross-cutting ones in M5. Mapping:

| Layer | File | WI | FR coverage |
|---|---|---|---|
| Unit — schemas | `src/knowledge/types.test.ts` | WI-01 | FR-2, FR-3, FR-4, FR-17, FR-18 |
| Unit — secrets (scan + redact) | `src/security/secrets.test.ts` | WI-02 | FR-27, FR-31f |
| Unit — store | `src/knowledge/store.test.ts` | WI-03 | FR-28, FR-29 (per-record + per-scope) |
| Unit — permissions | `src/knowledge/permissions.test.ts` | WI-04 | FR-6, FR-31e(i) |
| Unit — loader (incl. read-time redact) | `src/knowledge/loader.test.ts` | WI-05 | FR-10, FR-11, FR-12, FR-13, FR-15, FR-27 |
| Unit — built-in walker | `src/knowledge/builtinWalker.test.ts` | WI-05 | FR-24 (fixture); FR-31a covered by WI-21 (prod bundle, opt-in script) |
| Unit — tool context | `src/mcp/toolContext.test.ts` + `runtime.test.ts` extension | WI-06 | FR-6 prerequisite |
| Unit — MCP skills (incl. read redaction) | `src/mcp/knowledgeSkills.test.ts` | WI-07 | FR-7, FR-8, FR-27, FR-30, FR-31b |
| Unit — MCP memory (incl. read redaction) | `src/mcp/knowledgeMemory.test.ts` | WI-08 | FR-7, FR-14, FR-19, FR-27, FR-30 |
| Unit — chat slash | `src/chat/slashCommands.test.ts` | WI-09 | FR-22 |
| Unit — project init | `src/store/project.test.ts` extension | WI-10 | FR-1, FR-21, FR-23 |
| Unit — lifecycle hooks | `src/knowledge/lifecycle.test.ts` | WI-11 | FR-9 |
| Integration — server route | `src/server/server.test.ts` (or `bootstrap.test.ts`) extension | WI-12 | Phase D smoke pre-req |
| Unit — fsGuard | `src/mcp/fsGuard.test.ts` | WI-15 | FR-27 (FA §1.6.4 escape hatch) |
| Integration — MCP | `src/knowledge/integration.test.ts` | WI-18 | FR-6, FR-7, FR-30, FR-31e(i)(ii); all 15 error codes |
| Integration — concurrency | `src/knowledge/concurrency.test.ts` | WI-19 | FR-29 (per-record + per-scope), FR-31g |
| Agent-level | `src/agents/knowledge.agent.test.ts` | WI-20 | FR-9 (stage + session), FR-10, FR-11, FR-12, FR-15, FR-16, FR-22 |
| Regression-pin | `src/knowledge/regression.test.ts` | WI-21 | FR-31a..g (a is opt-in via `pnpm test:bundle`), FR-27 read redact, §5.12 boundary |

Total new test files: **15**. Existing test files modified: **4** (`agents.test.ts`, `builtins.test.ts`, `project.test.ts`, `server.test.ts`/`bootstrap.test.ts`).

---

## §6. Cutover / live deployments (Phase D, NOT executed in Phase C)

All three v2 hosts were verified (FA §1.4) to contain **zero skill state and zero memory state** today. Per ground rule 2, there is nothing to migrate; per design §J.2, fresh init (WI-10) creates empty trees. The cutover therefore reduces to: deploy binary → `saivage init` populates empty `.saivage/{skills,memory}/` tree → restart → smoke-test.

### 6.1 Per-host steps (classic LXC ops per workspace handoff)

The three v2 deployments are LXC containers `saivage`, `saivage-v3`, and `diedrico`. `saivage-v3-getrich-v2` runs v3, not v2, so it is excluded.

| LXC container | IP | Service unit | Project dir inside container |
|---|---|---|---|
| `saivage` | 10.0.3.111 | `saivage.service` | `/work/getrich` |
| `saivage-v3` | 10.0.3.112 | `saivage.service` | `/work/saivage-v3` |
| `diedrico` | 10.0.3.113 | `saivage.service` | `/work/diedrico` |
| ~~`saivage-v3-getrich-v2`~~ | ~~10.0.3.170~~ | (v3) | **excluded — v3, not v2** |

Execute on the operator's host (NOT inside the container) for each of the three v2 containers:

```bash
# Set per row from the table above.
C=saivage           # or saivage-v3, diedrico
PROJECT=/work/getrich   # or /work/saivage-v3, /work/diedrico
APPDIR=/opt/saivage # service working dir inside the container (adjust per row if different)

# Phase D step (NOT Phase C).
sudo lxc-info -n "$C" >/dev/null              # sanity: container exists + running
sudo lxc-attach -n "$C" -- systemctl stop saivage.service

# Verify no skill/memory state exists (sanity vs FA §1.4 finding).
sudo lxc-attach -n "$C" -- bash -c "
  ls -la $PROJECT/.saivage/skills 2>/dev/null;
  ls -la $PROJECT/.saivage/memory 2>/dev/null
"
# expect: missing. If anything exists (snapshot diff vs pre-flight), STOP
# and consult the operator. Otherwise: purge nothing (nothing to purge).

# Deploy new dist (mechanism out of scope here; usually rsync or
# systemd ExecStartPre Git pull + pnpm build inside the container).

# **Idempotent init upgrade — REQUIRED before restart.**
# The live projects already have a populated `.saivage/` (planner state,
# auth profiles, runtime state). On v2-current they do NOT have
# `.saivage/skills/` or `.saivage/memory/`. Service start path is
# `loadProject`, which does NOT create missing leaves — only `initProject`
# / `initProjectTree` does (extended in WI-10 to add the new trees,
# seed `index.json` + `audit.jsonl`, and update `.saivage/.gitignore`).
# WI-10 makes the call idempotent: existing leaves are not overwritten,
# existing `.gitignore` lines are not duplicated, no error on rerun.
# Re-running `saivage init` against an already-initialized project is
# therefore the documented upgrade path (no new CLI verb is needed — the
# existing `init` verb at `src/server/cli.ts` L33 is the right hook;
# round-3 reviewer fix).
sudo lxc-attach -n "$C" -- bash -lc "
  cd '$APPDIR' && node dist/cli.js init '$PROJECT'
"
# Expected effect: creates `.saivage/{skills,memory}/{project,stages,sessions}/`
# with `index.json` + empty `audit.jsonl` in each leaf; appends
# `skills/sessions/` and `memory/sessions/` to `.saivage/.gitignore` if not
# already present; leaves every other `.saivage/` file (`saivage.json`,
# `auth-profiles.json`, `plan.json`, `plan-history.json`, `runtime/`,
# `tmp/`, `notes/`, etc.) byte-untouched.

# Post-init verification — confirm the upgrade succeeded BEFORE restart.
sudo lxc-attach -n "$C" -- bash -c "
  ls -la $PROJECT/.saivage/skills/project/  $PROJECT/.saivage/memory/project/ &&
  test -f $PROJECT/.saivage/skills/project/index.json &&
  test -f $PROJECT/.saivage/memory/project/index.json &&
  test -f $PROJECT/.saivage/skills/project/audit.jsonl &&
  test -f $PROJECT/.saivage/memory/project/audit.jsonl &&
  grep -q 'skills/sessions/' $PROJECT/.saivage/.gitignore &&
  grep -q 'memory/sessions/' $PROJECT/.saivage/.gitignore
"
# If any of those fail, STOP. The init step either failed or the deployed
# binary predates WI-10 — do NOT start the service against incomplete state.

# Idempotence sanity (optional but recommended on first host of a batch):
# rerun the same `init` command and assert no diff in seeded files.
sudo lxc-attach -n "$C" -- bash -lc "
  cd '$APPDIR' && node dist/cli.js init '$PROJECT' &&
  test ! -s $PROJECT/.saivage/skills/project/audit.jsonl &&
  test ! -s $PROJECT/.saivage/memory/project/audit.jsonl
"

sudo lxc-attach -n "$C" -- systemctl start saivage.service
```

### 6.2 Smoke verification per host

```bash
# 1. Health endpoint — safe host-side curl to the container IP.
curl -fsS http://<container-ip>:8080/health

# 2. New tool surface registered (route added in WI-12).
curl -fsS http://<container-ip>:8080/api/mcp/tools \
  | jq '.[] | select(.name|test("skill|memory"))'
# expect: create_skill, update_skill, supersede_skill, archive_skill,
#         delete_skill, list_skills, read_skill, search_skills,
#         create_memory, update_memory, supersede_memory,
#         archive_memory, delete_memory, list_memories, get_memory,
#         search_memories.

# 3. Empty trees exist (initialized by WI-10).
sudo lxc-attach -n "$C" -- ls \
  $PROJECT/.saivage/skills/project/ \
  $PROJECT/.saivage/memory/project/
# expect each: index.json audit.jsonl records/

# 4. Agent run: ask the Planner one trivial question through Chat;
#    confirm no errors in journalctl mentioning resolveSkills,
#    SkillEntrySchema, or memory unavailable.
sudo lxc-attach -n "$C" -- bash -c '
  journalctl -u saivage.service -n 200 \
    | grep -Ei "resolveSkills|SkillIndex|memory.*unavailable|index.*unavailable"
' && exit 1 || echo OK
```

If `/api/mcp/tools` requires the `SAIVAGE_API_TOKEN` (the route is gated by the same `onRequest` hook as every other `/api/*` route — see WI-12), the operator must supply `-H "Authorization: Bearer $TOKEN"` in step 2.

### 6.3 Loss accepted at cutover

Per ground rule 2 + design §J.1: any in-flight stage-scoped or session-scoped records that the new build would have produced are **lost** if cutover happens mid-stage. FA §1.4 verified zero current records, so this is theoretical — but the policy is documented here so the operator does not file a bug.

**Do NOT execute any of §6 during Phase C.** This section is the Phase D runbook.

---

## §7. Documentation updates (Phase E preview)

Listed by file; categorized as **R** (full rewrite), **S** (section addition/edit), **D** (section removal). Phase E owns the edits.

| File | Action | Scope |
|---|---|---|
| `SPEC/v2/00-AGENT-SYSTEM.md` | S | Manager §2.2 "Schedules skill generation" — clarify Mg authors skills directly via `create_skill`; remove "via Coder dispatch" wording. |
| `SPEC/v2/01-DATA-MODEL.md` | S | Add `.saivage/{skills,memory}/` tree (§B.4); add `SkillRecord`/`MemoryRecord`/`AuditEntry` schemas. |
| `SPEC/v2/04-RUNTIME-DETAILS.md` | S | §3.2 compaction — add §E.1 survivor reinjection + §E.2 Planner pre-compaction nudge. |
| `SPEC/v2/05-MCP-SERVICES.md` | R | §6 "Skills" — full rewrite to new 8-tool surface. §7 "Memory" — full rewrite from stub to 8-tool surface. §8 "Index" — **delete** (OOS-1). Access matrix — replace with §F. |
| `SPEC/v2/06-SYSTEM-DESIGN.md` | R | §2.6 "Skills" — full rewrite. Remove `tool:`/`path:` trigger references. Add §D.1/D.2/D.3 algorithms. |
| `SPEC/v2/skills/skill-creation.md` | R | Replace with new authoring guide (frontmatter for built-ins, MCP for project). |
| `SPEC/v2/skills/` (other files) | varies | Audit; many become obsolete given new schema. |
| `SPEC/v2/skills-memory/` (this dir) | — | 00/01/02 stay as canonical record; future phases append a 03-* if/when scope grows. |
| `README.md` / `SETUP.md` | S | Add one paragraph: "Project knowledge lives under `.saivage/{skills,memory}/`; see SPEC/v2/skills-memory/." |
| `docs_new/` (if used) | S | New page covering chat slash commands (§H.1). |

---

## §8. Rollback

There are **two distinct points of no return**, and they must not be conflated (round-1 non-blocking 1 fix):

1. **Code point of no return: WI-16.** Everything up to and including WI-15 is additive and revertible by deleting new files. WI-16 deletes `src/skills/loader.ts`, the legacy handlers, and the four built-in `SKILL.md`s from `skills/<topic>/`.
2. **Live-state point of no return: first successful new-runtime write.** Once a live host has accepted a `create_skill` / `create_memory` via the new service, its `.saivage/{skills,memory}/` tree contains real records the old loader cannot read. The design ships no migrator (FR-23).

### 8.1 Pre-cutover snapshot (operator)

Before flipping any live host, capture `<project>/.saivage/` (rsync to a host-side path that is **not** under `.saivage/`) so that a worst-case rollback can restore the pre-cutover state byte-for-byte.

### 8.2 Code rollback after WI-16 lands on `main`

Prefer **`git revert <WI-16-sha>`** over `git reset --hard`. `git revert` preserves history, undoes only WI-16's deletions/moves (restores old loader + old handlers + four `SKILL.md`s), and leaves later commits (e.g., test additions WI-18..WI-21) for the operator to evaluate. `git reset --hard <pre-WI-16-sha>` is acceptable **only** when the operator's worktree is local-only and contains nothing they want to keep.

### 8.3 Live-deployment rollback

1. **Stop the service.** Per §6.1, classic-LXC `sudo lxc-attach -n <container> -- systemctl stop saivage.service`.
2. **Redeploy the previous-known-good `dist/` artifact** (operator-tracked outside this repo).
3. **State restoration.** If the new runtime had not yet written any records: `.saivage/{skills,memory}/` contains only the empty seed trees from WI-10, which the old loader ignores. The operator may leave them in place or, **with explicit confirmation**, `rm -rf /work/<project>/.saivage/skills /work/<project>/.saivage/memory` (per ground-rule "operationalSafety: confirm before `rm -rf`").
4. **If the new runtime had written records**, restore the snapshot from §8.1 over `.saivage/` (after stopping the service). Records produced by the new runtime are lost; this is the cost of crossing the second point of no return.
5. **Start the service.** `sudo lxc-attach -n <container> -- systemctl start saivage.service` and re-run §6.2 smoke (against the **old** service definition of the smoke).

### 8.4 Post-WI-16 mid-test failure

If WI-18..WI-21 reveal a design bug after WI-16 has landed but no live host has written records yet, prefer **fix-forward** over rollback. Reserve `git revert WI-16` only for systemic regressions that cannot be patched in one or two follow-up commits.

---

## §9. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Long-lived planner has the old static system-prompt cached in conversation; first post-cutover turn reads the new injected block but the old block also lingers in history | Med | Low | Planner compacts within first few turns; survivor reinjection (§E.1) re-establishes canonical block. No code mitigation needed — accepted. |
| Operator runs two `saivage` CLIs against the same project — explicit non-goal (§K) | Low | High (index corruption) | Documented loudly in `SETUP.md` (Phase E). **No `.saivage/.runtime.pid` defense in WI-03** — the existing project-level single-instance guard (`src/runtime/recovery.ts`, `src/server/bootstrap.ts`) already covers this, and design §K rejects extending cross-process locking into the knowledge store. (Round-1 reviewer open-item ruling.) |
| Built-in skill not found by prod bundle (FR-31a regression) | Med | Med | WI-21 `fr31a` test runs against actual `dist/skills/builtin/` after `pnpm build`. The test is `test.skip` if `dist/skills/builtin/` is absent and the regression is pinned by a separate `pnpm test:bundle` script (added in WI-16) that CI/Phase-D validation must run after `pnpm build`. Default `vitest run` does not invoke `pnpm build` (round-1 non-blocking 5 fix). |
| 2048 B audit-line cap silently truncates a long `reason` and the audit becomes lossy | Low | Low | Truncation suffix `…[truncated]` is explicit; loader-side test (WI-03) asserts the suffix presence. Accepted by design §C.3. |
| `fsGuard` (WI-15) blocks a legitimate user workflow that wrote test fixtures into `.saivage/skills/` directly | Low | Low | None of the three live deployments has such a fixture (pre-flight snapshot confirms). Documented in Phase E. |
| WI-16 still too large despite the new prerequisite WIs | Med | Med | The round-1 review explicitly flagged the previous monolithic WI-12. Round-2 moved runtime context (WI-06), project init (WI-10), lifecycle hooks (WI-11), and the smoke route (WI-12) into their own WIs, reducing WI-16 to deletion/move/bundle. Writer judges this acceptable as one atomic commit. |
| Chat `/remember` indirection rejected by operator who wants direct Chat write | Low | Med | Design §F + §H.1 are explicit; reopening this is a Phase B reversal, not a Phase C concern. Flag here for awareness. |
| `ToolCallContext` plumbing (WI-06) regresses an unrelated legacy MCP handler that does something unusual with the handler signature | Low | Med | WI-06 acceptance explicitly requires the existing MCP suite green with legacy handlers ignoring the new arg. The `withContext(handler)` wrapper exists for handlers that cannot adopt the new signature directly. |

---

## §10. FR → WI matrix

| FR | WI(s) | Test(s) |
|---|---|---|
| FR-1 (state under `.saivage/`, JSON/JSONL, `writeDoc`) | WI-03, WI-10 | `store.test.ts`, `project.test.ts`, `integration.test.ts` |
| FR-2 (record base fields) | WI-01 | `types.test.ts` |
| FR-3 (lifecycle states) | WI-01, WI-03 | `types.test.ts`, `store.test.ts` |
| FR-4 (3 scopes) | WI-01, WI-03, WI-10 | `types.test.ts`, `project.test.ts`, `concurrency.test.ts` |
| FR-5 (no global registry) | WI-03 | `store.test.ts` (project-tree-only paths) |
| FR-6 (per-role MCP authoring) | WI-04, WI-06, WI-07, WI-08 | `permissions.test.ts`, `toolContext.test.ts`, `integration.test.ts` |
| FR-7 (audit on every mutation) | WI-03, WI-07, WI-08 | `store.test.ts`, `integration.test.ts` |
| FR-8 (triggerless skill OK) | WI-07 | `knowledgeSkills.test.ts`, `regression.test.ts#fr31b` |
| FR-9 (stage scope archived on stage end; session on channel close) | WI-11 + WI-20 | `lifecycle.test.ts`, `knowledge.agent.test.ts` |
| FR-10 (eager + on-demand) | WI-05, WI-07, WI-08, WI-13 | `loader.test.ts`, `knowledge.agent.test.ts` |
| FR-11 (eager budget enforced) | WI-05 | `loader.test.ts`, `knowledge.agent.test.ts` |
| FR-12 (`target_agents` + `scope_tags`) | WI-05 | `loader.test.ts` |
| FR-13 (`tool:`/`path:` removed) | WI-05, WI-17 | `loader.test.ts` (asserts ignored) |
| FR-14 (exact-key + keyword search) | WI-05, WI-08 | `loader.test.ts`, `knowledgeMemory.test.ts` |
| FR-15 (survivor reinjection unconditional) | WI-14 | `knowledge.agent.test.ts` |
| FR-16 (Planner pre-compaction nudge) | WI-14 | `knowledge.agent.test.ts` |
| FR-17 (TTL / `expires_at`) | WI-01, WI-03 | `types.test.ts`, `concurrency.test.ts` (sweeper race) |
| FR-18 (supersession + chain walk) | WI-03, WI-08 | `store.test.ts`, `knowledgeMemory.test.ts` |
| FR-19 (`older_than_days` enumeration) | WI-08 | `knowledgeMemory.test.ts` |
| FR-20 (cat/grep-able) | WI-03, WI-10 | `store.test.ts`, `project.test.ts` (layout fixture) |
| FR-21 (per-scope gitignore) | WI-10 | `project.test.ts`; manual verification in §6 smoke |
| FR-22 (Chat enumeration) | WI-09 | `slashCommands.test.ts`, `knowledge.agent.test.ts` |
| FR-23 (no migrator) | WI-10, WI-16 (init writes empty trees only) | `project.test.ts`, `integration.test.ts` |
| FR-24 (built-ins load in prod) | WI-05, WI-16 (tsup bundling) | `builtinWalker.test.ts`, `regression.test.ts#fr31a` (opt-in `pnpm test:bundle`) |
| FR-25 (no LLM dep for load/store) | WI-03, WI-05 | All unit tests run without LLM mock |
| FR-26 (unit-testable without MCP) | WI-03, WI-05 | `store.test.ts`, `loader.test.ts` (no MCP runtime) |
| FR-27 (no secrets in records — write + read) | WI-02, WI-03, WI-05, WI-07, WI-08, WI-15 | `secrets.test.ts`, `store.test.ts`, `loader.test.ts` (read redact), `knowledgeSkills.test.ts` (read redact), `knowledgeMemory.test.ts` (read redact), `fsGuard.test.ts`, `regression.test.ts#fr31f` + `#fr31f_read` |
| FR-28 (atomic + validated writes) | WI-03 | `store.test.ts` |
| FR-29 (concurrent-write safety, per-record + per-scope) | WI-03, WI-19 | `store.test.ts`, `concurrency.test.ts` |
| FR-30 (archive + delete) | WI-07, WI-08 | `knowledgeSkills.test.ts`, `knowledgeMemory.test.ts` |
| FR-31a (built-in load — defect pin) | WI-21 | `regression.test.ts#fr31a` (opt-in `pnpm test:bundle`) |
| FR-31b (no unmatchable records) | WI-21 | `regression.test.ts#fr31b` |
| FR-31c (updates refresh metadata + audit) | WI-21 | `regression.test.ts#fr31c` |
| FR-31d (read honours `body_path`) | WI-21 | `regression.test.ts#fr31d` |
| FR-31e(i) (unauthorized writes filtered at runtime entry) | WI-06, WI-21 | `regression.test.ts#fr31e_i` |
| FR-31e(ii) (legacy stubs unreachable) | WI-21 | `regression.test.ts#fr31e_ii` |
| FR-31f (secrets refused on write + redacted on read) | WI-21 | `regression.test.ts#fr31f` + `#fr31f_read` |
| FR-31g (concurrent writes don't corrupt) | WI-21 | `regression.test.ts#fr31g` |

**No FR is DEFERRED.** All 31 + 7 sub-items have a satisfying WI and test.

---

## §11. Round Log

### Round 1 → Round 2 dispositions

All reviewer items below are **ACCEPT-FIX** unless marked otherwise. No items REJECTED. No items DEFERRED past Phase C.

#### Blocking (8 of 8 fixed)

| # | Reviewer finding | Disposition | Rationale / where fixed |
|---|---|---|---|
| B1 | Per-role MCP authoring (FR-6) needs a `ToolCallContext` plumbed through the dispatcher; no current mechanism | ACCEPT-FIX | New **WI-06** adds `ToolCallContext` + dispatcher threading; consumed by WI-04/07/08; tested in WI-18 + WI-21#fr31e_i. |
| B2 | `saivage init` does not create `.saivage/{skills,memory}/` trees nor per-scope `.gitignore` (FR-1, FR-21, FR-23) | ACCEPT-FIX | New **WI-10** extends `src/store/project.ts` with empty tree init + `.gitignore` template; tested in `project.test.ts`. |
| B3 | Stage-end + chat-channel-close lifecycle hooks (FR-9) are missing in plan | ACCEPT-FIX | New **WI-11** adds hooks in `src/mcp/plan-server.ts#plan_complete_stage` and `src/agents/chat.ts` channel-close path; tested in `lifecycle.test.ts` + WI-20. |
| B4 | `GET /api/mcp/tools` route does not exist in `src/server/server.ts`; Phase D smoke depends on it | ACCEPT-FIX | New **WI-12** adds the Fastify route under the existing `/api/*` token gate; tested in `server.test.ts` extension. |
| B5 | Previous WI-12 cutover commit was too large to land atomically | ACCEPT-FIX | Renumbered to **WI-16**; runtime context (WI-06), init (WI-10), hooks (WI-11), and HTTP route (WI-12) are pulled out as prerequisites; WI-16 is now deletion+move+bundle only. |
| B6 | `.runtime.pid` cross-process lock proposed in WI-03 conflicts with design §K | ACCEPT-FIX | Removed from WI-03 entirely; risk row in §9 documents the existing `recovery.ts` boundary; deferred to `SETUP.md` documentation in Phase E. |
| B7 | 14 vs 15 error-code count mismatch between design §G and plan | ACCEPT-FIX | Plan now states **15 codes** consistently in WI-03 and WI-18 (UNAUTHORIZED_ROLE, UNAUTHORIZED_SCOPE, NOT_FOUND, EMPTY_REASON, INVALID_SCOPE_REF, INVALID_SUPERSEDE_TARGET, TOPIC_COLLISION, NAME_COLLISION, INVALID_SUPERSEDE_SCOPE, SECRET_DETECTED, BLOCKED_PATH, BODY_PATH_BROKEN, OVERSIZED_SURVIVOR, MALFORMED_AUDIT_LINE, INDEX_REBUILD_FAILED). |
| B8 | §6 cutover used `ssh root@<host>`, contradicting workspace's classic-LXC ops policy | ACCEPT-FIX | §6.1 rewritten to use `sudo lxc-attach -n <container> -- systemctl …`; `saivage-v3-getrich-v2` row explicitly excluded as a v3 deployment. |

#### Non-blocking (6 of 6 fixed)

| # | Reviewer finding | Disposition | Rationale / where fixed |
|---|---|---|---|
| N1 | §8 conflated code rollback with live-state rollback | ACCEPT-FIX | §8 now separates "code point of no return = WI-16" from "live-state point of no return = first successful new-runtime write"; §8.1 mandates a pre-cutover snapshot; §8.3 covers state restoration explicitly. |
| N2 | Per-scope index serialization (FR-31g) not separated from per-record mutex | ACCEPT-FIX | WI-03 now lists both a per-record mutex **and** a per-scope index-update mutex; WI-19 concurrency suite covers both. FR-29 matrix entry updated. |
| N3 | Read-time secret redaction (FR-27) was only enforced at write time | ACCEPT-FIX | WI-02 exports a `redactForRead` helper; WI-05 loader, WI-07 `read_skill`, WI-08 `get_memory` apply it; WI-21 adds `fr31f_read` test pinning behavior. |
| N4 | BLOCKED_PATH example was wrong (used `source_ref` instead of body text or `body_path`) | ACCEPT-FIX | WI-08 description now correctly describes BLOCKED_PATH firing when memory body text contains a forbidden absolute path **or** when `body_path` itself points under a forbidden tree. |
| N5 | FR-31a `pnpm test` would call `pnpm build` (non-idiomatic CI shape) | ACCEPT-FIX | WI-21 declares the `fr31a` regression as `test.skip` when `dist/skills/builtin/` is absent; WI-16 adds a separate `pnpm test:bundle` npm script that CI/Phase-D validation must run after `pnpm build`. Default `vitest run` no longer triggers builds. |
| N6 | Built-in path references inconsistently used `saivage/skills/…` (looked like an external package path) | ACCEPT-FIX | All references normalized to repo-relative `skills/…` and `skills/builtin/<topic>/…`. Verified via `ls skills/` on disk. |

#### Spot-check FAILs (19 of 19 subsumed)

All 19 spot-check FAILs were lower-granularity manifestations of B1–B8 / N1–N6. They are subsumed by the same fixes; no separate disposition needed. The §10 FR→WI matrix and §5 test plan table now reflect the new WI numbering and the new tests.

### Round 2 → Round 3 dispositions

Reviewer accepted 13 dispositions and the 4 new WIs. Two items remained:

| # | Reviewer finding | Disposition | Rationale / where fixed |
|---|---|---|---|
| R2-WF1 (B1 wrong-fix) | WI-06 named the right shape but did not specify how `stageId`/`channelId`/`author` reach `AgentContext`; round-2 said "dispatcher derives from `AgentContext`" but those fields do not exist on `AgentContext` (verified at `src/agents/types.ts` L38-58) | ACCEPT-FIX | WI-06 rewritten with the verified propagation chain: extend `AgentContext` with `stageId?`/`channelId?`/`sessionId?`; populate at every spawner site (`bootstrap.ts createChildSpawner` for Manager/workers, `bootstrap.ts runPlanner` via `recovery.ts` tracker getter, `server.ts` WebSocket for web chat, `telegram-bot.ts` for Telegram). Files-touched list now lists each construction site explicitly; acceptance includes a spawned-worker test, a Planner test, a web-chat test, and a Telegram-chat test. |
| R2-NB1 (§6 new blocker) | §6.1 deployed the binary and restarted the service but never ran the idempotent init step needed to create `.saivage/{skills,memory}/` on already-initialized live projects (`loadProject` does not create missing leaves) | ACCEPT-FIX | §6.1 now includes an explicit `node dist/cli.js init '$PROJECT'` step between deploy and `systemctl start`, plus post-init verification that asserts the new tree, seed files, and `.gitignore` lines exist. The existing `init` verb is reused (verified at `src/server/cli.ts` L33) — WI-10 makes the call idempotent, so no new CLI flag is needed. Step rejects start if verification fails. |

Counts: confirmed 13, wrong-fix fixed 1, new-blocking fixed 1, REJECTED 0.

#### Open-item decisions (3 of 3 resolved)

| # | Open item | Decision | Where applied |
|---|---|---|---|
| O1 | Keep MCP wire service names `skills`/`memory` vs. introduce `knowledge.*` prefix? | **Keep `skills` and `memory`** — reviewer's preferred option. Avoids churn in agent system prompts, tests, and documentation. | All WIs (06–08, 16) and §4 deletions catalogue. The `knowledge.*` prefix appears only in internal module paths (`src/knowledge/…`). |
| O2 | Add `.saivage/.runtime.pid` defense for two-CLI race? | **Reject** — existing `src/runtime/recovery.ts` project-lock covers this; design §K rules cross-process locking out of scope. | Removed from WI-03; risk row in §9. |
| O3 | Should FR-31a always run, even without `dist/`? | **No, opt-in via `pnpm test:bundle`** — default `vitest run` stays build-free. | WI-16 (script), WI-21 (`test.skip` guard), §9 risk row, §10 matrix. |

### Summary counts (Round 2)

- New WIs added: **4** (WI-06 runtime context, WI-10 project init, WI-11 lifecycle hooks, WI-12 HTTP route).
- WIs removed: **0**. WIs renumbered: **WI-06..WI-17 (old) → WI-07..WI-21 (new)**.
- Final WI count: **21**.
- Tests added beyond round-1 plan: `toolContext.test.ts`, `project.test.ts` extension, `lifecycle.test.ts`, `server.test.ts` extension, `fr31f_read` + `fr31e_i` regression cases.
- Line count: within 600–900 target (see header).

---

End of plan.
