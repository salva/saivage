# Phase B — Design Review (round 2)

Status: REVIEW
Reviewer: GPT-5.5
Verdict: REVISE
Date: 2026-05-23

## Verdict

Revise: almost every round-1 disposition is visibly applied, but the new store concurrency design still permits an undetected lost update and therefore does not satisfy FR-29 / FR-31g.

## Round-1 dispositions audit

| Round-1 finding | Claimed disposition | Audit | Evidence |
|---|---:|---|---|
| Blocking 1 — authoring vs FR-6 | ACCEPT-FIX | CONFIRMED | §C.1 grants `create_memory` to Pl/Mg/Co/Re/In and removes Chat writes; §F gives Co/Re `Y†`; §H.1 routes `/remember` through Planner. |
| Blocking 2 — triggerless skill / FR-8 | ACCEPT-FIX | CONFIRMED | 01-DESIGN.md:85 makes `triggers` default `[]`; 01-DESIGN.md:260-263 says triggerless skills are search-only and reachable by `search_skills`; 01-DESIGN.md:475-477 specifies content search. |
| Blocking 3 — scope semantics + gitignore | ACCEPT-FIX | CONFIRMED | 01-DESIGN.md:185-193 defines path ↔ scope mapping; 01-DESIGN.md:736-741 gives exact session gitignore rules. |
| Blocking 4 — audit/concurrency primitives | ACCEPT-FIX | WRONG-FIX | 01-DESIGN.md:299-323 specifies `expectedMtimeMs` as stat-before-rename; existing `writeDoc` renames at src/store/documents.ts:86. A writer can pass the mtime check, lose the race before rename, and overwrite another writer without `STALE_WRITE`. |
| Blocking 5 — compaction write hook | ACCEPT-FIX | CONFIRMED | 01-DESIGN.md:543-568 keeps reinjection out of `compaction.ts`; 01-DESIGN.md:570-600 makes FR-16 a BaseAgent prompt nudge through the normal tool loop. Current code also places tool schemas/execution in BaseAgent, while `compactConversation` is a router-only summarizer. |
| Blocking 6 — budget vs survivor | ACCEPT-FIX | CONFIRMED | 01-DESIGN.md:417-441 splits survivor summaries from the ordinary 2048-token budget and echoes ordinary omissions; 01-DESIGN.md:543-568 reinjects survivors after compaction. See new non-blocking issue NB-1 for contradictory oversized-survivor wording. |
| Blocking 7 — secret handling | ACCEPT-FIX | CONFIRMED | §C.3 defines `src/security/secrets.ts`, blocked paths, write refusal, rejected audit without echoing the match, and read-time redaction. |
| Non-blocking 1 — `scope="builtin"` contradiction | ACCEPT-FIX | CONFIRMED | §B.1 puts `origin` on `SkillRecord`; §B.4 says built-ins have `origin="builtin"`, `scope="project"`, and live outside `.saivage/`. |
| Non-blocking 2 — supersession scope ordering | ACCEPT-FIX | CONFIRMED | §B.5 replaces symbolic `scope ≥` with an explicit allowed-pairs table. |
| Non-blocking 3 — keyword normalization | ACCEPT-FIX | CONFIRMED | §D.3 defines NFC normalization, lowercase, punctuation stripping, exact token equality, cached body snippets, scoring, and ordering. |
| Non-blocking 4 — 16-tool surface rationale | ACCEPT-FIX | CONFIRMED | §C.1 says per-kind handlers are thin adapters over shared store/permission modules; §K explicitly rejects a single shared MCP service. |
| Non-blocking 5 — error modes | ACCEPT-FIX | CONFIRMED | §C.3 includes a canonical error-code table and MCP error-return shape. |
| Non-blocking 6 — sweeper vs concurrency | ACCEPT-FIX | WRONG-FIX | §G.2 correctly routes expiry through `writeRecordAtomic`, but that primitive is not race-free for same-record writes (same defect as Blocking 4). |
| Non-blocking 7 — Chat parser/routing | ACCEPT-FIX | CONFIRMED | 01-DESIGN.md:697-712 names `src/chat/slashCommands.ts`, routes read commands through MCP tools, and forwards `/remember` / `/forget` to Planner. |
| Non-blocking 8 — runtime flag as compat detour | ACCEPT-FIX | CONFIRMED | §J.3 describes the flag as local sequencing and deletes it in the same commit that switches defaults. |
| Non-blocking 9 — deletion test list | ACCEPT-FIX | CONFIRMED | §I and §J.1 name `src/agents/agents.test.ts` and `src/mcp/builtins.test.ts` as deleted-and-replaced test surfaces. |
| Architectural 1 — coherent store boundary | ACCEPT-FIX | WRONG-FIX | The boundary exists at `src/knowledge/store.ts` (§C.3), but its central optimistic write primitive is still not a correct compare-and-swap or lock. |
| Architectural 2 — compaction hook at orchestration boundary | ACCEPT-FIX | CONFIRMED | §E.1 keeps `compaction.ts` pure; §E.2 puts the write opportunity in BaseAgent and uses `executeToolCall`. |
| Architectural 3 — survivor budget cannot silently erase durable knowledge | ACCEPT-FIX | CONFIRMED | §D.2 makes survivors uncapped summaries and ordinary overflow visible via `omitted: [...]`; §E.1 says eager cap does not apply after compaction. |
| Architectural 4 — common lifecycle logic under kind-specific tools | ACCEPT-FIX | CONFIRMED | §C.1 and §K use shared `permissions.ts` + `store.ts` under thin kind-specific MCP adapters. |
| Architectural 5 — Chat/user-preference boundary | ACCEPT-FIX | CONFIRMED | §F makes Chat read-only; §H.1 routes `/remember` through Planner judgment. |
| Spot-check OQ-5.5 authoring rights | ACCEPT-FIX | CONFIRMED | §A.1 selects scope-restricted authoring; §F grants Planner/Manager/Coder/Researcher/Inspector authoring roles with bounded worker writes. |
| Spot-check FR-4 scope semantics | ACCEPT-FIX | CONFIRMED | §B.3 and §B.4 enforce scope in both schema and path. |
| Spot-check FR-6 authoring | ACCEPT-FIX | CONFIRMED | §C.1 / §F give all FA authoring roles at least one write path and deny unauthorized roles. |
| Spot-check FR-8 triggerless creation | ACCEPT-FIX | CONFIRMED | §B.1, §C.1, and §D.3 make triggerless skills legal and searchable. |
| Spot-check FR-11 eager budget | ACCEPT-FIX | CONFIRMED | §D.2 defines the ordinary eager cap, estimation method, omission behavior, and config key. |
| Spot-check FR-15 survivor reinjection | ACCEPT-FIX | CONFIRMED | §E.1 defines project-scope `survive_compaction` reinjection after `compactConversation` returns. |
| Spot-check FR-16 compaction write opportunity | ACCEPT-FIX | CONFIRMED | §E.2 defines the Planner-only pre-compaction nudge, normal MCP loop, 5-turn cap, and no-write fallback. |
| Spot-check FR-21 git-trackable records | ACCEPT-FIX | CONFIRMED | §H.3 commits project/stage records and audits, ignores only sessions. |
| Spot-check FR-27 no secrets | ACCEPT-FIX | CONFIRMED | §C.3 specifies write-time refusal, blocked paths, audit behavior, and read-time redaction. |
| Spot-check FR-28 atomic writes | ACCEPT-FIX | CONFIRMED | §C.3 wraps `writeDoc` and keeps indexes derivable; existing `writeDoc` is tmp+fsync+rename. |
| Spot-check FR-29 concurrent writes | ACCEPT-FIX | WRONG-FIX | 01-DESIGN.md:300 and 01-DESIGN.md:322-323 rely on stat-before-rename mtime checking, which is TOCTOU and can silently overwrite a concurrent success. |
| Spot-check coder/create-M | ACCEPT-FIX | CONFIRMED | §C.1 and §F grant Coder `create_memory` / `update_memory` with `scope="stage"` only. |
| Spot-check chat/create-S | ACCEPT-FIX | CONFIRMED | §F denies Chat writes; §H.1 forwards `/remember` and `/forget` to Planner instead of direct authoring. |

## New issues introduced in round 2

### Blocking

1. **`writeRecordAtomic` is still not a race-free conflict detector for FR-29.**
   Evidence: 01-DESIGN.md:300 says the mtime check is `stat-before-rename`, and 01-DESIGN.md:322-323 says updates read mtime, compute, and pass `expectedMtimeMs` back. That leaves a TOCTOU window: two writers can both read the same mtime, both pass the pre-rename stat, and the second rename can silently overwrite the first. The design also says supersession sets `new.supersedes` and `old.superseded_by` atomically (01-DESIGN.md:209), but §C.3 does not define a multi-record transaction, rollback, or lock for that two-file mutation. This is a Phase B design issue, not a Phase C detail, because FR-29 requires the design to pick a mechanism that prevents undetected lost updates.

### Non-blocking

1. **Oversized survivor behavior is internally inconsistent.**
   Evidence: §D.2 says oversized survivors are refused at write time and warn+skip at load time; §E.1 shows `omitted: []` while saying `OVERSIZED_SURVIVOR` is warn-and-skip; §I says oversized survivors still appear with a warning header. Pick one testable behavior. The cleanest version is probably: write-time refusal for new records; load-time quarantine with explicit survivor ids in the injection header for manually corrupted records.

2. **Worker scope wording contradicts itself.**
   Evidence: 01-DESIGN.md:43 says workers are bounded to `stage`/`session`-scoped memories; §C.1 and §F make Co/Re stage-only. Stage-only `create_memory` is a defensible FA §5.5 Option-B variant and does not invent an unacceptable constraint, but the design should use one wording.

3. **FR-24 matrix points to a nonexistent build-order step.**
   Evidence: 01-DESIGN.md:939 cites `J.3 step 9`, while §J.3 has only eight steps and the built-in move/bundle work is step 8.

## Architectural re-check

| Concern | Verdict | Notes |
|---|---|---|
| 1. Single knowledge-store boundary | REVISE | The module boundary is right, but the mtime CAS and multi-record supersede story are not race-free. |
| 2. Compaction integration boundary | PASS | Moving FR-15/FR-16 orchestration to BaseAgent is clean; `compaction.ts` remains a pure summary helper. |
| 3. Survivor budget | PASS with clarification | The main design resolves silent ordinary drops and preserves survivors; the oversized-survivor wording needs cleanup. |
| 4. Tool surface vs duplicated logic | PASS | Kind-specific MCP tools are acceptable because the design routes lifecycle logic through shared store/permission layers. |
| 5. Chat/user trust boundary | PASS | Chat is read-only, Chat commands surface records, and `/remember` goes through Planner. |

Additional confirmations: `Status: DRAFT (Phase B, round 2)` is present at 01-DESIGN.md:3. The §L coverage matrix still lists FR-1 through FR-31 and FR-31a through FR-31g (01-DESIGN.md:916-953); no FR is silently dropped.

## Sign-off

REVISE. Must fix before Phase C:

1. Replace the `expectedMtimeMs` stat-before-rename design with a genuinely race-free write mechanism: for example, per-record lock files with stale-lock handling, an atomic lock directory, or another explicit serialization primitive. The design must say how update, supersede, sweeper expiry, and same-id create behave under that primitive.
2. Specify how `supersede_*` atomically updates both old and new records, or remove the claim of atomic two-record mutation and define the recoverable intermediate states and loader repair rules.

After those are fixed, the remaining round-2 issues are documentation consistency cleanups and should not block Phase C.