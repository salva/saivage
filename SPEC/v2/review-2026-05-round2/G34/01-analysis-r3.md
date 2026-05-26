# G34 — Analysis r3

**Finding**: [../G34-builtins-fetch-url-no-streaming-cap.md](../G34-builtins-fetch-url-no-streaming-cap.md)

**Round 2 docs**:
[01-analysis-r2.md](01-analysis-r2.md),
[02-design-r2.md](02-design-r2.md),
[03-plan-r2.md](03-plan-r2.md)

**Round 2 review**: [04-review-r2.md](04-review-r2.md) — VERDICT
CHANGES_REQUESTED. Direction approved (G34 owns the shared
helper module; G33 depends on G34; download envelopes carry
structured `code`; byte-cap rename is deliberately breaking).
Three concrete defects in the round-2 helper must close.

**Writer**: Claude Opus 4.7 (round 3)

## 1. Carried over from round 2 (unchanged)

The five root-cause facts and the architectural decisions
listed in [01-analysis-r2.md §1](01-analysis-r2.md#L17-L46)
(body materialised before cap),
[01-analysis-r2.md §2](01-analysis-r2.md#L48-L60)
(flat-string failure envelopes),
[01-analysis-r2.md §3](01-analysis-r2.md#L62-L72)
(G34 owns the helper module), and
[01-analysis-r2.md §4](01-analysis-r2.md#L74-L88)
(G31 → G34 → G33 sequencing) all stand. The live anchors in
[01-analysis-r2.md §6](01-analysis-r2.md#L138-L148) still
match the live file (verified against
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42),
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L104),
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L162),
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762),
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L793),
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L825),
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L845),
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078)).

## 2. Three new root causes flagged by round 2 review

### 2.1 Timer-leak across success / error / abort paths

Source: [04-review-r2.md](04-review-r2.md#L7).

The round-2 helper at
[02-design-r2.md §2](02-design-r2.md#L88-L102) constructs a
`setTimeout` whose handle is only conditionally cleared on the
synchronous `fetch()` throw path. For the success path the
design relies on
`response.body?.["finally"]?.(() => clearTimeout(timer))`. Two
defects:

1. The WHATWG `ReadableStream` returned by `response.body` does
   not implement `Promise#finally`. The bracketed indexed
   access papers over the type system without actually
   registering a cleanup callback. Result: on the happy path
   (short response well under `mcp.fetchTimeoutMs`), the timer
   stays armed until it fires, at which point it aborts a
   controller whose signal nothing is listening to — but
   `timedOut()` flips to `true`, which then lies to every
   subsequent caller that retains a reference to the
   `TimedFetch`.
2. Even if the cancel-on-stream-end pattern were spelled
   correctly, it would still miss the early-exit branches
   (`!response.ok`, Content-Length over cap, prompt-injection
   scan throws, IO error on local write). Those branches call
   `discardBody(response)` but never `clearTimeout(timer)`.

Architectural fix: `TimedFetch` must expose an explicit
`dispose()` (idempotent `clearTimeout`) and **every** caller
path must invoke it in a `finally` block — including the
success path that completes a bounded read.

### 2.2 Mid-body abort returned as `done: true` (silent partial success)

Source: [04-review-r2.md](04-review-r2.md#L9).

In the round-2 bounded reader at
[02-design-r2.md §2](02-design-r2.md#L143-L175), the abort
listener calls `reader.cancel(signal?.reason)`. Under both
WHATWG and undici semantics, `reader.cancel()` resolves the
**next** pending `reader.read()` with `{ done: true, value:
undefined }`. The loop then exits at `if (done) break` and
returns the prefix that was already accumulated:

```ts
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;            // <-- timeout-driven cancel lands here
  // ...
}
return { body: ..., bytes: total, truncated };
```

Result: a slow upstream that sends headers fast and then
stalls past `mcp.fetchTimeoutMs` produces
`isError: false, content: <partial bytes>, truncated: <whatever was
last seen>` from `fetch_url`. The `classifyNetworkError(..., {
timedOut: timedOut() })` branch at the handler is never
reached because the bounded reader returned normally.

Architectural fix: the bounded reader must treat a
**post-abort** wake-up as an exception, not as EOF. Concretely,
after `await reader.read()` resolves, check `signal?.aborted`
before checking `done`. If the signal is aborted, throw the
abort reason so the caller's catch maps it to `TIMEOUT` via
the `timedOut: timedOut()` flag.

### 2.3 One-shot `TextDecoder` produces U+FFFD on truncated UTF-8

Source: [04-review-r2.md](04-review-r2.md#L11).

The round-2 design assertion at
[02-design-r2.md §2](02-design-r2.md#L127-L132) — "with
`fatal: false` and a final decode, incomplete trailing bytes
are silently dropped" — is wrong. WHATWG Encoding §10.1
prescribes that the UTF-8 decoder, when its input ends with an
incomplete byte sequence and the call is not a streaming call
(i.e., `stream: false` or default), emits exactly one U+FFFD
for the incomplete sequence. Reference behaviour in Node
v22.11 (the daemon runtime):

```
> new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.of(0xE4, 0xB8))
'\uFFFD'
```

The test gate that asserts "no replacement character at the
tail when the cap lands inside a 3-byte CJK rune"
([02-design-r2.md](02-design-r2.md#L803-L807)) cannot pass
against the round-2 implementation.

Two architecturally clean fixes exist:

- **(a) Stream-decode**: feed the captured bytes through a
  single `TextDecoder` instance using `{ stream: true }` for
  every chunk. On the **truncated path**, never flush
  (`decoder.decode()` with default `stream: false` is **not**
  called); the trailing partial sequence stays buffered inside
  the decoder and is discarded with the decoder itself. On the
  **non-truncated path**, the final flush (`stream: false`) is
  a no-op for well-formed input or, for malformed upstream
  input that happens to end mid-sequence, correctly surfaces
  U+FFFD — that is the upstream's problem, not ours.

- **(b) Pre-trim the incomplete tail**: scan back at most 3
  bytes of the captured buffer for the last UTF-8 lead byte;
  if it requires more bytes than are present after it, slice
  the buffer to end just before the lead byte. Then call the
  decoder once.

Round 3 picks **(a)** because it is the contract the WHATWG
Encoding spec explicitly provides for this case and it
composes naturally with the existing chunked read loop. The
test gate becomes: a `max_bytes` cap that splits a 3-byte
rune (1 KB of `日` repeated, `max_bytes: 1499`) returns
`truncated: true`, `bytes_read ≤ 1499`, and the returned
string ends in a complete `日`, with **no** U+FFFD anywhere.

## 3. Out-of-band reviewer notes preserved

- The `discardBody` direction, `DownloadOutcome` shape,
  no-shim rename, and G33 sequencing are kept verbatim from
  round 2 per [04-review-r2.md](04-review-r2.md#L21-L33).
- Anchor cleanup nit
  ([04-review-r2.md](04-review-r2.md#L33)): the design line
  that pointed at the round-2 plan's config-rename step for
  the `dataTools` schema is corrected in
  [02-design-r3.md §4.4](02-design-r3.md#L1) and the plan now
  carries the schema-update instruction in
  [03-plan-r3.md §1 — Step 7](03-plan-r3.md#L1) as an explicit
  bullet.

## 4. Sequencing constraints

Unchanged from round 2 ([01-analysis-r2.md §4](01-analysis-r2.md#L74-L88)):
G31 → G34 → G33 r2 swap. Daemon redeploy targets are
`saivage` (10.0.3.111), `diedrico` (10.0.3.113), and
`saivage-v3` (10.0.3.112); `saivage-v3-getrich-v2`
(10.0.3.170) is on a different project root and unaffected.

## 5. Round-3 test gates added

In addition to the round-2 matrix carried forward in
[03-plan-r3.md §3](03-plan-r3.md#L1):

- **Helper timer cleanup (success)**: `fetchWithTimeout`
  resolves on a 1 KB upstream; assert that no pending timer
  remains attached to the controller after the caller invokes
  `dispose()` in `finally` (use `vitest.useFakeTimers()` and
  assert `vi.getTimerCount() === 0` after the read completes).
- **Helper timer cleanup (error)**: pre-headers `ECONNREFUSED`
  throws from `fetchWithTimeout` itself; assert
  `vi.getTimerCount() === 0` after the catch.
- **Helper timer cleanup (mid-body error)**: upstream sends
  headers, then 500 socket-resets mid-body; assert
  `vi.getTimerCount() === 0` after the handler's catch +
  `dispose()` finally.
- **Mid-body timeout returns `TIMEOUT` at handler boundary**:
  `fetch_url` against an upstream that flushes headers fast
  then stalls past `mcp.fetchTimeoutMs`; assert the **handler
  result** has `isError: true`, `content.code === "TIMEOUT"`,
  and `content.content` is undefined (no partial body envelope
  leaked). The round-2 test only inspected `timedOut()` inside
  the helper; round 3 asserts the public contract.
- **UTF-8 multi-byte rune straddles cap**: 1 KB of `日` (three
  bytes per rune), `max_bytes: 1499` (one byte short of a full
  rune, so the last rune is mid-sequence at the cap). Assert
  `truncated: true`, `bytes_read ≤ 1499`, returned string
  contains **zero** `\uFFFD`, and the string length is exactly
  `Math.floor(1499 / 3) = 499`.
- **UTF-8 untruncated well-formed input flushes cleanly**:
  500 bytes of mixed ASCII + 3-byte CJK that fits entirely
  under the cap; assert returned string is byte-for-byte
  decoded with no U+FFFD.

## 6. Non-goals (unchanged)

Per [01-analysis-r2.md §8](01-analysis-r2.md#L221-L228):
default cap values are not retuned; no helper-internal
retries; `head_url` is not migrated; no streaming-to-disk path
for very large downloads.
