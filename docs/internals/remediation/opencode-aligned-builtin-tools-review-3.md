# Review 3: OpenCode-Aligned Built-In Tool Redesign Plan

Date: 2026-06-07

Reviewer: third-pass review against the current plan text and runtime dispatch code, with emphasis on simple architecture, explicit cutovers, and zero backward-compatibility weight.

## Summary

The plan is much stronger after the first two reviews, but a source-level audit still found several missed issues. The most important ones are not about tool naming anymore; they are about internal consistency and runtime invariants:

- The plan still has stale architecture text that contradicts its later decisions.
- The current runtime already exposes flat model-visible tool names, but duplicate tool names are ambiguous and not guarded.
- Removing `read_stash` is a clean decision, but the plan does not specify the required `maybeStash`/dispatcher rewrite.
- The role permission table still has hedging language instead of a concrete allowlist.
- `webfetch` still has stale HEAD/runtime-owned artifact examples that contradict the newer stash/Range decisions.

## Critical Issues

### C6: The architecture section still contradicts the later handler contract

The plan's proposed architecture still defines:

```ts
type BuiltinToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCallContext | undefined,
  artifact: ArtifactExecutionContext | undefined,
) => Promise<unknown>;
```

Later, the plan correctly says handler return type must stay `Promise<{ content: unknown; isError: boolean }>` for explicit error signaling.

This contradiction is easy to miss because the later section is correct. An implementer following the earlier architecture block could still build the wrong adapter.

**Fix:** Update the architecture block itself. The canonical type should be:

```ts
interface BuiltinToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: BuiltinToolHandler;
}

type BuiltinToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCallContext | undefined,
  artifact: ArtifactExecutionContext | undefined,
) => Promise<{ content: unknown; isError: boolean }>;
```

Also remove or rewrite the earlier recommendation to register all built-ins under a single `builtin` service. The later decision is cleaner: flat model-visible names, internal grouping as an implementation detail.

### C7: Flat model-visible names need duplicate-name rejection

The current runtime already exposes tool names flat to models:

- `BaseAgent.getToolSchemas()` drops `service` and exposes only `ToolEntry.name`.
- `Dispatcher.executeLocalTool()` maps a model call back to a tool by `allTools.find((t) => t.name === tc.name)`.
- If two services expose the same name, the first one wins silently.
- External MCP tools can also have duplicate names; API listing dedupes, model schema listing does not.

The plan says the model-facing namespace should be flat, but it does not add the key invariant required by a flat namespace: **model-visible tool names must be globally unique.**

Without this, a future external MCP tool named `read`, `grep`, `webfetch`, or `skill` can shadow or be shadowed unpredictably. The ambiguity is worse after the migration because the names are intentionally generic.

**Fix:** Add a registry/catalogue invariant:

- Build one model-visible tool catalogue that rejects duplicate names at startup.
- Built-ins reserve their names globally.
- External MCP tools with duplicate names fail registration or are hidden from agent-facing schemas with an operator-visible diagnostic.
- `Dispatcher.executeLocalTool()` should not use `find()` over ambiguous entries; it should use a precomputed `Map<string, RuntimeToolEntry>` that is guaranteed unique.

This is a simple architecture requirement and should be implemented before adding generic flat names.

### C8: `read_stash` removal needs an explicit rewrite of the stash mechanism

The plan says to remove `read_stash` and make spill files accessible via `read`. That is the clean direction, but the current stash mechanism is wired around `read_stash`:

- `BaseAgent.maybeStash()` writes content to `.saivage/tmp/stash/...` and returns text that says: `Use read_stash(path="<absolute path>")`.
- `read_stash` is synthetic, added in `BaseAgent.getToolSchemas()`, and handled inline in `Dispatcher.executeLocalTool()`.
- `read_file` can read `.saivage/tmp/stash/...` today because reads are only project-root bounded, not `.saivage` denied.

The plan only states the desired end state. It does not specify the required implementation cutover.

**Fix:** Add a concrete stash rewrite step:

- Change `stashResult()` to return a project-relative path under `.saivage/tmp/stash/...`, not an absolute path.
- Change `maybeStash()` guidance to: `Use read(path=".saivage/tmp/stash/...")`.
- Remove synthetic `read_stash` from `BaseAgent.getToolSchemas()`.
- Remove the dispatcher special case for `read_stash`.
- Add guard tests that `read_stash` is absent from prompts/tool schemas and that a stashed result can be read through `read`.

This avoids keeping two retrieval paths for overflow content.

## Significant Issues

### S13: The role permission table still is not a spec

The current role table still says:

- `maybe skill`
- `Maybe no direct web unless current prompt allows`
- `depending on current conventions`
- `Usually no web for reviewer`
- `maybe webfetch/websearch only on user request`

Review 2 already identified this as M4, but it remains unfixed. This matters because the implementation step says old names are removed from allowlists and snapshots. A hedged table cannot drive an allowlist refactor.

**Fix:** Replace the table with exact tool sets derived from current `tool-filters.ts`, then apply the new names. For example, decide explicitly whether each role gets:

- `read`, `glob`, `grep`
- `write`, `edit`, `apply_patch`
- `webfetch`, `websearch`
- `skill`
- `run_command`
- unchanged plan/stage/git/memory/rag/note tools

If a tool is conditional on user request, that condition belongs in the prompt, not the filter table.

### S14: Authorization is not yet a single clean boundary

The plan says tool filters check `toolName` only, but the current code has three different authorization situations:

- Prompt exposure is filtered in `BaseAgent.getToolSchemas()`.
- In-process calls are filtered in `InProcessServiceRegistry.authorizeToolCall()` when a non-operator context exists.
- External MCP calls are not filtered with `applyToolFilter`; they are broadly denied for non-operator contexts.
- Calls with no context bypass in-process authorization.

The migration is a good opportunity to make this simpler. The plan should specify one authorization boundary for all model-visible tools.

**Fix:** Add a `ToolAuthorizer` or equivalent runtime policy used by both schema exposure and call execution. It should:

- Require `ToolCallContext` for every agent-originated call.
- Treat missing context as operator/runtime-only and never as an agent path.
- Apply the same tool-name allowlist to prompt exposure and call execution.
- Keep external MCP denial explicit unless a future pass models external tool permissions.

This removes subtle drift between what a model can see and what a direct tool call can execute.

### S15: `webfetch` still contains stale HEAD and runtime-owned artifact wording

The updated plan correctly says `metadata_only` uses GET with `Range: bytes=0-0` and that `webfetch` spill uses the stash system. But stale earlier text and examples still say:

- `metadata_only=true` performs `HEAD-like behavior`.
- Oversized content writes to a `runtime-owned log/artifact file`.
- The spilled output example returns `.saivage/tmp/webfetch/webfetch-abc123.txt`.
- Web tests say `webfetch` spills to a runtime-owned artifact file.

These contradict the later decisions.

**Fix:** Normalize all wording:

- Replace `HEAD-like` with `metadata-only GET using Range: bytes=0-0`.
- Replace `runtime-owned artifact file` with `stash file` where webfetch overflow is discussed.
- Change the output example path to `.saivage/tmp/stash/...`.
- Update web tests to assert spill-to-stash and readability through `read`.

### S16: `webfetch.save_as` behavior for binary and `auto` mode is still ambiguous

The interaction table says:

- `save_as + auto`: save whatever `auto` would return inline.
- `save_as + multimodal`: save raw bytes and return attachment.

But `auto` for an image would return an attachment, not inline text. "Save whatever auto would return inline" could mean saving a base64 data URI, decoded bytes, or original response bytes.

**Fix:** Make the rule byte-oriented:

- `save_as` always writes the fetched response body bytes, except `read_mode='text'` may write decoded text if explicitly specified.
- `read_mode='auto'` + image + `save_as` saves raw image bytes and may return an attachment if inline attachment limits allow.
- `read_mode='auto'` + text + `save_as` saves decoded text or raw bytes; choose one and state it. The simplest clean rule is: `save_as` writes raw response bytes unless `read_mode='text'` is set.

### S17: `read` needs explicit line/byte semantics

The proposed `read` inputs use `offset` and `length`, but the plan examples do not specify whether they are byte offsets or line offsets. Current `read_file` uses byte offsets. OpenCode's `read` examples often use line offsets/limits.

This matters because UTF-8 byte windows can split characters, while line windows are easier for agents editing code.

**Fix:** Choose one model-facing semantic. For simple agent ergonomics, use line-based `offset`/`limit` for text reads and reserve byte caps as internal safety limits. If preserving current byte offsets is preferred, rename parameters to `byte_offset` and `byte_length` so the tool schema is unambiguous.

Given the OpenCode-alignment goal, line-based `offset`/`limit` is the cleaner model-facing design.

### S18: `apply_patch` deletion handling is less clean than standard unified diff

The plan adds a separate `deletions` array because it says unified diff does not cover deletions natively. That is not quite true: a file deletion can be represented with `+++ /dev/null` in a unified diff.

The extra `deletions` array creates a second mutation channel and parameter interaction problems:

- What if `patch` updates a file also listed in `deletions`?
- What if `deletions` deletes a file added by the patch?
- How are deletions ordered relative to hunks?

**Fix:** Prefer pure unified diff for add/update/delete:

- New file: `--- /dev/null`, `+++ b/path`.
- Deleted file: `--- a/path`, `+++ /dev/null`.
- Updated file: normal headers.

If the parser cannot support deletions initially, omit deletion support in v1 rather than adding a parallel `deletions` array. This is simpler and more standard.

## Minor Issues

### M11: Output schemas use inconsistent field names

The plan uses `path`, `artifact_path`, `saved path`, `source`, `mime`, `mediaType`, `bytes_read`, `size_bytes`, `length`, and `inline_bytes` without a single naming convention.

This is not fatal, but it undermines the goal of a predictable tool surface.

**Fix:** Add a short naming convention:

- `path` means a project-relative path.
- `source_path` means an absolute/source file path in trusted metadata.
- `stash_path` means a project-relative stash file path.
- `saved_path` means a caller-requested project mutation path.
- `mime` or `media_type`, choose one across all attachments.
- `bytes_read` for network reads, `size_bytes` for local file size.

### M12: Directory listing caps are not specified

`read` folds in directory listing, but the directory output has no caps, sorting rule, or hidden-file behavior. Large directories can produce huge outputs.

**Fix:** Specify lexical sorting and a maximum entry count. Return `truncated` and `truncated_reason` for directory reads.

### M13: `grep` skipped output is underspecified

The `grep` output includes `skipped: []`, but the plan does not define what goes there. Binary files? Oversized files? Permission failures? Ignored directories?

**Fix:** Define `skipped` entries as `{ path, reason }` with bounded count, or remove `skipped` from model output and only return aggregate counts.

### M14: The index does not link the review documents

`docs/internals/remediation/index.md` links the plan but not the first, second, or third review documents. If these review documents are intended as current remediation records, the index should link them. If they are only working notes, they should be excluded deliberately.

Given that the reviews materially change the implementation guidance, link them under the built-in tools row or add a separate review row.

## Recommended Changes Before Implementation

| Priority | Issue | Action |
| --- | --- | --- |
| Critical | C6: Stale handler architecture | Update architecture block to `{ content, isError }` return type and remove single-service implication. |
| Critical | C7: Duplicate flat tool names | Add global unique-name invariant and startup/catalogue rejection for duplicates. |
| Critical | C8: `read_stash` removal incomplete | Rewrite `maybeStash`, `stashResult`, tool schemas, dispatcher, and tests around `read(path=...)`. |
| Significant | S13: Hedged role table | Replace with exact per-role allowlists. |
| Significant | S14: Split authorization boundary | Introduce one authorizer shared by schema exposure and execution. |
| Significant | S15: Stale webfetch wording/examples | Replace HEAD/runtime-artifact/webfetch-path wording with Range/stash wording. |
| Significant | S16: Ambiguous `save_as` bytes/text behavior | Specify raw bytes vs decoded text exactly. |
| Significant | S17: `read` offset semantics | Use line-based offset/limit or rename byte parameters. |
| Significant | S18: `apply_patch` deletion channel | Prefer pure unified diff with `/dev/null`; remove `deletions` array. |
| Minor | M11: Output field names | Add naming convention. |
| Minor | M12: Directory listing caps | Specify sort, max entries, truncation. |
| Minor | M13: `grep.skipped` | Define skipped entries or remove field. |
| Minor | M14: Index links | Link review documents or explicitly exclude them. |
