# F10 Plan r1 — delete orphan `web/src/styles.css` and fix stale docs

Implements **Proposal A** from `02-design-r1.md`.

## Ordered edit steps

1. **Delete the orphan file.**
   - Remove [web/src/styles.css](web/src/styles.css#L1-L30) entirely (`git rm web/src/styles.css`).

2. **Update [docs/internals/web-internals.md](docs/internals/web-internals.md#L14).**
   - Replace the bullet under "Stack":
     - Old: `- Plain CSS (`web/src/styles.css`); no UI framework.`
     - New: `- Plain CSS pipeline under `web/src/styles/` (entry: `index.css`, layers: `tokens`, `semantic`, `base`, `patterns`); no UI framework.`

3. **Update [docs/internals/web-internals.md](docs/internals/web-internals.md#L57).**
   - Replace the bullet under "Customizing":
     - Old: `- Theming: `styles.css` exposes CSS variables for colors / spacing.`
     - New: `- Theming: `web/src/styles/tokens.css` defines the raw design tokens; `web/src/styles/semantic.css` maps them to semantic roles.`

4. **Verify no remaining references in shipped code or docs.**
   - From repo root: `rg -n 'web/src/styles\.css'` should return only matches inside `SPEC/v2/review-2026-05/` (the review notes, which are historical and remain untouched per loop conventions).

## Test strategy

This is a CSS-only deletion plus prose-only doc edits. No new automated tests are warranted, and no existing tests target either file.

- **Existing coverage**: none directly. Vitest tests under `src/**/*.test.ts` exercise runtime code, not the web bundle.
- **New tests**: none.
- **Manual smoke test (optional, ~1 minute)**: after `npm run build:web`, load the dashboard at `http://localhost:8080/` and confirm the header, panel switcher, and at least one panel (e.g. Plan or Agents) render with the expected colors. Because the orphan was already not imported, the rendered output must be byte-identical to pre-change; the smoke test exists only to catch a build-system regression, not a CSS regression.

### Validation commands (run from repo root `/home/salva/g/ml/saivage`)

```bash
npm run typecheck
npm run build
rg -n 'web/src/styles\.css' --glob '!SPEC/**'
```

Expected:

- `npm run typecheck`: passes (no TS files changed).
- `npm run build`: passes; `npm run build:web` step writes `web/dist/` without errors and without warnings about a missing `styles.css`.
- The `rg` invocation returns zero matches (the only living references outside `SPEC/v2/review-2026-05/` were the two doc lines fixed in steps 2 and 3).

A focused Vitest run is not applicable (no test file is affected). If the orchestrator prefers running the full suite anyway:

```bash
npx vitest run
```

is safe and expected to be unchanged by this issue.

## Rollback strategy

Single commit, trivially revertable with `git revert <sha>`. The change is purely deletions plus two one-line doc edits; no schema, no API, no on-disk state, no migration.

## Cross-issue ordering note

No ordering dependency.

- F10 does not block and is not blocked by any other Fxx in the inventory.
- The related issue F26 (web auth handling duplicated between `App.vue` and `useWebSocket`) operates on Vue/TS files and does not touch CSS; it can land before, after, or in parallel.
- Because `00-SUBSYSTEM-MAP.md` already names the file as orphan ([SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L199-L209)), no other proposal currently planned in this review depends on `web/src/styles.css` existing.
