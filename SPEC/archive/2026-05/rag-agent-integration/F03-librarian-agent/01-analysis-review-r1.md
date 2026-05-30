# F03 Librarian Agent Functional Analysis Review

## Findings

The analysis has the right high-level instinct: a single bounded Librarian role, no source-file mutation, no separate scheduler, and no replacement of the F01 records layer or the F02 tool surface. It is not ready to approve because several key mechanics are factually wrong against the current agent framework, and those errors would send implementation into nonexistent seams.

### 1. Coverage of Required Topics

The responsibilities section covers collection creation, source curation, watcher mode, reconcile cadence, pruning, and secret follow-up, but it does not complete the required incident surface. The topic file explicitly asks for response to flood reports, drift/corruption, and secret-leak follow-up; the analysis mentions flood detection and stale stamps only as background, then omits them from the ownership list and the failure decision table. It also does not clearly distinguish bulk-ingest dropped-secret reporting from `rag.add` secret rejection.

Dispatch is covered as a list of triggers, but not as a comparison of the available paths. The source topic asks to compare fallback after no retrieval hits, supervisor or dispatcher handoff, and operator request via chat. The analysis instead states a handoff model that is not how this codebase currently dispatches agents, and it introduces a supervisor queue plus RAG incident logger without separating that from the focused no-runtime-code proposal.

The tool whitelist is directionally bounded, but not implementable as written. It uses wildcard namespaces and dotted tool names while the current filter works over concrete MCP tool names. It also includes tools that do not exist in the cited implementation, such as `fs.statFile`, `read_skill_by_id`, and `propose_stage`.

The prompt section is too thin for implementation. It names constraints and a few decision rules, but it does not provide a concrete prompt outline with expected response style, collection-summary phrasing, confirmation rules for destructive actions, fallback behavior when tools fail, or a final-response contract for returning work to the caller.

Knowledge integration is mostly covered: project-scope memories with a `rag-policy` topic are a sensible fit. It should still specify the exact `target_agents`, `survive_compaction`, and authoring permissions expected after adding the new role to the knowledge schemas and permission matrix.

Operator interaction is partially covered, but the manual `saivage.json` conflict path is wrong. F02 says config/registry drift has no automatic resolution and the operator chooses the winner; the Librarian can investigate and report, not silently reconcile its view.

### 2. Factual Accuracy

The largest factual error is the description of [src/agents/handoff.ts](src/agents/handoff.ts). That file builds shared context text for an assignment; it is not an agent-to-agent `Handoff` envelope API and it does not swap runtime execution to a destination role. The actual dispatch seam is the synthetic `run_*` tool path derived from [src/agents/roster.ts](src/agents/roster.ts), exposed by [src/agents/base.ts](src/agents/base.ts), and executed by [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts). A Librarian that is reachable by other agents needs a `run_librarian` dispatch tool and spawner handling, or the analysis must explicitly choose not to make it directly dispatchable.

The analysis treats [src/runtime/supervisor.ts](src/runtime/supervisor.ts) as if it can enqueue handoffs. The current supervisor only inspects recent logs and cancels abortable agents when the system appears stuck. It has no queue, no destination-role dispatch, and no incident-routing API. Any supervisor-to-Librarian path is new runtime design and cannot be smuggled into the focused proposal.

The conventions claim is inaccurate. [src/agents/conventions.ts](src/agents/conventions.ts) contains write-territory warning rules, not runtime prompt/context injection. Dataset snapshots and recent `rag-policy` memories are not currently injected at the start of every turn through that module. If the analysis wants this capability, it must either make it a deliberate small framework change or drop it and require the Librarian prompt to call `rag.list` and `search_memories` when needed.

The prompt wiring is also misstated. [src/agents/prompts.ts](src/agents/prompts.ts) loads markdown files from the repo-level `prompts/` directory and maps prompt keys to roles; the system prompt itself should be a new `prompts/librarian.md`, plus updates to [src/agents/prompt-keys.ts](src/agents/prompt-keys.ts), `PROMPT_KEY_TO_ROLE`, and `ROLE_PROMPT_NAMES`. Saying “new key in `prompts.ts`” and omitting the prompt file will leave the implementation incomplete.

The roster/type claims need correction. [src/agents/types.ts](src/agents/types.ts) re-exports `AgentRole` from [src/agents/roster.ts](src/agents/roster.ts); the role union is derived from `ROSTER`, not hand-maintained there. The knowledge role schema in [src/knowledge/types.ts](src/knowledge/types.ts) is separate and does need an explicit Librarian value, plus a permission row in [src/knowledge/permissions.ts](src/knowledge/permissions.ts).

The current tool-filter architecture also differs from the analysis. [src/agents/tool-filters.ts](src/agents/tool-filters.ts) defines a `ToolFilterKind`, and each roster role points at one filter kind. There is no per-role additive whitelist entry today. A Librarian-specific filter therefore needs either a new `librarian` filter kind or a small service-aware filter abstraction. That change should be named directly instead of described as a simple role entry.

Several concrete tool names are wrong against the cited files. File tools are `read_file` and `list_dir`, not `fs.readFile` and `fs.listDir`; no `stat_file` or `fs.statFile` tool exists in [src/mcp/builtins.ts](src/mcp/builtins.ts). The skill read tool is `read_skill`, not `read_skill_by_id`, in [src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts). The plan surface contains tools like `plan_add_stage`, not `propose_stage`, and granting any plan write tool to the Librarian would conflict with planner ownership unless the analysis deliberately rejects it.

### 3. Architectural Soundness

The analysis tries to respect planner-owned stages, but the reconcile-cadence language crosses the boundary. “Schedules a periodic reconcile via the planner” and “gets the planner's `propose_stage` tool” imply the Librarian can initiate plan mutation. There is no such planner-proposal tool, and the clean direction is for the Librarian to return a recommendation or incident report to the caller; only the Planner should decide whether plan state changes. Recurring reconcile also risks turning the plan into a scheduler, which the source topic explicitly rules out.

The handoff direction is internally confused. Section 9 says handoff direction is always Planner or Manager to Librarian and never the reverse, but the same section lets the Librarian issue a stage proposal. That is reverse influence over the plan. The analysis should make the return path a plain report, not a hidden planning command.

The level-up dispatcher-routing alternative is probably not worth its cost, but the analysis does not justify the rejection strongly enough. Automatic dispatcher routing based on retrieval-like phrasing would add string-intent heuristics to [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts), blur who owns retrieval fallback, and create surprising agent switches. The cleaner architecture is explicit dispatch from roles that already know their retrieval failed. If a level-up option remains, it should be rejected on those grounds unless the source topic requires it as a later gated experiment.

### 4. Clean Code and Architecture-First

The analysis has two places where it reaches for new runtime behavior instead of a small framework correction. First, the tool whitelist should not be approximated with wildcard names if the existing filter cannot represent service/name tuples; add a small service-aware filter capability or enumerate exact concrete tool names. Second, the conventions injection should not be hung on [src/agents/conventions.ts](src/agents/conventions.ts); either keep discovery tool-driven or introduce a narrowly-scoped role context builder.

The proposed `rag-incident-logger` plus supervisor queue is also too speculative for a functional analysis that claims a focused no-runtime-code path. It is a new incident router. If retained, it belongs only in a clearly separate level-up design with costs, tests, and rejection criteria.

### 5. Completeness

The agent declaration is underspecified. The analysis should give the actual roster entry shape: whether `worker` is false, whether it is stage-scoped, which `dispatchTool` it exposes, which roles may dispatch it, which `toolFilter` it uses, abort priority, default model key, display name, prompt key, summary, and convention rule. Section 10 says to add a role entry but does not specify enough fields to implement it safely.

The prompt outline needs to be more operational. It should include sections for role boundary, collection discovery, registration decision tree, destructive-action confirmation, secret-safe reporting, collection-summary wording, return-report shape, and exact handling for each F02 error code. It also needs to say how to answer cross-collection lookup questions without inventing records or exposing secret-bearing paths.

The decision tree is incomplete. It lacks watcher flood and stale-stamp behavior, manual config conflict resolution, `INVALID_QUERY_FILTER`, `UNAUTHORIZED_RAG_TOOL`, startup `RAG_CONFIG_DRIFT`, repeated `SECRET_DETECTED` or bulk `chunksDroppedSecrets`, and the no-scheduler response when a caller asks for recurring work. It also prescribes immediate destructive recovery for drift and watcher failures where the safer contract is to diagnose, journal, and ask the operator or Planner for the decision when data might be discarded.

The whitelist needs to be exhaustive and bounded by exact service/tool pairs. The analysis should decide whether the Librarian gets `search_files` or only `read_file` and `list_dir`; whether it gets `create_memory`, `update_memory`, and `archive_memory` but not `delete_memory`; whether it can read skills via `read_skill`; and whether `rag.admin.drop` requires confirmation. Wildcards are too broad for the role that owns collection mutation.

### 6. Internal Consistency

Section 4, Section 10, and Section 11 do not line up. Section 4 grants file and planner tools that are not reflected in the file-change list. Section 10 omits the actual prompt markdown file, the dispatch schema, the child-spawner case, prompt-loader map updates, roster tests, tool-filter tests, and any chat or planner path needed for operator-triggered dispatch. Section 11 says the Librarian has no special runtime path, while Section 3 and Section 10 add supervisor incident routing and a new runtime incident logger.

The analysis also conflicts with F02 in a few places. It says register/drop are part of the write-side tools allowed to Librarian, Planner, and Manager, but F02 makes `register` and `drop` admin operations allowed to Librarian and operator. It says existing collection descriptions drive registration decisions, but F02 explicitly chooses not to add a `description` field to `DatasetConfig`; discovery is via `rag.list` plus Librarian-maintained policy memories, not registry descriptions.

### 7. Style Compliance

The document is mostly self-contained and has no emojis or references to the review process. Link style needs cleanup before approval. Some file references use a `saivage/` prefix while others use `src/` or bare code spans; the final analysis should use one repo-root-relative markdown-link convention consistently, and file paths such as `src/agents/librarian.ts` and `SPEC/v2/rag/librarian.md` should be links rather than inline code when they refer to real files to add.

VERDICT: CHANGES_REQUESTED
1. Replace the nonexistent `Handoff` envelope model with the actual dispatch architecture: roster-derived `run_*` tools, BaseAgent dispatch schemas, Dispatcher execution, and bootstrap child-spawner handling. Explicitly state whether the Librarian is dispatchable and, if so, which roles can call `run_librarian`.
2. Remove or sharply separate supervisor incident routing from the focused proposal. If supervisor or dispatcher auto-routing remains as a level-up option, describe it as new runtime code, compare it against explicit dispatch, and either reject it with a clear cost argument or specify the exact new seams and tests.
3. Rewrite the tool whitelist as exact bounded service/tool grants that match F02 and the current MCP names. Correct `read_file`, `list_dir`, `read_skill`, the absence of `stat_file`, the absence of `propose_stage`, and the F02 admin-role split for `register` and `drop`.
4. Correct prompt and role wiring: add `prompts/librarian.md`, update prompt keys and prompt-loader maps, provide a complete roster entry shape, add the knowledge role schema and permission row, and name the needed tests. Do not describe `src/agents/types.ts` as the source of the role union.
5. Replace the conventions-injection claim with an implementable design. Either require the Librarian to call `rag.list` and knowledge-read tools, or propose a small dedicated role-context builder; do not use `src/agents/conventions.ts` for runtime dataset injection.
6. Fix planner ownership and failure handling. The Librarian must return reports/recommendations rather than mutate or propose stages directly, must not turn recurring reconcile into a scheduler, and must require operator or Planner confirmation before destructive drop/re-register recovery when config drift, store corruption, or manual operator edits are involved.
7. Complete the required decision tree and prompt outline: include flood reports, stale stamps, bulk secret drops, `INVALID_QUERY_FILTER`, `UNAUTHORIZED_RAG_TOOL`, startup `RAG_CONFIG_DRIFT`, protected datasets, no-hit retrieval fallback, collection-summary wording, destructive-action confirmation, and final response shape.
8. Repair internal consistency across the whitelist, file list, boot/lifecycle expectations, and style. Keep links repo-root-relative and markdown-formatted, remove tool/file names that do not exist, and ensure the focused proposal does not list runtime files that belong only to a level-up design.