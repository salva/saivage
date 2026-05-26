# G49 — Design (Round 3)

- **Round 1**: [01-analysis-r1.md](01-analysis-r1.md), [02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md)
- **Round 2**: [01-analysis-r2.md](01-analysis-r2.md), [02-design-r2.md](02-design-r2.md), [03-plan-r2.md](03-plan-r2.md)
- **Round 3 analysis**: [01-analysis-r3.md](01-analysis-r3.md)
- **Review**: [04-review-r2.md](04-review-r2.md)

This r3 design supersedes [02-design-r2.md](02-design-r2.md) only on the points raised by [04-review-r2.md](04-review-r2.md). All r2 schema, composable, server-channel, Telegram, and failure-mode decisions stand. The two changes here are (a) explicit three-way alias wiring for `@channels/ws-schema`, and (b) workspace-local smoke project path.

## 1. Alias topology (new section vs. r2)

`@channels/ws-schema` is the SPA-facing import string for the single Zod schema module at [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts). It must resolve identically in three independent consumers:

| Consumer | Config | Mechanism | Target (relative to that config) |
|---|---|---|---|
| Browser build (Vite) | [web/vite.config.ts](../../../../web/vite.config.ts) | `resolve.alias` | `../src/channels/ws-schema.ts` |
| Browser type-check (tsc) | [web/tsconfig.json](../../../../web/tsconfig.json) | `compilerOptions.paths` | `["../src/channels/ws-schema.ts"]` |
| Test runtime (Vitest) | [vitest.config.ts](../../../../vitest.config.ts) | `resolve.alias` | `./src/channels/ws-schema.ts` |

The server runtime ([src/channels/websocket.ts](../../../../src/channels/websocket.ts)) imports `./ws-schema.js` directly and intentionally does **not** use the alias: tsup/NodeNext handle the relative path, the root tsconfig excludes `web/`, and there is no benefit to widening the server's import vocabulary for a sibling file.

The three alias entries map to the same on-disk file. They are duplicated rather than centralised because (a) there is exactly one alias today, and (b) Vitest does not load `vite.config.ts` and Vite does not load `vitest.config.ts`; any "shared config" abstraction would have to be required by both, which is the same amount of code as three two-line entries.

### 1.1 [vitest.config.ts](../../../../vitest.config.ts) shape

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@channels/ws-schema": fileURLToPath(
        new URL("./src/channels/ws-schema.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "web/src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 10_000,
    passWithNoTests: true,
  },
});
```

`fileURLToPath(new URL(..., import.meta.url))` is the project-idiomatic absolute-path form for ESM configs and avoids `__dirname` issues under `"module": "NodeNext"`. `passWithNoTests`, the two timeouts, and the original two include globs are untouched.

### 1.2 [web/vite.config.ts](../../../../web/vite.config.ts) shape

```ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@channels/ws-schema": fileURLToPath(
        new URL("../src/channels/ws-schema.ts", import.meta.url),
      ),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/health": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
  build: { outDir: "dist" },
});
```

Note: live [web/vite.config.ts](../../../../web/vite.config.ts) at the time of writing has no `resolve` block. r1 §B.1 promised this entry; r3 records the exact form so the round-3 implementer does not invent variants.

### 1.3 [web/tsconfig.json](../../../../web/tsconfig.json) shape

```jsonc
{
  "compilerOptions": {
    // …unchanged…
    "paths": {
      "@/*": ["./src/*"],
      "@channels/ws-schema": ["../src/channels/ws-schema.ts"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.vue"]
}
```

The existing `"@/*"` entry stays. The new entry is a single string (not a wildcard) because the alias targets one file.

## 2. Amended file inventory (delta from r2 §4)

Only the rows that change versus r2 are listed.

| File | Change vs. r2 |
|---|---|
| [vitest.config.ts](../../../../vitest.config.ts) | r2 added `web/src/**/*.test.ts` to `include`. r3 additionally adds a `resolve.alias` entry mapping `@channels/ws-schema` to `./src/channels/ws-schema.ts`. |
| [web/vite.config.ts](../../../../web/vite.config.ts) | Restate the exact `resolve.alias` form (promised in r1/r2 but not previously written down): `@channels/ws-schema` → `../src/channels/ws-schema.ts`. |
| [web/tsconfig.json](../../../../web/tsconfig.json) | Restate the exact `paths` form (promised in r1/r2 but not previously written down): `"@channels/ws-schema": ["../src/channels/ws-schema.ts"]` alongside the existing `"@/*"`. |

All other rows in r2 §4 and r1 §B.1 are unchanged.

## 3. Manual smoke amendment (delta from r2)

The r2 Step 12 smoke is unchanged except the project path. The workspace rule is to keep temporary artifacts under `/home/salva/g/ml/tmp/`, not `/tmp`. The replacement path is `/home/salva/g/ml/tmp/saivage-g49-smoke-project`. The smoke also gains a `mkdir -p` pre-step and an `rm -rf` post-step so the run is hermetic.

```bash
mkdir -p /home/salva/g/ml/tmp/saivage-g49-smoke-project
cd /home/salva/g/ml/saivage
npm run dev -- serve /home/salva/g/ml/tmp/saivage-g49-smoke-project
# (in another terminal, the Node ws one-shot from r2 Step 12 unchanged)
# after assertions pass:
rm -rf /home/salva/g/ml/tmp/saivage-g49-smoke-project
```

The Node `ws` snippet body and the expected `close 1003 schema-violation` line are unchanged from r2 §10 Step 12. The optional in-server fail-loud sub-step (temporarily edit `src/server/server.ts` to call a drifting `sendEvent`) is unchanged.

## 4. Updated migration order (delta from r2 §6)

Same 12 steps from r2, plus one targeted edit (numbered 4a to keep ordinals stable):

1. [src/channels/ws-schema.ts](../../../../src/channels/ws-schema.ts) (new).
2. [web/package.json](../../../../web/package.json), [web/tsconfig.json](../../../../web/tsconfig.json) (adds `paths` entry), [web/vite.config.ts](../../../../web/vite.config.ts) (adds `resolve.alias`).
3. [package.json](../../../../package.json) — add `happy-dom` devDependency. Lockfile update.
4. [vitest.config.ts](../../../../vitest.config.ts) — extend `include` to cover `web/src/**/*.test.ts`.
4a. [vitest.config.ts](../../../../vitest.config.ts) — add `resolve.alias` for `@channels/ws-schema`. (Combine with Step 4 if a single diff is preferred.)
5. [src/channels/types.ts](../../../../src/channels/types.ts).
6. [src/channels/websocket.ts](../../../../src/channels/websocket.ts).
7. [src/channels/telegram.ts](../../../../src/channels/telegram.ts).
8. [src/agents/chat.ts](../../../../src/agents/chat.ts).
9. [web/src/composables/useWebSocket.ts](../../../../web/src/composables/useWebSocket.ts).
10. [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue).
11. [src/channels/ws-schema.test.ts](../../../../src/channels/ws-schema.test.ts) (new).
12. [src/channels/websocket.test.ts](../../../../src/channels/websocket.test.ts) (new).
13. [web/src/composables/useWebSocket.test.ts](../../../../web/src/composables/useWebSocket.test.ts) (new).

The PR remains atomic for the same reasons given in r1/r2: the server, web, and test resolvers must agree on the schema module shape and location at every commit a reviewer might check out.

## 5. Items unchanged from r2

Everything in [02-design-r2.md](02-design-r2.md) §1 (schema shape, strict variants, `error` inbound), §2 (composable shape, runtime `send` validation, browser-safe close), §3 (server channel shape, `JSON.stringify(parsed)`), §5 (failure-mode table), §7 (deferred items) stands.
