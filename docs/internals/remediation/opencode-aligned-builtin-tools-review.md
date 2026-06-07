# Review: OpenCode-Aligned Built-In Tool Redesign Plan

Date: 2026-06-07

Reviewer: self-review of `opencode-aligned-builtin-tools-plan.md`

## Summary

The plan is structurally solid, covers the right scope, and makes the correct no-backward-compatibility call. However, it has several concrete issues and a few missed opportunities for higher-level simplification. This review identifies 10 issues (3 critical, 4 significant, 3 minor) and 3 architectural alternatives worth considering before implementation starts. It was updated after operator review to keep `webfetch.save_as`, add automatic spill-to-file behavior, and make `read_mode='auto'` the default for `read` and `webfetch`.

---

## Critical Issues

### C1: `webfetch` format enum is the same problem we just fixed

The plan introduces `format: "markdown | text | html | metadata | attachment"` on `webfetch`. This is exactly the same kind of mixed-layer parameter we rejected for `read_file.response_format`. The `format` values conflate three different decisions:

1. **What to fetch** — the HTTP request semantics (GET vs HEAD-like metadata).
2. **How to present text** — markdown vs raw text vs raw HTML.
3. **Whether to attach media** — attachment mode for images.

These are not the same axis. An agent requesting metadata for an image URL does not want `format: "attachment"`. An agent fetching an HTML page may want markdown or raw HTML depending on the task. An image response should auto-attach regardless of what the agent "requested" as format, because the agent cannot know the content-type before fetching.

**Recommendation:** Split into orthogonal parameters and use the same `read_mode` vocabulary as `read`:

```json
{
  "url": "string",
  "read_mode": "auto | text | multimodal",
  "metadata_only": "boolean?",
  "max_bytes": "number?",
  "max_inline_bytes": "number?",
  "save_as": "string?"
}
```

- `read_mode='auto'` (default): fetch the body and infer text vs multimodal from content-type.
- `metadata_only=true`: HEAD-like metadata behavior, no body.
- Image responses auto-attach in `auto` mode.
- Remove `format="attachment"` entirely. Attachments are driven by response content-type, not by a model pre-declaring intent.
- If the text body exceeds `max_inline_bytes`, spill to a runtime-owned artifact file and return the path plus a capped preview.
- Keep `save_as` for direct authorized persistence when the agent's intent is to save the fetched body rather than inspect it inline.

This avoids the semantic layering problem and mirrors how OpenCode's `webfetch` actually works: it does not have an explicit `attachment` format; images auto-attach.

### C2: `read` is three tools in a trench coat

The plan originally folded directory listing, text file reading, and multimodal attachment reading into one `read` tool via `read_mode: "text | multimodal | directory"`. This creates a tool with three entirely different output shapes, which is the kind of overload that confuses agents.

OpenCode's `read` tool handles this differently: it reads a path. If the path is a directory, it returns entries. If the path is a file, it returns text or an attachment. The mode is inferred from what the path actually is, with `read_mode` as an override only for the text-vs-multimodal choice on files. Directory listing is not a separate explicit mode; it falls out naturally.

**Recommendation:** Remove `read_mode="directory"`. Instead:

- If `path` points to a directory, always return directory entries. No mode needed.
- If `path` points to a file, `read_mode` controls auto/text/multimodal behavior.
- Default to `read_mode='auto'`, not `text`, so agents can call `read` without already knowing whether a path is text or supported media.
- This makes `read_mode` a simple `"auto" | "text" | "multimodal"` with a smart default.

This also eliminates the question of "what if the agent passes `read_mode='directory'` on a file path" — a confusing edge case the plan does not address.

### C3: `apply_patch` custom format is an unnecessary invention

The plan proposes a custom `*** Begin Patch` / `*** Update File:` / `*** End Patch` envelope format. This is not a standard, no model is trained on it, and building a parser for it is the highest-risk item in the entire plan. The plan itself flags this risk but does not consider the simpler alternative.

OpenCode's `apply_patch` uses exactly this format, but models are not natively trained on it either — they learn it from the tool description and few-shot examples. The same learning applies to any format. The question is: what format has the lowest implementation risk and the highest model familiarity?

**Recommendation:** Use standard unified diff format instead:

```
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
 line1
-old line
+new line
+added line
 line3
```

Rationale:

- Models are heavily trained on unified diff; it appears in commit messages, PRs, and code review data.
- Node.js already has `diff` parsing libraries or we can write a focused unified-diff parser in ~100 lines.
- The plan's custom format adds a second thing models must learn from scratch, with no training data advantage.
- If the plan wants to support "add file" and "delete file" operations that unified diff does not cover natively, add two small extensions: `--- /dev/null` for new files and an explicit `delete: true` flag on the patch, or a separate `delete` operation in the input schema.

Alternative input:

```json
{
  "patch": "string (unified diff)",
  "deletions": ["path/to/delete.ts"]
}
```

This keeps the diff standard but adds a clean extension for deletions.

---

## Significant Issues

### S1: `skill` action-dispatch pattern is fragile

The plan proposes `skill` with `action: "list | read | search"` and conditional required fields (`name` for read, `query` for search). This pattern — one tool with multiple actions controlled by a dispatch field — is well-known to be error-prone with LLMs. Models frequently omit the `action` field or pass `name` when they mean `query`.

OpenCode handles this by having `skill` be a single "load skill by name" tool, with discovery happening through other means (the tool catalogue itself, or the system prompt listing available skills). The multi-action dispatch is an unnecessary complexity.

**Recommendation:** Split into two tools or simplify:

- Option A: `skill list` and `skill read` as two separate tools. Cleaner for the model, simpler to validate, clearer error messages.
- Option B: `skill` takes only `name` (required). `skill` with no name defaults to listing available skills. Drop `search` unless there is a concrete use case that cannot be covered by `glob`/`grep` on the skill files.

Option B is closest to OpenCode and simplest. Option A is safest if we want strict per-action validation. The current plan's multi-action dispatch is the worst of both worlds.

### S2: `webfetch.save_as` needs explicit write semantics, not removal

The plan allows `webfetch` to optionally save fetched content to a project path. This means `webfetch` can mutate the project filesystem, which breaks the simple "web tools are read-only" assumption that the role permission table depends on.

However, operator review confirmed that `save_as` is desirable: it avoids an unnecessary model round trip and avoids filling context with large data that the agent only wants to persist. This is also consistent with `run_command`, which writes oversized output to runtime-owned files and returns paths.

**Recommendation:** Keep `save_as`, but make the write semantics explicit:

- If `save_as` is omitted and inline content is too large, write to a runtime-owned artifact path under `.saivage/tmp/webfetch/` and return the path plus a capped preview. This does not use project write permissions because it is runtime-owned evidence, analogous to command logs.
- If `save_as` is provided, write to that caller-requested project path using the exact same authorization as `write`.
- The role permission table must treat `webfetch` as a potentially mutating tool when `save_as` is available, or the runtime must reject `save_as` for roles without write privileges.
- Tool output should clearly distinguish `artifact_path` (runtime-owned spill) from `path`/`saved_path` (project mutation).

### S3: `edit` should support creating new files

The plan says "File must exist and be text" for `edit`. But one of the most common agent patterns is: check if a file exists, then either edit it or create it. OpenCode's `edit` tool also rejects missing files, but OpenCode has `write` for creation.

In Saivage, if `edit` rejects missing files, the agent must use `write` for new files. That is fine as long as prompts make the distinction clear. However, the plan should explicitly document this boundary and consider whether `edit` with an empty `old_string` on a missing file should create the file, since that is a natural model behavior.

**Recommendation:** Keep `edit` as requiring the file to exist. Document clearly in the tool description that new files use `write`. Do not add create-via-edit because it blurs the tool boundary and makes `old_string=""` ambiguous (replace nothing? replace the empty string at every position?).

### S4: `glob` argument name `path` is ambiguous with `read` `path`

In `glob`, `path` means "root directory to search under." In `read`, `path` means "the file or directory to read." In `grep`, `path` means "root directory to search under." This overloading is confusing for agents.

OpenCode uses `directory` for the root in `glob` and `path` for the target in `read`. The current Saivage `search_files` uses `directory`.

**Recommendation:** Use `path` consistently to mean "the target" in `read` and `write`, and use a different name for "search root" in `glob` and `grep`. Options:

- `root` — clear but unusual.
- `directory` — matches current `search_files` convention.
- `base` — concise.

`directory` is the most familiar to models that have seen the current Saivage schema. Use `directory` for `glob` and `grep` search roots, `path` for file targets.

---

## Minor Issues

### M1: `grep` `context_lines` is underspecified

The plan mentions `context_lines` but does not specify default, max, or how it interacts with `max_results`. If `context_lines=3` and there are 50 matches, the output could be enormous. The plan should state a default of 0 (match lines only) and a hard cap on context lines per match (e.g., max 3).

### M2: Plan does not address `run_command` in the context of `edit`/`apply_patch`

Prompts currently tell agents to use `write_file` for all file changes and `run_command` for everything else. After this migration, prompts should steer agents toward `edit` and `apply_patch` for code changes and reserve `run_command` for build/test/inspect operations. The plan mentions prompt updates but does not call out this specific behavioral shift, which is arguably the most important prompt change.

### M3: `websearch` output includes `status: 200`

The DuckDuckGo HTML scraper returns `status` from the HTTP response to DuckDuckGo, not from the search itself. This is an implementation detail that leaks through to the model. The plan should specify whether `status` is kept (as upstream HTTP status) or replaced with a search-specific success/failure indicator.

---

## Architectural Alternatives

### A1: Tool groups instead of a flat namespace

The plan puts all built-ins in a flat namespace: `read`, `write`, `edit`, etc. This works for 9 tools but will not scale if Saivage later adds `lsp_diagnostics`, `lsp_references`, `capture_screenshot`, `ask_operator`, and others. Tool names will collide or become verbose.

Alternative: group tools by domain using a prefix separator that the model sees as part of the name:

- `fs.read`, `fs.write`, `fs.edit`, `fs.glob`, `fs.grep`
- `web.fetch`, `web.search`
- `skill.load`

This keeps names short, avoids collisions, and makes the tool catalogue self-organizing. OpenCode does not do this (it stays flat), but OpenCode is a single-user interactive tool, not a multi-agent autonomous runtime. Saivage's tool surface will grow; flat naming will become a problem.

**Verdict:** Not worth introducing now. The 9-tool set fits flat naming. Revisit if/when the surface exceeds ~15 tools. Document this decision so it can be revisited.

### A2: Higher-level "project operations" abstraction

Instead of giving agents low-level file tools and letting them compose operations, Saivage could expose higher-level operations that encapsulate common workflows:

- `refactor.rename(path, old_name, new_name)` — rename a symbol across files.
- `project.build()` — run the build.
- `project.test(filter?)` — run tests.

This would reduce agent errors and make the runtime more auditable. However, it is a fundamentally different architecture that requires domain-specific dispatch, not just tool renaming.

**Verdict:** Out of scope for this pass. The low-level tool alignment with OpenCode is the right first step. Higher-level abstractions can be built on top of the new tool surface later, as composite tools or agent-internal workflows.

### A3: Unified content-addressable result store

Instead of each tool returning its own output shape, all tools could write results to a content-addressable store and return a reference. The agent then reads results by reference. This would:

- Bound memory usage uniformly.
- Support streaming large results.
- Enable caching and deduplication.
- Make attachment handling uniform (everything is a reference; media references carry MIME info).

This is how some agent frameworks (e.g., Anthropic's tool use with partial results) handle large outputs. However, it is a major architectural change.

**Verdict:** Too large for this pass. The current approach of tool-specific output shapes with bounded results is adequate. The content-addressable store is a good v3 candidate if/when tool outputs become a memory or latency bottleneck.

---

## Conclusions

The plan is directionally correct and the scope is well-chosen. The three critical issues — `webfetch` format conflation, `read` triple-mode overload, and `apply_patch` custom format — should be fixed before implementation starts because they would embed the same class of design mistake we just corrected with `response_format`. The significant issues are real but not blocking; they can be resolved during implementation with small design tweaks.

### Recommended Changes Before Implementation

| Priority | Issue | Action |
| --- | --- | --- |
| Critical | C1: `webfetch` format enum | Replace with `read_mode='auto' \| 'text' \| 'multimodal'` plus `metadata_only`. Remove `format="attachment"`. Auto-attach images and spill oversized inline text to runtime-owned files. |
| Critical | C2: `read` triple-mode | Remove `read_mode="directory"`. Infer directory listing from path type. Keep `read_mode: "auto" \| "text" \| "multimodal"` with `auto` as default. |
| Critical | C3: `apply_patch` custom format | Use unified diff + `deletions` array. |
| Significant | S1: `skill` multi-action | Simplify to `skill` with `name` (required for read, omitted for list). Drop `search`. |
| Significant | S2: `webfetch.save_as` | Keep it, but enforce write authorization and add automatic runtime-owned spill files for oversized inline content. |
| Significant | S3: `edit` new-file behavior | Keep file-must-exist; document clearly. |
| Significant | S4: `glob`/`grep` `path` vs `directory` | Use `directory` for search roots, `path` for file targets. |
| Minor | M1: `grep` context_lines | Default 0, hard cap 3. |
| Minor | M2: Prompt behavioral shift | Explicitly call out edit/patch vs write/shell guidance. |
| Minor | M3: `websearch` status | Replace with search-level indicator or remove. |

### Overall Assessment

The plan is **implementable with revisions**. Fix the three critical issues, apply the significant-issue tweaks, and keep `webfetch.save_as` with explicit authorization and spill semantics. The architectural alternatives are worth documenting as future considerations but should not delay this pass.
