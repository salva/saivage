# G34 — Analysis r2

**Finding**: [../G34-builtins-fetch-url-no-streaming-cap.md](../G34-builtins-fetch-url-no-streaming-cap.md)

**Round 1 docs**:
[01-analysis-r1.md](01-analysis-r1.md),
[02-design-r1.md](02-design-r1.md),
[03-plan-r1.md](03-plan-r1.md)

**Round 1 review**: [04-review-r1.md](04-review-r1.md) — VERDICT
CHANGES_REQUESTED; direction (G34 owns the shared HTTP helper
module) approved.

**Writer**: Claude Opus 4.7 (round 2)

## 1. Root cause (unchanged)

The five HTTP-fetching builtins in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts)
materialise the upstream response in full before consulting any
size cap:

- `fetch_url` calls `await response.text()` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L765)
  and trims with `String#slice` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L767).
- `fetch_page_text` does the same at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L796-L799).
- `download_file` and `download_with_fallbacks` both flow
  through `downloadUrl`, which calls
  `Buffer.from(await response.arrayBuffer())` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L197).
- The `Content-Length` pre-check at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L191-L195)
  is advisory only.
- `head_url` is `HEAD`-only and has no body to bound.

Module-level caps are declared at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43)
and rebound from config in `registerBuiltinServices` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078-L1079).
The per-call clamps at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L764),
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L795),
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L826), and
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L847)
are correct; the bug is that they fire after the body is already
in RAM. No per-fetch timeout exists; the only outer bound is
`mcp.inProcessTimeoutMs` at
[src/config.ts](../../../../src/config.ts#L140) (5 min).

## 2. Error-envelope status (unchanged)

Current handlers return `{ error: string }` on failure
([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L775-L777)
for the `fetch_url` prompt-injection branch,
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L838-L841)
for `download_file`, and
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L879-L883)
for `download_with_fallbacks`). `DownloadAttempt` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L103-L111)
has no `code` field. No structured codes are emitted. This is
inconsistent with the envelope conventions established by
[../G31/02-design-r4.md §2](../G31/02-design-r4.md#L23-L41),
[../G32/02-design-r3.md](../G32/02-design-r3.md), and
[../G33/02-design-r2.md](../G33/02-design-r2.md).

## 3. Helper ownership — settled

Reviewer approved G34 owning the shared HTTP module
[04-review-r1.md](04-review-r1.md#L20-L22). Module path:
[src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts).
[../G33/02-design-r2.md](../G33/02-design-r2.md#L193-L208)
must drop its builtins-local helper and import from G34. The
G33 swap is now a **hard out-of-band dependency**, not a soft
note (round 1 left this loose; corrected in
[03-plan-r2.md §0](03-plan-r2.md#L8-L33)).

## 4. Sequencing constraints

- **G30** — orthogonal (`fs/promises` migration touches different
  functions).
- **G31** — hard prereq; provides the `classifyFsError` exported
  precedent and the `{ code, error, ... }` envelope shape G34
  mirrors. G34 reuses `classifyFsError` for the local-write
  branch of `download_file` (`IO_ERROR`).
- **G33** — coordination point. Order: G31 → G34 → G33 r2 swap.
- **G32, G35** — spatially disjoint same-file edits; standard
  rebase.
- **Daemon redeploys** after landing: `saivage` (10.0.3.111),
  `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112).
  `saivage-v3-getrich-v2` (10.0.3.170) is on a different project
  root and is unaffected.

## 5. Reviewer-flagged failure modes the round-1 design did not
   close

Round 1 fixed the "body materialised before cap" core bug but
left four sharp edges open. Round 2 must close all four:

1. **Header-fast-fail body leak.** Whenever the helper decides
   after headers that the body must not be read (Content-Length
   exceeds cap, upstream returned 4xx/5xx, invalid response
   shape), the socket must be cancelled, not abandoned. The
   round-1 readers cancel on **mid-read** overflow but not on
   **pre-read** rejection — see
   [04-review-r1.md](04-review-r1.md#L7) and the early-return
   sites in round-1 design at
   [02-design-r1.md](02-design-r1.md#L355-L363) and
   [02-design-r1.md](02-design-r1.md#L449-L459).

2. **Mid-body timeout misclassified.** Round 1 wraps
   `AbortSignal.timeout` only around `fetch` itself
   [02-design-r1.md](02-design-r1.md#L131-L141) and never
   threads the signal into the bounded readers
   [02-design-r1.md](02-design-r1.md#L151-L154). A slow upstream
   that sends headers fast but then stalls mid-body will throw
   from `reader.read()` with a name **other** than
   `TimeoutError`, so the round-1 classifier
   [02-design-r1.md](02-design-r1.md#L222-L231) maps it to
   `NETWORK_ERROR`. G33 r2 already identified the same bug
   class — see
   [../G33/02-design-r2.md](../G33/02-design-r2.md#L26-L67).

3. **Download envelopes still flat strings.** Round 1's
   `downloadUrl` writes failure reasons into `attempt.error` as
   prose and returns `null`
   [02-design-r1.md](02-design-r1.md#L437-L473); the plan
   explicitly says the `download_file` /
   `download_with_fallbacks` case bodies don't change beyond
   consuming that text [03-plan-r1.md](03-plan-r1.md#L91-L97).
   Result: the top-level envelope is still
   `{ error: "Download failed", url, attempts }` and the test
   gates that demand top-level `code: "RESPONSE_TOO_LARGE"`,
   `code: "UPSTREAM_HTTP_ERROR"`, etc.
   [03-plan-r1.md](03-plan-r1.md#L167-L173) cannot pass against
   the produced shape. Round 1 also claims an `IO_ERROR` code
   for local-write failures
   [02-design-r1.md](02-design-r1.md#L480-L489) but never wires
   it: the live `mkdirSync`/`writeFileSync` block at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L225-L226)
   has no try/catch in the round-1 rewrite either.

4. **`maxFetchChars` semantics ambiguity.** Round 1 silently
   reinterprets the historical character cap as a byte cap
   [02-design-r1.md](02-design-r1.md#L284-L294) and offers
   "exact character parity restored later if requested" as a
   fallback [02-design-r1.md](02-design-r1.md#L296-L300). For
   `fetch_page_text` the issue is sharper: capping raw HTML
   bytes before `stripHtml` can drop visible text that would
   otherwise have fit under the historical character cap
   [04-review-r1.md](04-review-r1.md#L13). Per the workspace
   architecture-first rule (no backward compat shims), round 2
   picks the byte cap unambiguously, renames the config field
   accordingly, deletes the old name, and documents that
   `fetch_page_text` bounds **raw HTML bytes** (not stripped
   characters). Returned text is whatever `stripHtml` produces
   from the bounded HTML; no second-tier post-strip slice.

## 6. Stale anchors corrected

Round-1 plan anchors drifted from the live source. Corrected
anchors used throughout
[02-design-r2.md](02-design-r2.md) and
[03-plan-r2.md](03-plan-r2.md):

| Round-1 anchor                                                                                                       | Live anchor                                                                                                          |
|---|---|
| [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L138-L235) (downloadUrl per round 1)                           | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L156-L237) (actual downloadUrl)                                |
| [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L783) (fetch_url per round 1)                             | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L790) (actual fetch_url)                                  |
| [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L795-L823) (fetch_page_text per round 1)                       | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L792-L821) (actual fetch_page_text)                            |
| Implicit `download_file` / `download_with_fallbacks` regions                                                         | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L823-L842), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L844-L890) |

## 7. Test gaps to add in round 2

In addition to the round-1 matrix:

- Mid-body timeout (headers arrive fast, body stalls past
  `mcp.fetchTimeoutMs`) → `code: "TIMEOUT"`, not
  `NETWORK_ERROR`.
- Content-Length fast-fail with a server that *would* keep
  writing if not cancelled → assert the client closed the
  socket (server-side observation: `req.aborted === true`
  before EOF, or `connection: close` observable inside the
  `setInterval` loop the test server uses).
- HTTP 5xx response with a non-empty body → assert the body
  was not read (server observation: the response writer never
  hits a "fully drained" callback before client RST), and
  envelope contains `code: "UPSTREAM_HTTP_ERROR"`,
  `status: 500`.
- `download_file` against an upstream that returns 500 →
  top-level `{ code: "UPSTREAM_HTTP_ERROR", status: 500,
  url, attempts: [{ code: "UPSTREAM_HTTP_ERROR", status: 500, ... }] }`.
- `download_file` with a `path` that points inside an existing
  read-only directory → `code: "IO_ERROR"`,
  message includes the underlying `EACCES`/`EROFS`.
- Multi-byte UTF-8 page (≥10 KB of 3-byte CJK runes) read with
  `max_chars` (now `max_bytes`) of 5 000 → returns
  `truncated: true`, `bytes_read <= 5 000`, and the returned
  string does **not** end on a split rune (decoder is run
  over the captured bytes, not per-chunk, so partial runes at
  the tail are dropped cleanly).

## 8. Non-goals (unchanged)

- Default cap values are not retuned.
- No retries inside the shared helper
  (`download_with_fallbacks` keeps retry ownership).
- `head_url` is not changed.
- No streaming-to-disk path for `download_file > 250 MB`; the
  current buffer-then-write is kept, just bounded.
