# Saivage v2 — Skill + Memory: Design

Status: DRAFT (Phase B, round 1)
Author: Claude Opus 4.7 (writer)
Date: 2026-05-23

---

## A. Reframing decision (one feature vs two; relation to NoteManager and inspections)

**Decision: two distinct record kinds (`skill`, `memory`) sharing primitives.** Both
live under one document-store substrate (`writeDoc` / `readDoc`), one Zod base, one
audit-trail format, one permission engine; they diverge on default surfacing mode,
retrieval API, and authoring ergonomics. The `NoteManager` (OOS-10) stays untouched;
the `inspections/` lifecycle stays untouched.

Why two, not one (FA §5.1 Option B):

- Surfacing modes are genuinely different: skills want eager system-prompt injection;
  memories want on-demand lookup. A `kind` discriminator on one schema buys little
  beyond a flat namespace, and forces every retrieval call site to filter.
- Authoring ergonomics diverge: skills need `triggers` + `target_agents`; memories
  need `topic` + `keys`. Combining them produces a wide schema with half the fields
  null per row.
- The MCP namespace already separates `skills` from `memory` (FA §1.2, §1.5.5);
  spec readers will look for those names.
- The Inspector/Chat audit story is cleaner when "what skills do I have" and "what
  do I know" are independently enumerable.
- Failure containment: a broken memory does not poison skill loading.
- Built-in distribution differs (skills ship in repo as defaults; memories never
  do — they are always project-authored).

**Why not three (skill/memory/note unified):** notes are *user → planner*
injection with a different trust boundary (user-authored, must survive compaction
explicitly via `permanent`). Unifying breaks the user-vs-agent distinction.

### A.1 Open-question dispositions (FA §§5.1–5.12)

| OQ | Decision | Rationale (1 sentence) |
|----|----------|------------------------|
| 5.1 one feature or two | **Two** subsystems on shared primitives | Diverge on surfacing + authoring; shared store is enough. |
| 5.2 memory retrieval | **Topic key + keyword search** (hybrid A+B) | Authors get cheap exact lookup; on-demand keyword grep covers the unkeyed case. |
| 5.3 trigger system | **Keep for skills, drop for memory; remove dead `tool:` and `path:`** | `tool:` and `path:` are dead today (FA §1.3); clean-architecture rule forbids keeping unwired schema. |
| 5.4 user-supplied prefs | **Out of scope** (Option C) | Ground-rule 3 forbids `~/.saivage`; no virtual host scope. |
| 5.5 authoring rights | **Scope-restricted** (Option B) | Stage/project ownership cleanly maps to Manager/Planner; workers stay narrow. |
| 5.6 conflict handling | **Explicit supersession only** (Option B) | Reproducible; eliminates "last write wins" surprises. |
| 5.7 storage layout | **One JSON per record + append-only `audit.jsonl`** | Mirrors `notes/<id>.json`; audit log is naturally append-only. |
| 5.8 built-in distribution | **Loader walks directory, parses YAML frontmatter** (Option B) | Removes dual-format defect (FA §1.4, §1.5.1) and the `index.json`-next-to-`dist/` production bug. |
| 5.9 web UI / chat | **Chat commands now; web UI deferred to one hook point** | FR-22 is the testable requirement; UI is later work. |
| 5.10 cross-agent visibility | **Inspector + Chat always readers; others honour `target_agents`** (Option C) | Matches Inspector's audit posture and Chat's user-facing role. |
| 5.11 inspections relation | **Inspection → memory by reference** (Option A) | Preserves both lifecycles; no schema conflation. |
| 5.12 compaction sufficiency | **Memory carries only what `plan-history.json` cannot** (Option A) | No duplication; FR-31 pins the boundary test. |

---

## B. Data model

### B.1 Schemas (Zod-style pseudocode)

```ts
// Shared base — every record kind embeds this.
const RecordBase = z.object({
  id: z.string().uuid(),
  kind: z.enum(["skill", "memory"]),
  scope: z.enum(["project", "stage", "session"]),
  status: z.enum(["active", "superseded", "archived", "expired"]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  author_agent: z.object({ role: AgentRoleSchema, agent_id: z.string() }),
  source: z.object({ stage_id: z.string().optional(), task_id: z.string().optional() }).optional(),
  scope_ref: z.string().optional(),   // stage_id when scope=stage; channel_id when scope=session
  expires_at: z.string().datetime().optional(),
  ttl_ms: z.number().int().positive().optional(),
  supersedes: z.string().uuid().optional(),
  superseded_by: z.string().uuid().optional(),
  relates_to: z.array(z.string().uuid()).default([]),
  survive_compaction: z.boolean().default(false),
});

const SkillRecord = RecordBase.extend({
  kind: z.literal("skill"),
  name: z.string().min(1),            // unique within scope
  description: z.string(),
  triggers: z.array(z.string()).min(1),  // "keyword:..", "tag:..", "agent:.." only
  target_agents: z.array(AgentRoleSchema).default([]),
  body_path: z.string(),              // relative markdown path
});

const MemoryRecord = RecordBase.extend({
  kind: z.literal("memory"),
  topic: z.object({                   // structured key for exact lookup
    domain: z.string(),               // e.g. "build", "schema", "user-pref"
    subject: z.string(),              // e.g. "web-app", "users-table"
    aspect: z.string().optional(),    // e.g. "command", "denormalized-column"
  }),
  keys: z.array(z.string()).default([]),   // free-form lookup tokens
  target_agents: z.array(AgentRoleSchema).default([]),  // for advisory eager surfacing only
  body: z.string(),                   // inline markdown; memories are usually short
  source_ref: z.object({              // optional pointer to inspection / report
    kind: z.enum(["inspection", "task_report", "stage_summary"]),
    id: z.string(),
  }).optional(),
});

// Audit entry — appended to <scope>/<kind>s/audit.jsonl on every mutation.
const AuditEntry = z.object({
  ts: z.string().datetime(),
  record_id: z.string().uuid(),
  op: z.enum(["create", "update", "supersede", "archive", "delete", "expire"]),
  author_agent: z.object({ role: AgentRoleSchema, agent_id: z.string() }),
  reason: z.string(),
  prev_status: z.string().optional(),
  next_status: z.string().optional(),
  content_hash_before: z.string().optional(),
  content_hash_after: z.string().optional(),
});
```

Two top-level schemas only (`SkillRecord`, `MemoryRecord`); `RecordBase` is not a
discriminated-union root that consumers read directly.

### B.2 Lifecycle state machine

| From → To | Trigger | Who |
|-----------|---------|-----|
| (∅) → active | `create_*` MCP call | Authorized author |
| active → superseded | `supersede_*` MCP call (sets `superseded_by`) | Authorized author |
| active → archived | `archive_*` MCP call (reversible) | Authorized author |
| archived → active | `unarchive_*` MCP call | Authorized author |
| active → expired | sweeper: `now > expires_at` OR `now > updated_at + ttl_ms` | Runtime sweeper |
| stage-scoped active → archived | stage terminal transition (success / failed / canceled) | Stage hook |
| session-scoped active → archived | chat channel close | Chat session hook |
| any → (gone) | `delete_*` MCP call (writes tombstone + audit) | Authorized author |

Invariants: `superseded` and `expired` records are read-only via `get_*` by id;
they are excluded from eager injection and from default search. Status transitions
are never silent: every transition writes one audit entry.

### B.3 Scope semantics

| Scope     | Lifetime                     | Eager injection target                  |
|-----------|------------------------------|-----------------------------------------|
| `project` | Until archived or superseded | All matching agents, all stages         |
| `stage`   | Until stage terminates       | Only agents constructed *during* the stage referenced by `scope_ref` |
| `session` | Until chat channel closes    | Only the Chat agent whose channel matches `scope_ref` |

Scope is enforced at injection time and at search time (default filter), not at
storage time; a misfiled `scope` still survives lifecycle ops.

### B.4 On-disk layout under `<project>/.saivage/`

```
.saivage/
├── skills/
│   ├── index.json              # cached projection { skills: [SkillRecord without body] }
│   ├── audit.jsonl             # append-only mutation log
│   └── records/
│       ├── <uuid>.json         # one SkillRecord per file
│       └── <uuid>.md           # body referenced by SkillRecord.body_path
├── memory/
│   ├── index.json              # cached projection { memories: [MemoryRecord without body] }
│   ├── audit.jsonl
│   └── records/
│       └── <uuid>.json         # body is inline; no separate markdown
```

Plus built-in skills shipped in the repo at `saivage/skills/builtin/<name>/SKILL.md`
(YAML frontmatter; no `index.json`). Loader walks this directory at startup; in
production the directory is bundled into `dist/skills/builtin/` by `tsup` (FR-24).

**Layout justification (one paragraph).** One file per record (Option A) for both
kinds, plus a per-kind `index.json` projection (rebuilt on every write) and an
`audit.jsonl` append-only log. The per-record file gives the existing
`notes/<id>.json` ergonomics: easy git diff, easy `cat`, easy `rm`. JSONL would
make audit trails trivial but would degrade the human-grep experience on the
record corpus and fight `writeDoc`'s tmp-then-rename atomicity. The
`index.json` projection keeps load fast without scanning N record files; it is
fully derivable from `records/*.json` so a torn write is fixable by rebuild. The
audit JSONL is append-only and tolerates partial last lines.

### B.5 Record cross-references

| Relation        | Direction | Allowed combos                          | Rules |
|-----------------|-----------|-----------------------------------------|-------|
| `supersedes`    | new → old | same-kind, any scope ≥ old's scope      | Sets new.supersedes = old.id and old.superseded_by = new.id atomically. |
| `superseded_by` | old → new | reverse of above                        | Read-only mirror; not directly writable. |
| `relates_to`    | symmetric | skill↔skill, memory↔memory, skill↔memory | Free-form association; no lifecycle effect. |
| `source_ref`    | memory → external | memory → {inspection, task_report, stage_summary} | Drives §5.11 inspection-to-memory bridge. |

Rule: a `supersede_*` call on an already-superseded record is rejected (must
supersede the current head of the chain). `relates_to` is bounded at 16 entries
per record (cheap defensive cap).

---

## C. MCP authoring surface

### C.1 New tools

Roles abbreviated: Pl=planner, Mg=manager, Co=coder, Re=researcher, Da=data_agent,
In=inspector, Rv=reviewer, De=designer, Ch=chat.

| Tool                  | Input fields                                                                                                | Output                  | Callable by | FRs |
|-----------------------|-------------------------------------------------------------------------------------------------------------|-------------------------|-------------|-----|
| `create_skill`        | `{ name, description, body, triggers[], target_agents[], scope, scope_ref?, expires_at?, ttl_ms?, survive_compaction?, reason }` | `{ id, status }`        | Mg, In, Ch  | FR-6,7,8 |
| `update_skill`        | `{ id, body?, description?, triggers?, target_agents?, expires_at?, ttl_ms?, reason }`                       | `{ id, updated_at }`    | Mg, In, Ch  | FR-7 |
| `supersede_skill`     | `{ old_id, new_record, reason }` (new_record same shape as `create_skill`)                                   | `{ new_id, old_id }`    | Mg, In, Ch  | FR-18 |
| `archive_skill`       | `{ id, reason }`                                                                                            | `{ id, status }`        | Mg, In, Ch  | FR-30 |
| `delete_skill`        | `{ id, reason }`                                                                                            | `{ id }`                | Mg, In, Ch  | FR-30 |
| `list_skills`         | `{ scope?, target_agent?, include_archived?, include_superseded? }`                                          | `[SkillRecord summary]` | all roles   | FR-10,22 |
| `read_skill`          | `{ id }`                                                                                                     | `{ record, body }`      | all roles   | FR-10,FR-31d |
| `search_skills`       | `{ query, scope?, limit? }` (keyword over body+description+triggers)                                         | `[{id,score,snippet}]`  | all roles   | FR-14 |
| `create_memory`       | `{ topic, keys[], body, target_agents[], scope, scope_ref?, expires_at?, ttl_ms?, survive_compaction?, source_ref?, reason }` | `{ id, status }`        | Pl, Mg, In  | FR-6,7,8 |
| `update_memory`       | `{ id, body?, keys?, target_agents?, expires_at?, ttl_ms?, reason }`                                         | `{ id, updated_at }`    | Pl, Mg, In  | FR-7 |
| `supersede_memory`    | `{ old_id, new_record, reason }`                                                                            | `{ new_id, old_id }`    | Pl, Mg, In  | FR-18 |
| `archive_memory`      | `{ id, reason }`                                                                                            | `{ id, status }`        | Pl, Mg, In  | FR-30 |
| `delete_memory`       | `{ id, reason }`                                                                                            | `{ id }`                | Pl, Mg, In  | FR-30 |
| `list_memories`       | `{ scope?, topic_domain?, include_archived?, older_than_days? }`                                             | `[MemoryRecord summary]`| Pl,Mg,In,Rv,Ch | FR-10,FR-19,FR-22 |
| `get_memory`          | `{ id }` OR `{ topic: {domain, subject, aspect?} }`                                                          | `MemoryRecord`          | all roles except Da | FR-14 |
| `search_memories`     | `{ query, scope?, limit? }` (keyword over body + keys + topic flattened)                                     | `[{id,score,snippet}]`  | all roles except Da | FR-14 |

Notes:
- `create_*` enforces FR-8: triggers MUST be non-empty for skills; memories may
  omit `keys` because `get_memory` by `topic` always works (the topic itself is
  the retrieval key).
- All write tools require `reason` (non-empty string). The runtime — not the
  handler — rejects empty reasons with a descriptive error.
- All write tools route through `writeDoc` and append one `AuditEntry` to
  `audit.jsonl` via `appendDoc` (FR-28).
- `older_than_days` on `list_memories` services Inspector enumeration (FR-19).

### C.2 Existing tools — fate

| Name                       | Action  | Reason |
|----------------------------|---------|--------|
| `skills.create_skill` (old) | **Replace** | Old schema lacks triggers/audit/lifecycle; clean-arch rule (no compat) → wipe & re-implement under same name with new contract. |
| `skills.update_skill` (old) | **Replace** | Old version silently discards `reason`, never touches `index.json`. |
| `skills.list_skills` (old)  | **Replace** | Old version returns raw unvalidated index; new version returns Zod-validated summaries. |
| `skills.read_skill` (old)   | **Replace** | Old version ignores `entry.file` (FR-31d); replacement honours `body_path`. |
| `memory.*` stubs            | **Delete** | All registered `available: false`; replaced by new tools above. |
| `index.*` stubs             | **Delete** | Semantic/full-text search is OOS-1. |
| `SkillEntrySchema`, `SkillIndexSchema` in `src/types.ts` §10 | **Delete** | Replaced by `SkillRecord` and the per-kind index projection schema. |
| `MemoryEntrySchema`, `IndexEntrySchema` stubs | **Delete** | Never reachable; replaced. |
| Generic `write_file` writes targeted at `.saivage/skills/` or `.saivage/memory/` | **Reject at runtime** | New `fsGuard` denies writes under those paths from any role (closes FA §1.6.4 escape hatch). |

---

## D. Retrieval and surfacing

### D.1 Eager-injection algorithm (replaces `scoreTriggers` in `loader.ts`)

```
resolveEagerRecords(ctx, projectDir, budget):
  candidates = []

  # Skills — built-in first (frontmatter walk), then project (index projection).
  for entry in walkBuiltinSkills(distOrSrcSkillsDir):       # YAML frontmatter
    candidates += projectAsSkillRecord(entry, scope="builtin")
  for record in readSkillIndex(projectDir/"skills/index.json"):
    candidates += record                                     # project wins on name collision

  # Memories that opted into eager surfacing (target_agents non-empty).
  for record in readMemoryIndex(projectDir/"memory/index.json"):
    if record.target_agents.length > 0: candidates += record

  # Filter: status=active, scope compatible, target_agents matches role.
  eligible = candidates.filter(r =>
    r.status == "active" &&
    scopeMatches(r, ctx) &&             # project|stage(==ctx.stage_id)|session(==ctx.channel_id)
    (r.target_agents.length == 0 || r.target_agents.includes(ctx.agentRole))
  )

  # Score skills only (memories have no triggers).
  for r in eligible:
    r.score = (r.kind == "skill") ? scoreSkillTriggers(r.triggers, ctx) : 1
    if r.score == 0 && r.kind == "skill": drop r

  # Sort: project > builtin, then score desc, then updated_at desc.
  sort(eligible, by: [originPrecedence, -score, -updated_at])

  # Enforce per-agent budget; emit blocks until budget exhausted.
  return takeUntilBudget(eligible, budget)
```

`scoreSkillTriggers` supports **only** `keyword:`, `tag:`, `agent:` (the three
trigger types that work today). `tool:` and `path:` are removed from
`SkillRecord.triggers` validation (any record carrying them is rejected at write
time with a descriptive error; the loader treats them as unknown types and
ignores them defensively).

### D.2 Budget mechanism (FR-11)

- **Mechanism: token cap** (approximate, `length / 4` heuristic — same as
  `compaction.ts`'s `estimateTokens`).
- **Default: 2048 tokens** per agent for the combined `skill + memory` eager
  block.
- **Enforcement: in `BaseAgent` constructor**, after `resolveEagerRecords`
  returns the ranked list, the runtime appends records in rank order while a
  running total stays under the cap; the last record that would overflow is
  dropped (not truncated). The budget is configurable via
  `ctx.project.config.skills.eager_budget_tokens`; per-record override via
  `record.body` byte-length is logged but not capped per-record (records are
  authored to be small).

### D.3 On-demand pull (FR-14)

`get_memory({topic})` algorithm:
1. Compute canonical key `domain/subject[/aspect]`.
2. Look up in `memory/index.json` topic→id map (rebuilt on every write).
3. Walk supersession chain to head; return current head if `status == active`,
   else return `null` (caller may pass `include_history: true` to walk the
   chain).

`search_memories({query, scope?, limit=10})` algorithm:
1. Tokenize `query` on whitespace, lowercase.
2. For each non-archived non-expired memory in `index.json`, score = sum over
   tokens of: 3·(token in topic) + 2·(token in keys) + 1·(token in body
   first 500 chars).
3. Drop score 0. Sort by score desc, then `updated_at` desc. Slice to `limit`.
4. Result shape: `[{ id, topic, score, snippet }]` where `snippet` is the
   200-char window around the first match in body.

`search_skills` is structurally identical, scoring over triggers + description +
body.

**Ordering rule (universal):** score desc → `updated_at` desc → `id` asc
(stable tie-break).

### D.4 Dead trigger fate (FR-13)

**Decision: remove from schema.** `tool:` and `path:` are deleted from
`SkillRecord.triggers` validation. No agent file gets a one-line
`SkillMatchContext.tools` / `filePaths` change — the trigger types they would
power are gone.

Agent-prompt one-liners (separate from trigger wiring): six agent system
prompts get a *one-paragraph* addition telling them how to pull memories
on-demand. Files touched (**6**): `src/agents/planner.ts`,
`src/agents/manager.ts`, `src/agents/coder.ts`, `src/agents/researcher.ts`,
`src/agents/inspector.ts`, `src/agents/chat.ts`. Reviewer, Designer, Data
Agent get no prompt change in this phase (rationale: workers, see Section F).

### D.5 `scope_tags` vs `target_agents`

- `target_agents` is a **role filter** for eager injection (and for the
  Inspector/Chat-readable visibility hybrid in §5.10): "should agent of role R
  see this in its system prompt?"
- `scope_tags` (a renamed/extended successor to today's flat `tags`, attached
  as `keys[]` for memories and folded into `triggers` as `tag:<x>` for skills)
  is **content-overlap matching** between record and task: "is this record
  topically relevant to *this* task?"
- An empty `target_agents` array means "any role" (preserves today's default).
- An empty `keys[]` / no matching `tag:` trigger means the record is not eager
  but is still findable on demand.
- `target_agents` is enforced at *both* injection time and on-demand-read time
  for worker roles (Coder/Researcher/Data Agent/Reviewer/Designer); Inspector
  and Chat bypass it on read (see Section F).
- For stage- and session-scoped records, `target_agents` is AND-ed with the
  scope filter: a `stage`-scoped record targeting Coder is only injected into
  Coders dispatched during that stage.

### D.6 Per-agent injected block format

Appended to the agent's static system prompt at construction (mirrors today's
`formatSkillsForPrompt`):

```
--- SAIVAGE KNOWLEDGE (3 skills, 1 memory, ~412 tokens) ---

--- SKILL: coding-style (project) ---
<markdown body>
---

--- SKILL: planning-loop (builtin) ---
<markdown body>
---

--- MEMORY: build/web-app/command (project) ---
<markdown body>
---

--- END SAIVAGE KNOWLEDGE ---
```

The header line states budget usage so the agent (or a human reading the
prompt) can audit. The `(scope)` annotation lets the LLM weight the record.

---

## E. Compaction integration

### E.1 FR-15 re-injection

- **Which records:** all `active` records (skills + memories) with
  `scope == "project"` AND `survive_compaction == true`. Stage- and
  session-scoped records do not survive (their scope ends earlier).
- **Where in `compaction.ts`:** new helper
  `injectSurvivingRecords(state, projectDir)` called from inside
  `compactConversation` between `serializeForSummary` and the prompt
  invocation, AND once more after the summary returns when reconstructing
  the post-compaction message list (mirroring how `NoteManager.getPermanentNotes()`
  is read at planner construction).
- **Post-compaction text format:** appended to the synthesized summary
  message as a second block:
  ```
  --- SURVIVING KNOWLEDGE (auto-reinjected after compaction #N) ---
  [SKILL coding-style] <one-line summary from record.description>
  [MEMORY build/web-app/command] <first 200 chars of body>
  ...
  --- END SURVIVING KNOWLEDGE ---
  ```
  Full bodies remain accessible via `read_skill` / `get_memory` if the
  Planner wants them; the eager re-inject is summaries only to respect the
  budget after compaction.

### E.2 FR-16 write hook

- **Tool-call shape:** prior to history truncation, the compaction routine
  appends a synthesized tool definition `compaction_persist_memory` to the
  Planner's tool list for *one* turn. Its schema is:
  ```
  { records: Array<{ topic, keys?, body, target_agents?, survive_compaction?, reason }> }
  ```
  The runtime translates each entry into a `create_memory` call (scope =
  `project`) before discarding history. If the Planner responds without
  calling the tool, no memories are written (fallback = no-op).
- **Fallback behavior:** if the Planner's response cannot be parsed for a
  tool call, the runtime logs a warning, persists nothing, and proceeds
  with compaction. Compaction never fails because the write hook didn't fire.
- **Test hook:** `compactConversation` accepts an injected
  `onPersistMemories?: (records: Memory[]) => void` callback used by unit
  tests to assert that the tool call materialized.

---

## F. Permissions matrix

Rows: nine roles from FA §1.2.1. Columns: operations across both kinds
(skills and memories collapsed where identical; "S" / "M" prefix where they
differ). Cell legend: `Y` = allowed, `—` = denied.

| Role        | create-S | create-M | read-S | read-M | supersede-S | supersede-M | archive-S | archive-M | search-S | search-M |
|-------------|----------|----------|--------|--------|-------------|-------------|-----------|-----------|----------|----------|
| planner     | —        | Y        | Y      | Y      | —           | Y           | —         | Y         | Y        | Y        |
| manager     | Y        | Y        | Y      | Y      | Y           | Y           | Y         | Y         | Y        | Y        |
| coder       | —        | —        | Y      | Y      | —           | —           | —         | —         | Y        | Y        |
| researcher  | —        | —        | Y      | Y      | —           | —           | —         | —         | Y        | Y        |
| data_agent  | —        | —        | Y      | —      | —           | —           | —         | —         | Y        | —        |
| inspector   | Y        | Y        | Y      | Y      | Y           | Y           | Y         | Y         | Y        | Y        |
| reviewer    | —        | —        | Y      | Y      | —           | —           | —         | —         | Y        | Y        |
| designer    | —        | —        | Y      | Y      | —           | —           | —         | —         | Y        | Y        |
| chat        | Y        | —        | Y      | Y      | Y           | —           | Y         | —         | Y        | Y        |

`delete-*` is the same set as `archive-*` (terminal action requires same
authority). Visibility rules (§5.10) layer over `read-*` and `search-*`:
worker roles (coder, researcher, data_agent, reviewer, designer) honour
`target_agents` on records they read; inspector and chat always see all
`target_agents` values (they are privileged readers).

Per-row rationale:

- **planner** writes memories (long-term recall; survives compaction) but
  cannot create skills directly; skill authorship goes through the Manager
  (FA §5.5 Option B).
- **manager** is the broadest authoring role (FA §2.1: only the Manager sees
  full task-by-task stage arc) — owns stage-scoped records and may promote
  to project scope.
- **coder / researcher** are read-only; if they discover a fact they want
  saved, they signal it in their task report and the Manager records it
  (preserves invariant ownership).
- **data_agent** reads skills but not memories (data agents work in isolated
  data-pipeline contexts; project facts can mislead).
- **inspector** is the audit/repair role; needs full read + write to mark
  things stale, archive, supersede.
- **reviewer** is read-only by design (its job is judgment, not writing).
- **designer** is read-only (today's runtime accidentally grants
  `create_skill`; FR-31e(i) regression test pins the new denial).
- **chat** writes skills only (so the user can say "remember that we use 4-
  space indents" → a session- or project-scoped skill); cannot write memories
  (those are derived from agent execution, not from chat).

---

## G. Decay and freshness

### G.1 TTL defaults

| Scope     | Default `ttl_ms` | Default `expires_at` | Override allowed |
|-----------|------------------|----------------------|------------------|
| `project` | none (∞)         | none                 | Yes              |
| `stage`   | none (∞ within stage; archived on stage end via scope hook, not TTL) | none | TTL ignored on stage scope |
| `session` | none (archived on channel close) | none | TTL ignored |

For `project` scope, authors typically set `ttl_ms` when the fact is
inherently time-bound ("CI quota resets at end of month").

### G.2 Sweeper trigger

**Pick: on-load.** When the loader is invoked (agent construction OR an
on-demand `list_*` / `search_*` call), it lazily checks `expires_at` /
`ttl_ms` on touched records and transitions them to `expired` in-place
(audit-logged). No separate cron, no on-write sweep. Rationale: cheapest
implementation, no background process, lazy-eviction is sufficient for
record counts in the hundreds.

### G.3 Stale-evidence flow

- Inspector calls `list_memories({ older_than_days: N })` (FR-19).
- Returned list shows last-update age plus `source_ref` if any.
- For each candidate, Inspector decides: `archive_memory` (no longer true),
  `update_memory` (refresh body + bump `updated_at` + audit-reason),
  `supersede_memory` (replaced by a newer formulation), or leave alone.
- A `stale_review_at` field is **not** added; the audit entry serves as the
  "reviewed" signal.
- Planner sees expired memories in `list_memories({ include_archived: true })`
  for retrospective audit only.

### G.4 Contradiction handling

**Pick: explicit supersession only.** No `override` boolean. If a new
record contradicts an active one, the author MUST call `supersede_*`. The
runtime rejects a `create_*` that produces a same-`topic` collision (for
memories) or same-`name`-within-scope collision (for skills) with an error
pointing at the existing record id. The author can then choose to
supersede, update, or pick a different topic/name.

---

## H. User-visible surfaces

### H.1 Chat commands (FR-22)

| Command                       | Input                                     | Output |
|-------------------------------|-------------------------------------------|--------|
| `/skills list`                | optional `scope` filter                   | Markdown table of skill summaries (name, scope, updated_at). |
| `/skills show <name-or-id>`   | identifier                                | Full skill body in fenced block. |
| `/memories list`              | optional `scope` / `domain` filter        | Markdown table (topic, scope, updated_at, source). |
| `/memories show <id-or-topic>`| `id` or `domain/subject[/aspect]`         | Full memory body. |
| `/memories search <query>`    | query string                              | Top 10 hits with snippets. |
| `/remember <text>`            | free text                                 | Routed to Planner; Planner decides whether to write a `project`-scoped memory or ack. |
| `/forget <id>`                | id                                        | Archives (not deletes) the record; requires user confirmation. |

These map onto the MCP tools above; the chat surface adds zero new
authoring paths.

### H.2 Web UI hook point

A future panel will read from a single backend endpoint
`GET /api/knowledge?kind=&scope=&include_archived=` that returns Zod-
validated summaries; this is the only Phase-B-required surface. The
endpoint is registered in the same web server module that currently
exposes `/api/notes` (no implementation in this phase; design is the
URL contract only).

### H.3 Git ergonomics

- `.saivage/skills/records/*.json`, `.saivage/skills/records/*.md`,
  `.saivage/skills/audit.jsonl`, `.saivage/skills/index.json` → **committed**.
- `.saivage/memory/records/*.json`, `.saivage/memory/audit.jsonl`,
  `.saivage/memory/index.json` → **committed** for `project` scope only.
- `.saivage/memory/records/<uuid>.json` where `scope=session` →
  **gitignored** (mirrors `tmp/chats/` policy).
- `.saivage/skills/records/<uuid>.json` where `scope=session` → gitignored
  (same reason; session skills are ephemeral user-pref captures).
- `stage`-scoped records are committed (they become history once the stage
  archives them, and the audit trail is the project's diary).

Typical commit diff shape:

```
A  .saivage/memory/records/9f3a-...-b1.json     (+ index.json entry)
M  .saivage/memory/index.json
A  .saivage/memory/audit.jsonl                  (+ one line)
```

---

## I. Test surface

Bulleted; Phase C turns these into a plan.

- **Unit — schema (FR-2,3,17,18):** `SkillRecord` / `MemoryRecord` Zod parse
  rejection table; status-transition guards; supersession-cycle rejection;
  TTL/expiry calculator.
- **Unit — store (FR-28):** `writeDoc` atomicity on tmp/rename failure;
  audit-log append survives partial last line; index projection rebuild from
  records dir.
- **Unit — loader (FR-10,11,12,15,24):** budget enforcement (count + token
  cap); scope filter (`project` vs `stage` vs `session`); `target_agents`
  filter; trigger scoring for `keyword:/tag:/agent:` only; built-in
  frontmatter walk in src-run AND tsup-bundled paths (FR-31a).
- **Unit — retrieval (FR-14):** `get_memory` by topic; supersession-chain
  walk; `search_memories` scoring and ordering; `older_than_days` filter
  (FR-19).
- **Integration — MCP surface (FR-6,7,8,30):** every new tool round-trips;
  `reason` is mandatory; unauthorized roles get descriptive errors
  (FR-31e(i)); deleted `memory.*` / `index.*` stubs return `unavailable`
  if any caller still references them (FR-31e(ii)).
- **Integration — concurrency (FR-29, FR-31g):** two parallel `create_memory`
  calls do not corrupt `index.json`; serialized via `writeDoc` mtime check
  + retry; conflicting same-id writes return explicit error.
- **Integration — secrets (FR-27, FR-31f):** `create_*` with provider-config
  / API-key-shaped body is rejected; no file written; audit log shows the
  rejection.
- **Agent-level — eager injection (FR-10,12):** construct each role with
  seeded records; assert the system prompt block contains exactly the
  expected ids, in expected order; assert `stage`-scoped record not injected
  in the next stage (FR-9).
- **Agent-level — Chat surfacing (FR-22):** `/memories list` over MCP from
  the Chat agent returns a non-empty list when records exist.
- **Agent-level — compaction (FR-15, FR-16):** force-trigger
  `compactConversation`; assert surviving-records block appears; assert
  `compaction_persist_memory` tool is offered; assert callback fires when
  the Planner uses it; assert no-op when the Planner declines.
- **Regression-pin (FR-31a-g):** every defect from FA §1 gets one test
  with the FR-31 letter as the test name suffix.
- **Boundary (FR-31 / §5.12):** seeded `plan-history.json` round-trip
  asserts which Planner-recovery fields are derived from history vs.
  surfaced from memory (no duplication).

---

## J. Migration / cutover

### J.1 DELETED (clean-architecture, no compat)

Files:
- `src/skills/loader.ts` — replaced by `src/knowledge/loader.ts`.
- `src/mcp/builtins.ts` blocks: `skillsHandler` (L1053-…), `memoryTools`
  stub (~L1139+), `indexTools` stub (~L1139+), and their service
  registrations at L1166-1168.
- `skills/coding/SKILL.md`, `skills/planning/SKILL.md`,
  `skills/research/SKILL.md`, `skills/mcp-authoring/SKILL.md` —
  **moved** to `saivage/skills/builtin/<name>/SKILL.md` (still YAML
  frontmatter; the loader walks `builtin/`).
- Any project-level `<project>/.saivage/skills/index.json` legacy file
  — none exists in the three reviewed deployments (FA §1.4); no
  conditional cleanup code.

Types (`src/types.ts` §10):
- `SkillEntrySchema`, `SkillIndexSchema`, `SkillMatchContext` (the latter
  moves to the new loader module with `tools` / `filePaths` removed).
- Any `MemoryEntrySchema` / `IndexEntrySchema` stubs.

MCP tools (deleted names): `memory_*` stubs (5+), `index_*` stubs (3+).
Existing `skills.*` names are reused but the contract is new (Section C.2).

Tests: every test currently asserting today's `create_skill` /
`update_skill` / `list_skills` / `read_skill` contract is deleted.
Replaced by the new-contract suites from Section I.

### J.2 What `saivage init` writes into a fresh `<project>/.saivage/`

```
.saivage/
├── skills/
│   ├── index.json              # { skills: [] }
│   ├── audit.jsonl             # empty file
│   └── records/                # empty dir
├── memory/
│   ├── index.json              # { memories: [], topic_map: {} }
│   ├── audit.jsonl             # empty file
│   └── records/                # empty dir
└── .gitignore                  # ignore session-scoped records glob
```

Built-in skills are **not copied** into the project; they are loaded from
the bundled `saivage/skills/builtin/` directory at construction time. A
project that wants to override a built-in writes a project-level skill of
the same `name` (project wins, mirrors today's precedence rule).

### J.3 Build-safe order

1. **Add new schemas** in `src/types.ts` (or new `src/knowledge/types.ts`):
   `SkillRecord`, `MemoryRecord`, `AuditEntry`. Old `SkillEntrySchema`
   stays — the build is green.
2. **Add new store helpers** in `src/knowledge/store.ts` (uses existing
   `store/documents.ts`). No call sites yet.
3. **Add new loader** in `src/knowledge/loader.ts` exposing
   `resolveEagerRecords`. Old `src/skills/loader.ts` still in use.
4. **Add new MCP service** `knowledge` (or split into `skills` + `memory`)
   registered in `src/mcp/builtins.ts` alongside the old `skills` service.
   Old `skills` handler still callable.
5. **Update `BaseAgent` constructor** to call the new loader and format the
   new injected block. Old code path stays under a runtime flag for one
   step (flag default off → old path; tests flip it on).
6. **Switch the flag default** to the new path; run full suite; fix.
7. **Delete** `src/skills/loader.ts` and the old `skillsHandler`,
   `memoryTools`, `indexTools` blocks in `builtins.ts`.
8. **Delete** the runtime flag and the old-path branches.
9. **Delete** `SkillEntrySchema` / `SkillIndexSchema` from `src/types.ts`
   and any leftover imports.
10. **Move** built-in skill markdowns into `saivage/skills/builtin/`;
    update `tsup.config.ts` to bundle that directory next to `dist/`.

Between any two consecutive steps the codebase compiles and the existing
test suite (minus the deleted-asserts) passes.

---

## K. Risks and rejected alternatives

- **Two subsystems vs one (A):** considered one unified `records` table,
  rejected because skill vs memory retrieval modes diverge and unification
  pushes filtering to every call site.
- **Memory retrieval (D.3):** considered LLM-side `list+pick` (5.2 Option
  C), rejected as token-expensive at scale; topic-key + keyword search is
  cheaper and deterministic.
- **Trigger fate (D.4):** considered wiring `tool:` / `path:` at call
  sites, rejected because no concrete use case justifies the agent-file
  churn; on-demand search covers the path-aware case.
- **Storage layout (B.4):** considered JSONL-only, rejected for poor
  `cat`/`grep` ergonomics on the record corpus; kept JSONL only for the
  audit trail.
- **Built-in distribution (B.4):** considered shipping an `index.json`
  alongside markdowns (5.8 Option A), rejected because dual format remains
  a perennial drift source; frontmatter walk is single source of truth.
- **Authoring rights (F):** considered "all authoring agents at all
  scopes" (5.5 Option A), rejected because Coder-written `project`
  memories contradict Planner ones unpredictably.
- **Conflict handling (G.4):** considered an `override` field, rejected
  because it silently licenses contradiction; explicit supersession
  enforces a decision.
- **Decay sweeper (G.2):** considered on-write sweeping, rejected because
  it triples write latency for negligible benefit at our scale; on-load
  is lazy enough.
- **Web UI (H.2):** considered designing the panel now, deferred because
  FR-22 is testable via chat commands alone.
- **Cross-agent visibility (F):** considered hard ACL (5.10 Option B),
  rejected because it breaks Inspector audit and Chat surfacing.
- **NoteManager fold-in:** considered unifying notes with memory (3-way
  unification), rejected per OOS-10 — different trust boundary, different
  invariants.

---

## L. FR coverage matrix

| FR    | Satisfied by section(s)          | Notes |
|-------|----------------------------------|-------|
| FR-1  | B.1, B.4, J.2                    | All state under `<project>/.saivage/`; JSON + JSONL; `writeDoc` used. |
| FR-2  | B.1                              | `RecordBase` mandates `id, kind, scope, timestamps, author_agent, source`. |
| FR-3  | B.1, B.2                         | Lifecycle states + transition table. |
| FR-4  | B.3                              | Three scopes; user-wide REJECTED per §5.4. |
| FR-5  | B.4, J.2                         | Single per-project tree; no global registry. |
| FR-6  | C.1, F                           | Per-role MCP write tools; matrix enforced. |
| FR-7  | C.1, B.1 (AuditEntry)            | Every mutation appends audit. |
| FR-8  | C.1, G.4                         | `create_*` rejects unmatchable (skills require triggers; memories addressable by topic). |
| FR-9  | B.2, B.3, C.1                    | Stage scope auto-archived on stage terminal. |
| FR-10 | D.1, D.3, C.1                    | Eager + on-demand both wired. |
| FR-11 | D.2                              | Token budget enforced in `BaseAgent`. |
| FR-12 | D.1, D.5                         | `scope_tags` (as `keys`/`tag:` triggers) + `target_agents` both filter. |
| FR-13 | D.4                              | `tool:` / `path:` removed from schema. |
| FR-14 | D.3                              | Exact-key (`get_memory({topic})`) + keyword `search_memories`. |
| FR-15 | E.1                              | `survive_compaction: true` records re-injected after compaction. |
| FR-16 | E.2                              | `compaction_persist_memory` synthesized tool. |
| FR-17 | B.1, G.1, G.2                    | `expires_at` / `ttl_ms`; on-load sweeper. |
| FR-18 | B.1 (supersedes), B.5, G.4       | `supersede_*` MCP calls; chain walk default-head-only. |
| FR-19 | C.1, G.3                         | `list_memories({older_than_days})`. |
| FR-20 | B.4, H.3                         | Markdown bodies, JSON records, `cat`/`grep`-friendly. |
| FR-21 | H.3                              | Per-scope gitignore policy. |
| FR-22 | H.1                              | Chat commands enumerate records; web UI deferred. |
| FR-23 | J.2                              | No migrator; fresh init writes empty trees. |
| FR-24 | B.4, D.1, J.3 step 10            | Frontmatter walk works in src-run + tsup bundle. |
| FR-25 | C.1, D.1, D.3                    | All authoring/retrieval are pure file/IO; no LLM dep. |
| FR-26 | I (unit + integration without MCP) | Loader/store unit-testable in isolation. |
| FR-27 | C.1 (validation note), I (FR-31f test) | Secret-detection at write; redaction at read. |
| FR-28 | C.1, J.3 step 2                  | All writes through `writeDoc`. |
| FR-29 | C.1 (note), I (FR-31g test)      | mtime/ETag check in `writeDoc`; explicit conflict error. |
| FR-30 | C.1, B.2                         | `archive_*` reversible, `delete_*` terminal. |
| FR-31a | I, J.3 step 10                  | Built-in load test for src + dist. |
| FR-31b | C.1, I                          | Unmatchable-record prevention test. |
| FR-31c | C.1, I                          | `update_*` refreshes `updated_at` + audit `reason`. |
| FR-31d | C.1 (`read_skill` honours `body_path`), I | Non-default body path readable. |
| FR-31e(i) | F, I                         | Manager/Designer/Chat skill-write filtering test. |
| FR-31e(ii) | J.1, I                      | Deleted `memory.*` / `index.*` stubs unreachable test. |
| FR-31f | C.1, I                          | Secret-rejection test. |
| FR-31g | C.1, I                          | Concurrent-write test. |

**No FR is REJECTED.** All thirty-one (plus seven sub-items) are satisfied
by at least one section of this design.
