# F01 — Markdown Table Rendering — Proposals r1

Two concrete proposals for closing the gap documented in
[01-analysis-r3.md](01-analysis-r3.md). Every code claim cites either the
analysis (as `01-analysis-r3.md#§N`) or path:line in the source tree.

## A. Recap of the problem

The shared web renderer
[web/src/utils/markdown.ts](../../../../web/src/utils/markdown.ts#L1-L29)
is a 29-line regex pipeline with no block-level state, so GFM pipe-tables
arrive at `v-html` as raw `| … |` rows wrapped by `white-space: pre-wrap`
([01-analysis-r3.md#§1](01-analysis-r3.md), [§3](01-analysis-r3.md),
[§4](01-analysis-r3.md)). Tables are the trigger, but the same renderer
silently drops italics-alone, links/autolinks, blockquotes, thematic
breaks, strikethrough, hard line breaks, nested lists, and coerces
task-list rows into plain bullets ([§3](01-analysis-r3.md)). The fix
propagates to every consumer of `renderMarkdown` — chat, agent panes,
file preview, debug view — because there is exactly one shared renderer
([§1](01-analysis-r3.md), [§2](01-analysis-r3.md)).

## B. Decision criteria

Scored 1–5 in §E (5 = best). Weights reflect the project context: an
internal operator UI with a small surface, low concurrency, and a
workspace-wide architecture-first / no-back-compat rule
([01-analysis-r3.md#§8b](01-analysis-r3.md)).

1. **GFM table fidelity** — header/body split and per-column alignment
   from `:---` / `---:` / `:---:` ([§1](01-analysis-r3.md),
   [§4](01-analysis-r3.md)). Weight **3** (the trigger requirement).
2. **Coverage of the other §3 gaps** — italics, links/autolinks,
   blockquotes, nested lists, strikethrough, task-list checkboxes, hard
   breaks ([§3](01-analysis-r3.md)). Weight **3** (same renderer, same
   consumers).
3. **Bundle-size and dependency-tree impact on `web/`** — measured per
   [§7 measurement plan](01-analysis-r3.md). Weight **2** (matters for an
   operator UI but is not the dominant axis; today's web runtime deps are
   only `lucide-vue-next`, `vue`, `zod` —
   [web/package.json](../../../../web/package.json#L12-L16)).
4. **XSS safety** — must keep escape-first or add explicit sanitization
   ([§5](01-analysis-r3.md), [§9 OQ2](01-analysis-r3.md)). Weight **3**
   (correctness gate).
5. **Compatibility with `FormattedContent.vue` JSON-vs-text branching**
   ([§2](01-analysis-r3.md), [§8](01-analysis-r3.md);
   [web/src/components/FormattedContent.vue](../../../../web/src/components/FormattedContent.vue#L13-L38)).
   Weight **2** (must not break).
6. **Test coverage feasibility** — root vitest + happy-dom already picks
   up `web/src/**/*.test.ts` ([§6](01-analysis-r3.md)). Weight **2**.
7. **Maintenance burden / auditability** — code volume, who owns the
   surface, ease of explaining behaviour. Weight **3**.
8. **Cleanness of resulting code** — workspace rule explicitly biases
   toward removing hand-rolled code over keeping shims
   ([§8b](01-analysis-r3.md)). Weight **3**.

## C. Proposal A — Extend the regex pipeline in place

### Plan

Add a block-level pre-pass to
[web/src/utils/markdown.ts](../../../../web/src/utils/markdown.ts#L1-L29)
that runs *before* today's line-oriented `String.prototype.replace`
chain. The escape step at
[web/src/utils/markdown.ts#L2-L5](../../../../web/src/utils/markdown.ts#L2-L5)
stays first; the new pre-pass operates on the already-escaped text and
swaps each detected block (initially: tables; optionally: blockquotes
and hard breaks) for a placeholder token that survives the inline pipeline
unchanged; a post-pass swaps placeholders back to literal HTML.

Concrete signature:

```ts
function preprocessBlocks(escaped: string): { text: string; blocks: string[] };
function postprocessBlocks(html: string, blocks: string[]): string;
```

Wired into `renderMarkdown` as: escape → `preprocessBlocks` → existing
inline pipeline ([L7-L26](../../../../web/src/utils/markdown.ts#L7-L26))
→ `postprocessBlocks`. Placeholders are a token unlikely to appear in
escaped user text (e.g. `\u0000MDTBL0\u0000`); the post-pass replaces
each with the rendered block HTML built from literals owned by the
renderer.

### Table block detection

A table block is a contiguous run of lines that, after the escape step,
matches all three:

1. **Header row:** `/^\s*\|.+\|\s*$/m` — at least one `|` interior.
2. **Separator row immediately below:**
   `/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/m`. Each cell yields an alignment:
   `:---` → `left`, `---:` → `right`, `:---:` → `center`, `---` → `none`.
   Cell count must equal the header's cell count; otherwise the run is
   *not* a table and is left alone.
3. **Zero or more body rows:** same `^\s*\|.+\|\s*$` shape, terminated
   by either a blank line, EOF, or a line that does not match.

### Emission

Tag shape (all attribute values are renderer-owned literals; cell text is
the escaped capture only):

```html
<table class="md-table">
  <thead><tr><th class="md-th" align="left|right|center">…</th>…</tr></thead>
  <tbody>
    <tr><td class="md-td" align="…">…</td>…</tr>
    …
  </tbody>
</table>
```

Alignment is emitted as the deprecated-but-universally-supported `align`
attribute *and* via CSS classes (`md-align-left|right|center`) — pick one
in implementation; the proposal uses CSS classes only, keeping the tag
shape attribute-free except for `class`, which keeps the safety story
identical to today's escape-first / emit-from-literals model
([01-analysis-r3.md#§5](01-analysis-r3.md)).

### Required CSS additions (atomic across both consumers)

Per [§8](01-analysis-r3.md), both scoped stylesheets must learn the new
selectors and override `white-space` inside the table subtree because
the wrapper sets `white-space: pre-wrap`:

- Chat wrapper: `.msg-content` at
  [web/src/components/ChatWindow.vue#L486-L496](../../../../web/src/components/ChatWindow.vue#L486-L496),
  `pre-wrap` at
  [web/src/components/ChatWindow.vue#L494](../../../../web/src/components/ChatWindow.vue#L494),
  existing `:deep(.md-*)` block at
  [web/src/components/ChatWindow.vue#L533-L554](../../../../web/src/components/ChatWindow.vue#L533-L554).
- Preview wrapper: `.formatted-text` at
  [web/src/components/FormattedContent.vue#L83-L87](../../../../web/src/components/FormattedContent.vue#L83-L87),
  `pre-wrap` at
  [web/src/components/FormattedContent.vue#L84](../../../../web/src/components/FormattedContent.vue#L84),
  existing `:deep(.md-*)` block at
  [web/src/components/FormattedContent.vue#L89-L110](../../../../web/src/components/FormattedContent.vue#L89-L110).

New rules to add to each block (using the existing `:deep(...)`
mechanism):

```css
:deep(.md-table)      { border-collapse: collapse; margin: 0.5em 0; }
:deep(.md-table th),
:deep(.md-table td)   { white-space: normal; padding: 0.2em 0.5em; border: 1px solid var(--border); }
:deep(.md-align-left)   { text-align: left; }
:deep(.md-align-right)  { text-align: right; }
:deep(.md-align-center) { text-align: center; }
```

The `white-space: normal` override is mandatory inside the table subtree;
without it the cells inherit `pre-wrap` from the wrapper and lose normal
collapsing — exactly the regression flagged in
[01-analysis-r3.md#§4](01-analysis-r3.md) ("Future `<table>` injection
would conflict with this CSS") and [§8](01-analysis-r3.md) ("`white-space:
pre-wrap` interacts with any future block-level `<table>`").

### Other §3 gaps to fix in the same proposal

Pick a deliberate, narrow subset — anything wider effectively concedes the
case to Proposal B:

- **Fix in this proposal:** tables (the trigger); italics alone
  (`/(?<!\*)\*([^*\n]+)\*/g` and the `_x_` analogue) since the regex
  surgery is trivial; autolinks `<https?://…>` because it's one rule and
  unlocks clickable URLs in tool output; hard line breaks at the
  trailing-two-spaces convention because the pre-pass already has
  block-aware state.
- **Explicitly leave alone:** full `[text](url)` links (needs paren
  balancing that pulls the rule toward a tokenizer), images, blockquotes
  (multi-line state grows further), thematic breaks, strikethrough,
  task-list checkboxes, nested lists, footnotes. These remain in their
  current state from [§3](01-analysis-r3.md). The proposal is honest
  about *not* closing those gaps.

### Pros

- **Zero new web runtime deps** — the today's set
  ([web/package.json#L12-L16](../../../../web/package.json#L12-L16))
  is unchanged.
- **Full control over the emitted tag shape and class names** — the
  scoped-CSS coupling in both consumers
  ([§8](01-analysis-r3.md)) keeps working with minimal churn.
- **Escape-first XSS posture is preserved verbatim** — every emitted
  attribute and tag remains a renderer-owned literal
  ([§5](01-analysis-r3.md)).
- **Auditable** — the renderer is still a single file; reviewers can read
  it end-to-end.

### Cons

- **Every additional syntax = more regex.** Even the narrow subset above
  adds three to four rules plus a block tokenizer; each is a new edge
  case to test.
- **No CommonMark conformance.** The renderer remains a hand-rolled
  approximation; anything past the chosen subset stays broken
  ([§3](01-analysis-r3.md)).
- **Block state in regex is fragile.** Splitting on `\n`, scanning for
  contiguous pipe runs, and reconciling against the inline pipeline
  introduces an ordering dependency between the new pre-pass and the
  existing `^…$` multiline rules at
  [web/src/utils/markdown.ts#L12-L26](../../../../web/src/utils/markdown.ts#L12-L26).
- **Workspace policy bias is against this direction.**
  [01-analysis-r3.md#§8b](01-analysis-r3.md) explicitly permits — and
  encourages — replacing the 29-line pipeline entirely; this proposal
  grows it instead.

### Estimated diff scope

- [web/src/utils/markdown.ts](../../../../web/src/utils/markdown.ts) —
  ~80 LOC added (block tokenizer + emitter + alignment parsing + the
  three minor inline rules), 0 LOC removed. Net file ≈ 110 LOC.
- [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue#L533-L554) —
  ~10 LOC added inside the existing `:deep(.md-*)` block.
- [web/src/components/FormattedContent.vue](../../../../web/src/components/FormattedContent.vue#L89-L110) —
  ~10 LOC added inside the existing `:deep(.md-*)` block.
- [web/src/utils/markdown.test.ts](../../../../web/src/utils/markdown.test.ts)
  (new file) — ~120 LOC of vitest cases covering header/body, alignment,
  ragged rows, non-table look-alikes, plus the inline additions. Runs
  under the root vitest harness per
  [01-analysis-r3.md#§6](01-analysis-r3.md); no new infrastructure.
- No `web/package.json` change.

### Risk scores against §B criteria

| Criterion                                | Score | Note |
| ---------------------------------------- | ----- | ---- |
| 1. GFM table fidelity                    | 3     | Header/body and alignment fine for well-formed input; ragged rows and escaped pipes (`\|`) are edge cases the pipeline will get wrong. |
| 2. Coverage of other §3 gaps             | 2     | Closes 3-4 of the 9 listed gaps; the rest remain. |
| 3. Bundle-size impact                    | 5     | Zero new bytes. |
| 4. XSS safety                            | 4     | Posture preserved; new tokenizer is the only new surface to audit. |
| 5. Compatibility with JSON branching     | 5     | `FormattedContent.vue` text-branch contract unchanged. |
| 6. Test coverage feasibility             | 4     | Easy to test against raw HTML strings; many cases to write. |
| 7. Maintenance burden / auditability     | 3     | Still one file; but ~4× larger and stateful. |
| 8. Cleanness                             | 2     | Grows hand-rolled regex against the workspace policy in [§8b](01-analysis-r3.md). |

## D. Proposal B — Replace with a small parser library (`marked` + `DOMPurify`)

### Library choice and justification

Pick **`marked`** for parsing and **`DOMPurify`** for sanitization. Both
already exist in this repo's lockfile (`marked@16.4.2` at
[package-lock.json#L8098-L8109](../../../../package-lock.json#L8098-L8109);
`dompurify@3.4.5` at
[package-lock.json#L6051-L6058](../../../../package-lock.json#L6051-L6058)),
each on a docs-only path through `mermaid` — they would still count as
**new direct web runtime deps** per
[01-analysis-r3.md#§7 "Implications"](01-analysis-r3.md) because the
Vite build will not pull a docs-only transitive into `web/dist`.

Against the alternatives:

- **`markdown-it`** — also small and battle-tested, but already in this
  lockfile only via `typedoc`
  ([01-analysis-r3.md#§7](01-analysis-r3.md)); same "new direct web dep"
  cost as `marked`, slightly larger plugin surface to keep clean, and
  GFM tables ship as a separate plugin (`markdown-it`'s `gfm:true` is on
  by default but plugin ecosystem broadens the audit surface). `marked`
  wins on smaller default API for a single-renderer use case.
- **`micromark`** — lower level (a tokenizer, not an HTML emitter); using
  it directly means re-implementing the HTML compiler. Over-budget for
  this surface even though the GFM extension family is in the lockfile
  via `telegramify-markdown` ([§7](01-analysis-r3.md)).
- **`remark`** — full mdast pipeline; overkill for inline rendering of
  short agent messages.

`marked`'s API ([`node_modules/marked/lib/marked.d.ts#L443-L490`](../../../../node_modules/marked/lib/marked.d.ts#L443-L490))
exposes `gfm`, `breaks`, and `async` directly. The relevant call shape is
synchronous, GFM on, soft-line-breaks on.

### Concrete API

```ts
import { marked } from "marked";
import DOMPurify from "dompurify";

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: true, async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
```

Note: `marked` does **not** sanitize its output. That is explicit in
[node_modules/marked/README.md#L53-L56](../../../../node_modules/marked/README.md#L53-L56)
and is exactly the constraint flagged in
[01-analysis-r3.md#§9 OQ2](01-analysis-r3.md). The `DOMPurify` pass is
therefore mandatory, not optional. `marked.parse` with `async: false`
returns `string` synchronously — matching the existing
`renderMarkdown(text: string): string` signature at
[web/src/utils/markdown.ts#L1](../../../../web/src/utils/markdown.ts#L1)
so neither consumer call site changes
([web/src/components/ChatWindow.vue#L314](../../../../web/src/components/ChatWindow.vue#L314),
[web/src/components/FormattedContent.vue#L38](../../../../web/src/components/FormattedContent.vue#L38)).

### Where the new code lives

[web/src/utils/markdown.ts](../../../../web/src/utils/markdown.ts#L1-L29)
is rewritten from scratch — no compat shim, per the workspace policy in
[01-analysis-r3.md#§8b](01-analysis-r3.md).

### What gets DELETED

- The entire 29-line regex pipeline
  ([web/src/utils/markdown.ts#L2-L28](../../../../web/src/utils/markdown.ts#L2-L28)):
  escape step, fenced-code rule, inline-code rule, the three
  `<strong class="md-h*">` heading rules, the `***/**` rules, both
  bullet rules.
- The hand-rolled span-grid bullet HTML
  ([web/src/utils/markdown.ts#L19-L26](../../../../web/src/utils/markdown.ts#L19-L26))
  — `marked` emits real `<ul>/<ol>/<li>`.
- The custom `<strong class="md-h1|h2|h3">` heading hack
  ([web/src/utils/markdown.ts#L12-L14](../../../../web/src/utils/markdown.ts#L12-L14))
  — `marked` emits real `<h1>..<h6>`.

Consumer-side CSS deletions (atomic in the same commit per
[01-analysis-r3.md#§8b](01-analysis-r3.md)):

- Chat — drop the `:deep(.md-h*)`, `:deep(.md-bullet)`, `:deep(.md-marker)`,
  `:deep(.md-bullet-text)`, `:deep(.md-code-block)`, `:deep(.md-code)`
  rules inside
  [web/src/components/ChatWindow.vue#L533-L554](../../../../web/src/components/ChatWindow.vue#L533-L554).
- Preview — same deletion inside
  [web/src/components/FormattedContent.vue#L89-L110](../../../../web/src/components/FormattedContent.vue#L89-L110).

### New CSS to add (atomic across both consumers)

Both `:deep(.md-*)` blocks
([web/src/components/ChatWindow.vue#L533-L554](../../../../web/src/components/ChatWindow.vue#L533-L554),
[web/src/components/FormattedContent.vue#L89-L110](../../../../web/src/components/FormattedContent.vue#L89-L110))
are replaced with rules targeting native tags emitted by `marked`:

```css
:deep(h1), :deep(h2), :deep(h3) { font-weight: 600; margin: 0.4em 0 0.2em; }
:deep(h1) { font-size: 1.15em; }
:deep(h2) { font-size: 1.08em; }
:deep(h3) { font-size: 1.02em; }
:deep(p)  { margin: 0.3em 0; }
:deep(ul), :deep(ol) { margin: 0.3em 0; padding-left: 1.4em; }
:deep(li) { margin: 0.1em 0; }
:deep(code) { background: var(--code-bg); padding: 0 0.25em; border-radius: 3px; }
:deep(pre)  { background: var(--code-bg); padding: 0.5em; border-radius: 4px; overflow-x: auto; }
:deep(pre) code { background: transparent; padding: 0; }
:deep(table) { border-collapse: collapse; margin: 0.5em 0; }
:deep(th), :deep(td) { white-space: normal; padding: 0.2em 0.5em; border: 1px solid var(--border); }
:deep(blockquote) { border-left: 3px solid var(--border); padding-left: 0.6em; margin: 0.3em 0; opacity: 0.85; }
:deep(a) { color: var(--accent); text-decoration: underline; }
```

The `white-space: normal` override on `:deep(th)` / `:deep(td)` is
mandatory for the same reason as in Proposal A — the wrappers still set
`pre-wrap` ([01-analysis-r3.md#§4](01-analysis-r3.md),
[§8](01-analysis-r3.md)). This proposal keeps `pre-wrap` on the wrappers
(answer to [§9 OQ3](01-analysis-r3.md): "keep + override in table
subtree") because `marked` with `breaks: true` already emits `<br>` for
soft breaks, but consumers also send free-form whitespace that current
operator content relies on.

### Bundle impact

To be measured per
[01-analysis-r3.md#§7 measurement plan](01-analysis-r3.md) after
installing both as direct `web/` deps. Expected ballpark based on each
package's README — `marked` ~30 KB minified, `DOMPurify` ~25 KB minified
(~55 KB total pre-gzip). **Confirm in implementation** by running steps
1–4 of the §7 plan; record both raw and gzip numbers next to the install
diff before merge.

### Pros

- **CommonMark + GFM.** Tables (`gfm: true` —
  [node_modules/marked/lib/marked.d.ts#L443-L490](../../../../node_modules/marked/lib/marked.d.ts#L443-L490))
  with header/body and alignment work out of the box; the §9 OQ1
  ("extend or replace") dissolves on the table axis.
- **Closes the §3 gap list wholesale** — italics, links, autolinks,
  images (sanitized), blockquotes, thematic breaks, strikethrough,
  task-list checkboxes, hard breaks, nested lists — all become "what
  GFM says".
- **Removes the 29-line hand-rolled renderer** and the bullet-grid /
  heading-strong hacks; the consumer stylesheets become idiomatic native
  selectors.
- **DOMPurify gives a clearer security story than escape-first.** It
  enforces an HTML5 whitelist on the *parsed DOM* rather than relying on
  the renderer to never accidentally emit an attribute that interpolates
  user input ([01-analysis-r3.md#§5](01-analysis-r3.md),
  [§9 OQ2](01-analysis-r3.md)).
- **Aligns with the workspace policy** that explicitly invites this
  rewrite ([01-analysis-r3.md#§8b](01-analysis-r3.md)).

### Cons

- **Two new direct web runtime deps.** Both already in the lockfile via
  `mermaid`'s docs-only path
  ([01-analysis-r3.md#§7](01-analysis-r3.md)), but Vite will not pull
  them into `web/dist` until they are declared in `web/package.json`.
- **Vulnerability surface widens** — `marked` and `dompurify` each become
  things to track for advisories.
- **Modestly larger bundle** — measured per §7, expected ~55 KB pre-gzip
  added.
- **Behavioural diff with today.** Once `marked` renders real `<h1>` and
  real `<ul>`, the look of existing operator content changes; that diff
  must be reviewed visually in chat + preview + agent panes + files view
  + debug view ([01-analysis-r3.md#§1](01-analysis-r3.md)).

### Risk scores against §B criteria

| Criterion                                | Score | Note |
| ---------------------------------------- | ----- | ---- |
| 1. GFM table fidelity                    | 5     | `gfm: true` covers header, body, and alignment per [marked.d.ts#L443-L490](../../../../node_modules/marked/lib/marked.d.ts#L443-L490). |
| 2. Coverage of other §3 gaps             | 5     | All nine items become "what GFM/CommonMark says". |
| 3. Bundle-size impact                    | 2     | Expected ~55 KB pre-gzip; to be measured per §7. |
| 4. XSS safety                            | 5     | DOMPurify whitelist on parsed DOM is stronger than escape-first heuristic. |
| 5. Compatibility with JSON branching     | 5     | `renderMarkdown(text): string` signature preserved; `FormattedContent.vue` text-branch unchanged. |
| 6. Test coverage feasibility             | 4     | Easier to assert "table is rendered" via happy-dom `querySelector`; some tests now exercise library behaviour. |
| 7. Maintenance burden / auditability     | 4     | Renderer becomes ~5 lines; behaviour lives in two well-known libraries. |
| 8. Cleanness                             | 5     | Removes 29 lines of hand-rolled regex and two stylesheet blocks of class-name shims. |

## E. Comparison

| Criterion (weight) | A — Extend regex | B — `marked` + `DOMPurify` |
| --- | --- | --- |
| 1. GFM table fidelity (3) | 3 × 3 = **9** | 5 × 3 = **15** |
| 2. Coverage of other §3 gaps (3) | 2 × 3 = **6** | 5 × 3 = **15** |
| 3. Bundle-size impact (2) | 5 × 2 = **10** | 2 × 2 = **4** |
| 4. XSS safety (3) | 4 × 3 = **12** | 5 × 3 = **15** |
| 5. JSON-branching compat (2) | 5 × 2 = **10** | 5 × 2 = **10** |
| 6. Test coverage feasibility (2) | 4 × 2 = **8** | 4 × 2 = **8** |
| 7. Maintenance / auditability (3) | 3 × 3 = **9** | 4 × 3 = **12** |
| 8. Cleanness (3) | 2 × 3 = **6** | 5 × 3 = **15** |
| **Weighted total** | **70** | **94** |

Proposal A wins exactly one criterion (bundle size, #3) and ties on two
(#5, #6). Proposal B leads on every other criterion. The largest deltas
are on Cleanness (#8: −3), §3 gap coverage (#2: −3), and GFM table
fidelity (#1: −2) — i.e. on the dimensions that prompted the work and
the dimension the workspace policy explicitly privileges.

## F. Recommendation

**Adopt Proposal B (`marked` + `DOMPurify`).**

Justification, in priority order:

1. **GFM tables are the trigger.** Proposal B turns OQ1
   ([01-analysis-r3.md#§9](01-analysis-r3.md)) into one option flag
   (`gfm: true`,
   [node_modules/marked/lib/marked.d.ts#L443-L490](../../../../node_modules/marked/lib/marked.d.ts#L443-L490)).
   Proposal A scores 3/5 on the same axis because its hand-rolled
   tokenizer will mishandle ragged rows and escaped pipes that the
   library handles by construction.
2. **The §3 gap list disappears.** Operator-facing content has had
   silently-dropped italics, links/autolinks, blockquotes, strikethrough,
   task-list checkboxes, and nested lists for the renderer's entire
   lifetime ([01-analysis-r3.md#§3](01-analysis-r3.md)). Proposal A
   closes 3–4 of those; Proposal B closes all of them. For the *same*
   amount of consumer-side CSS churn (both proposals touch the same
   `:deep(...)` blocks in
   [ChatWindow.vue#L533-L554](../../../../web/src/components/ChatWindow.vue#L533-L554)
   and
   [FormattedContent.vue#L89-L110](../../../../web/src/components/FormattedContent.vue#L89-L110)),
   B delivers an order of magnitude more coverage.
3. **The workspace policy biases toward removing hand-rolled code.**
   [01-analysis-r3.md#§8b](01-analysis-r3.md) is explicit: "the 29-line
   regex pipeline should be deleted wholesale rather than kept as a
   fallback or migration shim." Proposal A grows that pipeline; Proposal
   B deletes it.
4. **The XSS posture improves, not regresses.** DOMPurify on the parsed
   DOM is a stricter contract than escape-then-emit-from-literals
   because it whitelists by HTML5 element/attribute model rather than
   relying on the renderer to never accidentally interpolate user input
   inside an emitted attribute. The current escape step does *not* even
   escape `"` or `'`
   ([web/src/utils/markdown.ts#L3-L5](../../../../web/src/utils/markdown.ts#L3-L5),
   [01-analysis-r3.md#§5](01-analysis-r3.md)) — which is safe today only
   because no emitted tag has an attribute interpolating user input;
   that invariant is one careless edit away from a regression. DOMPurify
   removes that fragility.
5. **The losing criterion is bounded and measurable.** Bundle impact is
   the one axis Proposal A wins. For an internal operator UI with no
   public concurrency target, a ~55 KB pre-gzip add (to be confirmed per
   [§7 measurement plan](01-analysis-r3.md)) is a modest, one-time cost
   against permanent renderer correctness and a smaller maintenance
   surface. The current `web/` runtime is `lucide-vue-next` + `vue` +
   `zod` ([web/package.json#L12-L16](../../../../web/package.json#L12-L16));
   adding two more well-maintained packages does not change the
   character of the dependency tree.

Decision on the open questions, restricted to the chosen proposal:

- **OQ1 (extend vs replace)** — replace.
- **OQ2 (sanitizer config)** — explicit `DOMPurify.sanitize(..., {
  USE_PROFILES: { html: true } })` pass, on top of `marked`'s default
  (no `mangle` / `headerIds` / `html: false` legacy flags; `marked@16`'s
  surface is the one declared in
  [node_modules/marked/lib/marked.d.ts#L443-L490](../../../../node_modules/marked/lib/marked.d.ts#L443-L490)).
- **OQ3 (`white-space: pre-wrap`)** — keep on the wrappers
  ([ChatWindow.vue#L494](../../../../web/src/components/ChatWindow.vue#L494),
  [FormattedContent.vue#L84](../../../../web/src/components/FormattedContent.vue#L84));
  override to `normal` inside `:deep(th)` / `:deep(td)` only.
- **OQ4 (shared renderer)** — keep the single `renderMarkdown` shared by
  [ChatWindow.vue#L314](../../../../web/src/components/ChatWindow.vue#L314)
  and
  [FormattedContent.vue#L38](../../../../web/src/components/FormattedContent.vue#L38);
  no current evidence that chat and file preview need different markdown
  semantics.
- **OQ5 (tests)** — place tests beside the renderer at
  `web/src/utils/markdown.test.ts` (picked up by root vitest per
  [01-analysis-r3.md#§6](01-analysis-r3.md)); assert via happy-dom
  `querySelector` (e.g. `'table > thead > tr > th'`, `'table tbody tr
  td.md-align-right'`-equivalent on the native attribute, etc.) so the
  tests document the *DOM shape contract* rather than brittle HTML
  string equality.

## G. Out of scope (for the chosen proposal)

Explicitly **not** addressed by Proposal B as scoped here:

- Backend `telegramify-markdown` and its `micromark`/`mdast-util-gfm`
  family — Telegram transport only
  ([01-analysis-r3.md#§2, §7](01-analysis-r3.md)).
- VitePress docs site (`docs:dev` / `docs:build` / `docs:preview`,
  [package.json#L22-L25](../../../../package.json#L22-L25)) and its
  `markdown-it` / `mermaid` chains
  ([01-analysis-r3.md#§7](01-analysis-r3.md)).
- [web/src/components/JsonHighlight.vue](../../../../web/src/components/JsonHighlight.vue)
  and the JSON branches of `FormattedContent.vue`
  ([L13-L34](../../../../web/src/components/FormattedContent.vue#L13-L34),
  [L70-L74](../../../../web/src/components/FormattedContent.vue#L70-L74))
  — the JSON-vs-text branching contract is preserved as-is
  ([01-analysis-r3.md#§2, §8](01-analysis-r3.md)).
- Commit-prefix prompts and any other non-web markdown consumer.
- Server-side rendering of markdown.
- KaTeX / Mermaid rendering inside chat messages.
- Syntax highlighting beyond `marked`'s default `<pre><code>` emission
  (no highlight.js / Shiki / Prism integration).
- Replacing `pre-wrap` site-wide with explicit `<p>` / `<br>` — kept as a
  later refactor if visual review surfaces wrapping regressions.
- Splitting the renderer per consumer (OQ4 above is closed: stay single).

STATUS: READY_FOR_REVIEW
