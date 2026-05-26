# G13 — Implementation plan (round 3)

**Design:** [02-design-r3.md](02-design-r3.md)
**Round 2:** [03-plan-r2.md](03-plan-r2.md)
**R2 review:** [04-review-r2.md](04-review-r2.md)
**Strategy:** Unchanged. Proposal A — extract the chat-command registry into `src/chat/localCommandRegistry.ts`; delete the second half of [src/agents/conventions.ts](../../../../src/agents/conventions.ts); remove the unused `checkConvention` import from [src/agents/base.ts](../../../../src/agents/base.ts#L35); update four chat-registry import sites; relocate one test file.

## R3 deltas vs r2

- Edits E1–E8: unchanged from [03-plan-r2.md](03-plan-r2.md#L23).
- Validation steps 1–5: unchanged.
- Validation step 6 (negative-grep verification of the split): rewritten. The r2 pattern `from.*agents/conventions` cannot match the stated survivors, because [src/agents/roster.ts](../../../../src/agents/roster.ts#L11), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L10), and [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24) all import from `"./conventions.js"` (same-directory) — not from a string containing `agents/conventions` ([04-review-r2.md](04-review-r2.md#L7)). R3 splits the check into one same-directory positive check that must list exactly those three files, plus one cross-directory negative check that must produce zero output (the r2 plan moves the chat-side `../agents/conventions.js` imports to `localCommandRegistry.js`).

## Edits

Unchanged from [03-plan-r2.md "Edits" §E1–E8](03-plan-r2.md#L23). Reproduced here only by reference:

- **E1.** Create `src/chat/localCommandRegistry.ts` ([03-plan-r2.md §E1](03-plan-r2.md#L23)).
- **E2.** Trim [src/agents/conventions.ts](../../../../src/agents/conventions.ts) ([03-plan-r2.md §E2](03-plan-r2.md#L27)).
- **E3.** Swap import in [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L14) ([03-plan-r2.md §E3](03-plan-r2.md#L31)).
- **E4.** Swap import in [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L11-L14) ([03-plan-r2.md §E4](03-plan-r2.md#L41)).
- **E5.** Swap import in [src/agents/prompts.test.ts](../../../../src/agents/prompts.test.ts#L11) ([03-plan-r2.md §E5](03-plan-r2.md#L55)).
- **E6.** Swap import in [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts#L18-L21) ([03-plan-r2.md §E6](03-plan-r2.md#L63)).
- **E7.** Relocate [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts) to `src/chat/localCommandRegistry.test.ts` via `git mv` and rewrite the import ([03-plan-r2.md §E7](03-plan-r2.md#L77)).
- **E8.** Remove the unused `checkConvention` import from [src/agents/base.ts](../../../../src/agents/base.ts#L35) ([03-plan-r2.md §E8](03-plan-r2.md#L97)).

## Untouched (intentional)

Unchanged from [03-plan-r2.md "Untouched (intentional)"](03-plan-r2.md#L107).

## Validation

Run from `/home/salva/g/ml/saivage`. Each step must exit with status 0.

1. **TypeScript build of source:** unchanged ([03-plan-r2.md §1](03-plan-r2.md#L117)).
2. **Focused vitest — affected test files:** unchanged ([03-plan-r2.md §2](03-plan-r2.md#L125)).
3. **Full vitest:** unchanged ([03-plan-r2.md §3](03-plan-r2.md#L137)).
4. **Lint (before build):** unchanged ([03-plan-r2.md §4](03-plan-r2.md#L143)).
5. **Production bundle:** unchanged ([03-plan-r2.md §5](03-plan-r2.md#L150)).

6. **Negative-grep verification of the split (rewritten in r3):**

       cd /home/salva/g/ml/saivage

       # 6a. Catalogue symbols outside the new registry module: only the
       #     production consumers should remain (no test-file matches, no
       #     dist matches, no self-match in the registry module).
       grep -rn "LOCAL_CHAT_COMMANDS\|LocalChatCommandName\|renderLocalChatCommandsTable\|LocalChatCommand " src/ \
         | grep -v dist | grep -v ".test.ts" | grep -v "localCommandRegistry.ts"
       # Expect: only src/agents/prompts.ts (import line) and
       #         src/chat/localCommands.ts (import line + dispatcher uses).

       # 6b. Same-directory consumers of src/agents/conventions.ts after the
       #     split. The chat-side cross-directory imports are gone (moved to
       #     localCommandRegistry.js by E4/E6); only the three agent-side
       #     same-directory imports of territory symbols remain.
       grep -rnE 'from ["'\''"]\./conventions(\.js)?["'\''"]' src/agents/ | grep -v dist
       # Expect exactly three lines:
       #   src/agents/roster.ts:11:import type { ConventionRule } from "./conventions.js";
       #   src/agents/agents.test.ts:10:import { checkConvention, getConvention } from "./conventions.js";
       #   src/agents/roster.test.ts:24:import { getConvention } from "./conventions.js";

       # 6c. Cross-directory imports of conventions must be gone. The r2
       #     plan moves the chat-side `../agents/conventions.js` imports to
       #     `./localCommandRegistry.js` (E4, E6), and E7 moves
       #     `src/agents/chat-commands.test.ts` into `src/chat/` so its
       #     `./conventions.js` import becomes `./localCommandRegistry.js`.
       #     No other file should import conventions via a parent-directory
       #     path.
       grep -rnE 'from ["'\''"]\.\..*conventions(\.js)?["'\''"]' src/ | grep -v dist
       # Expect: no output.

       # 6d. The registry symbols are fully removed from the trimmed
       #     conventions.ts.
       grep -n "LocalChatCommand\|LOCAL_CHAT_COMMANDS\|renderLocalChatCommandsTable" src/agents/conventions.ts
       # Expect: no output.

       # 6e. The unused checkConvention import is gone from base.ts.
       grep -n "checkConvention" src/agents/base.ts
       # Expect: no output.

   Notes on the pattern choice:

   - 6b uses `\./conventions` (literal `./`) so it matches only the
     same-directory imports (`from "./conventions.js"`) used by the
     surviving agent-side consumers, and ignores the registry-module
     imports (`./localCommandRegistry.js`) introduced by E3–E7.
   - 6c uses `\.\..*conventions` (literal `..`) so it matches only
     parent-directory imports (`from "../agents/conventions.js"` or
     deeper). Step 6c is the direct verification that the cross-layer
     coupling the finding flags is gone; the r2 grep `from.*agents/conventions`
     conflated this with the survivors and is dropped.
   - 6a is unchanged from r2; together with 6b–6e it produces a complete
     consumer map of both halves of the original
     [src/agents/conventions.ts](../../../../src/agents/conventions.ts).

## Operator-gated saivage-v3 restart

Unchanged from [03-plan-r2.md "Operator-gated saivage-v3 restart"](03-plan-r2.md#L181). Not required.
