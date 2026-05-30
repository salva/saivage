# G12b — APPROVED

**Chosen proposal**: Proposal A (per [02-design-r3.md](02-design-r3.md)) — DELETE the prompt-injection cop and all of its hangers-on, replacing the previously-disapproved G12 hardening design. The cop is a fragile LLM-based heuristic that violates the new project-wide principle "treat agents as adults — no fragile heuristics like checking whether some agent has called some tool or not". Removal targets:

- src/security/promptInjectionCop.ts and its dependents
- scanUntrustedText (now a pass-through, then deleted)
- security routing role + securityModel + injectionScanner + injectionModel + maxScanLengthBytes config keys (Zod schema must reject stale `security: { ... }` blocks via `.strict()` — fail-loud, no migration shim)
- /api/debug/security route, SecurityStatusRing, DebugView Security tab (verified R4 surface never landed but invariant test guards against resurrection)
- All test fixtures in runtime/router/model-capabilities referencing `security: { ... }`
- All docs surfaces: docs/guide/config-runtime.md (security section), docs/internals/testing.md (row), docs/internals/source-tree.md (tree), docs/.vitepress/config.ts (sidebar)
- 13 needles enumerated and grep-gated: PromptInjection, promptInjectionCop, prompt-injection-cop, scanUntrustedText, prompt_injection_scan, injectionScanner, injectionModel, maxScanLengthBytes, securityModel, `security: "security"`, SecurityStatusRing, securityStatusRing, /api/debug/security

Boundary protections kept (non-heuristic): URL scheme allow-list, size caps, containment guards on data tools.

**Approved by**: GPT-5.5 (copilot) reviewer at round 3 — see [04-review-r3.md](04-review-r3.md). All three rounds of blockers resolved: r1 framed the deletion; r2 expanded inventory to test fixtures + docs sidebar + Zod `.strict()` fail-loud + invariant test; r3 switched the regression test to the public `loadConfig` path with an on-disk fixture (avoiding unexported `configSchema`) and added the bootstrap.ts L13 `createPromptInjectionCop` import to the inventory.

**Implementation pointer**: [03-plan-r3.md](03-plan-r3.md). Validation: tsc, focused vitest on the new regression test (loadConfig + stale security block → ZodError with `unrecognized_keys`), full vitest, `npm run build`, `npm run build:web`, `npm run docs:api`, `npm run docs:build`, lint, plus the static invariant test that pins down absence of every cop residue.

**Supersedes**: G12 (now DISAPPROVED — see [../G12/APPROVED.md](../G12/APPROVED.md)).

**Daemon impact**: Restart `saivage` (10.0.3.111), `saivage-v3` (10.0.3.112), `diedrico` (10.0.3.113) — operator-gated.
