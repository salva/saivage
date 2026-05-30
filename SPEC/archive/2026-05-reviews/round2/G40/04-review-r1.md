# G40 - Review (r1)

## Summary

Verdict: changes requested. The r1 set correctly identifies the high-risk auth lie, the five-tab versus nine-tab drift, and the fake WebSocket envelope protocol. It also correctly corrects stale evidence in the original issue: `/api/providers` and `/api/inspections` do exist, and the server does not parse an inbound `interrupt` frame.

Design A is still the preferred immediate design. The guide contains a security-relevant falsehood at [docs/guide/web-ui.md](docs/guide/web-ui.md#L81-L86), so a focused in-place rewrite should land before building a generator. Design B is a reasonable follow-on for the G40/G44/G45 drift family, but it should not block the auth correction.

I cannot approve r1 yet because several proposed replacement claims are not true of the current SPA, and the validation plan overstates what `docs:build` checks.

## Spot Checks

- Current guide location is [docs/guide/web-ui.md](docs/guide/web-ui.md#L1-L86); I found no `docs/internals/web-ui.md` or `docs/guide/web-ui.md` alternative under another docs tree.
- The tab drift is real: the current guide lists Plan, Stage, Agents, Conversation, Events, Notes, Inspections, Files, Providers at [docs/guide/web-ui.md](docs/guide/web-ui.md#L20-L31), while the SPA tab array is Dashboard, Plan, Agents, Files, Debug at [web/src/App.vue](web/src/App.vue#L22-L40).
- The WebSocket drift is real: the current guide documents payload envelopes at [docs/guide/web-ui.md](docs/guide/web-ui.md#L64-L79), while inbound handling only unwraps `{ type: "message", content: string }` and otherwise forwards text at [src/channels/websocket.ts](src/channels/websocket.ts#L17-L28). Outbound `session`, `thinking`, and `message` frames are visible at [src/server/server.ts](src/server/server.ts#L662-L693), [src/agents/chat.ts](src/agents/chat.ts#L205-L215), and [src/agents/chat.ts](src/agents/chat.ts#L389-L393).
- The auth drift is real and security-relevant: the guide says no auth exists at [docs/guide/web-ui.md](docs/guide/web-ui.md#L81-L86), but `SAIVAGE_API_TOKEN` gates `/api/*` at [src/server/server.ts](src/server/server.ts#L70-L78) and `/ws` at [src/server/server.ts](src/server/server.ts#L662-L668). The accepted token transports are implemented at [src/server/server.ts](src/server/server.ts#L747-L766), and the SPA stores/injects tokens at [web/src/utils/api.ts](web/src/utils/api.ts#L46-L83) and [web/src/utils/api.ts](web/src/utils/api.ts#L109-L115).
- REST enumeration is mostly corrected in r1: `/api/providers`, `/api/mcp/tools`, and `/api/inspections` are registered at [src/server/server.ts](src/server/server.ts#L218-L238), and the notes routes use `:noteId` at [src/server/server.ts](src/server/server.ts#L255-L270). That correction should survive the next round.

## Required Changes

1. Correct the proposed layout/chrome facts before implementation.

   r1 says `ChatWindow` is rendered alongside every tab at [SPEC/v2/review-2026-05-round2/G40/01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G40/01-analysis-r1.md#L33-L40), and the plan tells the implementer to write that a persistent chat panel stays visible on every tab at [SPEC/v2/review-2026-05-round2/G40/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G40/03-plan-r1.md#L16-L18). The current template renders `ChatWindow` only inside the Dashboard section at [web/src/App.vue](web/src/App.vue#L234-L252). The guide should say the Dashboard combines the chat surface and status panel, while the other four tabs are full-view panels.

   The same correction should cover header/footer completeness. The SPA has a side rail with brand, tab nav, Docs, and Shortcuts at [web/src/App.vue](web/src/App.vue#L168-L220), plus a workspace header with the active tab label, project, and live chip at [web/src/App.vue](web/src/App.vue#L222-L232). It does not have a footer. Add one concise layout sentence for that chrome so the guide covers the requested header/footer surface.

2. Remove unsupported UI-consumer claims for notes, providers, inspections, and MCP tools.

   The analysis says notes are surfaced inline in the Dashboard and that `/api/inspections` and `/api/providers` are consumed inside Debug at [SPEC/v2/review-2026-05-round2/G40/01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G40/01-analysis-r1.md#L41-L50). The plan repeats this by describing Dashboard as containing recent notes and Debug as containing MCP tool inventory and provider health at [SPEC/v2/review-2026-05-round2/G40/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G40/03-plan-r1.md#L10-L14). Current source does not support those statements: `DebugView` only fetches `/api/debug/state`, `/api/debug/errors`, and `/api/debug/timeline` at [web/src/components/DebugView.vue](web/src/components/DebugView.vue#L23-L60), while note actions live in `FilesView` at [web/src/components/FilesView.vue](web/src/components/FilesView.vue#L92-L173).

   Keep the server endpoint rows if the guide is meant to document scriptable API routes, but label `/api/providers`, `/api/inspections`, and `/api/mcp/tools` as registered endpoints rather than claiming current SPA panels consume them. The Debug tab bullet should match [web/src/App.vue](web/src/App.vue#L32-L37): state, errors, and timeline.

3. Fix the validation plan: `docs:build` is not a link check today.

   Design and plan both claim that `npm run docs:build` catches dead internal links at [SPEC/v2/review-2026-05-round2/G40/02-design-r1.md](SPEC/v2/review-2026-05-round2/G40/02-design-r1.md#L83-L93) and [SPEC/v2/review-2026-05-round2/G40/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G40/03-plan-r1.md#L137-L147). The VitePress config explicitly has `ignoreDeadLinks: true` at [docs/.vitepress/config.ts](docs/.vitepress/config.ts#L8-L12), and the package script is just `npm run docs:api && vitepress build docs` at [package.json](package.json#L20-L25). `npm run docs:build` still belongs in validation, but it must not be described as verifying every internal link.

   Next round should either add a real link/path check command to the plan or make the manual path verification explicit. Also strengthen the grep self-check in [SPEC/v2/review-2026-05-round2/G40/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G40/03-plan-r1.md#L128-L135): searching for phrases like `Stage tab` will miss the old bullet text, which is `- **Stage**` in [docs/guide/web-ui.md](docs/guide/web-ui.md#L20-L31).

4. Keep Design A, but narrow Design B to a follow-on finding rather than an implementation dependency.

   The recommendation at [SPEC/v2/review-2026-05-round2/G40/02-design-r1.md](SPEC/v2/review-2026-05-round2/G40/02-design-r1.md#L205-L220) is directionally right: Design A should land first because the auth paragraph is urgent and the immediate fix is one doc. However, the follow-on generator should be recorded as cross-finding work after G40/G44/G45, not as hidden validation debt inside this issue. G40 should not add generator scripts, docs build plugins, or CI gates.

## Cross-Finding Notes

- G41: r1 is right to document the current `/api/state` response as `{ state, plan }` from [src/server/server.ts](src/server/server.ts#L173-L179). The only caveat is that the layout rewrite must not claim the Dashboard polls fields that G41 is about to remove or reshape.
- G44: keeping a non-load-bearing further-reading link to [docs/internals/channels.md](docs/internals/channels.md) is acceptable because the G40 WebSocket section should be self-contained. Do not defer G40 on the G44 rewrite.
- G45: independent audience and file. The generator idea belongs in the metaplan after the hand rewrites, not in this immediate G40 fix.

## Required Change Count

4

VERDICT: CHANGES_REQUESTED