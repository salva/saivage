# G34 — Analysis r1

**Finding**: [../G34-builtins-fetch-url-no-streaming-cap.md](../G34-builtins-fetch-url-no-streaming-cap.md)

**Writer**: Claude Opus 4.7 (round 1)

## 1. Root cause

The five HTTP-fetching builtins in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) all
materialise the upstream response **in full** before consulting
any size cap:

- `fetch_url` calls `await response.text()` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L766),
  then trims with `String#slice(0, MAX_FETCH_CHARS)` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L767).
- `fetch_page_text` (the handler the finding calls
  `fetch_page_content`; the on-disk tool name is
  `fetch_page_text`) does the same at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L797).
- `download_file` and `download_with_fallbacks` both go through
  `downloadUrl`, which calls
  `Buffer.from(await response.arrayBuffer())` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L197).
  The `Content-Length` pre-check at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L191-L195)
  is advisory: it short-circuits only when the upstream
  truthfully reports the size, and a hostile or chunked-transfer
  upstream can omit the header.
- `head_url` is `HEAD`-only and has no body to bound.

Module-level caps are declared at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43)
and rebound from config in `registerBuiltinServices` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078-L1079).
The handlers further clamp the per-call argument with
`Math.min(Math.max(...))` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L764),
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L795-L797),
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L828), and
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L850).
The clamp is correct; the bug is that the value is consulted
**after** the body is in RAM.

The cap is therefore a post-hoc trim of the resulting LLM
context, not a memory or bandwidth guard for the Saivage
process itself. A 5 GB chunked response will OOM the in-process
MCP runtime well before the byte counter fires. Likewise, there
is no `AbortSignal.timeout(…)`: a slow-loris upstream blocks
the worker indefinitely (the only outer timeout is the
runtime-level `mcp.inProcessTimeoutMs` at
[src/config.ts](../../../../src/config.ts#L140), which is 5 min
and is not a tight per-fetch bound).

## 2. Error-envelope status

The current handlers return only `{ error: string }` on failure
([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L772-L778)
for the prompt-injection branch,
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L817-L821)
for `download_file`). There is no `code` field, so callers
cannot distinguish "URL malformed" from "upstream returned 500"
from "body exceeded cap" from "network reset". This is
inconsistent with the envelope conventions established by
[../G31/02-design-r4.md §2](../G31/02-design-r4.md#L23-L41)
(filesystem `code`s: `NOT_FOUND`, `PERMISSION_DENIED`,
`NOT_A_FILE`, `IO_ERROR`, `BINARY_CONTENT`),
[../G32/02-design-r3.md](../G32/02-design-r3.md) (search
envelopes with per-entry `error.code`), and the in-flight
[../G33/02-design-r1.md](../G33/02-design-r1.md) (web-search
envelopes with `INVALID_ARGUMENT`, `TIMEOUT`, `NETWORK_ERROR`,
`UPSTREAM_HTTP_ERROR`, `RESPONSE_TOO_LARGE`,
`NO_RESULTS_PARSED`).

## 3. Helper-ownership question

[../G33/02-design-r1.md §3.5](../G33/02-design-r1.md#L228-L262)
introduces a file-private `readBoundedTextBody(response,
maxBytes)` for the `web_search` body read, and explicitly
notes:

> G34 will replace both copies (its own `fetch_url` path and
> the one introduced here) with a single shared helper after
> both land.

G34 is the natural owner because (a) it has four call sites to
G33's one, (b) it needs both text and binary variants
(`readBoundedTextBody` and `readBoundedBinaryBody`), and (c) it
must also own the `AbortSignal.timeout` plumbing that G33 only
needs trivially. Per the workspace architecture-first rule, the
helper should live in its own module from the start —
[src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) — and
G33 r2 should import it instead of re-declaring its own copy.

## 4. Sequencing constraints

- **Orthogonal to G30** (per [../G30/APPROVED.md](../G30/APPROVED.md)):
  G30's `fs/promises` migration touches the same file but
  different functions and a different concern. G30's
  `noSyncFsScanner` does not flag `fetch`/`response.body` paths.
- **Same-file co-edits** with G31 (the `read_file` rewrite at
  [../G31/02-design-r4.md §4](../G31/02-design-r4.md#L60-L181)),
  G32 (the `search_files` rewrite), G33 (`web_search` rewrite),
  and G35 (any handler edits in
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts)). The
  conflicts are spatially disjoint: G34 owns
  - the module-level `let MAX_FETCH_CHARS` /
    `MAX_DOWNLOAD_BYTES` block at
    [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43)
    (extended, not replaced),
  - the `downloadUrl` helper at
    [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L138-L235),
  - the `fetch_url`, `fetch_page_text`, `download_file`, and
    `download_with_fallbacks` handler bodies at
    [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L880),
  - the `registerBuiltinServices` config rebind at
    [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078-L1079),
  - the `mcp` config block at
    [src/config.ts](../../../../src/config.ts#L137-L170).
- **G31 prerequisite — soft.** G31 ships the first exported
  classifier helper (`classifyFsError`) and establishes the
  envelope shape. G34 does not call `classifyFsError`, but it
  follows the same export-and-test pattern for a sibling
  network-error classifier and adopts the same `{ code, error,
  ...extra }` shape. Order: G31 lands → G34 cherry-picks the
  envelope contract → G34 lands → G33 r2 imports the shared
  helper from G34 → G33 lands.
- **Daemon impact**: same as G30 — `saivage` (10.0.3.111),
  `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) bind-mount
  the workspace and run `dist/cli.js serve …`. A redeploy is
  required after G34 lands. `saivage-v3-getrich-v2` is
  unaffected (different project root).

## 5. Test gaps

- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)
  has no test for body-size enforcement in
  `fetch_url`/`fetch_page_text`/`download_file` against an
  upstream that refuses to honour the cap. It also has no
  timeout test and no test for chunked-transfer-encoding bodies
  that omit `Content-Length`.
- No test covers structured error codes for the network
  failure modes (DNS error, ECONNRESET, HTTP 4xx/5xx, slow
  upstream).

## 6. Non-goals

- We do not change the *default* values of `maxFetchChars`
  (200 000 chars) or `maxDownloadBytes` (250 MB). The bug is
  enforcement timing, not value tuning.
- We do not introduce retries inside the shared helper.
  `download_with_fallbacks` already owns retry semantics at the
  handler layer.
- We do not change `head_url`; it has no body to bound.
- We do not introduce a streaming-to-disk path for
  `download_file` larger than 250 MB. The current behaviour
  (buffer then write) is preserved, but bounded; if the default
  ever needs to grow past in-memory, that is a follow-up.
