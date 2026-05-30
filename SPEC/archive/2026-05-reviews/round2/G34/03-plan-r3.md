# G34 — Implementation plan r3

**Finding**: [../G34-builtins-fetch-url-no-streaming-cap.md](../G34-builtins-fetch-url-no-streaming-cap.md)

**Design**: [02-design-r3.md](02-design-r3.md)

**Writer**: Claude Opus 4.7 (round 3)

## 0. Prereqs

Unchanged from round 2:
[03-plan-r2.md §0](03-plan-r2.md#L9-L33). G31 must be landed;
G34 lands before G33 r2's helper swap. Re-verify the live
anchors before editing:

```
grep -n 'let MAX_FETCH_CHARS\|async function downloadUrl\|case "fetch_url"\|case "fetch_page_text"\|case "download_file"\|case "download_with_fallbacks"\|MAX_FETCH_CHARS = mcpConfig' src/mcp/builtins.ts
```

Expected as of round-3 authoring: lines 42, 162, 762, 793,
825, 845, 1078. If anchors drift, update the step pointers.

## 1. Steps

### Step 1 — Rename `maxFetchChars` → `maxFetchBytes` in config

Same as
[03-plan-r2.md — Step 1](03-plan-r2.md#L37-L52). Edit
[src/config.ts](../../../../src/config.ts#L137-L146) to add
`maxFetchBytes` (default 200 000) and `fetchTimeoutMs`
(default 60 000); delete `maxFetchChars`. No alias, no
`.or(...)` shim.

### Step 2 — Create the helper module

File: [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts)
(new). Implement the module per
[02-design-r3.md §2](02-design-r3.md#L25-L189). Key
deltas vs round 2:

- `TimedFetch` adds `dispose(): void`.
- `fetchWithTimeout` no longer registers a no-op
  `response.body?.["finally"]` callback.
- `readBoundedTextBody` is **not** a delegate over
  `readBoundedBinaryBody`; it owns its own chunk loop and
  stream-decodes each chunk with `{ stream: true }`. The
  decoder is flushed (`decoder.decode()` with default
  `stream: false`) **only** on the non-truncated branch.
- Both bounded readers check `signal?.aborted` after every
  `await reader.read()` resolves and throw `signal.reason`
  before treating `done: true` as EOF.

### Step 3 — Add helper-module tests

File:
[src/mcp/httpFetch.test.ts](../../../../src/mcp/httpFetch.test.ts)
(new). Implement the round-2 matrix
([02-design-r2.md §7 helper bullets](02-design-r2.md#L667-L702))
plus the six round-3 gates from
[02-design-r3.md §7](02-design-r3.md#L599-L633):

- `fetchWithTimeout` timer cleanup on success, pre-headers
  error, and mid-body error (three tests; `vi.useFakeTimers({
  shouldAdvanceTime: true })`, assert
  `vi.getTimerCount() === 0` after the caller's `finally`).
- Mid-body abort: `readBoundedTextBody` throws (does not
  return a partial-success envelope);
  `classifyNetworkError(err, url, { timedOut: true })` returns
  `{ code: "TIMEOUT", ... }`.
- UTF-8 multi-byte rune straddles cap (1 002 bytes of
  `"日".repeat(334)`, `maxBytes: 1 000`): `truncated: true`,
  `bytes_read ≤ 1 000`, zero `\uFFFD`, length === 333.
- UTF-8 untruncated well-formed input: same data,
  `maxBytes: 2 000`: `truncated: false`, zero `\uFFFD`,
  length === 334.

Run `npx vitest run src/mcp/httpFetch.test.ts` green before
proceeding.

### Step 4 — Rewire module-level state in builtins.ts

Same as
[03-plan-r2.md — Step 4](03-plan-r2.md#L78-L93). Replace lines
42–43 of
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43)
with `MAX_FETCH_BYTES`, `MAX_DOWNLOAD_BYTES`,
`FETCH_TIMEOUT_MS`. Add the `import { ... } from
"./httpFetch.js"` block at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L31).
Replace
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078)
with the three-line rebind.

### Step 5 — Extend `DownloadAttempt` and add `DownloadOutcome`

Same as
[03-plan-r2.md — Step 5](03-plan-r2.md#L95-L102). Apply
[02-design-r2.md §4.2](02-design-r2.md#L287-L308) at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L104-L112).

### Step 6 — Replace `downloadUrl` with try/finally dispose

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L162-L237).

Apply [02-design-r3.md §4.3](02-design-r3.md#L209-L327). Delta
vs round 2: the body of the function is wrapped in
`try { ... } finally { timed.dispose(); }` so the timer is
cleared on success, every classified failure, and the
prompt-injection / IO-error branches. The `discardBody(response)`
calls precede every header-stage early exit (no change from
round 2).

### Step 7 — Rewrite `fetch_url` with try/finally dispose

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L790).

Apply [02-design-r3.md §4.4](02-design-r3.md#L329-L406). Delta
vs round 2: the post-fetch body of the case is wrapped in
`try { ... } finally { timed.dispose(); }`.

**Additionally**: locate the `dataTools` registration block in
the same file (search for `name: "fetch_url"` and its
`inputSchema`). Rename the `max_chars` property to
`max_bytes`; update its description to reflect a byte cap.
This is the anchor cleanup that
[04-review-r2.md](04-review-r2.md#L33) flagged as still
unwired.

### Step 8 — Rewrite `fetch_page_text` with try/finally dispose

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L793-L823).

Apply [02-design-r3.md §4.5](02-design-r3.md#L408-L418). Same
try/finally shape as Step 7 with `stripHtml(read.body)` and
return key `text`. Update the `dataTools` registration block
for `fetch_page_text` (same anchor cleanup as Step 7) so its
`inputSchema` advertises `max_bytes`.

### Step 9 — Rewrite `download_file`

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L825-L843).

Apply
[02-design-r3.md §4.6](02-design-r3.md#L420-L425) — handler
shape is unchanged from
[02-design-r2.md §4.6](02-design-r2.md#L510-L546). The
`dispose()` is owned by `downloadUrl` (Step 6); the handler
does not touch a `TimedFetch` directly.

### Step 10 — Rewrite `download_with_fallbacks`

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L845-L891).

Apply
[02-design-r3.md §4.7](02-design-r3.md#L427-L432) — handler
shape is unchanged from
[02-design-r2.md §4.7](02-design-r2.md#L550-L613).

### Step 11 — Add handler-integration tests

File:
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts).

Add the round-2 thirteen scenarios from
[02-design-r2.md §7 handler bullets](02-design-r2.md#L730-L788),
**plus** the round-3 public-envelope test from
[02-design-r3.md §7](02-design-r3.md#L626-L632):

- `fetch_url` mid-body timeout — assert handler result has
  `isError: true`, `content.code === "TIMEOUT"`, and
  `content.content === undefined`. This is the gate that
  closes the silent-partial-success regression.

Reuse a single shared `http.createServer` per scenario with
explicit `req.on("close", ...)` observers so the body-leak
tests can assert that the client closed the socket before
EOF.

### Step 12 — Update docs

Same as
[03-plan-r2.md — Step 12](03-plan-r2.md#L154-L172). File:
[docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md).
Document the rename, the new `fetchTimeoutMs`, the
`fetch_page_text` raw-bytes contract, and the structured error
envelope.

### Step 13 — Build + typecheck + vitest

```
npx tsc --noEmit
npx vitest run src/mcp/httpFetch.test.ts src/mcp/builtins.test.ts
npm run build
```

All gates green before deployment.

### Step 14 — Daemon redeploy

Same as
[03-plan-r2.md — Step 14](03-plan-r2.md#L191-L205): `saivage`
(10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3`
(10.0.3.112). `saivage-v3-getrich-v2` (10.0.3.170) is
unaffected.

## 2. Files touched

- [src/config.ts](../../../../src/config.ts) — rename
  `maxFetchChars` → `maxFetchBytes`; add `fetchTimeoutMs`.
- [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) —
  new, per [02-design-r3.md §2](02-design-r3.md#L25-L189).
- [src/mcp/httpFetch.test.ts](../../../../src/mcp/httpFetch.test.ts)
  — new, with the round-2 helper matrix plus the six round-3
  gates.
- [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) —
  edits at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L31)
  (import),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43)
  (module-level caps),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L104-L112)
  (`DownloadAttempt` + `DownloadOutcome`),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L162-L237)
  (`downloadUrl` with try/finally `dispose()`),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L890)
  (the four handler cases; `fetch_url` and `fetch_page_text`
  wrap in try/finally `dispose()`),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078)
  (config rebind), plus the `dataTools` `inputSchema`
  declarations for `fetch_url` and `fetch_page_text`
  (`max_chars` → `max_bytes`).
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)
  — thirteen round-2 tests + one round-3 public-envelope test.
- [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)
  — rename + `fetchTimeoutMs` + `fetch_page_text` contract +
  error envelope.

Out of scope (separate ownership): G33 r2's import swap.

## 3. Test gates

| Gate                                  | Pass criterion                                                                                  |
|---|---|
| `npx tsc --noEmit`                    | Exit 0.                                                                                          |
| `npx vitest run src/mcp/httpFetch.test.ts`  | All helper-level tests green (round 2 + 6 round-3 gates).                                |
| `npx vitest run src/mcp/builtins.test.ts`   | Existing tests green + 14 new tests green.                                                |
| Helper timer cleanup — success        | `vi.getTimerCount() === 0` after caller invokes `dispose()` on a short successful fetch.        |
| Helper timer cleanup — pre-headers    | `vi.getTimerCount() === 0` after ECONNREFUSED throws from `fetchWithTimeout`.                   |
| Helper timer cleanup — mid-body       | `vi.getTimerCount() === 0` after upstream RST during body and caller's `finally` runs.          |
| Mid-body timeout — helper             | `readBoundedTextBody` throws (no partial-success envelope); classifier returns `TIMEOUT`.       |
| Mid-body timeout — `fetch_url` handler| `result.isError === true`, `result.content.code === "TIMEOUT"`, `result.content.content === undefined`. |
| UTF-8 cap mid-rune                    | 1 002 bytes of `"日".repeat(334)`, `maxBytes: 1 000` → `truncated: true`, zero `\uFFFD`, length 333. |
| UTF-8 untruncated                     | Same data, `maxBytes: 2 000` → `truncated: false`, zero `\uFFFD`, length 334.                   |
| Bounded text streaming                | 5 MB upstream → `truncated: true`, `bytes_read ≤ max_bytes`, server observed early socket close. |
| Bounded binary streaming              | 5 MB download, `max_bytes: 1 MB` → `code: "RESPONSE_TOO_LARGE"`, no partial file on disk.       |
| Pre-headers timeout                   | Sleeping upstream → `code: "TIMEOUT"` within `fetchTimeoutMs + 1 s`.                            |
| Body-leak on `!response.ok`           | Upstream returns 500 with infinite-write body → client cancels.                                 |
| Body-leak on Content-Length too large | Declared CL exceeds cap with infinite-write body → client cancels before significant bytes.     |
| Network error                         | `http://127.0.0.1:1` → `code: "NETWORK_ERROR"`, `errno: "ECONNREFUSED"`.                        |
| Invalid URL                           | `ftp://x` → `code: "INVALID_ARGUMENT"`.                                                          |
| Upstream HTTP error                   | Upstream 500 → `code: "UPSTREAM_HTTP_ERROR"`, `status: 500`.                                     |
| Lying Content-Length                  | Declared 100, sent 1 GB chunked → `code: "RESPONSE_TOO_LARGE"`, no partial file.                |
| Local IO failure                      | `download_file` to read-only dir → `code: "IO_ERROR"`, `errno` set.                              |
| Aggregate failure                     | `download_with_fallbacks` all-fail → top-level `code` = last failure code, error starts `ALL_SOURCES_FAILED:`. |
| Build                                 | `npm run build` produces `dist/cli.js`.                                                          |
| Daemon health                         | `curl /health` returns 200 on the three v2 containers post-deploy.                              |

## 4. Rollback

Same as
[03-plan-r2.md §4](03-plan-r2.md#L243-L249). `git revert` the
G34 merge commit and redeploy. If G33 r2's swap has landed,
it must be reverted in lockstep.

## 5. Out-of-band coordination

Same as
[03-plan-r2.md §5](03-plan-r2.md#L251-L266). G33 owner is
notified after G34 lands; operators with custom
`mcp.maxFetchChars` in their `.saivage/saivage.json` must
rename to `mcp.maxFetchBytes` before redeploy.
