# F31 — Analysis r1

## Problem restated

The JSDoc on `BaseAgentConfig.systemPrompt` advertises a `prompts/<role>.md` layout that does not exist in the repository.

- The lying comment: [src/agents/base.ts](src/agents/base.ts#L104-L105).
- There is no `prompts/` directory at the repo root (`ls prompts` → "No such file or directory" as of this round).
- Every agent constructs its system prompt from a TS string constant and passes it directly through `BaseAgentConfig.systemPrompt`:
  - [src/agents/planner.ts](src/agents/planner.ts#L194-L209)
  - [src/agents/manager.ts](src/agents/manager.ts#L264-L278)
  - [src/agents/coder.ts](src/agents/coder.ts#L139-L155)
  - and similarly for `researcher.ts`, `reviewer.ts`, `data-agent.ts`, `inspector.ts`, `chat.ts`, `designer.ts`.

A reader who follows the JSDoc looks for a `prompts/` tree, finds nothing, and either spends time hunting or assumes the comment is correct and the build is broken. The JSDoc is a stale promise — the unbuilt half of the design F18 argues for.

## Contract

`BaseAgentConfig.systemPrompt: string` is a synchronous, already-rendered system prompt string. The field has no loader contract, no path semantics, and no IO behaviour today. The comment is the only suggestion otherwise.

## Call sites & dependencies

- Type defined: [src/agents/base.ts](src/agents/base.ts#L103-L106).
- Stored as a `protected` field and used to seed every LLM call: [src/agents/base.ts](src/agents/base.ts#L136), [src/agents/base.ts](src/agents/base.ts#L171-L173), [src/agents/base.ts](src/agents/base.ts#L496), [src/agents/base.ts](src/agents/base.ts#L831).
- Producers: each agent under `src/agents/*.ts` builds a string literal (interpolated from `*_PROMPT` constants under `src/agents/conventions.ts`) and passes it as `systemPrompt`.
- No external/runtime code reads `prompts/` and no build step copies any such directory into `dist/`.

## Relationship to F18

F18 (approved, Proposal B — see [SPEC/v2/review-2026-05/F18/APPROVED.md](SPEC/v2/review-2026-05/F18/APPROVED.md) and [SPEC/v2/review-2026-05/F18/02-design-r2.md](SPEC/v2/review-2026-05/F18/02-design-r2.md)) creates the `prompts/<role>.md` tree, adds a `loadRolePrompt(role)` loader in `src/agents/prompts.ts`, ships the directory into `dist/` via `tsup.config.ts`, and explicitly rewrites the very JSDoc this issue is about. F18's Plan r2 names the JSDoc rewrite in its design discussion of `BaseAgent`:

> `BaseAgentConfig.systemPrompt` JSDoc is rewritten to: `/** Rendered role prompt (see prompts/<role>.md and src/agents/prompts.ts). */`. F31 is resolved.

Therefore F31 is fully subsumed by F18 on the path that F18 actually takes (build the loader, make the comment true). The only independent question F31 has to answer is what to do if F18 slips, is reverted, or is sequenced after another change that touches `base.ts` first.

## Constraints any solution must respect

- Architecture-first, no backward compatibility: do not introduce migration shims or `@deprecated` aliases.
- No new docstrings/comments on code we are not otherwise modifying — but the existing comment on `systemPrompt` IS the thing being changed, so editing it (or deleting it as part of the field's surrounding edits) is in-scope.
- No emojis.
- Out-of-scope: `src/skills/`, `SPEC/v2/skills*`, memory subsystem. F31 does not cross that boundary.
- Ordering: any F31 edit to the JSDoc on [src/agents/base.ts](src/agents/base.ts#L104-L105) trivially conflicts with F18's edit at the same line. F31 must either (a) be deferred so F18 is the only writer there, or (b) be a pure-deletion preemptive change that F18 then re-adds with the correct wording.
