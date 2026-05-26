# F06 — `attachPendingNotesNotice` mutates the last tool-result via JSON side-channel

**Category**: leaky-abstraction
**Severity**: medium
**Transversality**: module

## Summary

When pending notes exist, the dispatcher injects an `__saivage_pending_user_notes` marker into the **content string** of the last tool-result the LLM is about to read, by string-mutating an already-serialised result. This is a hidden side-channel that breaks the invariant "tool result content is whatever the tool returned" and forces every downstream consumer (web UI, test snapshots, conversation snapshot logic) to know about the marker.

## Evidence

- Call site at the end of `processToolCalls`: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L141).
- The `ToolCallResultEntry.content` type is a free-form string, so there's no schema constraint that would catch the injection: [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L51-L55).
- Result content is what later flows into the conversation snapshot displayed in the UI: [src/agents/base.ts](src/agents/base.ts#L367-L399).

## Why this matters

The dispatcher is the right place to surface the existence of pending notes — but a dedicated `user` message after the tool-result batch (or a structured `notice` field on `DispatchResult`) would do it without contaminating tool outputs. The current approach silently corrupts the audit trail of "what did tool X return" and any frontend that pattern-matches on the result body has to special-case Saivage's marker.

## Related

- F03 (string-based JSON parsing is fragile here too)
