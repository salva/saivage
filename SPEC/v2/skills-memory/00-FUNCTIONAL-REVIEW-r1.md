# Phase A — Functional Analysis Review (round 1)

Status: REVIEW
Reviewer: GPT-5.5
Verdict: REVISE
Date: 2026-05-23

## Verdict

REVISE: the analysis gets several major outcomes right, especially that built-in skills do not load and memory is not implemented, but it misstates runtime tool access and several MCP write-path behaviors badly enough that Phase B would start from a distorted model.

## Blocking issues

1. **Claim/quote:** "the `skills` service is **only available to the Coder**" and "the Manager ... never writes skills itself" (§1.2); later, "only the Coder has access today" (§2.8).

   **What's wrong:** This treats the spec access matrix as runtime truth. The actual runtime tool filter disagrees. Coder, Researcher, and Data Agent are explicitly blocked from `create_skill` and `update_skill`; Manager has no role filter and therefore receives all available tools; Chat also has no role filter in `ROLE_TOOL_FILTER`. So the document reverses the implemented write-access story. The spec matrix is useful evidence, but it is not what the running agent tool catalog enforces.

   **Evidence:** `src/agents/base.ts:607-610` filters the actual tool catalog through `ROLE_TOOL_FILTER`; `src/agents/base.ts:982-985` puts `create_skill` and `update_skill` in `WORKER_EXCLUDED_TOOLS`; `src/agents/base.ts:1009-1011` applies that exclusion to Coder, Researcher, and Data Agent; `src/agents/base.ts:990` states roles without an entry get all available tools. `SPEC/v2/05-MCP-SERVICES.md:29` says the matrix is convention-based, while `SPEC/v2/05-MCP-SERVICES.md:40` says Skills belongs to Coder only.

   **Suggested correction:** Separate "spec says" from "runtime does". Add an actual runtime access table for skills/memory/index/read-only tools, and rewrite every conclusion that depends on "Coder-only" access: Manager skill authoring, Coder skill authoring, pull-on-demand `list_skills`/`read_skill`, and write-permission requirements.

2. **Claim/quote:** "the Coder must call `update_skill` to fix the index after creation, or hand-craft the index entry through the filesystem service" (§1.5.2).

   **What's wrong:** `update_skill` cannot fix the index. It accepts `reason`, but ignores it; it writes only the markdown file; it does not accept triggers; it does not update `index.json`; it does not update `updated_at`. The only current way to fix triggers after `create_skill` is to edit `index.json` through another write path. The analysis correctly notices that `create_skill` writes `triggers: []`, but then gives a false remediation path.

   **Evidence:** `src/mcp/builtins.ts:1057` defines `update_skill` parameters as `name`, `content`, and `reason`; `src/mcp/builtins.ts:1103-1111` resolves `${name}.md` and writes only that file. `src/mcp/builtins.ts:1087-1100` is the only index mutation in the skills handler, and it happens only in `create_skill`, with `triggers: []` at `src/mcp/builtins.ts:1096`.

   **Suggested correction:** State plainly that `create_skill` creates an unmatchable skill and the skills MCP service provides no way to make it match, update its metadata, record the reason, or refresh `updated_at`.

3. **Claim/quote:** "Atomic writes via document store. `readDoc` / `writeDoc` / `deleteDoc` ... give us tmp-then-rename atomicity and Zod validation for free. Preserve." (§3 item 2).

   **What's wrong:** This is false for the current skill write path. The loader uses `readJsonOrNull` plus Zod validation on read, but `create_skill` and `update_skill` use raw `writeFileSync`. The index is serialized with `JSON.stringify` without `SkillIndexSchema` validation and without the document-store atomic-write pipeline. Calling this a property the current skill system "gets right" is materially wrong.

   **Evidence:** `src/mcp/builtins.ts:1086` writes skill content via `writeFileSync`; `src/mcp/builtins.ts:1100` writes `index.json` via `writeFileSync`; `src/mcp/builtins.ts:1110` writes updated content via `writeFileSync`. The atomic helper is `writeDoc` in `src/store/documents.ts:66-85`; the skills handler does not use it.

   **Suggested correction:** Move this from "gets right" to "missing / broken today". The current read path validates; the current write path does not.

4. **Claim/quote:** "Memory and Index services are registered as stubs ... calls return errors" (§1.5.5), while the analysis also reasons from the spec access matrix about which roles have Memory access (UNK-2).

   **What's wrong:** The document does not clearly distinguish three states: spec access matrix, runtime tool catalog, and direct `callTool` behavior. Runtime registration sets memory/index `available: false`; `getAllTools()` omits unavailable services; `callTool()` rejects unavailable in-process services before invoking the stub handler. In normal agent use, no role has memory tools in its tool catalog at all, regardless of the access matrix.

   **Evidence:** `src/mcp/builtins.ts:1132-1139` defines memory/index tools; `src/mcp/builtins.ts:1167-1168` registers memory and index with `{ available: false }`; `src/mcp/runtime.ts:221` skips unavailable in-process services in `getAllTools()`; `src/mcp/runtime.ts:182-184` throws for unavailable services in `callTool()`. The spec matrix in `SPEC/v2/05-MCP-SERVICES.md:41-42` grants Memory/Index to Coder, Researcher, and Inspector, but that is not the agent-facing runtime state.

   **Suggested correction:** Say "memory/index are registered but hidden from the agent-facing catalog and unavailable to every role today." Then separately note that the spec matrix is stale or aspirational.

5. **Claim/quote:** "User-wide ... has to live somewhere else (e.g. an `agents.md`-style file in the user's home, fetched by the runtime), or not exist at all" (§2.6), and Option B under §5.4 proposes "a user-managed file outside `.saivage/`".

   **What's wrong:** This violates the architectural ground rule for this review: JSON/JSONL files under `<project>/.saivage/` only, nothing global. It also contradicts the document's own FR-4/FR-5 and OOS-3, which say user-wide and cross-project scopes are out of scope. Even as an open option, it should not be presented as viable under the mandated constraints.

   **Evidence:** `00-FUNCTIONAL-ANALYSIS.md:541-545` says user-wide and cross-project scopes are out of scope and all scopes resolve to one project directory tree; `00-FUNCTIONAL-ANALYSIS.md:739-744` then proposes reading a home/repo-level file as a virtual scope. `00-FUNCTIONAL-ANALYSIS.md:832-833` again says user-wide preferences are deferred.

   **Suggested correction:** Remove home-file and virtual global-scope options from Phase A, or mark them explicitly non-compliant with the review ground rules.

6. **Claim/quote:** The functional requirements are presented as "Numbered, testable" (§4), but several are not actually testable or are Phase-B design choices.

   **What's wrong:** FR-11 says the budget "MAY be specified in tokens rather than record count" and punts the choice to Phase B; FR-16 requires a compaction "write opportunity" via a "synthesized tool call or summary template extension" without an observable success condition; FR-22 says the web UI "MUST" list records without deriving that requirement from the current v2 agent architecture or user-facing contract. These are not clean functional requirements. They mix design alternatives, implementation hooks, and unsupported scope expansion.

   **Evidence:** `00-FUNCTIONAL-ANALYSIS.md:582-586` contains the FR-11 MAY/design-choice language; `00-FUNCTIONAL-ANALYSIS.md:612-617` contains the vague compaction hook; `00-FUNCTIONAL-ANALYSIS.md:646-648` makes web UI listing mandatory; `00-FUNCTIONAL-ANALYSIS.md:915-916` admits FR-22 depends on an unstated operator desire.

   **Suggested correction:** Convert these into verifiable outcomes or downgrade them to open questions. A requirement should state what artifact, tool result, or prompt/context change proves it passed.

7. **Claim/quote:** "`<thisDir>/../../skills` — relative to `src/skills/`, which resolves to the **built-in** `saivage/skills/` shipped in the repo" (§1.1).

   **What's wrong:** That is true for source execution under `src/skills`, but the built package is bundled into `dist/cli.js`. In the built runtime, `import.meta.dirname` is the `dist` directory, so the same `../../skills` expression points outside the package's `saivage/skills` directory. The outcome still supports the "built-ins are dead" claim, but the evidence is incomplete and underestimates the packaging break: built-in skills are not copied into `dist`, and there is no `skills/index.json` anywhere checked.

   **Evidence:** `src/skills/loader.ts:116` joins `thisDir, "..", "..", "skills"`; the bundled output has the same join at `dist/cli.js:6879`; `package.json:13-15` and `tsup.config.ts:3-10` show a single tsup bundle with no asset copy. A targeted find found no `skills/index.json` under `saivage/skills`, `saivage/dist`, `saivage/dist_new`, or the three checked project `.saivage` directories.

   **Suggested correction:** Keep the "built-ins do not load" conclusion, but cite both source and bundled-runtime path behavior. Do not imply the source-relative path analysis covers production.

8. **Claim/quote:** The analysis flags two skill formats but misses the current spec/code path mismatch around `file` values and `read_skill` (§1.5.1).

   **What's wrong:** The skill-creation spec's example index entry uses `"file": "skills/skill-name.md"`, but the loader resolves `entry.file` relative to the skills directory. That example would make the loader look for `.saivage/skills/skills/skill-name.md`. Separately, `read_skill` ignores `index.json` entirely and always reads `${name}.md`, so any valid index entry whose `file` is nested or renamed cannot be read through the skills MCP tool. This is a real functional inconsistency the analysis should catch.

   **Evidence:** `SPEC/v2/skills/skill-creation.md:50-58` gives the `file: "skills/skill-name.md"` example; `src/skills/loader.ts:241-244` joins the skills dir with `entry.file`; `src/mcp/builtins.ts:64-68` maps `read_skill` names to `${name}.md` and `src/mcp/builtins.ts:1073-1079` uses that mapping.

   **Suggested correction:** Add this to spec-vs-code-vs-disk inconsistencies. It is separate from the frontmatter-vs-index problem.

## Non-blocking issues

1. **Claim/quote:** The skillContext table says Reviewer, Data Agent, and Designer have no `tags` (§1.3).

   **What's wrong:** They do pass `task.tags ?? []`. This does not invalidate the "tool/path triggers are dead" conclusion, but it makes the table unreliable.

   **Evidence:** `src/agents/reviewer.ts:90-93`, `src/agents/data-agent.ts:83-86`, and `src/agents/designer.ts:84-87` all include tags.

   **Suggested correction:** Fix the table and adjust the consequence text. For Planner and Chat, `tag:` triggers cannot fire because neither passes tags; for workers/reviewer/data/designer, `tag:` can fire.

2. **Claim/quote:** "Only `agent:` and `tag:` triggers can" select skills for Planner and Chat (§1.3 consequence 2).

   **What's wrong:** Neither Planner nor Chat passes tags. Also, keyword triggers can technically match their fixed descriptions (`"Strategic planning and stage dispatch"`, `"User-facing chat interface"`), though those matches are not objective/user-message-aware. The problem is not that keyword cannot fire; it is that it fires only on static boilerplate.

   **Evidence:** `src/agents/planner.ts:177-180` and `src/agents/chat.ts:156-159` pass only `agentRole` and fixed `description`.

   **Suggested correction:** Say Planner/Chat can only match `agent:` plus static-description `keyword:` triggers today; `tag:`, `tool:`, and `path:` do not fire for them.

3. **Claim/quote:** `path:<glob>` is listed as supported glob matching (§1.1, §1.3).

   **What's wrong:** The call sites make `path:` dead today, but the loader implementation is also weaker than the spec. The spec says minimatch; the code uses a hand-rolled regex. Its replacement order escapes the dot in the generated `.*`, so `**` patterns do not behave like real globstars.

   **Evidence:** `SPEC/v2/06-SYSTEM-DESIGN.md:233-236` says `path:<glob>` uses minimatch-like matching; `src/skills/loader.ts:230-236` implements custom replacement logic.

   **Suggested correction:** Add this as a code/spec mismatch if path triggers remain in the analysis.

4. **Claim/quote:** "The MCP `skills` service exposes `list_skills`, `read_skill`, `create_skill`, `update_skill`. These are the only write paths" (§1.2).

   **What's wrong:** They are the only named skills-service write paths, but not the only possible agent write paths to the same files: any role with filesystem write access can edit or delete `.saivage/skills/index.json` and skill markdown directly. The actual runtime role filters make this especially important, because Manager and Chat currently appear to receive broad tools.

   **Evidence:** `src/agents/base.ts:990-992` leaves unlisted roles unfiltered; `SPEC/v2/05-MCP-SERVICES.md:29` says the matrix is convention-based; `src/mcp/builtins.ts:278-279` implements generic filesystem `write_file`.

   **Suggested correction:** Qualify it as "only skills-service write paths" and separately discuss direct filesystem writes as an escape hatch / integrity hole.

5. **Claim/quote:** "schema validation at load time ... Preserve" (§3 item 3).

   **What's wrong:** This is mostly right, but it is limited to `index.json` loading. `list_skills` returns raw JSON without validation, `create_skill` can append duplicate names, and `update_skill` can leave metadata stale. The current system has read-time validation in the loader, not comprehensive skill-state validation.

   **Evidence:** `src/skills/loader.ts:124` and `src/skills/loader.ts:139` use Zod on load; `src/mcp/builtins.ts:1067-1071` parses and returns raw index JSON; `src/mcp/builtins.ts:1092-1099` blindly pushes a new entry.

   **Suggested correction:** Narrow the praise and add the MCP validation gaps.

6. **Claim/quote:** "migration cost is zero" because the three checked deployments have no project-level skills (§4 FR-23).

   **What's wrong:** The no-backward-compatibility conclusion is mandated and acceptable, but "cost is zero" is overclaimed from a sample of three local deployments. It is enough to say the three reviewed live project states have no `.saivage/skills/` directory.

   **Evidence:** `00-FUNCTIONAL-ANALYSIS.md:653-656` generalizes from §1.4. The verified disk check covers `saivage-v3/.saivage`, `diedrico/.saivage`, and `getrich/.saivage` only.

   **Suggested correction:** Remove the global cost claim; keep the local evidence.

7. **Claim/quote:** "The Planner's lessons-learned channel collapses to whatever ends up in the free-form compaction summary, which is itself thrown away at the next compaction" (§2.9).

   **What's wrong:** The gist is directionally right, but "thrown away" is imprecise. The next compaction summarizes the current conversation, which includes the previous summary unless it is lost through summarization or hard-truncation fallback. The stronger verified issue is that compaction has no structured durable write channel.

   **Evidence:** `src/runtime/compaction.ts:94-119` creates a continuation summary; `src/runtime/compaction.ts:125-139` has a hard-truncation fallback.

   **Suggested correction:** Replace the absolute wording with a precise statement about lossy summarization and lack of structured persistence.

8. **Claim/quote:** Several citations point to whole files or section labels but not stable line evidence.

   **What's wrong:** The document asks readers to trust broad citations such as "full file", "§10", or spec sections. For controversial claims like access control, write paths, and built-in load failure, that is too loose.

   **Evidence:** The access-control conclusions cite `05-MCP-SERVICES.md` but not `src/agents/base.ts`; the built-in path claim cites `loader.ts` but not `dist/cli.js`; the `update_skill` conclusion cites the handler lines but misses the absent index mutation.

   **Suggested correction:** Add exact source anchors for every must-fix factual claim.

## Missing content

1. **Actual runtime access matrix.** The analysis needs a current-code matrix for every relevant role and tool family: skills read, skills write, memory/index availability, filesystem write, and Chat/Manager fall-through behavior. Without this, the authoring-permission requirements are built on the wrong substrate.

2. **Cross-agent visibility rules.** FR-12 covers eager `target_agents`, but the analysis does not define who can discover/search/read memories, whether one agent can see another agent's stage/session records, or how Planner/Manager/Chat visibility differs.

3. **Notes vs memory as a product boundary.** The document says `NoteManager` is a useful model and later says not to replace it, but it does not answer whether permanent user notes are a special case of project memory, a higher-priority input channel, or a separate conflict source. This matters because `NoteManager.formatNotesForInjection()` already tells the Planner how to resolve note conflicts.

4. **Relation to inspections.** The Inspector section mentions failure-mode memory, but the analysis does not connect memory to `inspections/<id>.json` lifecycle, `expires_at`, report promotion, stale report review, or whether inspection findings should be retrieved as memory or remain reports.

5. **Compaction sufficiency.** The analysis assumes memory is required for Planner recovery, but it does not state what compaction plus `plan.json` / `plan-history.json` already solves, what it cannot solve, and how to test the boundary. This is especially important because `plan-history.json` is specified as append-only, not truncated (`SPEC/v2/01-DATA-MODEL.md:472`).

6. **Concurrent writes and conflict resolution under JSON-on-disk.** Manager can dispatch workers in parallel, and future memory authoring could have multiple agents writing the same index/JSONL. The analysis discusses semantic contradictions but not file-level write races, duplicate ids, stale reads, or merge behavior.

7. **Secret/sensitive-content handling.** A memory feature will tempt agents to persist provider details, tokens, auth profile facts, shell history, and environment snippets. The analysis needs functional requirements that prevent storing or surfacing secrets from `.saivage/auth-profiles.json`, provider configs, env files, token files, and backups.

8. **Deletion/archival ergonomics for current skills.** The document notices there is no `delete_skill`, but it does not follow through into functional requirements for deletion, archival, human review, and recovery from bad generated content.

9. **Tests tied to observed defects.** The requirements should include tests that reproduce today's failures: no built-in index, `create_skill` writes `triggers: []`, `update_skill` does not update metadata, `read_skill` ignores `entry.file`, unavailable memory/index tools are hidden, and no agent populates `tools`/`filePaths`.

## Confirmations

1. **Built-in skills are effectively dead today.** There is no `saivage/skills/index.json`, no bundled `dist` skills index, and no project-level skills index in the three checked `.saivage` trees. The loader requires `index.json` and silently continues when it is missing.

2. **The three requested project state dirs lack `.saivage/skills/`.** `saivage-v3/.saivage/skills`, `diedrico/.saivage/skills`, and `getrich/.saivage/skills` were all missing on the host checkout.

3. **`tool:` and `path:` triggers are dead through current agent constructors.** None of the inspected `skillContext` call sites populate `tools` or `filePaths`.

4. **`create_skill` creates unmatchable entries.** It writes `triggers: []`, and `resolveSkills()` drops entries with score 0.

5. **Memory/index are not implemented.** The tools are declared, but memory and index are registered with `{ available: false }`.

6. **The canonical spec references in the reviewed document use `SPEC/v2/`, not `SPECS/v2/`.** A `SPECS/v2` directory exists in the workspace, but the reviewed analysis cites `SPEC/v2`.

7. **The numeric FR count is 26.** The document defines FR-1 through FR-26, with no missing or duplicate FR numbers in that range.

8. **The `SkillEntrySchema` / `SkillIndexSchema` shape is correctly described.** The required fields in `src/types.ts` match the analysis: `name`, `file`, `description`, `triggers`, optional `target_agents`, `created_at`, and `updated_at`.

## Out-of-scope quibbles

1. I would avoid the word "record" as the main user-facing noun until Phase B chooses whether this is one subsystem or two. It is serviceable for analysis, but it makes the text feel more settled than it is.

2. The examples are useful, but there are enough of them that the functional argument occasionally gets diluted. The next round can cut examples after each requirement is backed by code evidence.

3. The "preserve" section reads too much like a design preferences list. Keep only properties demonstrably present in v2 today, and move the rest to Phase B input.