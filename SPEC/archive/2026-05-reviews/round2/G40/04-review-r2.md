# G40 - Review (r2)

## Summary

Verdict: approved. I verified the four changes requested in
[04-review-r1.md](./04-review-r1.md) against the r2 analysis, design,
and plan, then spot-checked the cited implementation sources. The r2 set
now accurately describes the current SPA layout, removes unsupported UI
consumer claims, fixes the validation story around `docs:build`, and
keeps the generator proposal out of the immediate G40 scope.

## Findings

No blocking issues found.

## Verified Changes

1. Layout and chrome facts are corrected.

   The r2 docs no longer claim `ChatWindow` is rendered alongside every
   tab. They state that the Dashboard combines chat and status, while
   Plan, Agents, Files, and Debug are full-view panels. The side rail,
   Docs link, Shortcuts button, workspace header, project pill, live pill,
   and absence of a footer are also captured. This matches
   [web/src/App.vue](web/src/App.vue), where the tab list is
   Dashboard, Plan, Agents, Files, Debug and `ChatWindow` is mounted only
   inside the Dashboard section.

2. Unsupported SPA consumer claims are removed.

   The r2 docs no longer say Dashboard surfaces notes inline or that
   Debug consumes `/api/inspections`, `/api/providers`, or
   `/api/mcp/tools`. Notes are tied to `FilesView`, and Debug is limited
   to `/api/debug/state`, `/api/debug/errors`, and `/api/debug/timeline`.
   `/api/providers`, `/api/inspections`, and `/api/mcp/tools` remain in
   the REST table as registered scriptable endpoints with no current SPA
   panel, which matches [src/server/server.ts](src/server/server.ts),
   [web/src/components/DebugView.vue](web/src/components/DebugView.vue),
   and [web/src/components/FilesView.vue](web/src/components/FilesView.vue).

3. The validation plan no longer overstates `docs:build`.

   Design and plan now say `npm run docs:build` is a Markdown/build smoke
   test, not a dead-link checker, because VitePress has
   `ignoreDeadLinks: true` and the package script is `npm run docs:api &&
   vitepress build docs`. The r2 plan adds a manual path-existence loop
   and strengthens the grep self-check to target the actual legacy bullet
   markup (`- **Stage**`, `- **Conversation**`, etc.) plus fabricated
   WebSocket payload/discriminator strings.

4. Design B is correctly narrowed to follow-on work.

   The r2 design keeps Design A as the immediate G40 fix and records the
   generator approach as a cross-finding follow-on after G40, G44, and G45
   land. The r2 plan explicitly avoids adding generator scripts, docs build
   plugins, or CI gates as part of G40.

## Spot Checks

- The REST/auth facts in r2 match the server: `SAIVAGE_API_TOKEN` gates
  `/api/*`, `/ws` performs its own 1008 close on bad tokens, accepted
  token transports are bearer header, `x-saivage-token`, and `?token=`,
  and public paths are intentionally left available for SPA/docs/health
  loading.
- The WebSocket section in r2 matches the channel code: outbound frames
  are flat objects such as `session`, `message`, `thinking`, `system`, and
  `event`; inbound handling only unwraps `{ type: "message", content }`
  and treats other JSON or text as raw user input.
- The static search sweep found the old r1 phrases only in explanatory
  change logs or negative validation statements, not as surviving
  implementation instructions.

## Verified Change Count

4

## Required Change Count

0

VERDICT: APPROVED