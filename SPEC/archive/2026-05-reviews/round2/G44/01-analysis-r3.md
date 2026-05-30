# G44 — Analysis r3

Round 3. Round 2 lives at [01-analysis-r2.md](01-analysis-r2.md); the
reviewer's findings are in [04-review-r2.md](04-review-r2.md). Round 2
fully resolved the round 1 `sendEvent` ownership blocker; the only
remaining issue was a verification-gate problem, not an inventory or
ownership problem. The substantive correction in this round is:

1. The stale-string sanity grep proposed in round 2 was over-broad. As
   confirmed by re-running the grep against `docs/**/*.md`, the
   pattern matches three additional lines that are **not** stale and
   **not** in scope:
   - [docs/internals/server.md](../../../../docs/internals/server.md#L48)
     — the valid return type `{ stop(): Promise<void> }` of
     `startServer`, hit by `stop\(\)`.
   - [docs/guide/quickstart.md](../../../../docs/guide/quickstart.md#L64)
     — the valid Planner mode heading `### One-shot CLI`, hit by
     `One-shot CLI`.
   - [docs/internals/data-model.md](../../../../docs/internals/data-model.md#L28)
     — the `ChatLogSchema` row `<project>/.saivage/tmp/chats/<sessionId>.json`,
     hit by the flat-path token. **This one is genuinely stale**: the
     code writes `<project>/.saivage/tmp/chats/<channel>/<sessionId>.json`
     (see verified fact 8 in
     [01-analysis-r2.md](01-analysis-r2.md#L88-L97)).

   Round 2 acknowledged the same flat-path drift in
   [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L55-L59)
   and absorbed it into G44 scope because the file was already being
   edited. The same argument applies to
   [docs/internals/data-model.md](../../../../docs/internals/data-model.md#L28):
   it is one table cell, identical drift, same root cause, same
   one-commit cost. Carving it out into a separate issue would leave a
   known-bad string in the tree under G44's nose.

2. The two false-positive lines in
   [docs/internals/server.md](../../../../docs/internals/server.md#L45-L48)
   and
   [docs/guide/quickstart.md](../../../../docs/guide/quickstart.md#L63-L67)
   are correct prose about valid live code and must be left untouched.
   The verification gate must therefore not flag them. Round 3
   restructures the gate into a small cross-doc pattern set (tokens
   that legitimately appear **only** in genuine drift anywhere in the
   tree) plus a file-scoped pattern set (tokens that legitimately
   appear elsewhere as valid prose and so can only be checked against
   the specific files G44 edits).

3. Verified fact about the flat-path drift in
   [docs/internals/data-model.md](../../../../docs/internals/data-model.md#L28):
   the `ChatLogSchema` row should read
   `<project>/.saivage/tmp/chats/<channel>/<sessionId>.json` per
   [src/agents/chat.ts](../../../../src/agents/chat.ts#L98-L104) (the
   per-channel directory) and
   [src/agents/chat.ts](../../../../src/agents/chat.ts#L398-L400) (the
   file name). Same source-of-truth lines used for the agent-chat.md
   fix; no new code reading needed.

## Carried over from r2

The verified-facts section, the `sendEvent` ownership table, the
severity/impact section, the issue-level inaccuracies note, the
built-dist drift note, and the cross-links section from
[01-analysis-r2.md](01-analysis-r2.md) all stand without change. The
reviewer found no fault with them in
[04-review-r2.md](04-review-r2.md) (see "What Is Solid"). Round 3 does
not restate them.

## Scope (delta from r2)

In addition to the two files already in scope at
[01-analysis-r2.md](01-analysis-r2.md#L22-L28), the
`ChatLogSchema` row in
[docs/internals/data-model.md](../../../../docs/internals/data-model.md#L28)
is added as a one-cell correction. No other prose in `data-model.md`
is touched. Justification: identical drift, identical root cause,
identical fix shape; carving it out wastes more SPEC bytes than it
saves and leaves a known-bad string in the tree.

## Updated stale-string inventory

The round 2 inventory in
[01-analysis-r2.md](01-analysis-r2.md#L233-L255) is correct as a list
of what must go from
[docs/internals/channels.md](../../../../docs/internals/channels.md)
and
[docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md).
Round 3 adds one row and partitions the inventory by **where the
token may legitimately appear** so the verification gate stays
executable:

### Cross-doc-clean tokens

These strings have **no** legitimate use anywhere under `docs/` in
the current tree (verified by running the grep against
`docs/**/*.md`). They can therefore be checked tree-wide and must
be zero across **all** source markdown after the rewrite. They are
also the cleanest signal that the rewrite landed.

| Token | Original source location |
| --- | --- |
| `channels/cli.ts` | [docs/internals/channels.md](../../../../docs/internals/channels.md#L22-L27) |
| `channels/oneshot.ts` | [docs/internals/channels.md](../../../../docs/internals/channels.md#L29-L34), [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L39) |
| `channels/index.ts` | (issue body claim; verify) |
| `publish(event` | [docs/internals/channels.md](../../../../docs/internals/channels.md#L16) |
| `chat-chunk` | [docs/internals/channels.md](../../../../docs/internals/channels.md#L43) |
| `Three concrete channel implementations` | [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md#L33) |
| `start(runtime` | [docs/internals/channels.md](../../../../docs/internals/channels.md#L14) |

### File-scoped tokens

These strings appear in valid prose elsewhere in `docs/` and **must
not** be flagged outside the specific G44-edited files. Each one is
checked only against the file(s) it is stale in.

| Token | Stale in (must be 0 after fix) | Legitimate elsewhere |
| --- | --- | --- |
| `interface Channel` (four-member shape) | [docs/internals/channels.md](../../../../docs/internals/channels.md) | No other file uses this exact phrase; scoped to channels.md to keep the gate minimal. |
| `stop()` (as a channel method) | n/a — fully covered by `interface Channel` removal in channels.md; the only other occurrence is the valid `startServer` return type in [docs/internals/server.md](../../../../docs/internals/server.md#L48). **Drop from the gate.** | [docs/internals/server.md](../../../../docs/internals/server.md#L48) — valid `startServer` return-type signature. |
| `One-shot CLI` | [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md) | [docs/guide/quickstart.md](../../../../docs/guide/quickstart.md#L64) — valid Planner one-shot mode heading; do not touch. |
| `tmp/chats/<sessionId>.json` (flat) | [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md), [docs/internals/data-model.md](../../../../docs/internals/data-model.md) | None — both occurrences are stale; both are fixed in this PR. |

Rationale for dropping `stop\(\)` from the gate entirely: in
channels.md it only appears inside the four-line stale `interface
Channel` block, which is removed wholesale by the channels.md
rewrite. After the rewrite, the only remaining `stop()` in `docs/`
is the valid `startServer` lifecycle return type in
[docs/internals/server.md](../../../../docs/internals/server.md#L48),
which is correct prose about live code. Grepping for `stop\(\)` at
all would either falsely flag that line or require a per-file
carve-out for a token whose check is already implied by the
`interface Channel` check. Removing the token cleanly is preferable
to carving exceptions into the gate.

## Acceptance criteria (delta from r2)

Acceptance criteria 1, 2, 4, and 5 from
[01-analysis-r2.md](01-analysis-r2.md#L323-L348) stand without
change. Criterion 3 is updated:

3. After the rewrite **and** the `ChatLogSchema` row fix:
   - Every token in the **cross-doc-clean** table above is absent
     from `docs/**/*.md` outside `docs/.vitepress/dist/` (rebuilt in
     step 4) and outside the SPEC review tree.
   - Every token in the **file-scoped** table is absent from the
     specific files listed in its "Stale in" column. Tokens may
     legitimately remain in the files listed under "Legitimate
     elsewhere"; the verification gate does not check those files
     for those tokens.
   - The same partitioned check passes against the rebuilt dist
     tree under `docs/.vitepress/dist/internals/channels.html`,
     `docs/.vitepress/dist/internals/agent-chat.html`, and
     `docs/.vitepress/dist/internals/data-model.html`.

A new criterion 6 is added:

6. [docs/internals/data-model.md](../../../../docs/internals/data-model.md#L28)
   `ChatLogSchema` row reads
   `<project>/.saivage/tmp/chats/<channel>/<sessionId>.json`, citing
   the same lines used in agent-chat.md
   ([src/agents/chat.ts](../../../../src/agents/chat.ts#L98-L104) and
   [src/agents/chat.ts](../../../../src/agents/chat.ts#L398-L400)).
   No other table row is altered.

## Project rules applied (delta)

The expanded scope (`data-model.md`) does not violate the
no-over-engineering rule: it is one table cell, identical drift,
identical root cause, identical fix shape, and avoids leaving a
known-bad string in the tree. It is also strictly smaller than
chasing the same string through a second issue.

The partitioned grep does not introduce new abstractions: it is
still a single `grep -rnE` invocation per pattern set, run on
specific paths. No new tooling, no new lint, no new build step.

The new project-wide principles (no regex parsing of user intent,
no hardcoded values, no fragile heuristics) still do not apply to a
docs-only fix; recorded for awareness as in r2.
