# F10 Analysis r1 — `web/src/styles.css` orphan

## Problem restated

`web/src/styles.css` (170 lines) is a legacy single-file stylesheet that nobody imports. The active stylesheet pipeline lives under `web/src/styles/` and is reached through the entry point `web/src/styles/index.css`, which the app boots via [web/src/main.ts](web/src/main.ts#L3):

```ts
import "./styles/index.css";
```

The orphan file still defines design tokens (`--bg`, `--surface-1`, `--accent`, etc.) that overlap with the canonical `tokens.css`, so a reader who opens `web/src/styles.css` to "fix the theme" will edit a file the bundle never sees. Vite tree-shakes by import graph, so the orphan has no runtime effect — it is pure source-tree confusion.

A secondary, documentation-level instance of the same confusion exists: [docs/internals/web-internals.md](docs/internals/web-internals.md#L14) and [docs/internals/web-internals.md](docs/internals/web-internals.md#L57) still describe the web app as styled by `web/src/styles.css`, which has not been true since the `styles/` split.

## Actual differences (orphan vs. live pipeline)

The two define the same conceptual tokens but with divergent values, which is the strongest reason to delete the orphan rather than treat it as a "second skin":

- Orphan [web/src/styles.css](web/src/styles.css#L1-L22) declares `--bg`, `--surface-1..3`, `--border`, `--text*`, `--accent`, `--accent-2`, `--warn`, `--danger`, `--purple`, `--orange`, `--radius`, `--mono`, `--shadow-1..3` directly on `:root` with a single light palette.
- Live [web/src/styles/tokens.css](web/src/styles/tokens.css#L1-L42) is the modern token layer (different values, semantic naming) consumed by [web/src/styles/semantic.css](web/src/styles/semantic.css#L1-L75), [web/src/styles/base.css](web/src/styles/base.css#L1-L67), and [web/src/styles/patterns.css](web/src/styles/patterns.css#L1-L60).

The orphan also carries element-level rules (`*`, `html/body/#app`, `button`, etc., [web/src/styles.css](web/src/styles.css#L24-L40)) whose equivalents now live in `base.css`. Keeping the orphan around invites accidental "merge both" edits.

## Contract

- `web/src/styles.css` has no contract: it is referenced by zero `import`, `@import`, `<link>`, or HTML asset entry.
- The live pipeline contract is fixed by [web/src/main.ts](web/src/main.ts#L3) → [web/src/styles/index.css](web/src/styles/index.css#L1-L8) → `tokens → semantic → base → patterns`. Deletion of the orphan does not touch this contract.

## Call sites & dependencies

Workspace-wide search for `styles.css` and `styles/index.css` returns:

- Source code: only [web/src/main.ts](web/src/main.ts#L3) (imports `./styles/index.css`). No reference to `./styles.css`.
- Docs: [docs/internals/web-internals.md](docs/internals/web-internals.md#L14) ("Plain CSS (`web/src/styles.css`)") and [docs/internals/web-internals.md](docs/internals/web-internals.md#L57) ("Theming: `styles.css` exposes CSS variables...").
- Review notes (informational, will be obsolete once F10 lands): [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md#L199-L209) already calls it out as orphan; [SPEC/v2/review-2026-05/F10-web-styles-orphan.md](SPEC/v2/review-2026-05/F10-web-styles-orphan.md#L1-L22).

No Vue SFC, no `index.html`, no `vite.config.ts`, no test fixture, and no build script references the orphan.

## Constraints any solution must respect

1. **Architecture-first, no backward compatibility** (project guideline): remove the dead source, do not leave a comment shim or re-export.
2. Live pipeline `tokens → semantic → base → patterns` must continue to load via `web/src/main.ts`. The fix must not perturb the import order or the existing token names consumed by SFCs.
3. Out-of-scope dirs (`src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/`, memory subsystem) are not touched — F10 lives entirely under `web/` and `docs/internals/`.
4. Documentation that still names `styles.css` should be corrected in the same change so the orphan does not silently "reappear" via stale guidance.
5. No new tests required at the unit level (CSS deletion is verified by the existing `npm run build:web` succeeding); but the typecheck and full build commands stay in the validation set.
