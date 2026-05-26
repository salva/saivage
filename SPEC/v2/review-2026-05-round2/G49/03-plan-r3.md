# G49 — Plan (Round 3)

- **Round 1**: [03-plan-r1.md](03-plan-r1.md)
- **Round 2**: [03-plan-r2.md](03-plan-r2.md)
- **Round 3**: [01-analysis-r3.md](01-analysis-r3.md), [02-design-r3.md](02-design-r3.md)
- **Review**: [04-review-r2.md](04-review-r2.md)

This r3 plan supersedes [03-plan-r2.md](03-plan-r2.md) only on the two blockers in [04-review-r2.md](04-review-r2.md). All r2 step bodies (Steps 1, 2, replaced 3, 4, 5, 6, replaced 7, 8, replaced 9, replaced 10, new 11) stand. The two deltas are:

- Step 4 is split into 4a (test discovery) and 4b (test resolver alias).
- Step 12 (manual smoke) replaces `/tmp/smoke-project` with a workspace-local path under `/home/salva/g/ml/tmp/`.

A small restatement of the matching browser-side alias forms (Step 2) is included so the three configs are unambiguous.

## Replaced Step 2 — Browser-side alias entries (restates r1 §B.1 / r2 §4)

The r1/r2 plan promised an alias for `@channels/ws-schema` in the web Vite config and the web tsconfig but did not pin the exact form. Round 3 fixes the wording.

Edit [web/vite.config.ts](../../../../web/vite.config.ts):

- Add `import { fileURLToPath } from "node:url";` next to the existing imports.
- Insert a `resolve.alias` block:
  ```ts
  resolve: {
    alias: {
      "@channels/ws-schema": fileURLToPath(
        new URL("../src/channels/ws-schema.ts", import.meta.url),
      ),
    },
  },
  ```
  Position it between `plugins` and `server` so it reads top-to-bottom in declaration order.

Edit [web/tsconfig.json](../../../../web/tsconfig.json):

- Inside `compilerOptions.paths`, add `"@channels/ws-schema": ["../src/channels/ws-schema.ts"]` next to the existing `"@/*": ["./src/*"]`.

(The rest of Step 2 from r1 — adding `zod` to `web/package.json` `dependencies` — is unchanged.)

## Replaced Step 4 — Vitest discovery + resolver alias

Edit [vitest.config.ts](../../../../vitest.config.ts) in two coordinated changes (same diff is fine; numbered for clarity):

### 4a. Discovery

- `include` becomes `["src/**/*.test.ts", "tests/**/*.test.ts", "web/src/**/*.test.ts"]`. (Already specified in r2.)

### 4b. Resolver alias (new in r3)

- Add `import { fileURLToPath } from "node:url";` at the top.
- Add a top-level `resolve.alias` block:
  ```ts
  resolve: {
    alias: {
      "@channels/ws-schema": fileURLToPath(
        new URL("./src/channels/ws-schema.ts", import.meta.url),
      ),
    },
  },
  ```
- Leave `testTimeout`, `hookTimeout`, `passWithNoTests` untouched.

Final shape of the file is given verbatim in [02-design-r3.md §1.1](02-design-r3.md#11-vitestconfigts-shape).

**Why this matters.** Without 4b, Vitest discovers `web/src/composables/useWebSocket.test.ts`, evaluates it, fails to resolve `@channels/ws-schema` against `node_modules`, and reports a load-time error before any `expect` runs. The composable test count would silently go from "20 added" to "13 added"; T14–T20 would all fail at the import line. This is exactly the failure mode the round-2 reviewer flagged.

**Note for the implementer.** Server-side specs ([src/channels/ws-schema.test.ts](../../../../src/channels/ws-schema.test.ts) and [src/channels/websocket.test.ts](../../../../src/channels/websocket.test.ts)) import the schema via the relative path `./ws-schema.js` (matching the server-side runtime import). They do **not** exercise the alias and therefore would pass even without 4b. Only the SPA composable spec depends on the alias; do not "fix" the server-side imports to use `@channels/ws-schema` for symmetry — keeping them relative is what lets the root tsconfig and tsup continue to ignore the alias entirely.

## Replaced Step 12 — Manual smoke (workspace-local project path)

The smoke procedure is unchanged from [r2 Step 12](03-plan-r2.md#new-step-12--manual-smoke-replaces-r1-4-last-bullet) except the project path. Workspace policy requires temp artifacts under `/home/salva/g/ml/tmp/`, not `/tmp`.

1. Set up a fresh project directory under workspace `tmp/`:
   ```bash
   mkdir -p /home/salva/g/ml/tmp/saivage-g49-smoke-project
   cd /home/salva/g/ml/saivage
   npm run dev -- serve /home/salva/g/ml/tmp/saivage-g49-smoke-project
   ```
2. In another terminal, open a raw WebSocket as the auth client would and send a malformed frame (unchanged from r2):
   ```bash
   node -e '
   import("ws").then(({ default: WS }) => {
     const ws = new WS("ws://127.0.0.1:8080/ws?token=" + process.env.SAIVAGE_TOKEN);
     ws.on("open",  () => { ws.send("garbage"); });
     ws.on("close", (code, reason) => {
       console.log("close", code, reason.toString());
       process.exit(0);
     });
   });'
   ```
   Expected: `close 1003 schema-violation` on stdout, and the server log line `[ws] dropping malformed inbound frame: invalid-json: …`.
3. Open the SPA in a browser against the same dev server, send a normal chat message — the round-trip works (regression check on the happy path).
4. (Optional, unchanged from r2.) Temporarily edit [src/server/server.ts L693](../../../../src/server/server.ts#L693) to call `channel.sendEvent({ type: "toolCall" } as any)` on a debug endpoint, hit that endpoint, and confirm the server throws synchronously in the existing chat-agent error path. Revert the temp edit.
5. Stop the dev server and clean up:
   ```bash
   rm -rf /home/salva/g/ml/tmp/saivage-g49-smoke-project
   ```

## Updated order of file edits (delta from r2)

Same list as r2 §13, with Step 4 understood to cover both 4a and 4b:

1. [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts) (new).
2. [web/package.json](../../../../web/package.json), [web/tsconfig.json](../../../../web/tsconfig.json) (adds `paths` entry), [web/vite.config.ts](../../../../web/vite.config.ts) (adds `resolve.alias`).
3. [package.json](../../../../package.json) — add `happy-dom` devDependency. Lockfile update.
4. [vitest.config.ts](../../../../vitest.config.ts) — extend `include` **and** add `resolve.alias` for `@channels/ws-schema`.
5. [src/channels/types.ts](../../../../src/channels/types.ts).
6. [src/channels/websocket.ts](../../../../src/channels/websocket.ts).
7. [src/channels/telegram.ts](../../../../src/channels/telegram.ts).
8. [src/agents/chat.ts](../../../../src/agents/chat.ts).
9. [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts).
10. [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue).
11. [src/channels/ws-schema.test.ts](../../../../src/channels/ws-schema.test.ts) (new).
12. [src/channels/websocket.test.ts](../../../../src/channels/websocket.test.ts) (new).
13. [web/src/composables/useWebSocket.test.ts](../../../../web/src/composables/useWebSocket.test.ts) (new).

The tree is compilable after step 1. Steps 6–10 must land together so the wire format never disagrees between ends. Step 4 must land at or before step 13, otherwise the composable spec fails at import.

## Acceptance checklist (delta from r2)

Carry forward every checkbox in [r2 §"Acceptance checklist"](03-plan-r2.md#acceptance-checklist-replaces-r1-4). Add or replace:

- [ ] [vitest.config.ts](../../../../vitest.config.ts) `resolve.alias` maps `@channels/ws-schema` to the absolute path of `src/channels/ws-schema.ts` (via `fileURLToPath(new URL(...))`).
- [ ] [web/vite.config.ts](../../../../web/vite.config.ts) `resolve.alias` maps `@channels/ws-schema` to `../src/channels/ws-schema.ts` (same target, relative form for that config).
- [ ] [web/tsconfig.json](../../../../web/tsconfig.json) `compilerOptions.paths` contains `"@channels/ws-schema": ["../src/channels/ws-schema.ts"]`.
- [ ] All three aliases above point at the same on-disk file. Verify with `realpath`:
  ```bash
  cd /home/salva/g/ml/saivage
  test "$(realpath src/channels/ws-schema.ts)" = \
       "$(node -e 'import("./vitest.config.ts").then(c => console.log(c.default.resolve.alias["@channels/ws-schema"]))')"
  ```
  (The Vite/tsc resolutions are verified implicitly by `cd web && npm run build` and `npm run typecheck` in the web package.)
- [ ] `npm test` from `/home/salva/g/ml/saivage` reports `Test Files  3 passed (3)` and `Tests  20 passed (20)`.
- [ ] The manual smoke in Step 12 uses `/home/salva/g/ml/tmp/saivage-g49-smoke-project`, **not** `/tmp/...`. Verify by `grep -n "/tmp/smoke" SPEC/v2/review-2026-05-round2/G49/03-plan-r3.md` — only the historical reference in the prose is allowed; no live command targets `/tmp/`.
- [ ] After the smoke, `/home/salva/g/ml/tmp/saivage-g49-smoke-project` does not exist (verify with `test ! -d`).

The r2 acceptance line "`vitest.config.ts` `include` lists `web/src/**/*.test.ts`" remains; r3 only **adds** the alias requirement, it does not retract anything.

## Out of scope (unchanged from r1/r2)

Same as r2 "Out of scope" (which inherited from r1 §5). No new exclusions in r3.
