# Proposals APPROVED — F01 Markdown Table Rendering

Round 2 of the proposals is approved as the authoritative comparison and recommendation document.

- File: [02-proposals-r2.md](02-proposals-r2.md)
- Review history:
  - [02-proposals-review-r1.md](02-proposals-review-r1.md) — `CHANGES_REQUESTED` (6 items)
  - [02-proposals-review-r2.md](02-proposals-review-r2.md) — `APPROVED`

## Outcome

- **Selected**: Proposal B — replace `web/src/utils/markdown.ts` with a `marked` + `DOMPurify` pipeline.
- **Rejected**: Proposal A — extend the regex pipeline in place. Documented as a policy-non-compliant alternative (it grows hand-rolled code instead of replacing it).
- **Weighted score**: B = 91, A = 67.
- **Footnotes**: deliberately out of scope. Default `marked@16.4.2` does not render them.
- **Sanitization**: `DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })` — no broadening permitted in the implementation.
