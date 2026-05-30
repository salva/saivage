# Phase B — Design Review (round 1)

Status: REVIEW
Reviewer: GPT-5.5
Verdict: REVISE
Date: 2026-05-23

## Verdict

Revise: the design is directionally sound, but it currently fails accepted FA requirements around authoring, triggerless creation, scope/gitignore semantics, audit/concurrency plumbing, and compaction reinjection.

## Blocking Issues

1. **Where:** §C.1 new tools, §F permissions matrix, §L FR-6.
   **What's wrong:** The authoring matrix does not satisfy accepted FA FR-6. FR-6 says Planner, Manager, Coder, Researcher, and Inspector have legitimate authoring needs; the design makes Coder and Researcher read-only, gives Chat skill-write, and gives Inspector skill-write without a bounded scope story. The §5.5 disposition says “scope-restricted authoring,” but the concrete matrix implements “workers cannot author at all.”
   **Evidence:** FA FR-6 requires authoring by Planner, Manager, Coder, Researcher, Inspector; FA §2.1 and §2.3 identify worker-discovered lessons/facts as first-class needs. The design's tool table allows `create_memory` only for Pl/Mg/In and `create_skill` only for Mg/In/Ch; §F marks Coder and Researcher create/supersede/archive denied for both kinds.
   **Suggested correction:** Either revise the design to satisfy FR-6 or explicitly re-open the FA requirement. A consistent fix is: Planner owns project memory; Manager owns stage/project promotion; Coder/Researcher can create task- or stage-scoped candidate memories through MCP; Inspector can archive/supersede/stale-mark and create memory findings; Chat remains a user-facing reader/requester unless a user-confirmed authoring path is separately designed.

2. **Where:** §C.1 `create_*` notes, §B.1 `SkillRecord.triggers`, §L FR-8.
   **What's wrong:** The design reintroduces the current “author must choose triggers” failure mode for skills. FR-8 says creation must not require authors to choose triggers/retrieval keys up front; the system must accept triggerless records with content-based retrieval or infer triggers. The design instead requires `SkillRecord.triggers.min(1)` and says `create_*` rejects skills without triggers.
   **Evidence:** FA FR-8 forbids the current `create_skill` unreachable-record failure by requiring no trigger/key choice or inferred retrieval. Design §C.1 says “triggers MUST be non-empty for skills,” and §L claims this satisfies FR-8 because “skills require triggers,” which is the opposite of the accepted requirement.
   **Suggested correction:** Make `triggers` optional/empty for skills and guarantee reachability through `search_skills` over body/description/name, or specify deterministic trigger inference at create time. Keep eager injection trigger-scored, but do not reject a valid skill solely because the author did not provide triggers.

3. **Where:** §B.3 scope semantics, §H.3 git ergonomics, §L FR-4/FR-21.
   **What's wrong:** Scope semantics are not storage-testable, and the gitignore policy is impossible as written. Records of different scopes share the same `records/*.json` directory, while §H.3 says commit project-scoped records but gitignore session-scoped records “where `scope=session`.” Git cannot ignore a JSON file based on its contents. Also `scope_ref` is optional even when `scope=stage` or `scope=session`, so lifecycle hooks cannot reliably identify what to archive.
   **Evidence:** §B.1 makes `scope_ref` optional; §B.3 says scope is enforced at injection/search time, not storage time; §H.3 commits `.saivage/memory/records/*.json` for project scope but gitignores `.saivage/memory/records/<uuid>.json` where `scope=session`.
   **Suggested correction:** Put scope in the path and validate it in the schema, for example `.saivage/memory/project/records/`, `.saivage/memory/stages/<stage_id>/records/`, and `.saivage/memory/sessions/<channel_or_session_id>/records/`. Add Zod refinements requiring `scope_ref` for stage/session records and tests for auto-archive and gitignore globs.

4. **Where:** §C.1 audit write note, §B.4 layout justification, §I store/concurrency tests, §L FR-28/FR-29.
   **What's wrong:** The design cites write mechanisms that do not exist or do not do what the design says. `appendDoc` is not a JSONL append helper; it appends to a JSON array document via `writeDoc`. Existing `writeDoc` has no mtime/ETag conflict check. Therefore the design does not yet specify a valid implementation for append-only `audit.jsonl`, crash consistency across record/index/audit writes, or concurrent write safety.
   **Evidence:** §C.1 says all writes append one `AuditEntry` to `audit.jsonl` “via `appendDoc`.” In `src/store/documents.ts`, `appendDoc` reads/writes a JSON object with an array field, and `writeDoc` validates then tmp-renames a single file without optimistic concurrency. §I later says parallel writes are serialized through a `writeDoc` mtime check, but no such check exists.
   **Suggested correction:** Design explicit knowledge-store primitives: `appendJsonlAtomic`, `writeDocIfUnmodified` or per-kind file locking, index rebuild semantics, and the transaction order for record + index + audit. Tests should cover partial audit lines, stale index rebuild, and two parallel writes producing either ordered successes or one retryable conflict.

5. **Where:** §E.2 compaction write hook, current `src/runtime/compaction.ts`, §L FR-16.
   **What's wrong:** `compaction_persist_memory` is not a clean integration point in the current architecture. `compactConversation` currently invokes a summarizer through `router.chat` with no tools, no MCP runtime, no role context, and no normal tool-call execution loop. The design says the Planner gets a synthesized tool for one turn, but places that behavior inside compaction without specifying how the tool is advertised, executed, authorized, or limited to the Planner.
   **Evidence:** `BaseAgent` calls `compactConversation(this.systemPrompt, this.messages, this.ctx.router, ...)`; `compactConversation` only serializes messages and calls `router.chat` for a summary. Tool schemas and tool execution live in `BaseAgent`, not in `compaction.ts`.
   **Suggested correction:** Move the write opportunity to `BaseAgent` before compaction, using the existing tool schema/filter/execution path, and gate it to Planner only. Alternatively, choose the FA's other allowed option: extend the summary template to request a deterministic JSON block, parse it, validate it, and route through the normal memory writer. In either design, specify what is logged when the Planner emits no records; the current no-op fallback is acceptable but must be tied to the actual integration point.

6. **Where:** §D.2 budget, §E.1 re-injection, §L FR-11/FR-15.
   **What's wrong:** The writer's 2048-token concern is real. §D.2 silently drops records that overflow the eager budget, while §E.1 promises all active project-scoped `survive_compaction` records are re-injected after compaction. Those two rules conflict, and neither tells the Planner or tests which supposedly durable records were omitted. This can make compaction lossy for exactly the records marked “survive compaction.”
   **Evidence:** §D.2 says the last overflowing record is dropped, not truncated; §E.1 says “all active records” with `survive_compaction == true` are re-injected; §D.6 only reports included count/token usage, not omitted IDs. The current compaction summary already replaces history, so silent omission after compaction is high impact.
   **Suggested correction:** Define mandatory post-compaction behavior: either surviving summaries have their own deterministic budget with explicit omitted IDs, or `survive_compaction` records are never silently dropped and compaction fails/degrades visibly when over budget. Add tests for over-budget survivor sets, one oversized record, deterministic ordering, and user-visible diagnostics.

7. **Where:** §L FR-27, §C.1 notes, §I secrets tests.
   **What's wrong:** Secret handling is asserted but not designed. FR-27 requires write refusal and retrieval redaction/refusal using the project's secret-detection heuristics. The design only says tests will reject provider-config/API-key-shaped content; it does not define the scanner, the blocked path list, where read-time redaction happens, or whether audit entries record rejected attempts.
   **Evidence:** §L cites §C.1 for FR-27, but §C.1 has no secret-scanning mechanism. §I lists a test, not a design. Ground rules also explicitly forbid reading/printing/copying auth/profile/provider/env secrets, so this cannot be left to implementation taste.
   **Suggested correction:** Add a short security subsection naming the shared secret scanner/heuristics, write-time and read-time behavior, blocked source paths, audit behavior for rejected writes, and test fixtures that avoid real secrets.

## Non-Blocking Issues

1. **Where:** §D.1 built-in projection and §B.1 scope enum.
   **What's wrong:** The eager algorithm uses `projectAsSkillRecord(entry, scope="builtin")`, but `scope` only allows `project`, `stage`, and `session`. This is a schema contradiction.
   **Evidence:** §B.1 defines `scope: z.enum(["project", "stage", "session"])`; §D.1 says built-ins are projected with `scope="builtin"`; §D.1 sorting also uses “project > builtin.”
   **Suggested correction:** Add an `origin: "builtin" | "project"` field separate from `scope`, or add `builtin` as a non-persistent origin that never enters `RecordBase.scope`.

2. **Where:** §B.5 supersession cross-references.
   **What's wrong:** “same-kind, any scope ≥ old's scope” is not defined. There is no scope ordering in the data model, so implementers cannot know whether a project record may supersede a stage record, or a stage record may supersede a session record.
   **Evidence:** §B.5 uses `scope ≥ old's scope` but §B.3 provides lifetime semantics only, not a partial order.
   **Suggested correction:** Replace the symbolic ordering with an explicit allowed-pairs table and tests.

3. **Where:** §D.3 keyword search.
   **What's wrong:** The retrieval scoring is close to testable but still leaves match semantics ambiguous. “token in topic/keys/body” could mean exact token equality, case-folded substring, or normalized punctuation-stripped comparison. `search_skills` also scores over body even though skill bodies live in markdown files outside `index.json`.
   **Evidence:** §D.3 defines tokenization as whitespace/lowercase only and says body first 500 chars, but does not define punctuation, substring behavior, or body-file loading.
   **Suggested correction:** Define canonical normalization and exact match behavior, and specify whether search reads body files on demand or stores/searches indexed snippets in `index.json`.

4. **Where:** §C.1 and §C.2 MCP authoring surface.
   **What's wrong:** Sixteen new tools are defensible, but the design does not justify why kind-specific CRUD is better than a smaller shared `knowledge` service with `kind` discriminators for common operations. This adds surface area and error-mode duplication.
   **Evidence:** `create/update/supersede/archive/delete/list/read-or-get/search` exist separately for both skills and memory, while §A says both share primitives and one permission engine.
   **Suggested correction:** Either justify the split as an intentional ergonomics tradeoff, or collapse common lifecycle operations into `create_record/update_record/supersede_record/archive_record/delete_record` while preserving kind-specific read aliases if desired.

5. **Where:** §C.1 and §F error modes.
   **What's wrong:** Error modes are scattered but not comprehensively defined. The design mentions empty reasons and unknown triggers, but not canonical errors for unauthorized role, not found, stale write conflict, same-topic collision, invalid scope_ref, secret match, oversized eager record, broken body_path, malformed audit line, or index rebuild failure.
   **Evidence:** §C.1 has only a few notes; §G.4 defines collision behavior; §I tests unauthorized roles, but no error taxonomy exists.
   **Suggested correction:** Add a compact error table with code, trigger condition, mutating/non-mutating behavior, and whether an audit entry is written.

6. **Where:** §G.2 sweeper trigger.
   **What's wrong:** On-load expiry is coherent with no background process, but it can mutate records while multiple agents are constructing/searching at once. That is acceptable only after the concurrency design in Blocking Issue 4 exists.
   **Evidence:** §G.2 says loader/list/search lazily transitions expired records in-place and audit-logs it; FR-29 requires concurrent-write safety.
   **Suggested correction:** Tie expiry transitions to the same write-lock/optimistic concurrency primitive, and specify whether a failed expiry write causes the expired record to be skipped or surfaced.

7. **Where:** §H.1 Chat commands.
   **What's wrong:** Chat likely satisfies FR-22 at the user-facing level, but the design does not state where slash-command parsing lives or how command calls are routed through Chat's filtered MCP catalog instead of host filesystem reads.
   **Evidence:** §H.1 lists commands and says they map onto MCP tools; current Chat already has special note/inspection surfaces, so implementers need the integration point.
   **Suggested correction:** Name the Chat command parser/module and require command implementations to call MCP read tools, not read `.saivage` files directly.

8. **Where:** §J.3 build-safe order.
   **What's wrong:** The temporary runtime flag and old-path branch are a backward-compatibility-shaped detour. It may be useful during local development, but it should not appear as a shipped design requirement under the “no backward compatibility” ground rule.
   **Evidence:** §J.3 steps 4-8 keep old and new services/loaders side by side behind a runtime flag before deletion.
   **Suggested correction:** Phrase the flag as an optional local sequencing tactic, not an architecture requirement, or delete the old loader/service in the same implementation slice that switches `BaseAgent`.

9. **Where:** §J.1 deletion list and test impact.
   **What's wrong:** The deletion list names broad categories but misses concrete existing tests/imports that will fail. This is easy to fix now and saves Phase C churn.
   **Evidence:** `src/agents/agents.test.ts` imports `resolveSkills`, `formatSkillsForPrompt`, and `SkillIndexSchema`; `src/mcp/builtins.test.ts` asserts current `read_skill` path traversal behavior and unavailable stub behavior.
   **Suggested correction:** Name the affected test files and expected replacement suites in §J or §I.

## Spot-Check Log

- **OQ 5.1 one feature vs two:** PASS. Two kinds on shared primitives is defensible; the design gives concrete divergence in surfacing, authoring ergonomics, and distribution.
- **OQ 5.2 memory retrieval:** PASS. Topic + keyword search is deterministic and respects OOS-1.
- **OQ 5.3 trigger fate:** PASS. Removing dead `tool:`/`path:` satisfies FA FR-13, although path-based task relevance should be re-evaluated after on-demand search exists.
- **OQ 5.5 authoring rights:** FAIL. “Scope-restricted” is chosen, but Coder/Researcher authoring disappears rather than being scoped.
- **OQ 5.6 contradiction handling:** PASS with caveat. Explicit supersession is a real decision; semantic contradiction detection remains out of scope and should be described as same-key/same-name collision handling.
- **OQ 5.7 storage layout:** PASS. File-per-record plus JSONL audit has a real justification beyond taste, but the JSONL write primitive is missing.
- **OQ 5.9 web UI / chat:** PASS. Chat commands are enough for FR-22; web UI can remain a hook point.
- **FR-2 fields:** PASS with caveat. Base fields and payloads exist; audit is external in `audit.jsonl`, which is acceptable if write semantics are fixed.
- **FR-3 lifecycle:** PASS. States and major transitions are listed.
- **FR-4 scope semantics:** FAIL. `scope_ref` is optional and scope is not encoded in storage paths, weakening stage/session tests.
- **FR-6 authoring:** FAIL. Coder/Researcher authoring needs are not met.
- **FR-8 triggerless creation:** FAIL. Skills require triggers.
- **FR-11 budget:** FAIL. Enforced cap exists, but silent drops and compaction survivor conflict make it unsafe.
- **FR-13 dead triggers:** PASS. The design chooses removal.
- **FR-14 memory lookup/search:** PASS. Exact topic lookup plus keyword search are specified enough for a first implementation after match semantics are tightened.
- **FR-15 compaction reinjection:** FAIL. “All survivors” conflicts with the budget behavior and current compaction integration.
- **FR-16 compaction write opportunity:** FAIL. The proposed synthetic tool is not wired through the current tool execution architecture.
- **FR-17 expiry:** PASS. TTL/`expires_at` and on-load expiry are coherent, subject to concurrency fixes.
- **FR-18 supersession:** PASS with caveat. Chain handling is present; cross-scope allowed pairs need definition.
- **FR-19 stale enumeration:** PASS. `older_than_days` on `list_memories` covers enumeration.
- **FR-21 git-trackable records:** FAIL. Content-dependent gitignore rules cannot work.
- **FR-22 Chat surfacing:** PASS. Slash commands satisfy the requirement if routed through MCP tools.
- **FR-24 built-ins in production:** PASS with caveat. Frontmatter walk plus bundled assets is a good direction; `scope="builtin"` must be fixed.
- **FR-27 no secrets:** FAIL. Requirement is asserted but the scanner/redaction design is missing.
- **FR-28 atomic writes:** FAIL. `audit.jsonl` append and multi-file transaction semantics are not specified correctly.
- **FR-29 concurrent writes:** FAIL. The design references an mtime/ETag check that does not exist.
- **Permission cell planner / create-M:** PASS. Planner memory-write fits Planner compaction and long-term recall.
- **Permission cell coder / create-M:** FAIL. Accepted FA grants Coder legitimate authoring needs; the design denies them entirely.
- **Permission cell data_agent / read-M:** PASS. Denial is defensible because Data Agent is not listed in FR-6 and has narrower data-pipeline responsibilities.
- **Permission cell inspector / archive-M:** PASS. Inspector needs stale/repair authority.
- **Permission cell chat / create-S:** FAIL. Chat skill-write is not justified by FR-22 and conflicts with the `/remember` route-to-Planner design.

## Architectural Concerns

1. The design should keep the knowledge store as a coherent module with its own transaction/concurrency primitives. Spreading invariants across `writeDoc`, `appendDoc`, `fsGuard`, MCP handlers, and loaders without a single store boundary will recreate the current integrity holes in a new shape.

2. The compaction write hook belongs at the agent orchestration boundary, not buried inside the summarizer helper. `compaction.ts` should remain a deterministic history transformation unless it is explicitly promoted into a tool-executing workflow with role and MCP context.

3. The budget default is not noise. A 2048-token cap can silently erase durable post-compaction knowledge unless omitted records are explicit and recoverable. This is especially dangerous because the LLM will treat the post-compaction summary as authoritative continuation context.

4. The 16-tool surface may be acceptable, but it should not force duplicated lifecycle logic. Common create/update/supersede/archive/delete semantics should route through one store/permission engine even if exposed as kind-specific MCP tools.

5. The design mostly respects OOS: no vector search, no cross-project/global state, no DB, no long-lived service, and no LLM-driven eviction. The only OOS-adjacent risk is letting Chat-written “remember” content become a user-preference channel without the Planner/confirmation boundary being explicit.

## Confirmations

- The §A reframing is broadly correct: two record kinds with shared primitives is cleaner than forcing skills and memories into one wide schema, and keeping `NoteManager` separate respects OOS-10.

- The design correctly preserves project-local JSON/JSONL state under `<project>/.saivage/` and does not introduce SQLite, `~/.saivage`, a global registry, or a background service.

- Dropping `tool:` and `path:` triggers is an acceptable answer to FA FR-13 because the current agents do not populate those fields, and the design keeps `keyword:`, `tag:`, and `agent:`.

- The frontmatter-walk direction for built-in skills directly addresses the accepted FA defect where built-ins are dead in source and production.

- The eager-injection block format does not conflict with the current system-prompt assembly pattern; it mirrors today's `formatSkillsForPrompt` approach by appending static prompt text at construction time.

- The decay choice of on-load/on-search expiry is coherent with the no-background-process ground rule, provided the write-concurrency issue is fixed.

- Chat commands are the right minimal user-visible surface for FR-22; a web UI panel can remain deferred.

- The design stays inside FA §6 out-of-scope boundaries: no vector/semantic search, no cross-project sharing, no global host state, no LLM eviction policy, and no replacement of `NoteManager`.