# G13 — Implementation plan (round 2)

**Design:** [02-design-r2.md](02-design-r2.md)
**Round 1:** [03-plan-r1.md](03-plan-r1.md)
**R1 review:** [04-review-r1.md](04-review-r1.md)
**Strategy:** Proposal A — extract the chat-command registry into `src/chat/localCommandRegistry.ts`; delete the second half of [src/agents/conventions.ts](../../../../src/agents/conventions.ts); remove the unused `checkConvention` import from [src/agents/base.ts](../../../../src/agents/base.ts#L35); update four real chat-registry import sites; relocate one test file.

No backward-compatibility shim. No new docstrings or comments in untouched code (in particular, no new file-level header on the registry module — the existing `LOCAL_CHAT_COMMANDS` JSDoc at [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L66-L71) moves verbatim and is the only documentation in the new file).

## R2 deltas vs r1

- E1 simplified: the new file is a verbatim move of the four symbols — no new file-level docblock.
- New step E8: remove the unused `checkConvention` import from [src/agents/base.ts](../../../../src/agents/base.ts#L35).
- "Untouched (intentional)" updated: [src/agents/base.ts](../../../../src/agents/base.ts) no longer appears as a conventions consumer.
- Validation: added `npm run lint` step before the production bundle so [eslint.config.js](../../../../eslint.config.js#L11-L14) `no-unused-vars` catches any future stale import.
- Negative-grep verification updated: the post-split conventions consumers are exactly [src/agents/roster.ts](../../../../src/agents/roster.ts#L11-L31), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L10-L86), and [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24-L130).

## Edits

### E1. Create `src/chat/localCommandRegistry.ts` (new file)

Content: a verbatim move of [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L60-L93) — the `LocalChatCommand` interface, the existing `LOCAL_CHAT_COMMANDS` JSDoc at [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L66-L71) followed by the `LOCAL_CHAT_COMMANDS` array, the `LocalChatCommandName` type, and `renderLocalChatCommandsTable`. No imports. No additional file-level header. No code changes.

### E2. Trim [src/agents/conventions.ts](../../../../src/agents/conventions.ts)

Delete lines 60–93 (everything from `export interface LocalChatCommand` through the closing brace of `renderLocalChatCommandsTable`). The file ends after `getConvention`. Leave the existing top-of-file docblock at [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L1-L4) as-is (territory-only — no edit needed).

### E3. Swap import in [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L14)

Replace:

    import { renderLocalChatCommandsTable } from "./conventions.js";

with:

    import { renderLocalChatCommandsTable } from "../chat/localCommandRegistry.js";

### E4. Swap import in [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L11-L14)

Replace:

    import {
      LOCAL_CHAT_COMMANDS,
      type LocalChatCommandName,
    } from "../agents/conventions.js";

with:

    import {
      LOCAL_CHAT_COMMANDS,
      type LocalChatCommandName,
    } from "./localCommandRegistry.js";

### E5. Swap import in [src/agents/prompts.test.ts](../../../../src/agents/prompts.test.ts#L11)

Replace:

    import { LOCAL_CHAT_COMMANDS } from "./conventions.js";

with:

    import { LOCAL_CHAT_COMMANDS } from "../chat/localCommandRegistry.js";

### E6. Swap import in [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts#L18-L21)

Replace:

    import {
      LOCAL_CHAT_COMMANDS,
      type LocalChatCommandName,
    } from "../agents/conventions.js";

with:

    import {
      LOCAL_CHAT_COMMANDS,
      type LocalChatCommandName,
    } from "./localCommandRegistry.js";

### E7. Relocate [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts)

Use `git mv` so the rename is tracked:

    cd /home/salva/g/ml/saivage
    git mv src/agents/chat-commands.test.ts src/chat/localCommandRegistry.test.ts

Then rewrite the import block at [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts#L10-L13) from:

    import {
      LOCAL_CHAT_COMMANDS,
      renderLocalChatCommandsTable,
    } from "./conventions.js";

to:

    import {
      LOCAL_CHAT_COMMANDS,
      renderLocalChatCommandsTable,
    } from "./localCommandRegistry.js";

### E8. Remove the unused `checkConvention` import from [src/agents/base.ts](../../../../src/agents/base.ts#L35)

Delete the line:

    import { checkConvention } from "./conventions.js";

There is no production call site for `checkConvention` (full-source search; the only callers are the unit tests in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L36-L86), which import the symbol directly). The deletion is dead-code removal; no other edit to [src/agents/base.ts](../../../../src/agents/base.ts) is needed.

## Untouched (intentional)

- [src/agents/roster.ts](../../../../src/agents/roster.ts#L11) — keeps `import type { ConventionRule } from "./conventions.js";`.
- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L10) — keeps the territory-symbol import (`checkConvention`, `getConvention`).
- [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24) — keeps `getConvention` import.
- [prompts/chat.md](../../../../prompts/chat.md) — `{{slash_commands_table}}` substitution name unchanged; rendered value byte-identical.
- `dist/` — regenerated by build; no manual edits.

## Validation

Run from `/home/salva/g/ml/saivage`. Each step must exit with status 0.

1. **TypeScript build of source:**

       cd /home/salva/g/ml/saivage
       npx tsc --noEmit

   Catches any missed import update; the literal-union derivation via `satisfies Record<LocalChatCommandName, LocalCommandHandler>` in [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L57) is the compile-time drift guard for the registry.

2. **Focused vitest — affected test files:**

       cd /home/salva/g/ml/saivage
       npx vitest run \
         src/chat/localCommandRegistry.test.ts \
         src/chat/localCommands.test.ts \
         src/agents/prompts.test.ts \
         src/agents/agents.test.ts \
         src/agents/roster.test.ts

   Confirms `LOCAL_CHAT_COMMANDS` shape, `renderLocalChatCommandsTable` output (including the dispatcher's `renderLocalHelp` table), prompt-loader template substitution for `chat.md`, territory warnings, and roster-derived conventions all still pass.

3. **Full vitest:**

       cd /home/salva/g/ml/saivage
       npx vitest run

   Catches any unrelated consumer the grep missed.

4. **Lint (before build):**

       cd /home/salva/g/ml/saivage
       npm run lint

   Per [package.json](../../../../package.json#L20) and [eslint.config.js](../../../../eslint.config.js#L11-L14) (`no-unused-vars` is an error). This is the guardrail that catches dead imports like the `checkConvention` one removed in E8, and any future regressions of the same shape.

5. **Production bundle:**

       cd /home/salva/g/ml/saivage
       npm run build

   Verifies `tsup` picks up the new file and the deletions do not leave dangling references in the CLI bundle.

6. **Negative-grep verification of the split:**

       cd /home/salva/g/ml/saivage
       grep -rn "LOCAL_CHAT_COMMANDS\|LocalChatCommandName\|renderLocalChatCommandsTable\|LocalChatCommand " src/ \
         | grep -v dist | grep -v ".test.ts" | grep -v "localCommandRegistry.ts"
       # Expect: only src/agents/prompts.ts (import line) and src/chat/localCommands.ts (import line + dispatcher uses).

       grep -rn "from.*agents/conventions" src/ | grep -v dist
       # Expect: only src/agents/roster.ts (type-only), src/agents/agents.test.ts, src/agents/roster.test.ts.

       grep -n "LocalChatCommand\|LOCAL_CHAT_COMMANDS\|renderLocalChatCommandsTable" src/agents/conventions.ts
       # Expect: no output.

       grep -n "checkConvention" src/agents/base.ts
       # Expect: no output.

## Operator-gated saivage-v3 restart

**Not required.** This change is internal to the v2 codebase under `/home/salva/g/ml/saivage` and does not touch the v3 harness at `/work/saivage-v3` on the `saivage-v3` LXC container. The behavioural invariants (`/help` output, prompt substitution, territory warnings) are byte-identical, and removing the unused `checkConvention` import is a no-op at runtime. No deployment or service restart is needed. Restart only if the operator explicitly asks to redeploy v2 to its container after merge.
