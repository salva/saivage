# F10 — `web/src/styles.css` is orphaned dead CSS

**Category**: dead-code
**Severity**: low
**Transversality**: local

## Summary

The legacy `web/src/styles.css` (170 lines) is no longer imported anywhere. `web/src/main.ts` imports the new pipeline `./styles/index.css`, which in turn imports `tokens`, `semantic`, `base`, and `patterns`. The old file ships in the source tree as a confusing alternative.

## Evidence

- Sole stylesheet import in `main.ts`: [web/src/main.ts](web/src/main.ts#L3).
- The new pipeline: [web/src/styles/index.css](web/src/styles/index.css#L1-L8).
- The orphan: [web/src/styles.css](web/src/styles.css#L1-L30) (still defines `--bg`, `--surface-1`, etc. that overlap with `tokens.css`).

## Why this matters

Two CSS sources with overlapping custom properties invite a reader to "fix" the wrong file. Vite ships only what's imported, so there is no runtime impact — only confusion. Delete `styles.css`.

## Related

- F26 (web auth handling is duplicated between App.vue and useWebSocket)
