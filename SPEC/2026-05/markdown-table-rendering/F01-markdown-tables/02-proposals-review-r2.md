# F01 — Markdown Table Rendering — Proposals r2 Review

Scope: R2 verification only. I did not re-review previously approved proposal content.

## Verdict

All requested R1 fixes are applied correctly in `02-proposals-r2.md`.

- `marked` declaration anchors were re-checked against `node_modules/marked/lib/marked.d.ts`: `async?` is at L441, `breaks?` at L445, `gfm?` at L453, the `Marked.parse` overload block is at L621-L629 with the sync `async: false` overload at L625-L627, and the exported `marked()` sync overload is inside the cited L675-L692 range at L688-L690.
- `FormattedContent.vue` out-of-scope now cites the JSON branch as `#L68-L74`.
- Proposal A's table-support claim is narrowed and explicitly lists unsupported pipe-less tables, escaped pipes, ragged body rows, and empty compact cells; A criterion 1 is lowered to 2/5.
- Proposal B no longer claims footnotes are covered; footnotes are explicitly out of scope in §G; B criterion 2 is lowered to 4/5.
- DOMPurify hardening appears in both §D and §G with the required constraints: no custom `ADD_TAGS`, `ADD_ATTR`, `ALLOWED_URI_REGEXP`, or non-default protocol allowances, with the sanitizer pinned to `USE_PROFILES: { html: true }`.
- §G includes the requested out-of-scope guardrails, including user/system messages, storage/transport/backend formatting, footnotes, sanitizer profile broadening, and image handling beyond default sanitized `<img>` rendering.
- §F adds the required paragraph stating Proposal A is policy-non-compliant as a final design choice.

## Weighted Totals

The recomputed weighted totals are arithmetically consistent with the revised scores.

- Proposal A: `2*3 + 2*3 + 5*2 + 4*3 + 5*2 + 4*2 + 3*3 + 2*3 = 67`.
- Proposal B: `5*3 + 4*3 + 2*2 + 5*3 + 5*2 + 4*2 + 4*3 + 5*3 = 91`.

VERDICT: APPROVED
