# F03 — Naive `\{[\s\S]*\}` JSON extraction duplicated across 7 sites

**Category**: duplication
**Severity**: high
**Transversality**: cross-cutting

## Summary

Seven different files independently use the same brittle regex `text.match(/\{[\s\S]*\}/)` to recover JSON from an LLM's free-form response. The regex is greedy, accepts a single trailing brace as terminator, and silently picks the largest brace-span — which means the first prose `{example}` block in the response ends as a "merged" object spanning the rest of the message.

## Evidence

- [src/agents/coder.ts](src/agents/coder.ts#L270)
- [src/agents/manager.ts](src/agents/manager.ts#L398)
- [src/agents/researcher.ts](src/agents/researcher.ts#L266)
- [src/agents/reviewer.ts](src/agents/reviewer.ts#L212)
- [src/agents/inspector.ts](src/agents/inspector.ts#L224)
- [src/agents/data-agent.ts](src/agents/data-agent.ts#L182)
- [src/agents/designer.ts](src/agents/designer.ts#L197)
- The supervisor uses an internal `parseJsonObject` helper that has the same semantics: [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L176-L200).
- The prompt-injection cop uses the same approach: [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts).

## Why this matters

Two failure modes are guaranteed: (1) any system prompt that contains a JSON example in fenced code, followed by a final report later in the same message, produces a parse that wraps both into one malformed object; (2) when an agent legitimately fails to emit JSON, the failure surface is silent — `null` from regex means "no report" rather than "model refused", and the worker reports a synthetic failure with no diagnostic value.

A single `extractJsonObject(text)` helper (with balanced-brace parsing or a JSON sniffer) would let every caller share the same fix.

## Related

- F09 (worker-agent duplication)
- F25 (prompt-injection cop false positives)
