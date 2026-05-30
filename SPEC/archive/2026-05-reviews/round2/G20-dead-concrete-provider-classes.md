# G20 — Dead concrete provider classes never instantiated by the router

**Subsystem**: providers
**Category**: dead-code
**Severity**: high
**Transversality**: architectural

## Summary

Four hand-written provider classes (`AnthropicProvider`, `OpenAIProvider`,
`OpenAICodexProvider`, `OpenRouterProvider`) live under [src/providers/](src/providers/)
but the `ModelRouter` never constructs them. Every router branch for those
providers instead instantiates the unified `PiAiProvider`. The concrete
classes are reachable only from their own unit tests, so roughly one
thousand lines of production code, alternate retry logic, and divergent
header handling exist purely to be exercised by tests of themselves.

## Evidence (with line-linked refs)

- Router only constructs `PiAiProvider` for `anthropic`, `openai`,
  `openai-codex`, and `opencode`: [src/providers/router.ts](src/providers/router.ts#L297-L325).
- `createProvider` switch never names the concrete classes:
  [src/providers/router.ts](src/providers/router.ts#L741-L789).
- The classes themselves: [src/providers/anthropic.ts](src/providers/anthropic.ts),
  [src/providers/openai.ts](src/providers/openai.ts),
  [src/providers/openai-codex.ts](src/providers/openai-codex.ts),
  [src/providers/openrouter.ts](src/providers/openrouter.ts).
- Their only non-test consumers are their own siblings — production
  imports come from `pi-ai.ts`, not these files.

## Why this matters

The dead classes encode a second, divergent contract for what a provider
must do (auth header shape, retry semantics, model lists), and reviewers
or new contributors naturally assume they are live. The duplication
silently rots — bug fixes in `PiAiProvider` never reach them — and the
tests that target them provide false coverage signal because no
production path exercises the behaviour. Per the workspace
"no backward compatibility" rule, dead implementations should be removed
rather than preserved as parallel scaffolding.

## Rough remediation direction (one bullet "one conceptual level up")

- Collapse the provider layer to a single concrete class (`PiAiProvider`)
  plus per-provider configuration; delete the four standalone classes and
  their tests, and move any still-useful contract checks (header shape,
  base URL defaults) into a single parameterised PiAi conformance suite.

## Cross-links

- Round 1: F08 (OAuth dispatch table), F33 (provider naming drift) —
  this is the structural cause of those symptoms.
- Related round-2 findings: G21 (provider name list duplicated 4×),
  G22 (dead OAuth `copilot` mapping).
