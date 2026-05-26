# G49 — Analysis (Round 3)

- **Round 1**: [01-analysis-r1.md](01-analysis-r1.md), [02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md)
- **Round 2**: [01-analysis-r2.md](01-analysis-r2.md), [02-design-r2.md](02-design-r2.md), [03-plan-r2.md](03-plan-r2.md)
- **Review**: [04-review-r2.md](04-review-r2.md)
- **Issue**: [../G49-usewebsocket-send-leaky-envelope.md](../G49-usewebsocket-send-leaky-envelope.md)

This r3 analysis supersedes [01-analysis-r2.md](01-analysis-r2.md) only on the two points raised by [04-review-r2.md](04-review-r2.md). Every finding, evidence table, schema decision, strict-outbound argument, browser-close semantics, Telegram dispatch, and test surface from r2 stands. The two blockers are pure plumbing: test-time resolver alignment, and the temp path used in the manual smoke.

## 1. Corrections to r2 framings

### 1.1 Root Vitest must resolve `@channels/ws-schema`, not just discover the spec

r2 widened the root [vitest.config.ts](../../../../vitest.config.ts) `include` to `["src/**/*.test.ts", "tests/**/*.test.ts", "web/src/**/*.test.ts"]`, which is necessary but not sufficient. The new composable spec at `web/src/composables/useWebSocket.test.ts` imports [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts), which in r2 imports `@channels/ws-schema`. That bare specifier is only resolvable to consumers that have been told what it points at. The live wiring story would be:

- **Server-side runtime** ([src/channels/websocket.ts](../../../../src/channels/websocket.ts)) uses the relative path `./ws-schema.js`. No alias needed; tsup/Node handle it natively. Confirmed by reading r2 §3 design snippet — the server does **not** use `@channels/ws-schema`.
- **Browser runtime** (web Vite build) uses `@channels/ws-schema`, resolved by an alias in [web/vite.config.ts](../../../../web/vite.config.ts).
- **Browser editor / type-check** uses `@channels/ws-schema`, resolved by a matching `paths` entry in [web/tsconfig.json](../../../../web/tsconfig.json).
- **Test runtime** (root Vitest, the same `npm test` that gates merge) sees the same import string when it picks up `web/src/composables/useWebSocket.test.ts` → `useWebSocket.ts` → `@channels/ws-schema`. The live root [vitest.config.ts](../../../../vitest.config.ts) has no `resolve.alias`, no tsconfig-paths plugin, and does not load the web Vite config. Vitest therefore tries to resolve `@channels/ws-schema` against `node_modules` and fails with `Cannot find module '@channels/ws-schema'`. The promised composable tests do not run.

**Correction.** A new Step 4a is added to the round-3 plan: add a `resolve.alias` block to the root [vitest.config.ts](../../../../vitest.config.ts) that maps `@channels/ws-schema` to the absolute path of `src/channels/ws-schema.ts`. The alias is co-located with the matching browser-side alias in [web/vite.config.ts](../../../../web/vite.config.ts) and the matching TypeScript `paths` entry in [web/tsconfig.json](../../../../web/tsconfig.json) — three configs, one specifier, one target file.

The root tsconfig is left alone: it excludes `web/` and the server import uses the relative form, so it never sees the alias.

This matches the precedent set by other Vitest configs in the workspace: the same machinery is duplicated across `vite.config.ts` and `vitest.config.ts` deliberately because Vitest does not load `vite.config.ts` unless explicitly asked. We do not refactor to a shared module because (a) there is exactly one alias today and (b) the duplication is two lines.

**Alternatives considered and rejected.**

- *Use `vitest --config web/vite.config.ts`.* Rejected: Vitest would run only with the web Vite plugins active, and the server-side specs (which import Node-only modules) would either crash on the `vue()` plugin or need a separate command. The current "one `npm test` runs everything" guarantee is worth keeping.
- *Add a `test` section to `web/vite.config.ts` and let Vitest auto-load it.* Same problem as above plus the web package would need a `test` script, contradicting the standing decision to keep `web/` framework-free.
- *Add `vite-tsconfig-paths` and pick up `web/tsconfig.json` paths.* Rejected as over-engineering: one new dev dep, one new plugin, all to encode the same one-line mapping.

### 1.2 Smoke project path is workspace-local, not `/tmp`

The standing workspace rule (recorded in user memory and reiterated in the review) is to keep temporary artifacts under `/home/salva/g/ml/tmp/`, not `/tmp`. r2 Step 12 wrote `npm run dev -- serve /tmp/smoke-project`. That is wrong by local policy and breaks for any agent that has not authorized read access to `/tmp`.

**Correction.** The smoke project path becomes `/home/salva/g/ml/tmp/saivage-g49-smoke-project`. Round 3 Step 12 also adds a pre-step that ensures the directory exists (`mkdir -p`) and a post-step that removes it on success (`rm -rf`), so the smoke leaves no residue under the workspace `tmp/`.

## 2. Updated test wiring (delta from r2 §3)

Same set of three spec files. Same `happy-dom` env header on the SPA spec. The new wiring:

- [vitest.config.ts](../../../../vitest.config.ts) `include` becomes `["src/**/*.test.ts", "tests/**/*.test.ts", "web/src/**/*.test.ts"]` (already in r2 plan).
- [vitest.config.ts](../../../../vitest.config.ts) gains `resolve.alias: { "@channels/ws-schema": fileURLToPath(new URL("./src/channels/ws-schema.ts", import.meta.url)) }` (new in r3).
- [web/vite.config.ts](../../../../web/vite.config.ts) gains `resolve.alias: { "@channels/ws-schema": fileURLToPath(new URL("../src/channels/ws-schema.ts", import.meta.url)) }` (was already in r1/r2 plan §B.1; this round states the exact form).
- [web/tsconfig.json](../../../../web/tsconfig.json) gains `paths: { "@channels/ws-schema": ["../src/channels/ws-schema.ts"] }` next to the existing `"@/*"` entry (was already in r1/r2 plan; restated here for the three-way match).

The three lines all point at the same file, written as a relative path from the config that owns the entry. This is the "alias matches across server, web, and test" wording from the review.

## 3. Updated test surface (delta from r2 §2)

No test additions or deletions. The 20-test count from r2 stands. The composable tests now actually load because Vitest can resolve `@channels/ws-schema`. T18's `// @ts-expect-error events` is still valid even though the type comes through the alias; tsc resolves the alias via `web/tsconfig.json` paths.

A new acceptance line is added: `npm test` from the saivage root must complete with `Test Files 3 passed` (the new schema, server, and composable specs) and `Tests 20 passed`.

## 4. Updated smoke (delta from r2 §10)

The full r2 Step 12 body stays except for the project path:

```bash
mkdir -p /home/salva/g/ml/tmp/saivage-g49-smoke-project
cd /home/salva/g/ml/saivage
npm run dev -- serve /home/salva/g/ml/tmp/saivage-g49-smoke-project
# … node ws one-shot from r2 Step 12 …
rm -rf /home/salva/g/ml/tmp/saivage-g49-smoke-project
```

The Node `ws` snippet, the expected `close 1003 schema-violation` assertion, and the optional in-server fail-loud check are unchanged from r2.

## 5. Items unchanged from r2

Everything in [01-analysis-r2.md](01-analysis-r2.md) §1.1–§1.6, §2, §4, §6, §7 stands. Specifically:

- Browser close uses `ws.close()` with no arguments.
- `WsOutboundSchema` is strict per variant; the server sender serializes `WsOutboundSchema.parse(event)`, not the original argument.
- `useWebSocket.send` runtime-validates with `WsInboundSchema.parse(msg)`.
- Telegram `sendEvent` forwards the `"message"` variant; other variants are explicit no-ops.
- Inbound `error` envelope is logged at warn and does **not** reach `messageHandler`.
- The grep invariants are a manual PR-checklist gate, not part of `npm run build`.

## 6. Items still deferred

Same as r2 §7: AsyncAPI/OpenAPI publication (G40 territory), Telegram event-stream replacement (sibling work), Debug-tab redesign migration (G46/G47 territory).
