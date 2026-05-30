# G34 — Implementation plan r1

**Finding**: [../G34-builtins-fetch-url-no-streaming-cap.md](../G34-builtins-fetch-url-no-streaming-cap.md)

**Design**: [02-design-r1.md](02-design-r1.md)

**Writer**: Claude Opus 4.7 (round 1)

## 0. Prereqs

- G31 landed (`classifyFsError` exported from
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts);
  envelope conventions established).
- G33 r1 design exists at
  [../G33/02-design-r1.md](../G33/02-design-r1.md); G34 owns
  the shared helper and G33 r2 will import from it.
- `git status` clean on the relevant slice of
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

## 1. Steps

### Step 1 — Add `fetchTimeoutMs` config field

File: [src/config.ts](../../../../src/config.ts#L137-L170).

Add the new line inside the `mcp` block before the closing
`.default({})`. No `superRefine` changes needed (the new field
is independent of the existing shell-timeout invariant).

Validate with `npx tsc --noEmit` and the existing config tests.

### Step 2 — Create the helper module

File: [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts)
(new).

Implement the four exports + one type per
[02-design-r1.md §3.1](02-design-r1.md#L74). Keep dependencies
zero — only `node:buffer` is imported.

### Step 3 — Add helper-module tests

File:
[src/mcp/httpFetch.test.ts](../../../../src/mcp/httpFetch.test.ts)
(new).

Implement the helper-level matrix from
[02-design-r1.md §3.9](02-design-r1.md#L319). Use the same
in-process `http.createServer` pattern already in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts).
Run `npx vitest run src/mcp/httpFetch.test.ts` to green.

### Step 4 — Rewire module-level cap in builtins.ts

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

- Add `let FETCH_TIMEOUT_MS = 60_000;` next to
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43).
- Add import:
  `import { fetchWithTimeout, readBoundedTextBody, readBoundedBinaryBody, classifyNetworkError, type BoundedReadResult } from "./httpFetch.js";`
- Inside `registerBuiltinServices` near
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078-L1079),
  add `FETCH_TIMEOUT_MS = mcpConfig.fetchTimeoutMs;`.

### Step 5 — Rewrite `fetch_url` handler

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L783).

Apply the replacement from
[02-design-r1.md §3.4](02-design-r1.md#L184). Touch only the
case body; do not move neighbouring cases.

### Step 6 — Rewrite `fetch_page_text` handler

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L795-L823).

Apply the replacement from
[02-design-r1.md §3.5](02-design-r1.md#L255). Identical to
`fetch_url` except the body is `stripHtml(read.body)` and the
returned key is `text` (preserves the existing tool output
contract for that field).

### Step 7 — Rewrite `downloadUrl` helper

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L138-L235).

Apply the replacement from
[02-design-r1.md §3.6](02-design-r1.md#L264). Preserve the
existing prompt-injection scan, sha256, file-write, and
`DownloadSuccess` shape — only the body acquisition path
changes. The `download_file` and `download_with_fallbacks`
case bodies do not change beyond consuming the new
`attempt.error` text.

### Step 8 — Add handler-integration tests

File:
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts).

Add the seven scenarios from
[02-design-r1.md §3.9](02-design-r1.md#L319) (chunked
truncation, timeout, refused, malformed URL, HTTP 500,
download truncation, lying Content-Length). Use a single
shared `http.createServer` per scenario.

### Step 9 — Build + typecheck + vitest

```
npx tsc --noEmit
npx vitest run src/mcp/httpFetch.test.ts src/mcp/builtins.test.ts
npm run build
```

All must be green.

### Step 10 — Daemon redeploy (per workspace ops rules)

Stop, rebuild, restart on the three v2-codebase containers:

- `saivage` at 10.0.3.111
- `diedrico` at 10.0.3.113
- `saivage-v3` at 10.0.3.112

`saivage-v3-getrich-v2` is unaffected.

Health-check each: `curl -fsS http://<ip>:8080/health` must
return success.

## 2. Files touched

- [src/config.ts](../../../../src/config.ts) — one new field
  in the `mcp` block.
- [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) —
  new file.
- [src/mcp/httpFetch.test.ts](../../../../src/mcp/httpFetch.test.ts)
  — new file.
- [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) —
  edits to lines
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L138-L235),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L823),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078-L1079).
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)
  — seven new integration tests.
- [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)
  — one-paragraph documentation of `mcp.fetchTimeoutMs` and the
  re-interpretation of `maxFetchChars` as a byte cap on the
  upstream stream.

Out of scope for this finding (handled elsewhere):

- [../G33/02-design-r2.md](../G33/02-design-r2.md) — G33's r2
  swap of its file-private helper for the shared import. The
  import line is one diff: a separate PR/commit owned by G33.

## 3. Test gates

| Gate                          | Pass criterion                                                |
|---|---|
| `npx tsc --noEmit`            | Exit 0.                                                       |
| `npx vitest run src/mcp/httpFetch.test.ts` | All helper-level tests green.                    |
| `npx vitest run src/mcp/builtins.test.ts`  | All existing + 7 new integration tests green.    |
| Bounded text streaming        | 5 MB upstream → `truncated: true`, `bytes_read ≤ max_chars`.  |
| Bounded binary streaming      | 5 MB download with `max_bytes: 1 MB` → `code: "RESPONSE_TOO_LARGE"`, no partial file. |
| Timeout                       | Sleeping upstream → `code: "TIMEOUT"` within `fetchTimeoutMs + 1s`. |
| Network error                 | `http://127.0.0.1:1` → `code: "NETWORK_ERROR"`, `errno: "ECONNREFUSED"`. |
| Invalid URL                   | `ftp://x` → `code: "INVALID_ARGUMENT"`.                       |
| Upstream HTTP error           | Upstream 500 → `code: "UPSTREAM_HTTP_ERROR"`, `status: 500`.  |
| Lying Content-Length          | Declared 100, sent 1 GB → `code: "RESPONSE_TOO_LARGE"`.       |
| Build                         | `npm run build` produces `dist/cli.js`.                       |
| Daemon health                 | `curl /health` on each v2 container returns 200 post-deploy.  |

## 4. Rollback

`git revert` the G34 merge commit and redeploy. The shared
helper is purely additive (one new module); reverting the
handler changes leaves the (still-broken) round-1 behaviour.
G33 r2 must be reverted in lockstep if it has landed; the
import becomes dangling on revert.

## 5. Out-of-band coordination

- **G33 owner**: notify when G34 has landed so G33 r2 can swap
  the file-private helper for the shared import.
- **G31 owner**: no coordination required; G34 only reads the
  shape of `classifyFsError`, does not call it.
- **G32, G35 owners**: same-file rebase only; no semantic
  coordination.
