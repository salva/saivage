# Saivage v2 — Skill + Memory: Design

Status: DRAFT (Phase B, round 3)
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

- Surfacing modes differ: skills want eager system-prompt injection;
  memories want on-demand lookup. A `kind` discriminator buys little
  beyond a flat namespace and forces every retrieval site to filter.
- Authoring ergonomics differ: skills need `triggers` + `target_agents`;
  memories need `topic` + `keys`. Combining yields a wide schema with
  half the fields null per row.
- MCP namespace already separates `skills` from `memory` (FA §1.2, §1.5.5).
- Inspector/Chat audit story is cleaner with independent enumeration.
- Failure containment: a broken memory does not poison skill loading.
- Built-in distribution differs (skills ship as defaults; memories never).

**Why not three (skill/memory/note unified):** notes are user→planner
injection with a different trust boundary (user-authored, must survive
compaction explicitly via `permanent`). Unifying breaks the user-vs-agent
distinction.

### A.1 Open-question dispositions (FA §§5.1–5.12)

| OQ | Decision | Rationale (1 sentence) |
|----|----------|------------------------|
| 5.1 one feature or two | **Two** subsystems on shared primitives | Diverge on surfacing + authoring; shared store is enough. |
| 5.2 memory retrieval | **Topic key + keyword search** (hybrid A+B) | Authors get cheap exact lookup; on-demand keyword grep covers the unkeyed case. |
| 5.3 trigger system | **Keep for skills, drop for memory; remove dead `tool:` and `path:`** | `tool:` and `path:` are dead today (FA §1.3); clean-architecture rule forbids keeping unwired schema. |
| 5.4 user-supplied prefs | **Out of scope** (Option C) | Ground-rule 3 forbids `~/.saivage`; no virtual host scope. |
| 5.5 authoring rights | **Scope-restricted** (Option B) — every FR-6 role can author; workers (Coder/Researcher) are bounded to `stage`-scoped memories only | Honors FA FR-6 (Planner/Manager/Coder/Researcher/Inspector); promotion to `project` is reserved to Planner/Manager/Inspector (the roles with cross-stage view). |
| 5.6 conflict handling | **Explicit supersession only** (Option B) | Reproducible; eliminates "last write wins" surprises. |
| 5.7 storage layout | **One JSON per record + append-only `audit.jsonl`** | Mirrors `notes/<id>.json`; audit log is naturally append-only. |
| 5.8 built-in distribution | **Loader walks directory, parses YAML frontmatter** (Option B) | Removes dual-format defect (FA §1.4, §1.5.1) and the `index.json`-next-to-`dist/` production bug. |
| 5.9 web UI / chat | **Chat commands now; web UI deferred to one hook point** | FR-22 is the testable requirement; UI is later work. |
| 5.10 cross-agent visibility | **Inspector + Chat always readers; others honour `target_agents`** (Option C) | Matches Inspector's audit posture and Chat's user-facing role. |
| 5.11 inspections relation | **Inspection → memory by reference** (Option A) | Preserves both lifecycles; no schema conflation. |
| 5.12 compaction sufficiency | **Memory carries only what embedded plan history cannot** (Option A) | No duplication; FR-31 pins the boundary test. |

---

## B. Data model

### B.1 Schemas (Zod-style pseudocode)

```ts
const RecordBase = z.object({
  id: z.string().uuid(),
  kind: z.enum(["skill", "memory"]),
  scope: z.enum(["project", "stage", "session"]),
  status: z.enum(["active", "superseded", "archived", "expired"]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  author_agent: z.object({ role: AgentRoleSchema, agent_id: z.string() }),
  source: z.object({ stage_id: z.string().optional(), task_id: z.string().optional() }).optional(),
  scope_ref: z.string().optional(),   // REQUIRED for stage|session (refinement below)
  expires_at: z.string().datetime().optional(),
  ttl_ms: z.number().int().positive().optional(),
  supersedes: z.string().uuid().optional(),
  superseded_by: z.string().uuid().optional(),
  relates_to: z.array(z.string().uuid()).default([]),
  survive_compaction: z.boolean().default(false),
}).refine(
  r => r.scope === "project" || (typeof r.scope_ref === "string" && r.scope_ref.length > 0),
  { message: "scope_ref is required when scope is 'stage' or 'session'" },
);

const SkillRecord = RecordBase.extend({
  kind: z.literal("skill"),
  origin: z.enum(["builtin", "project"]).default("project"),
  name: z.string().min(1),            // unique within (scope, scope_ref)
  description: z.string(),
  triggers: z.array(z.string()).default([]),  // OPTIONAL (FR-8); empty ⇒ search-only
  target_agents: z.array(AgentRoleSchema).default([]),
  body_path: z.string(),
});

const MemoryRecord = RecordBase.extend({
  kind: z.literal("memory"),
  topic: z.object({
    domain: z.string(), subject: z.string(), aspect: z.string().optional(),
  }),
  keys: z.array(z.string()).default([]),
  target_agents: z.array(AgentRoleSchema).default([]),
  body: z.string(),
  source_ref: z.object({
    kind: z.enum(["inspection", "task_report", "stage_summary"]),
    id: z.string(),
  }).optional(),
});

// One JSONL line per write attempt (incl. rejections) at <scope-tree>/audit.jsonl.
const AuditEntry = z.object({
  ts: z.string().datetime(),
  record_id: z.string().uuid(),
  op: z.enum(["create", "update", "supersede", "archive", "unarchive", "delete", "expire"]),
  outcome: z.enum(["ok", "rejected"]).default("ok"),
  error_code: z.string().optional(),
  author_agent: z.object({ role: AgentRoleSchema, agent_id: z.string() }),
  reason: z.string(),
  prev_status: z.string().optional(),
  next_status: z.string().optional(),
  content_hash_before: z.string().optional(),
  content_hash_after: z.string().optional(),
});
```

`origin` is on `SkillRecord` only (built-in memories are OOS per FA §6
OOS-3) and is independent of `scope`. The scope/scope_ref refinement is
authoritative — the on-disk layout (§B.4) mirrors it.

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

Scope is enforced **both** in the on-disk path (§B.4: `project/`, `stages/<id>/`,
`sessions/<id>/` subtrees) **and** in the Zod refinement on `(scope, scope_ref)`.
Lifecycle hooks (stage-terminal archive, channel-close archive) operate on the
relevant subtree by directory walk — they do not have to scan record bodies.
Misfiled records (wrong directory for declared scope) are rejected at write
time by the knowledge-store layer (§C.3).

### B.4 On-disk layout under `<project>/.saivage/`

Scope lives in the path. Each scope tree is self-contained (its own
`index.json`, `audit.jsonl`, and `records/`), which makes lifecycle archival
and gitignore policy trivial directory operations.

```
.saivage/
├── skills/
│   ├── project/
│   │   ├── index.json          # { skills: [SkillRecord summary] }
│   │   ├── audit.jsonl         # append-only, one JSON line per attempt
│   │   └── records/
│   │       ├── <uuid>.json     # one SkillRecord per file
│   │       └── <uuid>.md       # body referenced by SkillRecord.body_path
│   ├── stages/<stage_id>/{index.json, audit.jsonl, records/}
│   └── sessions/<channel_id>/{index.json, audit.jsonl, records/}
├── memory/
│   ├── project/{index.json, audit.jsonl, records/<uuid>.json}
│   ├── stages/<stage_id>/{index.json, audit.jsonl, records/}
│   └── sessions/<channel_id>/{index.json, audit.jsonl, records/}
```

Memory bodies are inline (no separate `.md`). Built-in skills ship at
`saivage/skills/builtin/<name>/SKILL.md` (YAML frontmatter; no
`index.json`) and are bundled into `dist/skills/builtin/` by `tsup`
(FR-24); they have `origin="builtin"`, `scope="project"` and live
outside `<project>/.saivage/`.

**Path ↔ scope mapping (storage invariant).**

| `scope`   | Storage subtree                                      |
|-----------|------------------------------------------------------|
| `project` | `<kind>/project/`                                    |
| `stage`   | `<kind>/stages/<scope_ref>/` (scope_ref = stage_id)  |
| `session` | `<kind>/sessions/<scope_ref>/` (scope_ref = channel) |

The store layer (§C.3 `writeRecordAtomic`) rejects any record whose
declared `(scope, scope_ref)` does not match its target path.

**Layout justification.** One file per record (Option A) for both kinds;
per-scope `index.json` (rebuilt on every write) + append-only
`audit.jsonl`. Per-record files preserve current `notes/<id>.json`
ergonomics (git diff, `cat`, `rm`). Scope-rooted tree makes
stage-terminal archival a directory walk and session gitignore (§H.3)
a single glob — not a content rule. `index.json` is derivable (torn
writes fixable by `rebuildIndex`, §C.3). Audit is POSIX `O_APPEND`
(§C.3 `appendJsonlAtomic`) and tolerates partial last lines on read.

### B.5 Record cross-references

| Relation        | Direction | Allowed combos                          | Rules |
|-----------------|-----------|-----------------------------------------|-------|
| `supersedes`    | new → old | same-kind, scope-pair in table below      | Sets new.supersedes = old.id and old.superseded_by = new.id atomically. |
| `superseded_by` | old → new | reverse of above                        | Read-only mirror; not directly writable. |
| `relates_to`    | symmetric | skill↔skill, memory↔memory, skill↔memory | Free-form association; no lifecycle effect. |
| `source_ref`    | memory → external | memory → {inspection, task_report, stage_summary} | Drives §5.11 inspection-to-memory bridge. |

**Allowed supersession pairs `(old.scope → new.scope)`.** Scope cannot narrow:
the replacement must live at the same scope or wider so the supersession is
visible to every reader who could see the old record.

| old.scope ↓ / new.scope → | `project` | `stage` (same scope_ref) | `session` (same scope_ref) |
|---------------------------|-----------|--------------------------|----------------------------|
| `project`                 | YES       | NO                       | NO                         |
| `stage`                   | YES       | YES                      | NO                         |
| `session`                 | YES       | NO                       | YES                        |

A `stage`-scoped record can be **promoted** to `project` by supersession
(this is how a one-stage finding becomes a project-wide lesson).
Cross-stage or cross-session supersession is rejected
(`INVALID_SUPERSEDE_SCOPE`). A `supersede_*` on an already-superseded
record is rejected (must supersede the chain head). `relates_to` is
bounded at 16 entries per record (cheap defensive cap).

---

## C. MCP authoring surface

### C.1 New tools

Roles abbreviated: Pl=planner, Mg=manager, Co=coder, Re=researcher, Da=data_agent,
In=inspector, Rv=reviewer, De=designer, Ch=chat.

| Tool                  | Input fields                                                                                                | Output                  | Callable by | FRs |
|-----------------------|-------------------------------------------------------------------------------------------------------------|-------------------------|-------------|-----|
| `create_skill`        | `{ name, description, body, triggers[]?, target_agents[], scope, scope_ref?, expires_at?, ttl_ms?, survive_compaction?, reason }` | `{ id, status }`        | Mg, In      | FR-6,7,8 |
| `update_skill`        | `{ id, body?, description?, triggers?, target_agents?, expires_at?, ttl_ms?, reason }`                       | `{ id, updated_at }`    | Mg, In      | FR-7 |
| `supersede_skill`     | `{ old_id, new_record, reason }` (new_record same shape as `create_skill`)                                   | `{ new_id, old_id }`    | Mg, In      | FR-18 |
| `archive_skill`       | `{ id, reason }`                                                                                            | `{ id, status }`        | Mg, In      | FR-30 |
| `delete_skill`        | `{ id, reason }`                                                                                            | `{ id }`                | Mg, In      | FR-30 |
| `list_skills`         | `{ scope?, target_agent?, include_archived?, include_superseded? }`                                          | `[SkillRecord summary]` | all roles   | FR-10,22 |
| `read_skill`          | `{ id }`                                                                                                     | `{ record, body }`      | all roles   | FR-10,FR-31d |
| `search_skills`       | `{ query, scope?, limit? }` (keyword over body+description+triggers)                                         | `[{id,score,snippet}]`  | all roles   | FR-14 |
| `create_memory`       | `{ topic, keys[]?, body, target_agents[], scope, scope_ref?, expires_at?, ttl_ms?, survive_compaction?, source_ref?, reason }` | `{ id, status }`        | Pl, Mg, Co, Re, In | FR-6,7,8 |
| `update_memory`       | `{ id, body?, keys?, target_agents?, expires_at?, ttl_ms?, reason }`                                         | `{ id, updated_at }`    | Pl, Mg, Co, Re, In | FR-7 |
| `supersede_memory`    | `{ old_id, new_record, reason }`                                                                            | `{ new_id, old_id }`    | Pl, Mg, In  | FR-18 |
| `archive_memory`      | `{ id, reason }`                                                                                            | `{ id, status }`        | Pl, Mg, In  | FR-30 |
| `delete_memory`       | `{ id, reason }`                                                                                            | `{ id }`                | Pl, Mg, In  | FR-30 |
| `list_memories`       | `{ scope?, topic_domain?, include_archived?, older_than_days? }`                                             | `[MemoryRecord summary]`| Pl,Mg,In,Rv,Ch | FR-10,FR-19,FR-22 |
| `get_memory`          | `{ id }` OR `{ topic: {domain, subject, aspect?} }`                                                          | `MemoryRecord`          | all roles except Da | FR-14 |
| `search_memories`     | `{ query, scope?, limit? }` (keyword over body + keys + topic flattened)                                     | `[{id,score,snippet}]`  | all roles except Da | FR-14 |

Notes:
- **FR-8 (triggerless):** `triggers` is OPTIONAL on `create_skill`,
  defaults `[]`. Triggerless skills are never eager-injected but are
  findable via `search_skills` (keyword over name/description/body per
  §D.3) and `read_skill` by id — closes FA §1.5.2 dead-record path.
- **FR-6 worker scope:** `Co`/`Re` may call
  `create_memory`/`update_memory` ONLY with `scope == "stage"` and
  `scope_ref = current stage_id`; otherwise `UNAUTHORIZED_SCOPE`.
  Promotion to `project` requires Pl/Mg/In `supersede_memory`. Workers
  never author/modify skills (Mg/In only; rationale §F).
- **Chat has no write tools.** `/remember <text>` is an inter-agent
  message to Planner (§H.1); Planner decides whether to call
  `create_memory` (closes spot-check FAIL `chat/create-S`).
- All write tools require non-empty `reason` (`EMPTY_REASON` on violation).
- All writes route through `writeRecordAtomic` and append one
  `AuditEntry` via `appendJsonlAtomic` (§C.3, FR-28/FR-29).
- `older_than_days` on `list_memories` serves Inspector enumeration (FR-19).
- The 16 tools share one store/permission engine
  (`src/knowledge/store.ts` + `src/knowledge/permissions.ts`); per-kind
  handlers are 5–10-line adapters — no duplicated lifecycle logic.

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

### C.3 Knowledge-store primitives, error taxonomy, and secrets

The MCP tool surface is a thin facade over `src/knowledge/store.ts`. Three
primitives, all implemented in Phase C:

- **`writeRecordAtomic(dir, id, schema, data)`** — wraps `writeDoc`
  (`src/store/documents.ts`: tmp + `fsync` + rename + parent `fsync`,
  POSIX-atomic per record). Adds: pre-write `(scope, scope_ref)` vs `dir`
  coherence (mismatch → `INVALID_SCOPE_REF`); pre-write secret scan
  (match → `SECRET_DETECTED` + `rejected` audit). No mtime/CAS check —
  serialization is provided by the per-record mutex below, not by a
  stat-before-rename window (TOCTOU-prone, removed in round 3).
- **`appendJsonlAtomic(path, line)`** — POSIX `O_APPEND|O_CREAT`, single
  `writeSync` + `fsyncSync` + close. POSIX guarantees concurrent
  `O_APPEND` writes shorter than `PIPE_BUF` (4096 B on Linux) are atomic.
  Single audit entries are hard-capped at 2048 B by the writer (`reason`
  truncated with `…[truncated]` suffix if needed) so the guarantee always
  holds. Reader tolerates a truncated trailing line.
- **`rebuildIndex(scopeDir, schema)`** — deterministic scan of
  `records/*.json`, validate, project to summaries, write via
  `writeRecordAtomic`. Idempotent. Triggered on every mutating call AND
  on load when the parsed index disagrees with records dir (cheap O(N)
  hash compare).

**Transaction order (every write):** (1) Validate (Zod + secrets + scope
coherence); (2) `writeRecordAtomic` record JSON (and skill body `.md`);
(3) `appendJsonlAtomic` one `AuditEntry` `outcome="ok"`;
(4) `rebuildIndex` (or incremental; rebuild is safe fallback). Step-2
fail → nothing written, audit `outcome="rejected"`. Step-3 fail
post-step-2 → warn; next loader detects missing line and re-emits
(records are source of truth). Step-4 fail → next loader rebuilds.

**Concurrency model (FR-29) — single-writer invariant.** Saivage runs
as one Node process per project; child agents are in-process `Agent`
instances spawned via `Dispatcher.childSpawner`
(`src/runtime/dispatcher.ts:64-74,239`, registered in
`src/agents/base.ts:177-178`), never forked OS processes. Every
knowledge-store mutation flows through an MCP tool call
(`src/mcp/runtime.ts`), executed inside the same event loop. There is
therefore exactly one writer process per `.saivage/` tree, and the only
concurrency we must serialize is overlapping async tool invocations
within that process.

`src/knowledge/store.ts` owns a module-scoped
`Map<string, Promise<void>>` keyed by record id
(`<kind>:<scope>:<scope_ref|_>:<id>`). Every `writeRecordAtomic` call
(`create_*`, `update_*`, `archive_*`, `delete_*`, sweeper expiry) chains
its work onto the existing promise for that key and replaces the map
entry, releasing it in `finally`. Under this lock, the operation runs
Validate → write record JSON → append audit → rebuild-index serially;
two overlapping `update_memory` calls for the same id therefore execute
in arrival order with no overwrite, no `STALE_WRITE`, and no retry
loop. `create_*` keys on the freshly minted UUID, so collision is
statistically impossible and the lock is essentially uncontended.

**`supersede_*` two-record atomicity.** Supersession mutates the OLD
record (`superseded_by = new.id`, `status = "superseded"`) and writes
the NEW record. Both writes happen under a **two-key lock** acquired in
deterministic order (lexicographic by lock-key) to prevent deadlock
with another supersede pair. Sequence inside the lock:
(1) re-read OLD, refuse if its `status != "active"`
    (`INVALID_SUPERSEDE_TARGET`);
(2) `writeRecordAtomic` NEW record JSON (and skill body `.md`);
(3) `writeRecordAtomic` updated OLD record JSON;
(4) `appendJsonlAtomic` ONE `AuditEntry` with `op="supersede"`,
    `record_id = new.id`, `reason` mentioning `old_id`;
(5) `rebuildIndex`.
Step-3 fail → roll back step 2 (`unlink` NEW record + body), append
`rejected` audit, surface error. Step-4 fail → re-attempt append on
next loader pass (records are source of truth; loader re-emits a
`supersede` line if it observes the link without a matching audit
entry). Either OLD-then-NEW or NEW-then-OLD partial states are
recoverable: loader rule is "if NEW.supersedes points to OLD but
OLD.superseded_by is unset, patch OLD on next mutating access".

**Cross-process concurrency is an explicit non-goal** (see §K).
Running two `saivage` instances against the same `.saivage/` is
unsupported; the per-record in-memory mutex obviously does not protect
against that case. A future need for multi-process safety would add
advisory `flock(2)` on the per-scope `audit.jsonl` as a coarse gate;
out of scope for Phase B.

**Error taxonomy (every MCP tool returns one of):**

| Code                       | Trigger                                              | Audit `rejected`? |
|----------------------------|------------------------------------------------------|-------------------|
| `UNAUTHORIZED_ROLE`        | Role not in tool's ACL (§F)                          | no                |
| `UNAUTHORIZED_SCOPE`       | Worker writes with `scope != "stage"`                | yes               |
| `NOT_FOUND`                | `id` does not resolve                                | no                |
| `EMPTY_REASON`             | `reason` missing or whitespace-only                  | no                |
| `INVALID_SCOPE_REF`        | `scope_ref` missing for stage|session, or path mismatch | yes            |
| `INVALID_SUPERSEDE_TARGET` | `supersede_*` target not `active` (re-read under lock) | yes             |
| `TOPIC_COLLISION`          | `create_memory` topic already active in scope        | yes               |
| `NAME_COLLISION`           | `create_skill` name already active in scope          | yes               |
| `INVALID_SUPERSEDE_SCOPE`  | Scope pair not in §B.5 allowed table                  | yes               |
| `SECRET_DETECTED`          | Body/topic/keys/reason matches secret heuristic      | yes               |
| `BLOCKED_PATH`             | `body_path`/`source_ref` in blocked path             | yes               |
| `BODY_PATH_BROKEN`         | `read_skill` finds `body_path` missing               | no                |
| `OVERSIZED_SURVIVOR`       | Survivor exceeds survivor hard cap (§D.2)            | yes (write) / warn (load) |
| `MALFORMED_AUDIT_LINE`     | Loader hits unparseable audit line (skip + warn)     | no                |
| `INDEX_REBUILD_FAILED`     | `rebuildIndex` write failed                          | no                |

`delete_*` succeeds if record exists (no mtime check; tombstone + audit).
Errors return as MCP `error.code` + human message; tests assert on `code`.

**Security — secret handling (FR-27).** All write-time content (record
`body`, `body_path` file contents at creation, `reason`, flattened
`topic.*`, `keys[]`) is scanned by `src/security/secrets.ts` (new module,
shared with `fsGuard` and chat-attachment pipeline). Heuristics: provider
shapes (`sk-…{20,}`, `ghp_…`, `ya29.…`, `AKIA[0-9A-Z]{16}`, JWT triple);
env-style assignments `[A-Z][A-Z0-9_]{4,}=value{20,}` where Shannon
entropy > 3.5 bits/char; literal markers (`auth-profiles.json`,
`BEGIN (RSA|OPENSSH|EC) PRIVATE KEY`, `aws_secret_access_key`,
`client_secret`). **Blocked source paths** (rejected with `BLOCKED_PATH`
even if missing): `.saivage/auth-profiles.json`, `.saivage/*-credentials.json`,
`.saivage/*provider*.json`, any `.env*` at project root or under `secrets/`,
`~/.bash_history`, `~/.zsh_history`.

**Write-time:** `SECRET_DETECTED` / `BLOCKED_PATH` reject the write,
append a `rejected` audit entry (offending field name but NOT the
matched value), return MCP error. Reason string MUST NOT echo the
match (ground-rule 3). **Read-time:** `read_skill`, `get_memory`, and
`search_*` snippet builders re-scan bodies (cheap; bodies are short) and
substitute matches with `[REDACTED]`, adding `redacted_spans: number` to
the response. `list_*` returns only summaries (already scanned at write
time, by construction). Heuristics are unit-tested with synthetic
fixtures only — no real secrets in the suite.

---

## D. Retrieval and surfacing

### D.1 Eager-injection algorithm (replaces `scoreTriggers` in `loader.ts`)

```
resolveEagerRecords(ctx, projectDir, budget):
  candidates = []
  # Skills: built-ins (frontmatter walk) + project + stage + session.
  for entry in walkBuiltinSkills(distOrSrcSkillsDir):
    candidates += projectAsSkillRecord(entry, origin="builtin", scope="project")
  for tree in ["skills/project", "skills/stages/"+ctx.stage_id?,
               "skills/sessions/"+ctx.channel_id?]:
    candidates += readSkillIndex(projectDir/tree/"index.json")
  # Memories opted into eager surfacing via target_agents.
  for tree in ["memory/project", "memory/stages/"+ctx.stage_id?,
               "memory/sessions/"+ctx.channel_id?]:
    for record in readMemoryIndex(projectDir/tree/"index.json"):
      if record.target_agents.length > 0: candidates += record

  eligible = candidates.filter(r =>
    r.status == "active" &&
    (r.target_agents.length == 0 || r.target_agents.includes(ctx.agentRole))
  )

  # Triggerless skills (FR-8) score 0 → fall through to search-only.
  for r in eligible:
    if r.kind == "skill":
      r.score = (r.triggers.length == 0) ? 0 : scoreSkillTriggers(r.triggers, ctx)
    else:
      r.score = 1
    if r.score == 0: drop r

  sort(eligible, by: [originPrecedence(project > builtin), -score, -updated_at, id])
  return splitByBudget(eligible, budget)   # see §D.2 two-phase
```

`scoreSkillTriggers` supports **only** `keyword:`/`tag:`/`agent:`.
`tool:`/`path:` are removed from `SkillRecord.triggers` validation
(write-time rejection); loader ignores leftovers defensively.

### D.2 Budget mechanism (FR-11)

Two sub-budgets, not one cap. The eager block is **survivor reinjection**
+ **ordinary eager records**.

- **Survivor sub-budget (always-on, summary form).** Records with
  `survive_compaction == true` (skills + project-scoped memories) are
  ALWAYS included as one-line summaries (`description` for skills; first
  200 chars of `body` for memories). No token cap — FR-15 contract.
  Per-record hard ceiling 4096 tokens (post-summarization). **Write-time
  refusal:** `create_*` / `update_*` reject any record whose summarized
  body would exceed the ceiling (`OVERSIZED_SURVIVOR` + `rejected`
  audit). **Load-time quarantine:** a record that exceeds the ceiling at
  load time (manually corrupted on disk) is skipped from the survivor
  block but its id is listed in the injection header
  `oversized_survivors: [<id>, …]` so the agent can still reach it via
  `read_skill` / `get_memory`. One testable behavior per surface.
- **Ordinary eager sub-budget (token cap).** Other eligible records use
  `length / 4` token estimation (matches `compaction.ts` `estimateTokens`).
  Default 2048 tokens/agent, configurable via
  `ctx.project.config.skills.eager_budget_tokens`. Appended in rank order;
  next-record overflow → dropped (not truncated) AND its id is listed in
  the header `omitted: […]` so the agent can `read_skill`/`get_memory` on
  demand. Closes the silent-drop defect.
- **Enforcement.** `BaseAgent` ctor: after
  `resolveEagerRecords → {survivors, ordinary, omitted}`, block =
  `survivors` (unconditional) + `ordinary` (rank order); `omitted` echoed
  in header.

Resolves blocking-issue-6: survivors always reinjected (FR-15), ordinary
content bounded (FR-11), any omission visible.

### D.3 On-demand pull (FR-14)

**Canonical normalization (universal).** Query and indexed text are both:
NFC unicode normalize → lowercase → strip ASCII punctuation `[^\w\s]`
(replace with space) → collapse whitespace → split on whitespace. Match is
**exact token equality** after normalization (no substring, no stemming).
The `index.json` projection caches the first 500 chars of every record body
as `body_snippet` so `search_*` never reads body files on the hot path;
full bodies are loaded only by `read_skill` / `get_memory`.

`get_memory({topic})` algorithm:
1. Compute canonical key `domain/subject[/aspect]` (raw, not normalized —
   topic fields are exact identifiers).
2. Look up in the three scope indexes (`memory/project`,
   `memory/stages/<ctx.stage_id>`, `memory/sessions/<ctx.channel_id>`); the
   first match wins, project last (most specific wins for retrieval).
3. Walk supersession chain to head; return current head if `status == active`,
   else return `null` (caller may pass `include_history: true` to walk the
   chain).

`search_memories({query, scope?, limit=10})` algorithm:
1. Normalize `query` per canonical rules above.
2. For each non-archived non-expired memory in the in-scope `index.json`s,
   tokenize the indexed fields the same way and score = sum over query
   tokens of: 3·(token in normalized `topic.*`) + 2·(token in normalized
   `keys[]`) + 1·(token in normalized `body_snippet`).
3. Drop score 0. Sort by score desc, then `updated_at` desc, then `id` asc.
   Slice to `limit`.
4. Result shape: `[{ id, topic, score, snippet }]` where `snippet` is the
   200-char window around the first match in `body_snippet`.

`search_skills` is structurally identical, scoring over normalized
`triggers` + `name` + `description` + `body_snippet`. Triggerless skills
(FR-8) participate fully here; this is their primary retrieval path.

**Ordering rule (universal):** score desc → `updated_at` desc → `id` asc
(stable tie-break).

### D.4 Dead trigger fate (FR-13)

**Decision: remove from schema.** `tool:` and `path:` are deleted from
`SkillRecord.triggers` validation. The loader treats unknown forms as
no-ops defensively if any legacy record carries one.

**Justification (closes reviewer spot-check caveat):** all nine agents
build `SkillMatchContext` with at most `{agentRole, description, tags?}`
— none populates `tools` or `filePaths` (verified across
`src/agents/{coder,planner,manager,inspector,researcher,data-agent,
reviewer,designer,chat}.ts`; matches FA §1.3). Wiring would touch
schema, scoring, all nine agents, and `agents.test.ts` fixtures with
zero coverage and zero authoring use case. Notional coverage ("surface
skill when touching file X / using tool Y") is delivered by
`keyword:`/`tag:`/`agent:` triggers and on-demand search (§D.3).
Removal aligns trigger catalog with call-site reality (FR-13).

Agent-prompt one-liners (separate from trigger wiring): six agent
system prompts get a one-paragraph addition for on-demand memory pull:
`src/agents/{planner,manager,coder,researcher,inspector,chat}.ts`.
Reviewer/Designer/Data Agent unchanged this phase (workers; see §F).

### D.5 `scope_tags` vs `target_agents`

- `target_agents`: **role filter** for eager injection (and
  Inspector/Chat visibility hybrid, §5.10) — "should role R see this?"
  Empty = any role (today's default). Enforced at injection AND on
  on-demand read for worker roles (Coder/Researcher/Data
  Agent/Reviewer/Designer); Inspector and Chat bypass on read (§F).
- `scope_tags` (successor to flat `tags`; surfaces as `keys[]` for
  memories, `tag:<x>` triggers for skills): **content-overlap match**
  between record and task — "topically relevant to this task?" Empty
  keys / no `tag:` → not eager, still findable on demand.
- Stage/session scopes: `target_agents` is AND-ed with scope filter
  (e.g., stage-scoped + Coder = only Coders dispatched during that stage).

### D.6 Per-agent injected block format

Appended to the agent's static system prompt at construction (mirrors
today's `formatSkillsForPrompt`):

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

Header states budget usage; `(scope)` lets the LLM weight records.

---

## E. Compaction integration

### E.1 FR-15 re-injection

- **Which records:** all `active` records (skills + memories) with
  `scope == "project"` AND `survive_compaction == true`. Stage/session
  scopes do not survive.
- **Where:** **not** in `compaction.ts`. `BaseAgent` reinjects after
  `compactConversation` returns and before `replaceMessages`.
  `compaction.ts` stays a pure history→summary fn with no MCP / no role
  context / no store access — the requested architectural seam.
- **Procedure** (`reinjectSurvivors(projectDir, agentRole)` helper in
  `BaseAgent`): (1) post-`compactConversation`, resolve survivors via
  loader (same primitives as `resolveEagerRecords`, filter
  `survive_compaction && scope=="project"`); (2) build one appended
  user-role block (format below); (3) pass `[summary, survivorBlock]`
  to `replaceMessages`.
- **Block format** (separate `user` message after the summary):
  ```
  --- SURVIVING KNOWLEDGE (auto-reinjected after compaction #N) ---
  [SKILL coding-style] <one-line summary>
  [MEMORY build/web-app/command] <first 200 chars of body>
  ...
  oversized_survivors: []   # ids quarantined by load-time ceiling (§D.2)
  --- END SURVIVING KNOWLEDGE ---
  ```
  Full bodies via `read_skill` / `get_memory`. Survivor injection is
  unconditional per FR-15; eager token cap (§D.2) does NOT apply.

### E.2 FR-16 write hook

Planner may call `create_memory` (and `update_*`/`supersede_*`) as a
normal MCP tool at any time (in its ACL, §F). FR-16 is therefore a
single **prompt nudge**, not a synthesized tool. There is no
`compaction_persist_memory`. Everything goes through
`BaseAgent.executeToolCall` with full authorization and audit.

**Procedure** (`BaseAgent`, immediately before invoking compaction):
(1) When `shouldCompact(state) && role == Planner`, inject ONE
pre-compaction user-role message:
```
--- PRE-COMPACTION MEMORY HOOK (compaction #N about to occur) ---
The conversation history below is about to be summarized and discarded.
If there are durable lessons or facts worth keeping, call `create_memory`
(scope="project", survive_compaction=true) now. Multiple calls allowed.
Reply "DONE" when finished, or continue if there's nothing to persist.
Compaction proceeds either way.
--- END PRE-COMPACTION MEMORY HOOK ---
```
(2) Run the normal `executeToolCall` loop until Planner says "DONE",
emits a non-tool-call message, or hits the per-hook cap of 5 turns.
(3) `compactConversation` runs unmodified. Planner-emitted memories are
already on disk (sync); `reinjectSurvivors` picks any with
`survive_compaction==true`.
(4) Non-Planner agents skip the hook (FR-16 is Planner-only).

**Fallback:** no tool calls → nothing written, nothing logged beyond the
regular trace, compaction proceeds (identical to today's no-op).
**Test hook:** `BaseAgent` exposes
`onCompactionHookComplete?: (writeCount: number) => void`; the existing
`agents.test.ts` tool-call mock suffices. Closes blocking-issue-5: write
opportunity is at the orchestration boundary, uses existing tool-exec
architecture, Planner-gated, leaves `compaction.ts` pure.

---

## F. Permissions matrix

Rows: nine roles from FA §1.2.1. Columns: operations across both kinds
(skills and memories collapsed where identical; "S" / "M" suffix where they
differ). Cell legend: `Y` = allowed, `Y†` = allowed but restricted to
`scope=="stage"` (worker scope restriction, see notes), `—` = denied.

| Role        | create-S | create-M | read-S | read-M | supersede-S | supersede-M | archive-S | archive-M | search-S | search-M |
|-------------|----------|----------|--------|--------|-------------|-------------|-----------|-----------|----------|----------|
| planner     | —        | Y        | Y      | Y      | —           | Y           | —         | Y         | Y        | Y        |
| manager     | Y        | Y        | Y      | Y      | Y           | Y           | Y         | Y         | Y        | Y        |
| coder       | —        | Y†       | Y      | Y      | —           | —           | —         | —         | Y        | Y        |
| researcher  | —        | Y†       | Y      | Y      | —           | —           | —         | —         | Y        | Y        |
| data_agent  | —        | —        | Y      | —      | —           | —           | —         | —         | Y        | —        |
| inspector   | —        | Y        | Y      | Y      | Y           | Y           | Y         | Y         | Y        | Y        |
| reviewer    | —        | —        | Y      | Y      | —           | —           | —         | —         | Y        | Y        |
| designer    | —        | —        | Y      | Y      | —           | —           | —         | —         | Y        | Y        |
| chat        | —        | —        | Y      | Y      | —           | —           | —         | —         | Y        | Y        |

`delete-*` matches `archive-*`; `update-*` follows `create-*`.
Visibility (§5.10): workers (Co/Re/Da/Rv/De) honour `target_agents` on
reads; Inspector and Chat are privileged readers and see all values.

**Y† worker-scope restriction.** Co/Re `create_memory` / `update_memory`
require `scope == "stage"` AND `scope_ref == <current stage_id>`; any
other scope is `UNAUTHORIZED_SCOPE` (§C.3). Satisfies FA FR-6 without
letting workers contradict project-scope memory. Promotion: Inspector or
Manager `supersede_memory` from `stage`→`project` (§B.5).

Per-row rationale: **Planner** owns memory (survives compaction via
§E.2) but not skills (Manager territory). **Manager** is the broadest
author (FA §2.1) — owns skills and stage→project memory promotion.
**Coder/Researcher** author stage-scoped memories for mid-task facts
(FA §2.1); no supersede/archive/out-of-stage writes. **Data_agent**
reads skills only. **Inspector** is audit/repair (memory authoring +
archive/supersede; skill changes route through Manager).
**Reviewer/Designer** read-only (FR-31e(i) pins Designer skill-write
denial). **Chat** has NO writes; `/remember` routes to Planner
(§H.1), preserving FA §2.6 user-vs-agent trust boundary.

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

**Pick: on-load.** Loader (agent construction OR on-demand `list_*` /
`search_*` call) lazily checks `expires_at` / `ttl_ms` on touched records
and transitions to `expired` in-place (audit-logged). No cron, no
on-write sweep. Cheapest impl; sufficient at hundreds of records.

**Concurrency.** Expiry transition uses `writeRecordAtomic`, which
takes the same per-record mutex as authoring (§C.3). The sweeper
record-update therefore serializes against any concurrent
`update_*`/`supersede_*`; if an author has already mutated the record
between load-time check and lock acquisition, the sweeper re-reads
under the lock and skips when `status != "active"` (no audit, no error).
Never an undetected lost update.

### G.3 Stale-evidence flow

Inspector calls `list_memories({older_than_days: N})` (FR-19); list
shows last-update age + `source_ref`. Per candidate: `archive_memory`
(no longer true), `update_memory` (refresh body + bump `updated_at` +
audit reason), `supersede_memory` (replaced), or leave alone. No
`stale_review_at` — audit entry IS the reviewed signal. Planner sees
expired via `list_memories({include_archived: true})` for retrospective
audit only.

### G.4 Contradiction handling

**Pick: explicit supersession only.** No `override` boolean. If a new
record contradicts an active one, the author MUST call `supersede_*`.
Runtime rejects `create_*` that produces same-`topic` (memories) or
same-`name`-within-scope (skills) collision, pointing at the existing id;
author then chooses supersede / update / pick different topic/name.

---

## H. User-visible surfaces

### H.1 Chat commands (FR-22)

Slash-command parsing lives in `src/chat/slashCommands.ts` (registered
in `chat.ts`'s pre-LLM message handler, before the user turn reaches
the model). The parser maps commands onto MCP read tools — it does NOT
read `.saivage` directly, so the FA §1.6.4 escape hatch stays closed.

| Command                       | Input                                     | Routing |
|-------------------------------|-------------------------------------------|---------|
| `/skills list`                | optional `scope` filter                   | `list_skills` MCP → markdown table (name, scope, updated_at). |
| `/skills show <name-or-id>`   | identifier                                | `read_skill` MCP → full skill body in fenced block. |
| `/memories list`              | optional `scope` / `domain` filter        | `list_memories` MCP → markdown table (topic, scope, updated_at, source). |
| `/memories show <id-or-topic>`| `id` or `domain/subject[/aspect]`         | `get_memory` MCP → full memory body. |
| `/memories search <query>`    | query string                              | `search_memories` MCP → top 10 hits with snippets. |
| `/remember <text>`            | free text                                 | **Forwarded as an inter-agent message to the Planner** (not a direct write). Planner decides whether to call `create_memory` (scope=`project`, target_agents=[], survive_compaction=true) and replies with confirmation or refusal. Chat never bypasses Planner judgment. |
| `/forget <id>`                | id                                        | Confirms with user, then forwards an `archive_memory(id, reason="user-requested")` request to the Planner (same indirection as `/remember`). |

These map onto the MCP tools above; the chat surface adds zero new
authoring paths.

### H.2 Web UI hook point

Single backend endpoint `GET /api/knowledge?kind=&scope=&include_archived=`
returns Zod-validated summaries; only Phase-B-required surface. Registered
in the same web server module exposing `/api/notes` (no implementation
this phase; design is URL contract only).

### H.3 Git ergonomics

Gitignore is **path-based** (closes blocking-issue-3): scope lives in
the tree (§B.4), so rules are exact globs.

- **Committed:** `.saivage/{skills,memory}/{project,stages}/**` (records,
  bodies, indexes, audits). Stage records remain as history after archival.
- **Gitignored:** `.saivage/{skills,memory}/sessions/**` (including
  their session-scoped `audit.jsonl`, only meaningful live).

Committed `audit.jsonl` (project + stage) is the authoring diary — source
of truth for "who wrote what, when, why". `saivage init` (§J.2) writes
`.saivage/.gitignore` with exactly `skills/sessions/` and
`memory/sessions/`. Typical commit diff:
```
A  .saivage/memory/project/records/9f3a-...-b1.json
M  .saivage/memory/project/index.json
A  .saivage/memory/project/audit.jsonl                  (+ one line)
```

---

## I. Test surface

Bulleted; Phase C turns these into a plan.

- **Unit — schema (FR-2,3,17,18):** Zod parse rejection table; status
  transitions; supersession-cycle rejection; scope/scope_ref refinement;
  §B.5 allowed-pairs as parametrized table; TTL/expiry calculator.
- **Unit — store (FR-28, FR-29):** `writeRecordAtomic` happy path +
  per-record mutex serialization (two overlapping `update_memory` on same
  id execute in arrival order; both succeed; final state == second write);
  `appendJsonlAtomic` survives partial last line and enforces the 2048 B
  entry cap; `rebuildIndex` reconstructs from records dir; transaction
  order under step-2/3/4 failures; `supersede_*` two-key lock rollback on
  step-3 failure (NEW record unlinked, OLD untouched); loader repair when
  NEW.supersedes points to OLD without matching `superseded_by`.
- **Unit — secrets (FR-27, FR-31f):** every heuristic in
  `src/security/secrets.ts` with synthetic fixtures (no real secrets);
  write-time `SECRET_DETECTED` + `rejected` audit (reason never echoes the
  match); `BLOCKED_PATH` on each blocked source path; read-time
  `[REDACTED]` + `redacted_spans` count.
- **Unit — loader (FR-10,11,12,15,24):** ordinary eager budget with
  `omitted: […]` header; **survivor reinjection unconditional** (oversize
  survivors still appear, with `OVERSIZED_SURVIVOR` warn header); scope
  filter via directory provenance; `target_agents` filter; trigger scoring
  for `keyword:/tag:/agent:` only; triggerless skill not eager but found
  by `search_skills`; built-in frontmatter walk in src AND tsup paths
  (FR-31a).
- **Unit — retrieval (FR-14):** canonical normalization fixtures
  (unicode/punctuation/case); `get_memory` across three scope indexes
  with project-wins tie-breaker; supersession-chain walk; `search_*`
  stable ordering (score → updated_at → id); `older_than_days` (FR-19).
- **Integration — MCP (FR-6,7,8,30):** every tool round-trips;
  `EMPTY_REASON`; `UNAUTHORIZED_SCOPE` on Coder `scope="project"`;
  `UNAUTHORIZED_ROLE` for every denied cell (FR-31e(i)); deleted
  `memory.*` / `index.*` stubs return `unavailable` (FR-31e(ii)).
- **Integration — concurrency (FR-29, FR-31g):** two parallel
  `create_memory` don't corrupt `index.json` (per-record locks +
  rebuild); two parallel `update_memory` on the same id serialize cleanly
  (no lost update); sweeper expiry races author update → sweeper observes
  the post-update record under the lock and skips silently.
- **Agent-level — eager injection (FR-10,12):** seeded records per role
  produce expected prompt block; stage record not injected next stage
  (FR-9); `omitted: […]` when budget exceeded.
- **Agent-level — Chat (FR-22):** `/memories list` via MCP returns rows;
  `/remember` routes to Planner (no direct Chat write).
- **Agent-level — compaction (FR-15, FR-16):** force `shouldCompact`;
  assert pre-compaction hook user message injected; Planner's
  `create_memory` goes through `executeToolCall` with audit; survivors
  appear post-compaction; non-Planner skips hook; 5-turn cap.
- **Regression-pin (FR-31a-g):** one test per defect, suffixed with the
  FR-31 letter.
- **Boundary (FR-31 / §5.12):** `plan.json` embedded-history round-trip asserts
  Planner-recovery fields are history-derived, not duplicated in memory.
- **Existing tests deleted-and-replaced:** `src/agents/agents.test.ts`
  (imports `resolveSkills`, `formatSkillsForPrompt`, `SkillIndexSchema`)
  and `src/mcp/builtins.test.ts` (asserts current `read_skill` path
  traversal and `unavailable` stubs) — both removed in the same slice
  that lands the replacements above.

---

## J. Migration / cutover

### J.1 DELETED (clean-architecture, no compat)

Files:
- `src/skills/loader.ts` — replaced by `src/knowledge/loader.ts`.
- `src/mcp/builtins.ts` blocks: `skillsHandler` (L1053-…), `memoryTools`
  stub (~L1139+), `indexTools` stub (~L1139+), service registrations
  at L1166-1168.
- `skills/coding/SKILL.md`, `skills/planning/SKILL.md`,
  `skills/research/SKILL.md`, `skills/mcp-authoring/SKILL.md` —
  **moved** to `saivage/skills/builtin/<name>/SKILL.md` (loader walks
  `builtin/`).
- Any legacy `<project>/.saivage/skills/index.json` — none exists in
  the three reviewed deployments (FA §1.4); no conditional cleanup.

Types (`src/types.ts` §10): `SkillEntrySchema`, `SkillIndexSchema`,
`SkillMatchContext` (moves to new loader module, `tools`/`filePaths`
removed); any `MemoryEntrySchema` / `IndexEntrySchema` stubs.

MCP tools (deleted): `memory_*` stubs (5+), `index_*` stubs (3+).
Existing `skills.*` names reused with new contract (Section C.2).

Tests: every test asserting today's `create_skill`/`update_skill`/
`list_skills`/`read_skill` contract is deleted; replaced by Section I
new-contract suites.

### J.2 What `saivage init` writes into a fresh `<project>/.saivage/`

```
.saivage/
├── skills/
│   ├── project/{index.json, audit.jsonl, records/}
│   ├── stages/                # empty; stage dirs are created on first stage write
│   └── sessions/              # empty; gitignored
├── memory/
│   ├── project/{index.json, audit.jsonl, records/}
│   ├── stages/
│   └── sessions/              # empty; gitignored
└── .gitignore                 # exactly:  skills/sessions/\nmemory/sessions/\n
```

Every `index.json` starts as `{ skills: [] }` or `{ memories: [],
topic_map: {} }`; every `audit.jsonl` starts as an empty file.

Built-in skills are **not copied** into the project; they are loaded from
the bundled `saivage/skills/builtin/` directory at construction time. A
project that wants to override a built-in writes a project-level skill of
the same `name` (project wins, mirrors today's precedence rule).

### J.3 Build-safe order

Local sequencing for the implementer (flag in step 5 dies in step 6's
same commit; no compat branches ship). Between any two steps the tree
compiles and tests pass (minus the §I deleted-asserts).

1. Add `src/knowledge/types.ts` (`SkillRecord`, `MemoryRecord`,
   `AuditEntry`). Old `SkillEntrySchema` stays.
2. Add `src/knowledge/store.ts` (3 primitives), `permissions.ts`,
   `src/security/secrets.ts`. No call sites yet.
3. Add `src/knowledge/loader.ts` (`resolveEagerRecords`,
   `reinjectSurvivors`). Old `src/skills/loader.ts` still in use.
4. Register new MCP services alongside old `skills` handler in
   `src/mcp/builtins.ts`.
5. Update `BaseAgent` ctor + compaction path (loader, injected block,
   FR-16 hook) behind a local runtime flag defaulting to old path;
   tests flip it on.
6. Switch flag default; in the **same commit**, delete
   `src/skills/loader.ts`, old `skillsHandler`/`memoryTools`/
   `indexTools`, the runtime flag, and old-path branches.
7. Delete `SkillEntrySchema`/`SkillIndexSchema` and remaining imports.
8. Move built-in markdowns to `saivage/skills/builtin/`; update
   `tsup.config.ts` to bundle next to `dist/` (FR-31a).

---

## K. Risks and rejected alternatives

- **Unified `records` table (A):** rejected; skill vs memory retrieval
  modes diverge — unification pushes filtering to every call site.
- **LLM-side `list+pick` retrieval (D.3, 5.2 Option C):** rejected
  (token-expensive; topic-key + keyword search is cheaper, deterministic).
- **Wiring `tool:` / `path:` triggers (D.4):** rejected; no concrete
  use case justifies the churn; on-demand search covers the path-aware
  case (all 9 agents triggerless `skillContext` — verified).
- **JSONL-only storage (B.4):** rejected (poor `cat`/`grep`); JSONL only
  for the append-only audit trail.
- **Built-in `index.json` (B.4, 5.8 Option A):** rejected (dual-format
  drift); frontmatter walk is the single source of truth.
- **"All authoring at all scopes" (F, 5.5 Option A):** rejected; Coder/Re
  restricted to `scope="stage"` (Y†) — prevents worker-vs-Planner
  contradictions at project scope.
- **`override` field (G.4):** rejected (silently licenses contradiction);
  explicit supersession forces a decision.
- **On-write sweeping (G.2):** rejected (triples write latency); on-load
  lazy is enough at our scale.
- **Web UI panel now (H.2):** deferred; FR-22 is testable via chat alone.
- **Hard-ACL cross-agent visibility (F, 5.10 Option B):** rejected
  (breaks Inspector audit and Chat surfacing).
- **Single shared `knowledge` MCP service (non-blocking 4):** rejected;
  kind-specific tools give better ergonomics and clearer audit semantics.
  Shared engine still routes all through `permissions.ts` + `store.ts`.
- **Synthetic `compaction_persist_memory` tool (E.2):** rejected (arch
  concern 2); Planner uses the normal `create_memory` MCP path via a
  pre-compaction nudge from `BaseAgent`.
- **NoteManager fold-in:** rejected per OOS-10 (different trust
  boundary, different invariants).
- **Cross-process concurrency on the same `.saivage/` (C.3):** explicit
  non-goal. Saivage is one Node process per project (in-process child
  agents via `Dispatcher.childSpawner`); the per-record async mutex is
  the entire concurrency story. Running two `saivage` CLIs against the
  same project is unsupported and may corrupt indexes/audits — documented
  here so it is not assumed in Phase C.
- **File-level locking (`flock(2)` / lockfiles) in C.3:** rejected;
  redundant under the single-writer invariant. Reserved as the migration
  path if Saivage ever grows multi-process workers.

---

## L. FR coverage matrix

| FR    | Satisfied by section(s)          | Notes |
|-------|----------------------------------|-------|
| FR-1  | B.1, B.4, J.2                    | All state under `<project>/.saivage/`; JSON + JSONL; `writeDoc` used. |
| FR-2  | B.1                              | `RecordBase` mandates `id, kind, scope, timestamps, author_agent, source`. |
| FR-3  | B.1, B.2                         | Lifecycle states + transition table. |
| FR-4  | B.1 (refinement), B.3, B.4 (path layout) | Three scopes encoded in path AND in `(scope, scope_ref)`; user-wide REJECTED per §5.4. |
| FR-5  | B.4, J.2                         | Single per-project tree; no global registry. |
| FR-6  | C.1, F                           | Per-role MCP write tools; Coder/Researcher get `Y†` scoped memory authoring; Chat write removed (§H.1 indirection). |
| FR-7  | C.1, B.1 (AuditEntry)            | Every mutation appends audit; rejected attempts also audited (§C.3). |
| FR-8  | C.1, B.1                         | `triggers` OPTIONAL on `create_skill`; triggerless skills retrievable via `search_skills`. |
| FR-9  | B.2, B.3, B.4                    | Stage scope auto-archived on stage terminal via directory walk. |
| FR-10 | D.1, D.3, C.1                    | Eager + on-demand both wired. |
| FR-11 | D.2                              | Ordinary eager token budget enforced with explicit `omitted` ids; survivors uncapped. |
| FR-12 | D.1, D.5                         | `scope_tags` (as `keys`/`tag:` triggers) + `target_agents` both filter. |
| FR-13 | D.4                              | `tool:` / `path:` removed from schema; concrete rationale in §D.4. |
| FR-14 | D.3                              | Exact-key (`get_memory({topic})`) + keyword `search_memories` with canonical normalization. |
| FR-15 | E.1, D.2                         | Survivors unconditionally reinjected as summaries; never silently dropped. |
| FR-16 | E.2                              | Pre-compaction prompt nudge; Planner uses normal `create_memory` MCP tool. |
| FR-17 | B.1, G.1, G.2                    | `expires_at` / `ttl_ms`; on-load sweeper via `writeRecordAtomic`. |
| FR-18 | B.1 (supersedes), B.5, G.4       | `supersede_*` MCP calls; allowed-pairs table; chain walk default-head-only. |
| FR-19 | C.1, G.3                         | `list_memories({older_than_days})`. |
| FR-20 | B.4, H.3                         | Markdown bodies, JSON records, `cat`/`grep`-friendly. |
| FR-21 | H.3                              | Path-based per-scope gitignore (no content-derived rules). |
| FR-22 | H.1                              | Chat commands enumerate records via MCP read tools; web UI deferred. |
| FR-23 | J.2                              | No migrator; fresh init writes empty trees. |
| FR-24 | B.4, D.1, J.3 step 8             | Frontmatter walk works in src-run + tsup bundle. |
| FR-25 | C.1, D.1, D.3                    | All authoring/retrieval are pure file/IO; no LLM dep. |
| FR-26 | I (unit + integration without MCP) | Loader/store unit-testable in isolation. |
| FR-27 | C.3                              | Shared secret scanner; write refusal + audit; read-time redaction; blocked source paths. |
| FR-28 | C.3, J.3 step 2                  | `writeRecordAtomic` (tmp+fsync+rename) + `appendJsonlAtomic` (POSIX O_APPEND). |
| FR-29 | C.3, I, K                        | Single-writer invariant + per-record async mutex; `supersede_*` two-key lock with rollback; cross-process explicit non-goal. |
| FR-30 | C.1, B.2                         | `archive_*` reversible, `delete_*` terminal. |
| FR-31a | I, J.3 step 8                   | Built-in load test for src + dist. |
| FR-31b | C.1, I                          | Unmatchable-record prevention test. |
| FR-31c | C.1, I                          | `update_*` refreshes `updated_at` + audit `reason`. |
| FR-31d | C.1 (`read_skill` honours `body_path`), I | Non-default body path readable. |
| FR-31e(i) | F, I                         | Manager/Designer/Chat skill-write filtering test. |
| FR-31e(ii) | J.1, I                      | Deleted `memory.*` / `index.*` stubs unreachable test. |
| FR-31f | C.1, I                          | Secret-rejection test. |
| FR-31g | C.1, I                          | Concurrent-write test. |

**No FR is REJECTED.** All 31 (plus seven sub-items) are satisfied.

---

## M. Round log

All Phase B review (round 1) issues are **ACCEPT-FIX**. No
ACCEPT-DEFERs, no REJECTs.

**Blocking (7 / 7 ACCEPT-FIX).** (1) Authoring vs FR-6 → C.1, F (Y†:
Co/Re stage-only `create_memory`; Chat & Inspector skill-write removed).
(2) Triggerless skill / FR-8 → B.1 (`triggers` optional), C.1, D.1
(score 0, search-only). (3) Scope semantics + gitignore → B.1, B.4
(path layout), H.3 (path-based), J.2. (4) Audit/concurrency primitives
→ C.3 (`src/knowledge/store.ts`: `writeRecordAtomic` +
`appendJsonlAtomic` + `rebuildIndex` + 14-row error taxonomy).
(5) Compaction write hook → E.1 (reinject in `BaseAgent`), E.2
(pre-compaction nudge + normal MCP loop, Planner-only, 5-turn cap).
(6) Budget vs survivor → D.2 (uncapped survivor sub-budget summary-form
+ ordinary 2048-tok cap + explicit `omitted: […]` + `OVERSIZED_SURVIVOR`).
(7) Secret handling → C.3 security (`src/security/secrets.ts`, blocked
paths, write refusal + audit-no-echo, read-time `[REDACTED]`).

**Non-blocking (9 / 9 ACCEPT-FIX).** (1) `scope="builtin"` → B.1
(`origin` field), D.1. (2) Supersession "scope ≥" → B.5 allowed-pairs.
(3) Keyword normalization → D.3 (NFC + lowercase + strip-punct +
collapse-ws; `body_snippet` in index). (4) Why 16 tools → C.1, K
(shared engine under thin tool facades). (5) Error modes → C.3 14-row
taxonomy. (6) Sweeper vs concurrency → G.2 (`writeRecordAtomic` +
`STALE_WRITE` skip). (7) Chat parser → H.1
(`src/chat/slashCommands.ts`; MCP-only). (8) Runtime flag → J.3 (local
sequencing; flag dies step 6). (9) Deletion test list → J.1 + I name
`src/agents/agents.test.ts` and `src/mcp/builtins.test.ts`.

**Architectural concerns (5 / 5 ACCEPT-FIX).** (1) Single store boundary
`src/knowledge/store.ts` (C.3); (2) `compaction.ts` stays pure
history→summary, orchestration in `BaseAgent` (E.1, E.2); (3) survivors
uncapped, ordinary `omitted: […]` echoed (D.2); (4) shared
`permissions.ts` + `store.ts` under kind-specific tools (C.1, K);
(5) `/remember` routes through Planner; Chat is read-only (H.1, F).

**Spot-check FAILs (13 / 13 ACCEPT-FIX).** Closed by blocking fixes:
OQ-5.5/FR-6/coder-create-M/chat-create-S → Blk-1 (C.1, F, H.1);
FR-4/FR-21 → Blk-3 (B.1, B.4, H.3); FR-8 → Blk-2 (B.1, C.1, D.1);
FR-11/FR-15 → Blk-5+6 (D.2, E.1); FR-16 → Blk-5 (E.2); FR-27 → Blk-7
(C.3); FR-28/FR-29 → Blk-4 (C.3).

### Round 3 (2026-05-23)

Round-2 reviewer flagged 4 wrong-fixes (all the same root cause: TOCTOU
`expectedMtimeMs`), 1 new blocker (race-free store + `supersede_*`
atomic two-record mutation), 3 new non-blocking. **All 8 ACCEPT-FIX.**

**Wrong-fixes (4) + new blocker (1) → one §C.3 rewrite.** Blocking-4,
Non-blocking-6, Architectural-1, Spot-check FR-29, and the new blocker
all collapse into one concurrency model. Code inspection
(`src/runtime/dispatcher.ts:64-74,239`, `src/agents/base.ts:177-178`,
`src/mcp/runtime.ts`) confirms one Node process per project with
in-process child agents and all mutations via MCP tools. §C.3 now
states the single-writer invariant, replaces stat-before-rename with a
module-scoped per-record async mutex in `src/knowledge/store.ts`,
defines `supersede_*` under a deterministic two-key lock with step-3
rollback (unlink NEW, leave OLD), caps audit entries at 2048 B to honor
POSIX `O_APPEND` atomicity, and removes every `STALE_WRITE` reference
(taxonomy row → `INVALID_SUPERSEDE_TARGET`; §G.2, §I, §L FR-29 all
updated). Supersede atomicity now has a defined mechanism, failure
mode, and loader-repair rule.

**New non-blocking (3 ACCEPT-FIX):** (NB1) oversized-survivor wording —
§D.2 now states one rule per surface (write-time refusal in §C.1/§I,
load-time quarantine with `oversized_survivors: [id…]` in §D.2/§E.1);
(NB2) worker-scope wording — §A.1 OQ-5.5 row and the 5.5 disposition
line now both say "workers (Coder/Researcher) are bounded to
`stage`-scoped memories only"; (NB3) FR-24 cited J.3 step 9 — fixed to
step 8 in the §L coverage matrix.

**Non-goal documented (§K):** cross-process concurrency on the same `.saivage/` — the in-memory mutex is sufficient under single-writer; `flock(2)` reserved as the future migration path.
