# G13 - Review of round 2

## Findings

### 1. CHANGES_REQUESTED - The conventions-consumer grep cannot match the consumers it claims to verify

R2 says the post-split conventions consumers are exactly [src/agents/roster.ts](../../../../src/agents/roster.ts#L11-L31), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L10-L86), and [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24-L130), then validates that with a grep for the string pattern "from.*agents/conventions" and expects those three files to appear ([SPEC/v2/review-2026-05-round2/G13/03-plan-r2.md](03-plan-r2.md#L16), [SPEC/v2/review-2026-05-round2/G13/03-plan-r2.md](03-plan-r2.md#L168-L169)). That grep cannot match the stated survivors. Those imports are same-directory imports today: [src/agents/roster.ts](../../../../src/agents/roster.ts#L11), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L10), and [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24) all import from "./conventions.js", not from a string containing "agents/conventions".

The command currently matches only the cross-directory chat imports at [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L12-L14) and [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts#L19-L21). R2 correctly plans to move those to the new registry import, so after implementation the command will return no output while the plan says it should return the three legitimate agent-side consumers. That leaves the validation section encoding a false consumer map immediately after R2 fixed the false BaseAgent consumer map from R1.

This is easy to repair without changing the design. Replace the grep with a pattern that matches both same-directory and parent-directory conventions imports, and keep the expected survivors as [src/agents/roster.ts](../../../../src/agents/roster.ts#L11), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L10), and [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24). Alternatively, split it into one same-directory import check for the agent files plus one cross-directory grep that must produce no chat-side results.

## What is solid

The substantive R1 blockers are fixed. R2 now correctly states that [src/agents/base.ts](../../../../src/agents/base.ts#L35) has only an unused `checkConvention` import, not a production write-guard call site, and the implementation plan removes that import. It also drops the extra file-level registry docblock and keeps the new chat registry module as a literal move of the existing registry symbols from [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L60-L93).

The main split remains the right architecture: [src/agents/conventions.ts](../../../../src/agents/conventions.ts#L11-L58) keeps territory rules, while the chat-owned registry moves out of the agents namespace and the current chat consumers in [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L14-L61), [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L12-L14), [src/agents/prompts.test.ts](../../../../src/agents/prompts.test.ts#L11-L49), [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts#L19-L21), and [src/agents/chat-commands.test.ts](../../../../src/agents/chat-commands.test.ts#L11-L34) are all accounted for. Adding `npm run lint` is also the right guardrail, since [package.json](../../../../package.json#L20) wires lint and [eslint.config.js](../../../../eslint.config.js#L8-L14) treats unused variables as errors.

## Required round-2 change

- Fix the negative-grep validation command and expected output so it actually verifies the remaining [src/agents/conventions.ts](../../../../src/agents/conventions.ts) consumers after the split. No design change is needed beyond that validation correction.

VERDICT: CHANGES_REQUESTED