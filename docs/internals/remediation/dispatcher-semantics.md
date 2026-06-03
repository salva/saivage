# Dispatcher Semantics

## Problem

The architecture docs describe true “resume-on-each” semantics: if a parent
agent dispatches multiple children in one LLM response, the parent resumes as
each child finishes. The implementation starts child dispatches concurrently but
waits for all of them with `Promise.all` before returning tool results to the
parent.

The implementation is simpler than the docs. The question is whether v2 needs
true resume-on-each or whether docs should describe batch semantics.

## Options Considered

| Option | Pros | Cons |
| --- | --- | --- |
| Implement true resume-on-each | More responsive; parent can act as soon as one child completes. | Complex with LLM tool-result ordering, conversation consistency, and provider protocol expectations. |
| Keep batch semantics and update docs | Simple, reliable, matches current tests. | Slower feedback when one child finishes before another. |
| Remove parallel dispatch entirely | Simplest conversation model. | Loses useful worker concurrency. |

## Chosen Approach

Keep parallel batch semantics in v2 and update docs/prompts to say so.

True resume-on-each is a deeper runtime model and belongs in v3 if needed. V2 is
better served by predictable batch completion.

## Design

Current semantics should be named explicitly:

- Local tools execute sequentially.
- Dispatch tools in the same LLM response start concurrently after local tools.
- Duplicate worker roles in the same batch are rejected.
- Parent receives all child tool results in one follow-up message after the
  allowed dispatch batch completes.

## Execution Plan

1. Rename documentation references from “resume-on-each” to “parallel batch
   dispatch”.
2. Replace misleading source comments in `src/runtime/dispatcher.ts`, including
   the file header that currently says “resume-on-each”, with the intended batch
   semantics.
3. Add or adjust tests that prove the parent receives one result set after all
   children settle.
4. Remove wording that implies parent-side incremental scheduling.

## Validation

- `npm run typecheck`
- `npm test`
- Documentation search for `resume-on-each` should either find no references or
  only historical notes.

## Risks

- If operators rely on the documented behavior rather than actual behavior,
  this is a docs correction, not a runtime regression.
