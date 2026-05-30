# F30 — Chat agent slash-command list is duplicated between prompt text and handler

**Category**: duplication
**Severity**: low
**Transversality**: local

## Summary

`ChatAgent.tryHandleCommand` switches over the supported slash commands (`/help`, `/status`, `/plan`, `/history`, `/replan`, `/restart-planner`, `/note`, `/note!`, `/notep`). The system prompt and the `/help` output both list the same commands as Markdown. Adding a command requires three coordinated edits in the same file.

## Evidence

- Switch statement: [src/agents/chat.ts](src/agents/chat.ts#L300-L325).
- `/help` table: [src/agents/chat.ts](src/agents/chat.ts#L329-L348).
- Same list inside the system prompt: [src/agents/chat.ts](src/agents/chat.ts#L20-L260) (search for the slash commands section).

## Why this matters

The three lists already disagree: `/restart-planner` and its alias `/planner-restart` are wired in the handler but only one is listed in `/help`. A single declarative `const COMMANDS: Array<{name, aliases, help, handler}>` would drive all three uses.

## Related

- F18 (system prompt bloat — this is one symptom)
