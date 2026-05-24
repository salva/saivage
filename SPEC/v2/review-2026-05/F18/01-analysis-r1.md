# F18 — Analysis r1

## Problem restated

Every long-lived agent in `src/agents/` carries its system prompt as a multi-hundred-line backticked template literal at the top of its TS file. The nine prompts together account for ~1000 lines of pure natural-language guidance interleaved with code:

| Agent | File | Prompt range | Lines |
|---|---|---|---|
| Planner | [src/agents/planner.ts](src/agents/planner.ts#L18-L159) | `PLANNER_PROMPT` | 142 |
| Manager | [src/agents/manager.ts](src/agents/manager.ts#L21-L265) | `MANAGER_PROMPT` | 245 |
| Coder | [src/agents/coder.ts](src/agents/coder.ts#L20-L139) | `CODER_PROMPT` | 120 |
| Researcher | [src/agents/researcher.ts](src/agents/researcher.ts#L18-L136) | `RESEARCHER_PROMPT` | 119 |
| Reviewer | [src/agents/reviewer.ts](src/agents/reviewer.ts#L17-L77) | `REVIEWER_PROMPT` | 61 |
| Inspector | [src/agents/inspector.ts](src/agents/inspector.ts#L18-L131) | `INSPECTOR_PROMPT` | 114 |
| Chat | [src/agents/chat.ts](src/agents/chat.ts#L33-L128) | `CHAT_PROMPT` | 96 |
| Designer | [src/agents/designer.ts](src/agents/designer.ts#L17-L72) | `DESIGNER_PROMPT` | 56 (orphan — F01) |
| Data Agent | [src/agents/data-agent.ts](src/agents/data-agent.ts#L17-L71) | `DATA_AGENT_PROMPT` | 55 |

A shared "execution-style" block lives separately in [src/agents/base.ts](src/agents/base.ts#L83-L89) (`VISIBLE_EXECUTION_STYLE_PROMPT`), then is concatenated with the per-agent block at [src/agents/base.ts](src/agents/base.ts#L171-L175). The eager-injected skill/knowledge block comes from `buildEagerBlock`.

The `BaseAgentConfig.systemPrompt` JSDoc at [src/agents/base.ts](src/agents/base.ts#L104-L105) reads `System prompt (from prompts/<role>.md).` — but the `prompts/` directory does not exist anywhere in the repo (verified `ls prompts` → not found). The contract advertised by the type is therefore aspirational; F31 tracks the doc-mismatch half of the same bug.

## Why this hurts

1. **Iteration latency.** Tweaking a prompt requires editing TS, re-running `tsc`/`tsup`, restarting the runtime, and reloading. There is no hot-reload path even in dev.
2. **Escaping tax.** Prompts contain JSON examples; every backtick and `${` inside the prompt has to be backslash-escaped. Search `\`` in [src/agents/manager.ts](src/agents/manager.ts#L21-L265) — there are hundreds.
3. **Diff noise.** Substantive code changes in `src/agents/<role>.ts` are visually drowned in prompt text; reviews are harder.
4. **Drift between prompt and code.** F30 already catalogues this: `CHAT_PROMPT` lists slash commands at [src/agents/chat.ts](src/agents/chat.ts#L102-L110); the handler switch is at [src/agents/chat.ts](src/agents/chat.ts#L336-L358); the `/help` Markdown table is at [src/agents/chat.ts](src/agents/chat.ts#L369-L378). All three lists are maintained by hand and already disagree.
5. **Shared concepts re-stated.** The "Saivage system / agent roster" paragraph is repeated, with minor wording drift, in every long-running agent prompt (Planner, Manager, Inspector, Chat). The Communication-Protocol paragraph likewise. F02 tracks the roster-drift aspect; the prompts are one of its hosts.
6. **No single source for default project config text.** F33-style drift (`cli.initProject` vs `config.writeDefaultConfig`) is mirrored at the prompt layer: defaults named in prose inside prompts can disagree with code defaults, and there is no test that catches it.

## Contract (current)

- `BaseAgentConfig.systemPrompt: string` (required) at [src/agents/base.ts](src/agents/base.ts#L104-L106).
- `BaseAgent` concatenates `[config.systemPrompt, VISIBLE_EXECUTION_STYLE_PROMPT, skillBlock].filter(Boolean).join("\n\n")` at [src/agents/base.ts](src/agents/base.ts#L171-L175), stores the result in `this.systemPrompt`, and feeds it to every LLM call at [src/agents/base.ts](src/agents/base.ts#L496) and the compaction call at [src/agents/base.ts](src/agents/base.ts#L831).
- Each role constructor passes a TS constant: e.g. `systemPrompt: PLANNER_PROMPT` at [src/agents/planner.ts](src/agents/planner.ts#L176), `MANAGER_PROMPT` at [src/agents/manager.ts](src/agents/manager.ts#L282), `CODER_PROMPT` at [src/agents/coder.ts](src/agents/coder.ts#L151), `RESEARCHER_PROMPT` at [src/agents/researcher.ts](src/agents/researcher.ts#L148), `REVIEWER_PROMPT` at [src/agents/reviewer.ts](src/agents/reviewer.ts#L89), `INSPECTOR_PROMPT` at [src/agents/inspector.ts](src/agents/inspector.ts#L143), `CHAT_PROMPT` at [src/agents/chat.ts](src/agents/chat.ts#L157), `DATA_AGENT_PROMPT` at [src/agents/data-agent.ts](src/agents/data-agent.ts#L82), `DESIGNER_PROMPT` at [src/agents/designer.ts](src/agents/designer.ts#L83).
- Build: `tsup` already has a precedent for shipping non-TS assets — `onSuccess` copies `skills/builtin` → `dist/skills/builtin` ([tsup.config.ts](tsup.config.ts#L14-L19)).

## Call sites & dependencies

- Per-prompt constants are referenced only inside their own file's role constructor. None are imported across files; nothing else parses them.
- `src/agents/conventions.ts` defines territory rules and is the closest existing "shared agent metadata" module (98 lines). It does NOT today carry any prompt text; some of what each prompt asserts about territory belongs here as data.
- Tests that build agents use stub strings (`systemPrompt: "sys"`): [src/agents/base.compaction.test.ts](src/agents/base.compaction.test.ts#L113), [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts#L97). They never exercise the real prompts.
- Runtime, dispatcher, MCP, planner-state code never read prompt strings.

## Constraints any solution must respect

- **Architecture-first / no backward compatibility** (project rule). Whatever route is taken, the old TS-constant prompts are deleted in the same change; no transitional aliasing, no "prompts loader with TS fallback".
- **Synchronous startup contract.** `BaseAgent` is constructed inline; `systemPrompt` is needed by the time `super()` runs. Any loader must produce strings synchronously by the time the agent constructor is invoked, OR the loader must move into agent-factory code that already runs async.
- **Bundled deployment.** The runtime ships as a bundled `dist/cli.js` consumed by the LXC services. Prompt files MUST be part of the deployment artifact; the existing `tsup` `onSuccess` copy-step is the precedent.
- **Skills/memory are out of scope.** `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/` are owned by another agent. Eager-injected skill blocks must keep working unchanged.
- **No new "config knob" without a use case.** A template-engine choice that is only used to render one constant block has no payoff.
- **Tests must not depend on the real prompt files.** Vitest unit tests should keep using stub strings; only a small integration test asserts that the on-disk files load.

## Already-known drift this issue's solution should make harder to recreate

- F02 — roster drift in the multi-agent description paragraphs.
- F09 — worker-base duplication makes per-agent prompts repeat the same worker contract; with the worker-base refactor, prompt duplication becomes worse if not centralized.
- F30 — chat slash commands triplicated. Externalising the prompt does not by itself fix F30, but it removes the worst of the three locations from TS and makes a single declarative `commands.ts` source plausible.
- F31 — `BaseAgentConfig.systemPrompt` JSDoc references nonexistent `prompts/<role>.md`. Whatever F18 does must make F31's comment either true or deleted.
- F33 — default project config drift. Whatever shared "project layout" prose appears in prompts must be sourced from a single block, not retyped per agent.
