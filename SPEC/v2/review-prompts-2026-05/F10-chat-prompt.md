# F10 — chat.md

**File under review:** [prompts/chat.md](../../../prompts/chat.md) (86 lines)
**Agent:** Chat — [src/agents/chat.ts](../../../src/agents/chat.ts)
**Runtime contract:** roster entry [chat](../../../src/agents/roster.ts#L355), tool filter `chat`.

## Summary

User-facing agent. Renders the only thing the human ever sees from Saivage.
Reads state via Plan MCP; writes notes; dispatches Inspector. Receives
`{{ slash_commands_table }}` injection (the only role that does).

Review against the project-wide axes in
[00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md#project-wide-review-axes-apply-to-every-issue),
with special attention to:

- Voice — this prompt sets the human-visible voice of the system.
- Slash-commands table rendering — verify `{{ slash_commands_table }}` is in
  the right section and the surrounding text is accurate.
- Tool list vs `chat` filter ([src/mcp/](../../../src/mcp/)).
- Note-writing protocol vs `convention.writeTerritory` in
  [roster.ts](../../../src/agents/roster.ts).
- Boundary with Planner — chat must not pretend to plan; it relays via notes.

## Category

Review.

## Severity / Transversality

Severity: high (user-facing).
Transversality: local.
