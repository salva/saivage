# G49 — Review (Round 2)

- **Analysis**: [01-analysis-r2.md](01-analysis-r2.md)
- **Design**: [02-design-r2.md](02-design-r2.md)
- **Plan**: [03-plan-r2.md](03-plan-r2.md)
- **Round 1 review**: [04-review-r1.md](04-review-r1.md)
- **Issue**: [../G49-usewebsocket-send-leaky-envelope.md](../G49-usewebsocket-send-leaky-envelope.md)

## Findings

1. **Root Vitest discovery is fixed, but root Vitest resolution is still missing.**
   Round 2 correctly widens the root [vitest.config.ts](../../../../vitest.config.ts) include to `web/src/**/*.test.ts` and adds `happy-dom` as a root devDependency, but the proposed web tests still import [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts), which will import `@channels/ws-schema`. The alias edits carried over from round 1 are only in [web/tsconfig.json](../../../../web/tsconfig.json) and [web/vite.config.ts](../../../../web/vite.config.ts). The root Vitest config does not load the web Vite config and the current project has no tsconfig-paths plugin or root `resolve.alias`, so `npm test` will discover the composable spec and then fail before the assertions run. Add the same `@channels/ws-schema` resolver to the root Vitest config, or factor the alias through a shared config/plugin used by both Vite and Vitest, and include that in the acceptance checklist.

2. **The smoke project path should stay under workspace `tmp/`.**
   The new Node `ws` one-shot smoke is the right replacement for the nonexistent `globalThis.__ws`, and it does assert the server-side `1003 schema-violation` close. Its setup command still uses `/tmp/smoke-project`, though; this workspace's operating rule is to keep temporary artifacts under `/home/salva/g/ml/tmp/`. Use a workspace-local path such as `/home/salva/g/ml/tmp/saivage-g49-smoke-project` so the validation command matches local practice.

## Verified Corrections

- Browser malformed server-frame handling now emits a structured `error` envelope before calling `ws.close()` with no arguments. The server-side malformed-client path keeps `ws.close(1003, "schema-violation")`.
- `WsOutboundSchema` is strict per variant, and the server sender serializes the parsed value returned by `WsOutboundSchema.parse(event)`, not the original drifting object.
- `useWebSocket.send` now runtime-validates with `WsInboundSchema.parse(msg)` before writing to the browser socket.
- Telegram is no longer described as a no-op; the plan preserves forwarding of `{ type: "message", content }` to `this.send(content)` and makes non-web variants explicit no-ops.
- The bogus `globalThis.__ws` smoke is replaced by a real Node `ws` one-shot that sends malformed bytes and expects the server to close with `1003 schema-violation`.

## Summary

Round 2 fixes the substantive protocol-design problems from round 1: browser close semantics, strict outbound validation, SPA send validation, Telegram behavior, and the bad smoke seam are all corrected. The remaining blocker is execution wiring: after the root test include is widened, Vitest also needs a root resolver for the shared schema alias or the promised web composable tests will not actually run.

VERDICT: CHANGES_REQUESTED