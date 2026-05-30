# G34 — Implementation plan r2

**Finding**: [../G34-builtins-fetch-url-no-streaming-cap.md](../G34-builtins-fetch-url-no-streaming-cap.md)

**Design**: [02-design-r2.md](02-design-r2.md)

**Writer**: Claude Opus 4.7 (round 2)

## 0. Prereqs

- G31 landed: `classifyFsError` exported from
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts);
  `ClassifiedFsError` envelope shape established. G34 mirrors
  the shape but does not call the function (the network
  classifier is independent).
- **Hard sequencing**: G34 lands **before** G33 r2 swaps its
  helper. The order is G31 → G34 → G33 r2 swap. The G33 swap
  is a one-import edit owned by the G33 author; see
  [02-design-r2.md §6](02-design-r2.md#L470-L483) for the
  exact delta.
- `git status` clean on the relevant slice of
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).
- Verify line anchors against the live file before starting:

  ```
  grep -n 'let MAX_FETCH_CHARS\|async function downloadUrl\|case "fetch_url"\|case "fetch_page_text"\|case "download_file"\|case "download_with_fallbacks"\|MAX_FETCH_CHARS = mcpConfig' src/mcp/builtins.ts
  ```

  Expected (as of round 2 authoring): lines 42, 156, 762, 792,
  823, 844, 1078. If anchors have drifted, update the step
  links below before editing.

## 1. Steps

### Step 1 — Rename `maxFetchChars` → `maxFetchBytes` in config

File: [src/config.ts](../../../../src/config.ts#L137-L146).

Delete the `maxFetchChars` line; add `maxFetchBytes` (same
default 200 000) and `fetchTimeoutMs` (default 60 000) per
[02-design-r2.md §3](02-design-r2.md#L228-L256). No backward
compat alias; no Zod `.or(...)` shim. The existing
`.superRefine` block is untouched.

Verify `npx tsc --noEmit` errors on every consumer of the old
name (there should be exactly one in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078)).
Fix in Step 4.

### Step 2 — Create the helper module

File: [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts)
(new).

Implement `HttpFetchErrorCode`, `ClassifiedHttpError`,
`BoundedReadResult`, `TimedFetch`, `fetchWithTimeout`,
`discardBody`, `readBoundedTextBody`, `readBoundedBinaryBody`,
`classifyNetworkError` per
[02-design-r2.md §2](02-design-r2.md#L29-L218). Imports limited
to `node:buffer`.

### Step 3 — Add helper-module tests

File:
[src/mcp/httpFetch.test.ts](../../../../src/mcp/httpFetch.test.ts)
(new).

Implement the helper matrix from
[02-design-r2.md §7](02-design-r2.md#L490-L514). Use the same
in-process `http.createServer` pattern already in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L5)
and
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L13).
Run `npx vitest run src/mcp/httpFetch.test.ts` to green before
proceeding.

### Step 4 — Rewire module-level state in builtins.ts

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

Apply
[02-design-r2.md §4.1](02-design-r2.md#L260-L283):

- Replace lines 42–43
  ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43))
  with `MAX_FETCH_BYTES` / `MAX_DOWNLOAD_BYTES` /
  `FETCH_TIMEOUT_MS` declarations.
- Add the `import { ... } from "./httpFetch.js"` block
  alongside the existing imports near
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L31).
- Replace the rebind line
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078)
  with the three-line rebind (`maxFetchBytes`,
  `maxDownloadBytes`, `fetchTimeoutMs`).

### Step 5 — Extend `DownloadAttempt` and add `DownloadOutcome`

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L103-L111).

Add `code` and `errno` fields per
[02-design-r2.md §4.2](02-design-r2.md#L287-L308). Add the
`DownloadOutcome` discriminated union next to `DownloadSuccess`
at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L113-L121).

### Step 6 — Replace `downloadUrl`

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L156-L237).

Apply
[02-design-r2.md §4.3](02-design-r2.md#L312-L417). The
new helper returns `DownloadOutcome` and never throws — every
classified failure flows through `outcome.failure`. Confirm
`discardBody(response)` precedes every early-exit branch after
headers (no-ok and Content-Length over cap), per the round-1
reviewer's first blocker
([04-review-r1.md](04-review-r1.md#L7)).

### Step 7 — Rewrite `fetch_url`

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L790).

Apply [02-design-r2.md §4.4](02-design-r2.md#L421-L484).
Argument key `args.max_chars` is replaced by `args.max_bytes`;
the tool catalog entry in the same file must be updated to
match (search for the `fetch_url` `inputSchema` declaration).

### Step 8 — Rewrite `fetch_page_text`

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L792-L821).

Apply [02-design-r2.md §4.5](02-design-r2.md#L488-L506). Same
structure as `fetch_url` with `stripHtml(read.body)` and key
`text`. Update the tool catalog entry to use `max_bytes`.

### Step 9 — Rewrite `download_file`

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L823-L842).

Apply
[02-design-r2.md §4.6](02-design-r2.md#L510-L546). The outer
try/catch around `downloadUrl` is removed because
`downloadUrl` no longer throws; the handler propagates
`outcome.failure` (with `code`, `error`, optional
`status`/`errno`) directly to the top-level envelope.

### Step 10 — Rewrite `download_with_fallbacks`

File:
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L844-L890).

Apply
[02-design-r2.md §4.7](02-design-r2.md#L550-L613). Manifest
writes for both success and failure paths are preserved. The
top-level `code` is the last failure's classified code (or
`INVALID_ARGUMENT` when every URL was malformed). Aggregate
error messages start with `ALL_SOURCES_FAILED:`.

### Step 11 — Add handler-integration tests

File:
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts).

Add the thirteen scenarios from
[02-design-r2.md §7](02-design-r2.md#L516-L573). Group by
tool: `fetch_url` (6), `fetch_page_text` (1), `download_file`
(5), `download_with_fallbacks` (2). Reuse a single shared
`http.createServer` per scenario with explicit
`req.on("close", ...)` observers so the body-leak tests can
assert the client closed the socket before EOF.

### Step 12 — Update docs

File:
[docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md).

- Replace `mcp.maxFetchChars` references with
  `mcp.maxFetchBytes`. Document that the cap is a hard byte
  ceiling on the upstream response stream — not a character
  count on the returned string. Default 200 000 unchanged.
- Document that `fetch_page_text` bounds **raw HTML bytes**,
  not stripped characters; callers who need a strict
  character ceiling on the returned `text` must apply it
  themselves. This is the explicit contract the round-1
  reviewer asked for
  ([04-review-r1.md](04-review-r1.md#L13)).
- Document the new `mcp.fetchTimeoutMs` (default 60 000;
  bounds the full request including streaming body read).
- Document the new structured error envelope: top-level `code`
  is one of `INVALID_ARGUMENT`, `TIMEOUT`, `NETWORK_ERROR`,
  `UPSTREAM_HTTP_ERROR`, `RESPONSE_TOO_LARGE`, `IO_ERROR` for
  every fetching/downloading tool.

### Step 13 — Build + typecheck + vitest

```
npx tsc --noEmit
npx vitest run src/mcp/httpFetch.test.ts src/mcp/builtins.test.ts
npm run build
```

All gates must be green before deployment.

### Step 14 — Daemon redeploy

Per workspace ops rules
([WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md)):

- `saivage` at 10.0.3.111 (old v2-on-GetRich).
- `diedrico` at 10.0.3.113 (v2-on-diedrico).
- `saivage-v3` at 10.0.3.112 (v2 harness on
  /work/saivage-v3).

For each container: `ssh root@<ip> 'systemctl stop saivage.service'`,
rebuild on host (the workspace is bind-mounted into each
container), `systemctl start saivage.service`, then
`curl -fsS http://<ip>:8080/health` to confirm.
`saivage-v3-getrich-v2` (10.0.3.170) is unaffected (different
project root).

## 2. Files touched

- [src/config.ts](../../../../src/config.ts) — rename
  `maxFetchChars` → `maxFetchBytes`; add `fetchTimeoutMs`.
- [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) —
  new.
- [src/mcp/httpFetch.test.ts](../../../../src/mcp/httpFetch.test.ts)
  — new.
- [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) —
  edits at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43),
  the import block near
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L31),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L103-L111)
  (DownloadAttempt + DownloadOutcome),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L156-L237)
  (downloadUrl),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L890)
  (the four handler cases),
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078)
  (config rebind), plus the `dataTools` schema entries for
  `fetch_url` and `fetch_page_text` (search for the
  `inputSchema` of each tool).
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)
  — thirteen new integration tests.
- [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)
  — rename + new field documentation + contract paragraph for
  `fetch_page_text`.

Out of scope (separate ownership):

- G33's helper swap, tracked in
  [02-design-r2.md §6](02-design-r2.md#L470-L483). Lands in a
  follow-up commit owned by the G33 author after G34 merges.

## 3. Test gates

| Gate                                  | Pass criterion                                                                                  |
|---|---|
| `npx tsc --noEmit`                    | Exit 0.                                                                                          |
| `npx vitest run src/mcp/httpFetch.test.ts`  | All helper-level tests green.                                                              |
| `npx vitest run src/mcp/builtins.test.ts`   | Existing tests green + 13 new tests green.                                                 |
| Bounded text streaming                | 5 MB upstream → `truncated: true`, `bytes_read ≤ max_bytes`, server observed early socket close. |
| Bounded binary streaming              | 5 MB download, `max_bytes: 1 MB` → `code: "RESPONSE_TOO_LARGE"`, no partial file on disk.       |
| Pre-headers timeout                   | Sleeping upstream → `code: "TIMEOUT"` within `fetchTimeoutMs + 1 s`.                            |
| Mid-body timeout                      | Headers fast, body stall → `code: "TIMEOUT"` (the reviewer's mid-body case).                    |
| Body-leak on `!response.ok`           | Upstream returns 500 with infinite-write body → client cancels; server's write loop sees close. |
| Body-leak on Content-Length too large | Declared CL exceeds cap with infinite-write body → client cancels before significant bytes.     |
| Network error                         | `http://127.0.0.1:1` → `code: "NETWORK_ERROR"`, `errno: "ECONNREFUSED"`.                        |
| Invalid URL                           | `ftp://x` → `code: "INVALID_ARGUMENT"`.                                                          |
| Upstream HTTP error                   | Upstream 500 → `code: "UPSTREAM_HTTP_ERROR"`, `status: 500`.                                     |
| Lying Content-Length                  | Declared 100, sent 1 GB chunked → `code: "RESPONSE_TOO_LARGE"`, no partial file.                |
| Local IO failure                      | `download_file` to read-only dir → `code: "IO_ERROR"`, `errno` set.                              |
| Multi-byte rune                       | 10 KB CJK with `max_bytes: 5 000` → `truncated: true`, no replacement char at tail.             |
| Aggregate failure                     | `download_with_fallbacks` all-fail → top-level `code` = last failure code, `error` starts `ALL_SOURCES_FAILED:`. |
| Build                                 | `npm run build` produces `dist/cli.js`.                                                          |
| Daemon health                         | `curl /health` returns 200 on the three v2 containers post-deploy.                              |

## 4. Rollback

`git revert` the G34 merge commit and redeploy. The shared
helper is purely additive (one new module + new test file);
reverting restores the round-1 (still-broken) behaviour. If
G33 r2's swap has already landed, it must be reverted in
lockstep — its import becomes dangling on revert.

## 5. Out-of-band coordination

- **G33 owner**: notified once G34 lands to perform the
  helper-import swap per
  [02-design-r2.md §6](02-design-r2.md#L470-L483).
- **G31 owner**: no action; G34 mirrors envelope shape only.
- **G32, G35 owners**: same-file rebase only; no semantic
  coordination.
- **Operator-facing change**: the `maxFetchChars` config key
  is removed. Operators with custom `.saivage/saivage.json`
  files referencing the old name must rename it before
  redeploy. Document in the release notes.
