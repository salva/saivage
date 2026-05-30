# G44 — Design r1

## Goal

Bring [docs/internals/channels.md](../../../../docs/internals/channels.md)
and the channels section of
[docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md)
into line with the post-F35 code without introducing new drift or
backward-compat scaffolding.

## Proposal A — Targeted rewrite (recommended)

### Shape

Rewrite the two affected files in place:

1. **channels.md** — replace the file's body with three sections that
   match the code:
   - **Interface**: the real four-method `ChatChannel` from
     [src/channels/types.ts](../../../../src/channels/types.ts#L4-L17),
     reproduced verbatim, with a one-paragraph explanation of each
     method (send, onMessage, onClose, close).
   - **Implementations**: one subsection per shipped class
     ([websocket.ts](../../../../src/channels/websocket.ts),
     [telegram.ts](../../../../src/channels/telegram.ts)), each
     describing the transport, the per-connection lifecycle, and the
     channel-specific extension methods (`sendEvent` on both;
     `chatId` on Telegram) with a note that these are *not* part of
     `ChatChannel` and exist for registration-glue code only.
   - **Adding a channel**: an updated checklist that matches reality
     — implement the four-method interface, register the channel in
     the bootstrap flow that owns it (Telegram in
     `src/server/telegram-bot.ts`, websocket in the dashboard
     routes), add config plumbing as needed.
   - **State**: keep the existing one-paragraph "channels are
     stateless across restarts" note since it is still accurate;
     remove the `.saivage/tmp/chats/` reference if it no longer
     matches reality (verified during the implementation step, not
     assumed here).

2. **agent-chat.md** — in the `## Channels` section, replace the
   three-bullet list with a two-bullet list (Web, Telegram) and add
   a sentence describing the `saivage inspect` CLI as an in-process
   `InspectorAgent` invocation against the runtime — no channel
   involved. Link the sentence to
   [src/server/cli.ts](../../../../src/server/cli.ts#L219-L252) so
   future readers can verify.

3. **Built site** — run `npm run docs:build`; commit the regenerated
   files under `docs/.vitepress/dist/` so the in-tree site does not
   lag the source. No dist file is edited by hand.

### Cost / risk

- One PR, two source files edited, ~60 lines of markdown net change,
  plus regenerated dist assets.
- Risk: re-introducing drift if the new prose hardcodes an envelope
  shape or method signature that later changes. Mitigated by writing
  each technical claim as a deep link to the source rather than as
  copy-pasted prose where possible.

### Why this is recommended

- It is the minimum change that satisfies the acceptance criteria
  from the analysis.
- It respects the project rule against new abstractions and migration
  scaffolding.
- It leaves the broader anti-drift lint to G40, which already owns
  it; G44 simply consumes the fix once it lands.
- It does not create new docs files (no "deprecated channels"
  appendix), in line with "actively remove code/docs supporting old
  features".

## Proposal B — Generate the interface section from the source file

### Shape

Replace the hand-written `ChatChannel` block in `channels.md` with a
build-time include of `src/channels/types.ts` via a VitePress markdown
plugin (or a snippet-include directive) so the interface excerpt can
never drift from the source. Implementations section stays
hand-written. Same `agent-chat.md` edit as Proposal A.

### Cost / risk

- New VitePress plugin or import directive, added to
  `docs/.vitepress/config.ts`.
- Build pipeline now depends on path resolution between `docs/` and
  `src/`; misconfiguration breaks `docs:build`.
- Cost is materially higher than Proposal A for a single 17-line
  interface that already deep-links to source.
- Risk surface: a future code refactor of `types.ts` (e.g. JSDoc
  re-flow) could silently change the rendered docs in a non-obvious
  way.

### Why not recommended

This is a clear over-engineering against the project rules. Building
a docs-source include pipeline to keep a 17-line interface in sync is
disproportionate, and the same outcome (no drift) is achievable by
deep-linking and by adding the planned G40 lint. Picking Proposal B
also crosses into G40 / G45 territory because the same mechanism
would naturally be applied there, turning a small docs PR into a
docs-pipeline redesign.

## Proposal C — Delete `docs/internals/channels.md`, fold a short stub into `agent-chat.md`

### Shape

Remove `channels.md` entirely on the argument that with only two
implementations and a 4-method interface, the layer does not warrant
its own internals page. Move a 12-line summary into `agent-chat.md`'s
`## Channels` section and update the sidebar
(`docs/.vitepress/config.ts`) to drop the entry. Same inspect-flow
fix as Proposal A.

### Cost / risk

- Two source files edited, plus sidebar config, plus rebuilt dist.
- Risk: the channel layer is one of the few subsystems whose
  internals page is *expected* by readers because the SPEC v2 index
  and the subsystem map both call it out. Deleting it creates a
  cross-doc dangling reference burden that exceeds the value of
  removing a thin page. The map at
  [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md#L149-L153)
  lists `src/channels/` as a top-level subsystem; that map would
  also need updating, and so would any internal `[Channels](./channels)`
  links in other internals docs.
- Reader cost: people who arrive at "I want to add a channel" now
  scroll through Chat-agent docs to find a sub-section.

### Why not recommended

The deletion is principled (remove dead/thin docs), but it crosses
the line from "fix the drift" into "redesign the internals docs
layout". It also enlarges the scope of G44 from "fix two files" to
"audit every internals cross-link". Save the structural debate for a
later docs-layout pass; for now keep one page per top-level
subsystem.

## Decision

**Adopt Proposal A.**

It is the smallest correct change, matches the project's
no-over-engineering rule, leaves the structural lint to G40 which is
already designing it, and produces deep-linked prose that is robust
to small future source-file changes.

## Edit map (Proposal A, concrete)

| File | Change |
| --- | --- |
| [docs/internals/channels.md](../../../../docs/internals/channels.md) | Full body rewrite per the three-section outline above |
| [docs/internals/agent-chat.md](../../../../docs/internals/agent-chat.md) | Replace the three-bullet `## Channels` list with the two-bullet list + inspect-flow sentence |
| `docs/.vitepress/dist/internals/channels.html` | Regenerated by `npm run docs:build`; committed |
| `docs/.vitepress/dist/internals/agent-chat.html` | Regenerated by `npm run docs:build`; committed |
| `docs/.vitepress/dist/assets/internals_channels.md.*.js` | Regenerated; old hash file deleted by the build, new hash committed |
| `docs/.vitepress/dist/assets/internals_agent-chat.md.*.js` | Same |

No edits to source code, no edits to SPEC files (other than this
review trail), no changes to `src/channels/*` or
`src/server/cli.ts` — those are already correct.

## Wording rules for the rewrite

To minimise the chance of re-introducing drift:

1. For every interface member, signature, or envelope shape, the
   prose must be accompanied by a deep link to the canonical source
   line range. No free-floating "the channel exposes …" sentences.
2. The `ChatChannel` interface code block is reproduced from
   [src/channels/types.ts](../../../../src/channels/types.ts#L4-L17)
   verbatim. If a future change touches that file, the doc PR is
   trivial to spot in review.
3. The channel-specific extensions (`sendEvent`, `chatId`) are
   described under each implementation section, never inside the
   interface section, so a reader cannot confuse interface surface
   with implementation surface.
4. The inspect flow paragraph in `agent-chat.md` must say
   explicitly that no channel is constructed; the previous
   formulation ("one-shot CLI channel") was both wrong on the file
   path and wrong on the concept.

## Non-goals

- No CI lint design (G40 territory).
- No subsystem-map edits (the map is already correct; see
  [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md#L149-L153)).
- No code changes.
- No re-litigating F35's deletion decision.
