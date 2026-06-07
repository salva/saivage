# Review 2: OpenCode-Aligned Built-In Tool Redesign Plan

Date: 2026-06-07

Reviewer: second-pass review against source code, with emphasis on simple/clean architecture and zero backward-compatibility weight.

## Summary

The plan is directionally correct after the first review's revisions (C1-C3, S1-S4, M1-M3). However, a detailed audit of the current v2 source code reveals that the plan still contains two critical contradictions from the first review (the `skill` action dispatch and the `apply_patch` format were never updated in the plan text), and it leaves several significant architectural gaps where the 9-tool target surface intersects with the ~40 existing tools, the service registry, the spilling/stash system, and role authorization in ways that need resolution before implementation starts.

## Critical Issues (Not Yet Fixed in Plan Text)

### C4: `skill` still shows the multi-action dispatch pattern

**Plan line 583:**
```json
{
  "action": "list | read | search",
  "name": "string?",
  "query": "string?"
}
```

**First review S1** recommended simplifying this to: `skill` with `name` (required for read, omitted for list). No `action` field, no `search`. The plan was updated in the review's tracked changes table (line 223) but the contract detail (line 583) still shows the old multi-action dispatch.

**Impact:** If implemented as written, this embeds the fragile action-dispatch pattern that the first review specifically identified as the worst of both worlds.

**Fix:** Replace the contract with:

```json
{
  "name": "string?"
}
```

- `skill` with `name` returns that skill's content and metadata.
- `skill` without `name` lists available skills with names and descriptions.
- Drop `search` — `glob` and `grep` on the skill files directory cover content search if ever needed.

### C5: `apply_patch` still shows the custom envelope format

**Plan lines 310-317:**
```
*** Begin Patch
*** Add File: <path>
*** Update File: <path>
*** Delete File: <path>
*** End Patch
```

**First review C3** recommended switching to standard unified diff plus a `deletions` array. The tracked changes table (line 222) reflects this, but the contract detail (lines 298-345) still describes the custom envelope format.

**Impact:** This is the highest-risk implementation item in the entire plan. If we build a parser for a custom format, we create a format no model is trained on and no other tool uses. The review's argument stands: unified diff has the lowest implementation risk and highest model familiarity.

**Fix:** Replace the contract section with:

Input:
```json
{
  "patch": "string (unified diff)",
  "deletions": ["string?"]
}
```

- `patch` contains standard unified diff hunks for adds and updates.
- `deletions` is an optional array of project-relative file paths to delete.
- New files use `--- /dev/null` in the diff header.
- No custom envelope, no `*** Begin Patch`, no `*** End Patch`.

Remove implementation note 343 ("If a robust internal patch parser is too large...") since unified diff eliminates the complexity concern.

## Significant Issues

### S5: Skill mutation tools have no migration path

The plan says `skill` replaces `list_skills` and `read_skill`. But the current skill surface has 8 tools:

| Tool | Purpose |
|------|---------|
| `create_skill` | Mutation |
| `update_skill` | Mutation |
| `supersede_skill` | Mutation |
| `archive_skill` | Mutation |
| `delete_skill` | Mutation |
| `list_skills` | Discovery |
| `read_skill` | Discovery |
| `search_skills` | Discovery |

The plan's `skill` tool is read-only (list + read). The 5 mutation tools are unaddressed. The review note says "Do not collapse memory CRUD into `skill`" but says nothing about skill CRUD.

**Recommendation:** This migration should also collapse the 5 skill mutation tools. Options:

- Option A (simplest): One `skill` tool with `name` for read/list. Remove all skill mutation from the model tool surface. Skill creation and mutation become internal runtime operations, not agent-facing tools. This aligns with Saivage v3 where skills are loaded from workspace files, not created by agents.
- Option B: Keep `create_skill`, `update_skill`, `archive_skill`, `delete_skill` under new names in a separate pass. But this contradicts the no-backward-compatibility stance and the goal of a small, predictable tool vocabulary.

Given the zero-backward-compatibility principle and the architecture goal, Option A is cleaner. Skills are workspace files — agents should discover them via `skill`, not author them at runtime.

### S6: Memory tools are completely absent from the plan

8 memory CRUD tools exist (`create_memory`, `update_memory`, `supersede_memory`, `archive_memory`, `delete_memory`, `list_memories`, `get_memory`, `search_memories`). The plan does not mention them at all. They appear in `LIBRARIAN_TOOLS` and have their own service (`memory`).

These tools are conceptually separate from `skill` — they manage the knowledge/memory store. The plan needs to explicitly state what happens to them:

- If they stay unchanged in this pass, say so and explain why.
- If they should be consolidated, specify the new surface. A reasonable approach: `memory` with `topic` (required for read, omitted for list) mirroring the `skill` pattern, plus separate mutation tools renamed or removed per the same logic as S5.

### S7: The service dispatch architecture is incomplete

The plan proposes flattening filesystem + data tools into a single `builtin` service while `shell`, `git`, `knowledge`, `memory`, `rag`, `notes`, and `plan` remain as separate services. This creates an inconsistent dispatch model where some tools go through one handler and others go through service-specific handlers.

More fundamentally, the plan proposes a per-tool `BuiltinToolHandler` type:
```ts
type BuiltinToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCallContext | undefined,
  artifact: ArtifactExecutionContext | undefined,
) => Promise<unknown>;
```

But the current `InProcessToolHandler` returns `Promise<{ content: unknown; isError: boolean }>` — a structured result that distinguishes success from error at the type level. Returning `Promise<unknown>` loses this distinction, forcing the dispatcher to sniff the result type. This is a step backward in type safety.

**Recommendation:**

1. Keep the current handler return type: `Promise<{ content: unknown; isError: boolean }>`. This is simple, explicit, and the dispatcher already knows how to handle it.
2. The per-tool handler pattern is fine, but instead of registering one big `builtin` service with a routing handler, register each new builtin tool individually using a helper that wraps per-tool handlers in a thin adapter. This gives the model a flat tool namespace while keeping the dispatch clean.
3. Alternatively, keep service names as internal implementation details. The model sees flat tool names; the dispatch routes by `(serviceName, toolName)` internally. The service name never appears in prompts or schemas.

The key principle: **the model-facing namespace is flat, but the internal dispatch can use whatever grouping makes the code clean.**

### S8: Spill/stash system is fragmented

Three separate overflow mechanisms exist in the current codebase or the plan:

| Mechanism | Location | Purpose |
|-----------|----------|---------|
| `run_command` spill | `.saivage/tmp/command-logs/` | Always written; agent gets path reference |
| Stash | `.saivage/tmp/stash/` | Tool results exceeding 5% of context window |
| Proposed `webfetch` spill | `.saivage/tmp/webfetch/` | Inline content exceeding `max_inline_bytes` |

These three mechanisms solve overlapping problems. The plan proposes adding a third location when the first two already exist.

**Recommendation:** Unify overflow into one mechanism. Options:

- Option A: Expand the existing `maybeStash()` system to support tool-result spilling for any tool that needs it, and use it for both `run_command` output and `webfetch` inline content. The stash directory becomes the canonical overflow location.
- Option B: Keep `command-logs/` for `run_command` (always written, path always returned), and use a single `spill/` directory for all other tools' overflow (webfetch, future tools). Delete or merge the current `stash/` into `spill/`.

Given that `maybeStash()` is already dispatching based on context-window percentage and `command-logs` is always written, Option A is cleaner: use the stash system as the single overflow mechanism, and `command-logs` stays as-is because it's always written regardless of size.

### S9: `read_stash` needs a decision

`read_stash` is a synthetic tool added to every agent's tool schema in `base.ts` and handled inline in the dispatcher. If the plan generalizes overflow to a stash/spill mechanism used by `run_command`, `webfetch`, and future tools, then `read_stash` (or its successor, `read` with a path to a spill file) becomes the standard way for agents to retrieve overflowed content.

**Recommendation:** Keep `read_stash` or fold it into `read` with path resolution. If spill files live under `.saivage/tmp/`, then `read` with `path=".saivage/tmp/spill/..."` already works and no separate `read_stash` tool is needed. But `read_stash` is currently synthetic and path-independent (it looks up by stash ID, not by path). Decide whether to keep the synthetic `read_stash` or make spill files accessible via `read` using ordinary paths.

Given the simplicity principle: **make spill files accessible via `read` using their path.** Remove `read_stash` as a separate tool. The spill file path is already returned in the tool result, and `read` can access it like any other project file.

### S10: `webfetch` parameter interactions are underspecified

Several parameter combinations need explicit specification:

1. **`metadata_only=true` + `save_as`**: Contradictory (fetch metadata only, but save the body?). Reject with an error.
2. **`metadata_only=true` + `read_mode`**: Pointless (no body to interpret). Ignore `read_mode` and return metadata only.
3. **`save_as` + `read_mode='multimodal'`**: Save raw bytes to `save_as`, return attachment inline. Or: save to `save_as` and return metadata (no inline body). The plan should specify which.
4. **`save_as` + `read_mode='text'`**: Save decoded text to `save_as`, return metadata. Clear.
5. **`save_as` + `read_mode='auto'`**: Follow `auto` logic for the body; save whatever would have been returned inline. Return metadata + saved path.

**Recommendation:** Add an explicit parameter interaction table to the `webfetch` contract:

| `metadata_only` | `save_as` | `read_mode` | Behavior |
|---|---|---|---|
| `true` | — | — | HEAD-like metadata only, no body |
| `true` | provided | — | **Error**: cannot save body when not fetching body |
| `false`/absent | — | `auto` | Infer from content-type; spill oversized inline content |
| `false`/absent | — | `text` | Force text; spill oversized inline content |
| `false`/absent | — | `multimodal` | Force attachment; reject unsupported types |
| `false`/absent | provided | `auto` | Save whatever `auto` would return inline; return metadata + saved path |
| `false`/absent | provided | `text` | Save decoded text to `save_as`; return metadata + saved path |
| `false`/absent | provided | `multimodal` | Save raw bytes to `save_as`; return attachment + metadata + saved path |

### S11: `download_with_fallbacks` and `download_file` capabilities are silently dropped

The current `download_file` supports custom `headers` and the current `download_with_fallbacks` supports:
- Multiple URLs with ordered fallbacks
- Per-URL retry counts
- Manifest writing with attempt logs

None of these capabilities appear in the `webfetch` contract. The plan says `webfetch` replaces `download_file` and `download_with_fallbacks` but does not explain:
- Whether `webfetch.save_as` supports custom headers.
- Whether multi-URL fallback is dropped intentionally.
- Whether the manifest feature is dropped intentionally.

**Recommendation:** Drop multi-URL fallback and manifest writing. They are niche features that add complexity to the tool contract. Agents can compose multiple `webfetch` calls with `save_as` if they need fallback behavior. `headers` is also niche — drop it unless there is a concrete use case. Document these as intentional removals in the plan.

### S12: `metadata_only` should specify HTTP method

The plan says `metadata_only=true` performs "HEAD-like behavior." The current `head_url` tool sends an HTTP HEAD request. However, many servers return different headers or deny HEAD requests. The plan should specify:

- If `metadata_only=true`, send HEAD first. If HEAD fails or returns non-useful headers, fall back to GET with range/early-termination.
- Alternatively: always GET with immediate abort after headers. This is more reliable but uses more bandwidth for the request setup.

**Recommendation:** Use GET with `Range: bytes=0-0` and close the connection after receiving headers. This avoids the HEAD reliability problem while minimizing body transfer. Document this choice.

## Minor Issues

### M4: Role permission table uses hedging language

The role permission table says things like "Maybe no direct web unless current prompt allows" and "Usually no web for reviewer." These are not specifications. The table should contain definite tool access per role, derived from the current `tool-filters.ts` sets.

### M5: `grep` context_lines defaults and caps should be in the plan, not just the review

First review M1 recommended "default 0, hard cap 3" for `context_lines`. This is accepted per the review but the plan's `grep` contract (line 398) still just says "Cap number of matching lines/results" without specifying the default.

**Fix:** Replace "Cap number of matching lines/results" with explicit values:
- `context_lines` defaults to 0.
- Hard cap: 3.
- `max_results` caps total match entries; default from `mcp.maxSearchResults`.

### M6: `websearch` `status` field should be resolved

First review M3 flagged `status: 200` as an HTTP implementation detail leaking into search results. The plan still shows `status: 200` in the `websearch` output.

**Fix:** Replace `status` with `ok: true` or remove it. Search either succeeded or failed; HTTP status_code_of_DuckDuckGo_page is not model-meaningful.

### M7: Incremental deployment is underspecified

The plan has 5 steps that modify prompts, tool names, and filters incrementally. During Step 2, for example, `read` would exist but `fetch_url` would still exist too. Prompts would need to reference both old and new names during transitions. But the plan says "No hidden aliases, deprecated names, transition shims."

**Recommendation:** Each step should be independently deployable. During a step, old tool names are hard-removed and new tool names are hard-introduced. Prompts and filters are updated in the same commit. Between steps, the system is fully consistent. This means:

- Step 2 commit: remove `read_file`, `write_file`, `search_files`, `list_dir`; add `read`, `write`, `glob`, `grep`, `edit`, `apply_patch`; update all prompts and filters in one commit.
- Step 3 commit: remove `web_search`, `fetch_url`, `fetch_page_text`, `head_url`, `download_file`, `download_with_fallbacks`; add `webfetch`, `websearch`; update all prompts and filters in one commit.
- Step 4 commit: remove `list_skills`, `read_skill`, `search_skills`; add `skill`; update all prompts and filters.

Each commit is a hard cutover. No transition period. This matches the no-backward-compatibility principle.

### M8: `BuiltinToolHandler` return type loses error signaling

The plan proposes:
```ts
type BuiltinToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCallContext | undefined,
  artifact: ArtifactExecutionContext | undefined,
) => Promise<unknown>;
```

Current:
```ts
type InProcessToolHandler = (
  toolName: string,
  args: Record<string, unknown>,
  ctx?: ToolCallContext,
  artifact?: ArtifactExecutionContext,
) => Promise<{ content: unknown; isError: boolean }>;
```

The return type change from `{ content, isError }` to `unknown` removes explicit error signaling. This means every call site that invokes a handler must branch on the return type to determine success vs. failure.

**Fix:** Keep `Promise<{ content: unknown; isError: boolean }>` as the handler return type, or introduce a `ToolResult` type that both success and error results satisfy. This is a small but important type-safety detail.

### M9: Handler registration model needs a concrete adapter

The plan proposes `builtinToolRegistry.call(toolName, args, ctx, artifact)` but `InProcessServiceRegistry.callTool` takes `(serviceName, toolName, args, ctx, artifact)`. The plan needs to specify:

- How does the flat tool name map to a service name for the registry? Option: internally route all builtins as service `builtin` but keep per-tool handler dispatch.
- How does `applyToolFilter` work with flat tool names? Current filter checks `(name, service)`. With a flat namespace, filters just check `name`.

### M10: Tools outside the 9-tool target set need explicit status

The plan lists 9 target tools but the current system has many more. The following tools need explicit "stays unchanged" or "addressed in future pass" status:

| Tool | Current service | Plan status |
|------|---------------|-------------|
| `run_command` | shell | **Not mentioned** — should be stated as unchanged |
| `git_*` (8 tools) | git | **Not mentioned** — should be stated as unchanged |
| `create_note` | notes | **Not mentioned** — should be stated as unchanged |
| `plan_*` (16 tools) | plan | **Not mentioned** — should be stated as unchanged |
| `rag_*` (7 tools) | rag | **Not mentioned** — should be stated as unchanged |

**Fix:** Add an "Unchanged Tools" section that explicitly lists these tools as remaining in their current form with their current names for this pass.

## Recommended Changes Before Implementation

| Priority | Issue | Action |
|---|---|---|
| Critical | C4: `skill` action dispatch still in plan | Replace with name-based dispatch: `skill` with `name` reads, `skill` without `name` lists. |
| Critical | C5: `apply_patch` custom format still in plan | Replace with standard unified diff + `deletions` array. |
| Significant | S5: Skill mutation tools unaddressed | Remove skill mutation from model tool surface; make skills workspace files. |
| Significant | S6: Memory tools unaddressed | Add explicit section stating they stay unchanged this pass, or specify consolidation. |
| Significant | S7: Service dispatch architecture incomplete | Keep flat model namespace, internal dispatch by whatever grouping makes code clean. Keep `{content, isError}` return type. |
| Significant | S8: Spill/stash fragmentation | Unify overflow into one mechanism (stash or spill directory). |
| Significant | S9: `read_stash` decision | Remove `read_stash`; make spill files accessible via `read`. |
| Significant | S10: `webfetch` parameter interactions | Add explicit interaction table for `metadata_only`, `save_as`, `read_mode`. |
| Significant | S11: Dropped capabilities not documented | Document intentional removal of multi-URL fallback, manifests, and custom headers from `webfetch`. |
| Significant | S12: `metadata_only` HTTP method | Use GET with Range header, not HEAD. Document choice. |
| Minor | M4: Role permission hedging | Replace hedging with definite tool sets per role. |
| Minor | M5: `grep` context_lines defaults | Specify default 0, hard cap 3 in the contract. |
| Minor | M6: `websearch` status field | Replace with `ok: boolean` or remove. |
| Minor | M7: Incremental deployment | Each step is a hard cutover commit. No transition period. |
| Minor | M8: Handler return type | Keep `{ content, isError }` return type for type safety. |
| Minor | M9: Handler registration adapter | Specify how flat tool names route internally. |
| Minor | M10: Unchanged tools need explicit status | Add "Unchanged Tools" section listing `run_command`, `git_*`, `create_note`, `plan_*`, `rag_*`. |