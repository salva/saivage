# G49 — Review (Round 1)

- **Analysis**: [01-analysis-r1.md](01-analysis-r1.md)
- **Design**: [02-design-r1.md](02-design-r1.md)
- **Plan**: [03-plan-r1.md](03-plan-r1.md)
- **Issue**: [../G49-usewebsocket-send-leaky-envelope.md](../G49-usewebsocket-send-leaky-envelope.md)

## Summary

Round 1 correctly identifies the core bug: the current server does not ignore a bare string from `useWebSocket.send`; it trims it and routes it to the chat agent as raw user prose. It also makes the right architectural move away from duplicated loose `WsEvent` bags, inline JSON envelopes, the unbounded SPA `events.value` array, and `ChatChannel & { sendEvent?: ... }` casts.

The proposed direction is still not ready to implement. The design says the new protocol should fail loud at both boundaries, but the concrete schema and close-code plan preserve silent drift in one important outbound case and asks the browser to send a close code it is not allowed to send. The test plan also places web tests where the current Vitest config will not run them.

## Findings

1. **Browser-side `ws.close(1003, ...)` is not a valid WebSocket API call.**
   [02-design-r1.md](02-design-r1.md) and [03-plan-r1.md](03-plan-r1.md) both tell the SPA composable to close the browser WebSocket with code `1003` after receiving an invalid server frame. Server-side `ws.close(1003, ...)` is fine, but browser scripts may only pass `1000` or custom `3000`-`4999` codes to `WebSocket.close()`. Passing `1003` from `web/src/composables/useWebSocket.ts` will throw before the boundary can recover. The round needs to split the rule explicitly: the server closes malformed client frames with `1003`; the SPA records the schema violation and closes with a valid browser code, closes without an explicit code, or uses a project-owned application code such as `4400`.

2. **Outbound `WsOutbound` is not actually fail-loud for drift.**
   The design intentionally makes the outbound message object non-strict and the plan adds test T7 asserting that unknown outbound fields are silently dropped. That contradicts the stated goal that a server field rename like `provider` to `providerId` must fail loudly. It is worse in the server sender sketch: `WsOutboundSchema.parse(event)` validates but then `JSON.stringify(event)` sends the original object, so a drifting extra field can still go onto the wire. The fix should make every `WsOutbound` variant strict, remove T7, and serialize the parsed value returned by the schema. If arbitrary future provenance is desired, it must be a typed nested object with a bounded schema, not a loose top-level escape hatch.

3. **The SPA outbound `send` boundary is compile-time only.**
   [02-design-r1.md](02-design-r1.md) says either side trying to send an invalid frame should throw synchronously, but the proposed composable implementation only accepts `WsInbound` at the TypeScript level and then calls `JSON.stringify(msg)`. A caller using `as any`, a test helper, or a future raw/debug path can still send a bad shape; the server would reject it, but the SPA boundary would not be fail-loud. The schema module should expose encoder helpers or `send` should call `WsInboundSchema.parse(msg)` before writing to the socket.

4. **The web composable tests will not run under the current test config.**
   The plan adds [web/src/composables/useWebSocket.test.ts](../../../../web/src/composables/useWebSocket.test.ts) and then claims `npm test` runs all 18 tests. The live [../../../../vitest.config.ts](../../../../vitest.config.ts) only includes `src/**/*.test.ts` and `tests/**/*.test.ts`, so tests under `web/src` are excluded. Also, [../../../../web/package.json](../../../../web/package.json) has no `test` script and no `@vue/test-utils`; the plan's claim that `@vue/test-utils` is available transitively via Vite is not true enough to rely on. Round 2 should either move the composable tests under a root-included path, update Vitest includes and environment deliberately, or add a web test script with explicit dependencies.

5. **Telegram `sendEvent` is described incorrectly.**
   Round 1 repeatedly calls Telegram's `sendEvent` a no-op, but the live implementation forwards `message` events to Telegram and discards only internal events. Retyping it to `WsOutbound` may still be fine, but the plan must preserve the current message-forwarding behavior and should not tell the implementer to keep a no-op body.

6. **The validation gates are not wired to anything.**
   [03-plan-r1.md](03-plan-r1.md) says the grep invariants run in CI as part of the existing `npm run build` flow. The live root `build` script runs `npm run build:web && tsup`; it does not run those grep checks. Keep the invariants, but make them an explicit validation command or acceptance step instead of claiming the build already gates them.

7. **The manual smoke step references a nonexistent `globalThis.__ws`.**
   The plan asks the reviewer to run `globalThis.__ws?.send("garbage")`, but neither the live composable nor the proposed design exposes the socket on `globalThis`. A fail-loud smoke test is useful, but it should use a real debug seam, a Playwright route, or a tiny test-only mock rather than an undeclared global.

## Axis Check

- **Inbound bare-string handling**: correct. Round 1 improves the issue text by stating that bare strings reach the chat agent as raw prose.
- **Shared Zod schema + Vite/tsconfig alias**: workable, provided the web build is validated with the alias and `zod` is added to the web package/lockfile.
- **Fail-loud boundaries / `1003`**: not yet correct. Server-side `1003` is right; browser-side `1003` is invalid, and outbound extras currently fail open.
- **Delete duplicate `WsEvent` + escape hatches**: directionally correct. Add `sendEvent` to `ChatChannel`, delete the local bags, and remove the casts.
- **Emitter API / bounded resources**: correct. Replacing `events.value` with `onEvent` removes the unbounded retained history; keep any diagnostic error buffer capped behind a named constant.
- **No regex / hardcoded knobs / fragile tool-call heuristics**: no new regex or tool-call heuristics are introduced. The hardcoded diagnostic cap and bundle budget should be named and enforced, not left as prose.
- **Atomic PR / no shim**: correct in intent. The final plan must keep schema, server, SPA, channel interface, and tests in one PR with no compatibility aliases.

## Required Round 2 Changes

1. Make outbound schema variants strict and serialize parsed schema values, not original event objects.
2. Add runtime validation to the SPA `send` path via `WsInboundSchema.parse` or shared encoder helpers.
3. Replace browser-side `close(1003, ...)` with a valid browser close strategy while preserving server-side `1003` for bad client frames.
4. Fix the web test placement/dependencies so `npm test` or an explicit web test command actually runs the proposed SPA composable tests.
5. Correct the Telegram `sendEvent` description and preserve its current message-forwarding behavior.
6. Turn grep invariants and manual smoke steps into executable, accurate validation steps.

VERDICT: CHANGES_REQUESTED