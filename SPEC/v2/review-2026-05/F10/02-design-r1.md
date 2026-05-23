# F10 Design r1 — `web/src/styles.css` orphan

## Proposal A — Focused fix: delete the orphan, fix the stale docs

**Scope (files touched)**:

- Delete [web/src/styles.css](web/src/styles.css#L1-L30).
- Edit [docs/internals/web-internals.md](docs/internals/web-internals.md#L14) — change "Plain CSS (`web/src/styles.css`)" to reference the live pipeline (`web/src/styles/` with entry `index.css`).
- Edit [docs/internals/web-internals.md](docs/internals/web-internals.md#L57) — replace "`styles.css` exposes CSS variables" with the actual location: `web/src/styles/tokens.css` (and the semantic layer in `semantic.css`).

**What gets added**: nothing.

**What gets removed**: 170 lines of dead CSS and two stale doc lines that point at it.

**Risk**: effectively zero. The file is provably unimported (workspace grep returns only `main.ts` for `styles/index.css` and nothing for `styles.css` outside docs and the review notes). Vite tree-shakes by import graph, so the production bundle is byte-identical before and after deletion at the CSS level. Existing Vue SFCs and the live pipeline are untouched. The only risk is human: a developer with the old file open in an editor will see it disappear on next pull.

**What it enables**: a single, unambiguous theming surface. Future work (e.g. dark mode, design-token cleanup) edits exactly one set of files.

**What it forbids**: any future "patch the theme via `styles.css`" workaround. The file simply will not exist.

**Recommendation note**: this is the minimum-surface change that fully resolves the issue. The issue is purely orphan code, so the minimal fix is also the architecturally correct fix.

## Proposal B — One level up: consolidate the styles pipeline structure

**Scope (files touched)**:

- Everything in Proposal A, plus:
- Reorganize [web/src/styles/index.css](web/src/styles/index.css#L1-L8) into a documented "layers" form using CSS `@layer` (e.g. `@layer tokens, semantic, base, patterns;` then `@import` per layer), so future additions have an explicit cascade-priority contract.
- Audit `web/src/styles/{tokens,semantic,base,patterns}.css` and move any element-level rule (e.g. `* { box-sizing: border-box }`, `html, body, #app { height: 100% }`) that currently sits in `patterns.css` or elsewhere into `base.css` to match the layer name.
- Inline-document the layer contract at the top of `index.css` (allowed — these files are being modified anyway, so the "no new comments" rule does not apply to them).

**What gets added**: an explicit `@layer` cascade declaration (~3 lines in `index.css`); possibly minor relocations across the four pipeline files.

**What gets removed**: same as A plus any rule found in the wrong layer.

**Risk**: medium. `@layer` changes specificity semantics: rules in earlier layers lose to rules in later layers regardless of selector strength. Even with the `tokens → semantic → base → patterns` order preserved, any SFC `<style>` block (which lives outside all named layers, i.e. in the implicit final layer) will now override pipeline rules even when its selector is weaker. That is usually desirable but can silently regress visual styling for components that relied on specificity ties. Requires a visual smoke test of every panel.

**What it enables**: a clearer mental model for future contributors; ground for adding a `themes/` layer later without ad-hoc precedence fights.

**What it forbids**: nothing extra beyond what A already forbids.

**Recommendation note**: B is a refactor riding on a dead-code removal. It expands scope beyond F10's stated category (`dead-code`, severity `low`) and conflates two concerns: removing an orphan and re-architecting the cascade. Worth doing as a separate, deliberately scoped issue if/when the team wants `@layer` semantics; not as part of F10.

## Recommendation

**Proposal A.** F10 is explicitly classified as low-severity dead code with local transversality. The orphan can be removed in a single commit with zero behavioral risk, and the two stale doc lines are corrected in the same change so the file does not "come back" via outdated guidance. Proposal B mixes in an unrelated architectural change (`@layer` adoption) whose risk profile (specificity semantics shift) is wildly disproportionate to the issue being fixed. Defer B to a hypothetical future "CSS pipeline modernization" issue.
