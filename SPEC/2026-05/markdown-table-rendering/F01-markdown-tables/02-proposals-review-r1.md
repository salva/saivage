# F01 — Markdown Table Rendering — Proposals Review r1

Reviewed `/home/salva/g/ml/saivage/SPEC/2026-05/markdown-table-rendering/F01-markdown-tables/02-proposals-r1.md` against `01-analysis-r3.md` and the current source tree. I re-greped the cited renderer, consumers, package metadata, and installed library type/docs files, then probed the proposed regexes and `marked` behavior with representative GFM inputs.

## Citation Verification

Most path:line citations in the proposal are correct against the current tree:

- `web/src/utils/markdown.ts#L1-L29`, `#L2-L5`, `#L7-L26`, `#L12-L14`, `#L12-L26`, and `#L19-L26` match the current 29-line regex renderer, escape step, inline/block regex body, heading rules, and bullet rules.
- `web/src/components/ChatWindow.vue#L314`, `#L486-L496`, `#L494`, and `#L533-L554` match the assistant `v-html` call, `.msg-content` wrapper, `white-space: pre-wrap`, and current markdown selectors.
- `web/src/components/FormattedContent.vue#L13-L38`, `#L38`, `#L83-L87`, `#L84`, and `#L89-L110` match the JSON-vs-text computation, renderer call, `.formatted-text` wrapper, `pre-wrap`, and current markdown selectors.
- `web/package.json#L12-L16`, `package.json#L22-L25`, `package-lock.json#L6051-L6058`, and `package-lock.json#L8098-L8109` match the claimed package/dependency facts.
- `node_modules/marked/README.md#L53-L56` correctly cites Marked's warning that it does not sanitize output HTML.

Citation problems that need correction:

1. `node_modules/marked/lib/marked.d.ts#L443-L490` does not include `async?: boolean`; `async?: boolean` is at line 441. The range does include `breaks?: boolean` and `gfm?: boolean`, so the citation is partially correct but wrong for the exact claim that the range exposes all three options.
2. The `async: false` call itself is valid, but the better citation is the parse overload area: `marked.parse(src, options & { async: false }): ParserOutput` appears around `node_modules/marked/lib/marked.d.ts#L623-L635`, and the exported `marked` overload returning `string` for `async: false` appears around `#L675-L692`.
3. The out-of-scope `FormattedContent.vue` template citation should be widened from `#L70-L74` to `#L68-L74`; the current range misses the opening `<JsonHighlight` and `v-if="parsed.kind === 'json'"` lines.

## Proposal A Review

The separator regex does recognize alignment markers for the strict leading/trailing-pipe form:

```ts
/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/m
```

It accepts `:---`, `---:`, `:---:`, and `---` when each delimiter cell is bounded by literal pipes. That part is directionally correct.

However, the table detection is not a GFM parser and should not be described as full table fidelity:

- GFM tables can be parsed without leading and trailing pipes, e.g. `a | b` / `--- | ---`; Marked renders that as a table, while Proposal A's header and separator regexes both reject it.
- The proposal never specifies an escaped-pipe-aware cell splitter. A header like `| a \| b | c |` matches the row regex, but a naive split/count on `|` will treat the escaped pipe as a delimiter. The proposal mentions escaped pipes as a risk later, but the detection/emission section needs to say explicitly that this is unsupported or define correct parsing.
- Empty cells need clearer treatment. Rows such as `| a |  |` work with the row regex, but truly empty compact cells such as `||` or ragged body rows are not specified. GFM/Marked pads or ignores ragged body cells in defined ways; Proposal A currently leaves that behavior to implementation accident.
- The body-row rule only says "same shape" and termination by non-matching line. It does not define whether body rows must match the header cell count, whether shorter rows are padded, or whether longer rows are truncated/rejected.

The A risk score of 3/5 for GFM table fidelity is defensible only if the proposal clearly calls this a strict subset: piped tables with simple unescaped cell content. As written, the detection section sounds more complete than the later risk table admits.

Project-rule compliance: Proposal A is not a compatibility shim, but it grows the old regex renderer, leaves most unsupported syntax in place, and estimates 0 LOC removed. That is contrary to the workspace's architecture-first bias in `01-analysis-r3.md#§8b`. It can remain as a rejected alternative, but should not be framed as equally policy-compliant with Proposal B.

## Proposal B Review

The proposed `marked` call shape is valid:

```ts
marked.parse(text, { gfm: true, breaks: true, async: false })
```

The installed `marked.d.ts` exposes `async?: boolean`, `breaks?: boolean`, and `gfm?: boolean`, and has overloads that return `string` for `async: false`. The proposal must fix the citation range, but the API claim is substantively correct.

The DOMPurify config is also the right baseline for this use case:

```ts
DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
```

DOMPurify documents this exact config as allowing safe HTML while excluding SVG/MathML. Its HTML tag allowlist includes `table`, `tbody`, `td`, `tfoot`, `th`, `thead`, and `tr`; its attribute allowlist includes `align`, which matters because Marked emits `align="left|right|center"` for aligned table cells. This keeps tables and preserves the XSS safety requirement, provided the implementation does not add permissive options such as unknown protocol allowance or broad custom attribute/tag allowlists.

The "what gets DELETED" list matches the current code for the items it names:

- `web/src/utils/markdown.ts` really contains the 29-line escape/regex pipeline and emits `md-code-block`, `md-code`, `md-h1`, `md-h2`, `md-h3`, `md-bullet`, `md-marker`, and `md-bullet-text`.
- `ChatWindow.vue` contains the corresponding selectors at lines 535-554, with the surrounding `strong`/`em` rules at lines 533-534.
- `FormattedContent.vue` contains the corresponding selectors at lines 91-110, with the surrounding `strong`/`em` rules at lines 89-90.

One important scoring/coverage issue remains: Proposal B overstates the §3 gap closure. Marked with `{ gfm: true, breaks: true, async: false }` covers tables, italics, links/autolinks, blockquotes, thematic breaks, strikethrough, task-list checkboxes, hard breaks, and nested lists. It does not provide footnote support out of the box in the installed version; a probe of `footnote[^1]` plus `[^1]: note` rendered as a paragraph containing a normal link, not a footnote section. Since `01-analysis-r3.md#§3` lists footnotes as an unsupported syntax, §D/§E/§F must either add a deliberate footnote extension to Proposal B, remove footnotes from the promised gap closure, or explicitly keep footnotes out of scope and adjust the criterion-2 score/justification.

## Decision Criteria and Recommendation

The weighted comparison is mostly self-consistent: Proposal B wins on table fidelity, general Markdown coverage, maintainability, and cleanness; Proposal A wins only on bundle size and ties on JSON branching/test feasibility. The arithmetic is correct.

The weak spots are in the justifications, not the math:

- B's 5/5 for criterion 2 is not currently justified because default Marked does not cover footnotes, despite the analysis listing footnotes in §3.
- B's 5/5 for criterion 1 is directionally right, and the runtime probe confirms Marked handles aligned tables, optional leading/trailing pipes, empty cells, and escaped pipes. The cited `marked.d.ts#L443-L490` range only proves the `gfm` option exists; it does not itself prove table alignment behavior. The proposal should cite the option declaration plus either Marked table renderer/tokenizer declarations or the implementation/test evidence expected from the implementation.
- A's 3/5 for criterion 1 is plausible only after narrowing the claim to simple, fully piped tables. Without calling out optional pipes and escaped-pipe splitting in the detection section, the score is under-explained.

The §F recommendation is grounded in the §B criteria and the project rule. It does not merely assert the conclusion: it points to table fidelity, broader syntax coverage, deletion of hand-rolled code, XSS posture, and measurable bundle impact. But it inherits the citation and footnote-overcoverage problems above, so it needs revision before approval.

## Out-of-Scope Review

The §G list is mostly good: it excludes Telegram/backend markdown, VitePress/docs chains, JSON rendering, non-web markdown consumers, SSR markdown, KaTeX/Mermaid rendering, syntax highlighting, global `pre-wrap` replacement, and renderer splitting.

Add these exclusions or clarifications to prevent implementation drift:

1. Do not start rendering user or system chat messages as Markdown; current `ChatWindow.vue` only applies `renderMarkdown` to assistant messages.
2. Do not change chat history/message storage, WebSocket payloads, or agent output formatting to work around renderer behavior; this is a web-renderer change.
3. If footnotes are not added deliberately via a vetted Marked extension, list footnote rendering as out of scope and remove "all nine" coverage claims.
4. Do not broaden DOMPurify beyond the HTML profile without a separate security justification; avoid custom protocol/tag/attribute allowances as part of this table-rendering change.
5. Do not add image handling policy beyond sanitized default rendering unless the implementation explicitly scopes image sizing/loading/security behavior.

## Verdict

VERDICT: CHANGES_REQUESTED

1. Correct every `node_modules/marked/lib/marked.d.ts#L443-L490` citation that claims `async` is in that range; cite `async?: boolean` at line 441 and the `async: false` overloads around lines 623-635 / 675-692 instead.
2. Fix the `FormattedContent.vue#L70-L74` citation to include the actual `JsonHighlight` opening and `v-if` lines (`#L68-L74`).
3. Revise Proposal A's table detection section to state that it only handles fully piped simple tables, or extend it to cover optional leading/trailing pipes, escaped pipes, empty compact cells, and ragged body-row behavior.
4. Adjust §E criterion-2 scoring and §F coverage reasoning for Proposal B: default Marked does not support footnotes, so either add an explicit footnote extension/design or mark footnotes out of scope and remove "all nine" / "wholesale" gap-closure claims.
5. Keep the DOMPurify `USE_PROFILES: { html: true }` recommendation, but add an explicit note that the implementation must not loosen the sanitizer profile or URL/protocol handling without a separate security review.
6. Add the missing out-of-scope guardrails for user/system chat messages, backend message storage/output formatting, footnotes if not implemented, sanitizer broadening, and image policy.