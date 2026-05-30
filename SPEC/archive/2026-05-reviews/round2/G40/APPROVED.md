# G40 — APPROVED

**Chosen proposal**: Design A (per [02-design-r2.md](02-design-r2.md)) — in-place rewrite of `docs/internals/web-ui.md` (or `docs/guide/web-ui.md`) to match reality. ~150 lines, one file. Design B (auto-generated WS protocol section from server route registrations) is recorded as a follow-on covering G40/G44/G45 together.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). All 4 r1 changes addressed.

**Layout corrected**: chat only on Dashboard; side rail + workspace header documented; no footer.

**Unsupported UI claims removed**: Notes UI lives in Files tab; Debug fetches only `/api/debug/*`; providers/inspections/mcp-tools labelled scriptable-only.

**Critical drift fix**: removed the dangerous "the daemon does not implement authentication" paragraph — `SAIVAGE_API_TOKEN` IS enforced at `src/server/server.ts` L70-L78/L662-L668.

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md).

**Daemon impact**: none — docs-only change. Web UI build unaffected.
