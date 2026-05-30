# F01 — Markdown Table Rendering — Design + Plan r3

> **r3 changes from r2** (per [03-design-plan-review-r2.md](03-design-plan-review-r2.md)):
> - Corrected every per-rule CSS subrange in the §3a and §3b DELETE bullets to the verified disk offsets (`FormattedContent.vue` md-h1/h2/h3 at L91-L93, md-code L94, md-code-block + code L95-L96, md-bullet L97-L103, md-marker L104-L109, md-bullet-text L110; `ChatWindow.vue` md-h1/h2/h3 at L535-L537, md-code L538, md-code-block + code L539-L540, md-bullet L541-L547, md-marker L548-L553, md-bullet-text L554).
> - Corrected `.msg-content` wrapper block citation to L486-L497 and `white-space: pre-wrap` line to L494 (was L487-L497 / L495).
> - Corrected the two historical context citations in the §3a/§3b ADD blocks (font-size carry-over to L91-L93; `var(--mono)` example to L540).
>
> **r2 changes from r1** (per [03-design-plan-review-r1.md](03-design-plan-review-r1.md)):
> 1. Corrected CSS deletion summary line ranges — `FormattedContent.vue` is L91-L110 (was L93-L112); `ChatWindow.vue` is L535-L554 (was L538-L557).
> 2. Removed the conditional `@types/dompurify` fallback from the validation gate — DOMPurify 3.4.5 ships its own ESM types in `dist/purify.es.d.mts`.
> 3. Added §7 step 6 post-edit guard `rg -n 'md-' web` (must produce no output).
> 4. Expanded the `white-space: normal` rationale to call out the list-item nested-`<p>` behaviour (`- a\n\n  b` → `<li><p>a</p><p>b</p></li>`) so visual review does not treat it as a regression.
>
> Test-shape note (no plan edit required — already compliant): the task-list checkbox test in §5 only asserts `toContain('type="checkbox"')`, which is robust to attribute-order/boolean-serialization variance in `marked@16.4.2`. Per reviewer R1 §4 this is acceptable as-is.

Design and implementation plan for Proposal B from
[02-proposals-r2.md](02-proposals-r2.md#D-proposal-b---replace-with-a-small-parser-library-marked--dompurify),
the reviewer-vetted recommendation
([02-proposals-r2.md#F](02-proposals-r2.md)). Inputs: analysis
[01-analysis-r3.md](01-analysis-r3.md) (approved), proposals
[02-proposals-r2.md](02-proposals-r2.md) (Proposal B selected), source
trees under `web/`, and the `marked` typings already on disk
([node_modules/marked/lib/marked.d.ts](../../../../node_modules/marked/lib/marked.d.ts)).
No code is touched in this document.

## 1. Design summary

Replace the 29-line regex pipeline at
[web/src/utils/markdown.ts#L1-L29](../../../../web/src/utils/markdown.ts#L1-L29)
with `marked`-as-parser + `DOMPurify`-as-sanitizer, both as direct
`web/` runtime deps. Pipeline:
`text → marked.parse(text, { async: false }) → DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }) → v-html`.
GFM tables, breaks, and the other §3 gap list
([01-analysis-r3.md#§3](01-analysis-r3.md)) are configured once at
module scope via `marked.use({ gfm: true, breaks: true, async: false })`
— flags declared in
[node_modules/marked/lib/marked.d.ts#L441](../../../../node_modules/marked/lib/marked.d.ts#L441)
(`async?`),
[L445](../../../../node_modules/marked/lib/marked.d.ts#L445) (`breaks?`),
[L453](../../../../node_modules/marked/lib/marked.d.ts#L453) (`gfm?`).
Synchronous overload returning `string` is the `async: false` branch at
[node_modules/marked/lib/marked.d.ts#L623-L635](../../../../node_modules/marked/lib/marked.d.ts#L623-L635)
and the top-level
[L676-L683](../../../../node_modules/marked/lib/marked.d.ts#L676-L683).
Custom class names `md-h1/h2/h3`, `md-code`, `md-code-block`,
`md-bullet`, `md-marker`, `md-bullet-text` are deleted from both
consumers; new CSS targets native tags `marked` emits (`:deep(table)`,
`:deep(h1)`, `:deep(ul)`, etc.). The exported function signature
`renderMarkdown(text: string): string`
([web/src/utils/markdown.ts#L1](../../../../web/src/utils/markdown.ts#L1))
is preserved so the two call sites at
[web/src/components/ChatWindow.vue#L314](../../../../web/src/components/ChatWindow.vue#L314)
and
[web/src/components/FormattedContent.vue#L38](../../../../web/src/components/FormattedContent.vue#L38)
do not change.

## 2. New module — `web/src/utils/markdown.ts`

Complete replacement file body (TypeScript, ESM). Replaces the existing
[web/src/utils/markdown.ts#L1-L29](../../../../web/src/utils/markdown.ts#L1-L29)
verbatim — no fallback, no migration shim
([01-analysis-r3.md#§8b](01-analysis-r3.md),
[02-proposals-r2.md#D-where-the-new-code-lives](02-proposals-r2.md)).

```ts
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.use({ gfm: true, breaks: true, async: false });

export function renderMarkdown(text: string): string {
  if (!text || !text.trim()) return "";
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
```

Notes (each grounded in source):

- `marked.use` configures the singleton at module scope; the call shape
  is the `use(...)` method exposed on the exported `marked` namespace
  ([node_modules/marked/lib/marked.d.ts#L713](../../../../node_modules/marked/lib/marked.d.ts#L713)).
  Single side effect on import, per project rule of no defensive shims.
- `marked.parse(text, { async: false })` selects the synchronous string
  overload at
  [node_modules/marked/lib/marked.d.ts#L676-L683](../../../../node_modules/marked/lib/marked.d.ts#L676-L683)
  (top-level `marked` namespace also exposes `parse` — see
  `var setOptions` / `var use` block at
  [L710-L716](../../../../node_modules/marked/lib/marked.d.ts#L710-L716)).
  The `as string` cast pins the return type because the generic
  overload at
  [L685-L687](../../../../node_modules/marked/lib/marked.d.ts#L685-L687)
  widens to `string | Promise<string>`.
- `DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })` is the
  hardening pass mandated by
  [02-proposals-r2.md#D-dompurify-hardening-note](02-proposals-r2.md)
  and
  [01-analysis-r3.md#§9 OQ2](01-analysis-r3.md). `marked` itself does
  not sanitize
  ([node_modules/marked/README.md#L53-L56](../../../../node_modules/marked/README.md#L53-L56)).
- Empty / whitespace-only input returns `""` before invoking either
  library — matches today's effective behaviour for empty assistant
  messages without paying the parse cost.
- No `try`/`catch`. Per project rule (no defensive shims), if `marked`
  or `DOMPurify` throws on malformed input, the exception bubbles to
  the Vue render and is visible in the operator console, where it can
  be diagnosed instead of swallowed.

## 3. CSS changes per consumer

Both stylesheets keep the same wrapper layout, drop the `:deep(.md-*)`
hand-rolled class hooks, and add new `:deep(...)` rules targeting the
native tags `marked` emits — same approach for both, parallel
selectors. Consumer-side deletion is atomic in the same commit per
[01-analysis-r3.md#§8b](01-analysis-r3.md) and
[02-proposals-r2.md#D-what-gets-deleted](02-proposals-r2.md).

### 3a. `web/src/components/FormattedContent.vue`

**DELETE** (lines cited from current file; analysis citation
[01-analysis-r3.md#§2, §3](01-analysis-r3.md);
[02-proposals-r2.md#D-what-gets-deleted](02-proposals-r2.md)):

- `:deep(.md-h1)`, `:deep(.md-h2)`, `:deep(.md-h3)` —
  [web/src/components/FormattedContent.vue#L91-L93](../../../../web/src/components/FormattedContent.vue#L91-L93).
- `:deep(.md-code)` —
  [web/src/components/FormattedContent.vue#L94](../../../../web/src/components/FormattedContent.vue#L94).
- `:deep(.md-code-block)` and `:deep(.md-code-block code)` —
  [web/src/components/FormattedContent.vue#L95-L96](../../../../web/src/components/FormattedContent.vue#L95-L96).
- `:deep(.md-bullet)` grid rule —
  [web/src/components/FormattedContent.vue#L97-L103](../../../../web/src/components/FormattedContent.vue#L97-L103).
- `:deep(.md-marker)` —
  [web/src/components/FormattedContent.vue#L104-L109](../../../../web/src/components/FormattedContent.vue#L104-L109).
- `:deep(.md-bullet-text)` —
  [web/src/components/FormattedContent.vue#L110](../../../../web/src/components/FormattedContent.vue#L110).

**KEEP, but mutate one declaration**:

- `.formatted-text` block —
  [web/src/components/FormattedContent.vue#L83-L87](../../../../web/src/components/FormattedContent.vue#L83-L87).
  Change `white-space: pre-wrap;`
  ([L84](../../../../web/src/components/FormattedContent.vue#L84)) →
  `white-space: normal;`. Rationale: `marked` with `breaks: true`
  ([node_modules/marked/lib/marked.d.ts#L445](../../../../node_modules/marked/lib/marked.d.ts#L445))
  emits real `<br>` for single `\n` and `<p>` for paragraph breaks, so
  visual line-break behaviour is preserved without `pre-wrap`, and
  `<table>` cells no longer inherit the pre-wrap regression flagged in
  [01-analysis-r3.md#§4](01-analysis-r3.md) ("Future `<table>` injection
  would conflict with this CSS") and
  [02-proposals-r2.md#D-new-css-to-add](02-proposals-r2.md). **Nuance**:
  inside list items, blank-line-separated paragraphs become real nested
  `<p>` blocks (e.g. `- a\n\n  b` → `<li><p>a</p><p>b</p></li>`); this
  is Markdown-correct and must not be treated as a visual regression.
- `.formatted-text :deep(strong)` and `.formatted-text :deep(em)` —
  [web/src/components/FormattedContent.vue#L89-L90](../../../../web/src/components/FormattedContent.vue#L89-L90).
  Still useful because `marked` emits `<strong>` and `<em>`.

**ADD** (paste-ready scoped block, replacing the deleted `:deep(.md-*)`
rules at
[L91-L110](../../../../web/src/components/FormattedContent.vue#L91-L110);
all selectors target native tags that `marked` emits;
font-size/spacing values for `h1`/`h2`/`h3` carry over from the old
`md-h1`/`md-h2`/`md-h3` rules at
[L91-L93](../../../../web/src/components/FormattedContent.vue#L91-L93)):

```css
.formatted-text :deep(h1) { display: block; font-size: 16px; margin: 8px 0 4px; }
.formatted-text :deep(h2) { display: block; font-size: 14px; margin: 6px 0 3px; }
.formatted-text :deep(h3) { display: block; font-size: 13px; margin: 4px 0 2px; }
.formatted-text :deep(code) { background: var(--code-bg); color: var(--code-color); padding: 1px 5px; border-radius: 3px; font-family: monospace; font-size: 12px; }
.formatted-text :deep(pre) { background: var(--code-block-bg); border: 1px solid var(--code-block-border); padding: 10px 12px; border-radius: 6px; margin: 6px 0; overflow-x: auto; font-size: 12px; line-height: 1.5; }
.formatted-text :deep(pre code) { font-family: monospace; color: var(--code-block-text); background: transparent; padding: 0; }
.formatted-text :deep(ul), .formatted-text :deep(ol) { padding-left: 1.2em; margin: 4px 0; }
.formatted-text :deep(li) { line-height: 1.4; }
.formatted-text :deep(blockquote) { border-left: 3px solid var(--border, #444); padding-left: 10px; margin: 6px 0; color: var(--text-muted); }
.formatted-text :deep(a) { color: var(--link, #6cf); text-decoration: underline; }
.formatted-text :deep(hr) { border: 0; border-top: 1px solid var(--border, #444); margin: 8px 0; }
.formatted-text :deep(table) { border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.formatted-text :deep(th), .formatted-text :deep(td) { border: 1px solid var(--border, #444); padding: 4px 8px; text-align: left; }
.formatted-text :deep(th) { background: var(--bg-strong, rgba(255,255,255,0.05)); font-weight: 600; }
.formatted-text :deep(th[align="right"]), .formatted-text :deep(td[align="right"]) { text-align: right; }
.formatted-text :deep(th[align="center"]), .formatted-text :deep(td[align="center"]) { text-align: center; }
```

`align="..."` attribute targeting mirrors `marked`'s emission for GFM
alignment markers (`:---`, `---:`, `:---:`) — confirmed by the
behavioural contract documented in
[02-proposals-r2.md#D-required-css](02-proposals-r2.md) and asserted in
the new test §5 below.

### 3b. `web/src/components/ChatWindow.vue`

Same delete/keep/add structure, prefixed by the
`.msg.assistant .msg-content` scope used throughout the existing block.

**DELETE** (cited from current file):

- `.msg.assistant .msg-content :deep(.md-h1|h2|h3)` —
  [web/src/components/ChatWindow.vue#L535-L537](../../../../web/src/components/ChatWindow.vue#L535-L537).
- `.msg.assistant .msg-content :deep(.md-code)` —
  [web/src/components/ChatWindow.vue#L538](../../../../web/src/components/ChatWindow.vue#L538).
- `.msg.assistant .msg-content :deep(.md-code-block)` and
  `:deep(.md-code-block code)` —
  [web/src/components/ChatWindow.vue#L539-L540](../../../../web/src/components/ChatWindow.vue#L539-L540).
- `.msg.assistant .msg-content :deep(.md-bullet)` grid block —
  [web/src/components/ChatWindow.vue#L541-L547](../../../../web/src/components/ChatWindow.vue#L541-L547).
- `:deep(.md-marker)` —
  [web/src/components/ChatWindow.vue#L548-L553](../../../../web/src/components/ChatWindow.vue#L548-L553).
- `:deep(.md-bullet-text)` —
  [web/src/components/ChatWindow.vue#L554](../../../../web/src/components/ChatWindow.vue#L554).

**KEEP, but mutate one declaration**:

- `.msg-content` wrapper block —
  [web/src/components/ChatWindow.vue#L486-L497](../../../../web/src/components/ChatWindow.vue#L486-L497).
  Change `white-space: pre-wrap;`
  ([L494](../../../../web/src/components/ChatWindow.vue#L494)) →
  `white-space: normal;`. Same rationale as
  `FormattedContent.vue` above
  ([01-analysis-r3.md#§4](01-analysis-r3.md),
  [02-proposals-r2.md#D-new-css-to-add](02-proposals-r2.md)). The user
  / system branches at
  [web/src/components/ChatWindow.vue#L498-L508](../../../../web/src/components/ChatWindow.vue#L498-L508)
  inherit from `.msg-content` but render `{{ msg.content }}` directly
  ([web/src/components/ChatWindow.vue#L315](../../../../web/src/components/ChatWindow.vue#L315)),
  not via `renderMarkdown` — so the `normal` whitespace mode is
  consistent with the §8 risk acceptance.
- `.msg.assistant .msg-content :deep(strong)` and `:deep(em)` —
  [web/src/components/ChatWindow.vue#L533-L534](../../../../web/src/components/ChatWindow.vue#L533-L534).
  Kept (native tags emitted by `marked`).

**ADD** (paste-ready, scoped to `.msg.assistant .msg-content`,
replacing the deleted `:deep(.md-*)` rules at
[L535-L554](../../../../web/src/components/ChatWindow.vue#L535-L554);
chat uses `var(--mono)` for monospace to match the rest of the file —
see existing `font-family: var(--mono)` at
[web/src/components/ChatWindow.vue#L540](../../../../web/src/components/ChatWindow.vue#L540)):

```css
.msg.assistant .msg-content :deep(h1) { display: block; font-size: 16px; margin: 8px 0 4px; }
.msg.assistant .msg-content :deep(h2) { display: block; font-size: 14px; margin: 6px 0 3px; }
.msg.assistant .msg-content :deep(h3) { display: block; font-size: 13px; margin: 4px 0 2px; }
.msg.assistant .msg-content :deep(code) { background: var(--code-bg); color: var(--code-color); padding: 1px 5px; border-radius: 3px; font-family: var(--mono); font-size: 12px; }
.msg.assistant .msg-content :deep(pre) { background: var(--code-block-bg); border: 1px solid var(--code-block-border); padding: 10px 12px; border-radius: 6px; margin: 6px 0; overflow-x: auto; font-size: 12px; line-height: 1.5; }
.msg.assistant .msg-content :deep(pre code) { font-family: var(--mono); color: var(--code-block-text); background: transparent; padding: 0; }
.msg.assistant .msg-content :deep(ul), .msg.assistant .msg-content :deep(ol) { padding-left: 1.2em; margin: 4px 0; }
.msg.assistant .msg-content :deep(li) { line-height: 1.4; }
.msg.assistant .msg-content :deep(blockquote) { border-left: 3px solid var(--border, #444); padding-left: 10px; margin: 6px 0; color: var(--text-muted); }
.msg.assistant .msg-content :deep(a) { color: var(--link, #6cf); text-decoration: underline; }
.msg.assistant .msg-content :deep(hr) { border: 0; border-top: 1px solid var(--border, #444); margin: 8px 0; }
.msg.assistant .msg-content :deep(table) { border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.msg.assistant .msg-content :deep(th), .msg.assistant .msg-content :deep(td) { border: 1px solid var(--border, #444); padding: 4px 8px; text-align: left; }
.msg.assistant .msg-content :deep(th) { background: var(--bg-strong, rgba(255,255,255,0.05)); font-weight: 600; }
.msg.assistant .msg-content :deep(th[align="right"]), .msg.assistant .msg-content :deep(td[align="right"]) { text-align: right; }
.msg.assistant .msg-content :deep(th[align="center"]), .msg.assistant .msg-content :deep(td[align="center"]) { text-align: center; }
```

## 4. Package.json updates

### `web/package.json`

Current declared runtime deps at
[web/package.json#L12-L16](../../../../web/package.json#L12-L16):
`lucide-vue-next`, `vue`, `zod`. Add two entries (versions chosen to
match the already-present lockfile resolutions cited in
[01-analysis-r3.md#§7](01-analysis-r3.md):
`marked@16.4.2`,
`dompurify@3.4.5`):

```json
"dependencies": {
  "dompurify": "^3.4.5",
  "lucide-vue-next": "^1.0.0",
  "marked": "^16.4.2",
  "vue": "^3.5.0",
  "zod": "^3.25.76"
}
```

`web/package-lock.json` will be regenerated by `npm install` inside
`web/` (validation gate §6 step 1). DOMPurify v3 ships its own ESM
types — `node_modules/dompurify/package.json` declares
`exports["."].import.types = "./dist/purify.es.d.mts"` — so
`@types/dompurify` is NOT installed under any condition. If `vue-tsc`
fails to resolve `DOMPurify` after `npm install`, diagnose module
resolution / install state instead of adding a stale DefinitelyTyped
package.

### Root `package.json`

**No change.** `marked@16.4.2` and `dompurify@3.4.5` are already present
in the root lockfile via the `mermaid → marked` and `mermaid → dompurify`
docs-only paths
([01-analysis-r3.md#§7](01-analysis-r3.md);
[package-lock.json#L8098-L8109](../../../../package-lock.json#L8098-L8109),
[L6051-L6058](../../../../package-lock.json#L6051-L6058)). The `web/`
declaration is independent and does not require touching root
`package.json` or root `package-lock.json`.

## 5. Tests — `web/src/utils/markdown.test.ts` (new file)

No markdown coverage exists today
([01-analysis-r3.md#§6](01-analysis-r3.md): "no file under `web/`
references `renderMarkdown`, `markdown.ts`, `FormattedContent.vue`, or
`ChatWindow.vue` from a `*.test.ts`"). Tests are picked up by the root
vitest config, which already includes `web/src/**/*.test.ts` and runs
with `happy-dom`
([01-analysis-r3.md#§6](01-analysis-r3.md): `test.include = ["src/**/*.test.ts", "tests/**/*.test.ts", "web/src/**/*.test.ts"]`,
`happy-dom` at root
[package.json#L59](../../../../package.json#L59), `vitest@^4.1.7` at
[package.json#L70](../../../../package.json#L70)). No new test
infrastructure is required.

File body:

```ts
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("renders a GFM table with header and body", () => {
    const html = renderMarkdown("| h1 | h2 |\n|---|---|\n| a | b |");
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>h1</th>");
    expect(html).toContain("<tbody>");
    expect(html).toContain("<td>a</td>");
  });

  it("respects column alignment markers", () => {
    const html = renderMarkdown("| L | R | C |\n|:---|---:|:---:|\n| a | b | c |");
    expect(html).toContain('align="left"');
    expect(html).toContain('align="right"');
    expect(html).toContain('align="center"');
  });

  it("renders bold and italics correctly", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("*it*")).toContain("<em>it</em>");
  });

  it("renders inline code and fenced code", () => {
    expect(renderMarkdown("`x`")).toContain("<code>x</code>");
    expect(renderMarkdown("```\nblock\n```")).toContain("<pre>");
  });

  it("renders headings as native h1/h2/h3", () => {
    expect(renderMarkdown("# H")).toContain("<h1");
    expect(renderMarkdown("### H3")).toContain("<h3");
  });

  it("renders bullet and ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toContain("<ul>");
    expect(renderMarkdown("1. a\n2. b")).toContain("<ol>");
  });

  it("sanitizes inline script tags", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nhello');
    expect(html).not.toContain("<script");
    expect(html).toContain("hello");
  });

  it("sanitizes javascript: hrefs", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("renders strikethrough via GFM", () => {
    expect(renderMarkdown("~~strike~~")).toContain("<del>strike</del>");
  });

  it("renders task-list checkboxes via GFM", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo");
    expect(html).toContain('type="checkbox"');
  });

  it("converts hard line breaks via breaks:true", () => {
    expect(renderMarkdown("a\nb")).toContain("<br");
  });

  it("renders blockquote", () => {
    expect(renderMarkdown("> quoted")).toContain("<blockquote>");
  });

  it("renders horizontal rule", () => {
    expect(renderMarkdown("---")).toContain("<hr");
  });
});
```

The strikethrough (`<del>`) and task-list (`type="checkbox"`)
assertions are derived from `marked`'s documented GFM emission (see
the GFM enablement flag at
[node_modules/marked/lib/marked.d.ts#L453](../../../../node_modules/marked/lib/marked.d.ts#L453)
and `marked`'s README on GFM behaviour); if either assertion fails on
the installed `marked@16.4.2`, the implementer should reduce the
assertion to a weaker shape (`/<del/`, `/<input[^>]*checkbox/i`) before
weakening any other test — those two are the only test cases marked as
"verify by probing" by the writer. All other assertions match shapes
already exercised in `marked`'s public test suite.

## 6. Validation gate (commands run from `/home/salva/g/ml/saivage`)

Run in order; stop at the first failing step and diagnose before
continuing.

1. `cd web && npm install --save marked@^16.4.2 dompurify@^3.4.5 && cd ..`
   — adds the two runtime deps to
   [web/package.json](../../../../web/package.json) and regenerates
   `web/package-lock.json`.
2. `cd web && npx vue-tsc --noEmit -p tsconfig.json && cd ..` —
   ts-check resolves DOMPurify types from the package's own
   `purify.es.d.mts`. If this step fails to resolve `dompurify`,
   diagnose `node_modules` / `package-lock.json` state; do NOT install
   `@types/dompurify`.
3. `npm test` (root) — Jest backend suite (root
   [package.json#L17](../../../../package.json#L17): `"test": "vitest run"`;
   if a separate Jest backend script exists it runs the backend suite).
   Must still pass — no backend changes are made.
4. `npx vitest run web/src/utils/markdown.test.ts` — runs the new test
   file under the root vitest config
   ([01-analysis-r3.md#§6](01-analysis-r3.md)). All 14 cases must pass.
5. `npm run web:test:sweep` — root web test sweep. The four existing
   web tests listed in
   [01-analysis-r3.md#§6](01-analysis-r3.md)
   ([web/src/components/agents/round-id.test.ts](../../../../web/src/components/agents/round-id.test.ts),
   [web/src/components/agents/timeline.test.ts](../../../../web/src/components/agents/timeline.test.ts),
   [web/src/composables/useAuthState.test.ts](../../../../web/src/composables/useAuthState.test.ts),
   [web/src/composables/useWebSocket.test.ts](../../../../web/src/composables/useWebSocket.test.ts))
   must continue to pass.
6. `npm run build` (root) — root build must succeed.
7. `cd web && npm run typecheck && npm run build && cd ..` — web
   typecheck (`vue-tsc --noEmit -p tsconfig.json`,
   [web/package.json#L9](../../../../web/package.json#L9)) and web build
   (`vue-tsc --noEmit -p tsconfig.json && vite build`,
   [web/package.json#L8](../../../../web/package.json#L8)) must succeed.
8. Manual visual check: start the dev server, open the chat panel with
   an assistant message containing a GFM table, a bulleted list, an
   inline link, and a fenced code block; visually confirm each renders
   correctly in both `ChatWindow.vue` (chat panel) and
   `FormattedContent.vue` (a `FilesView` markdown preview at
   [web/src/components/FilesView.vue#L393](../../../../web/src/components/FilesView.vue#L393)
   or a `DebugView` skill/memory body at
   [web/src/components/DebugView.vue#L359](../../../../web/src/components/DebugView.vue#L359)).

## 7. Implementation order (single linear sequence)

1. Edit
   [web/package.json](../../../../web/package.json#L12-L16) to add
   `marked` and `dompurify` per §4; run `cd web && npm install` to
   regenerate `web/package-lock.json`.
2. Rewrite
   [web/src/utils/markdown.ts](../../../../web/src/utils/markdown.ts#L1-L29)
   from scratch with the body in §2. The exported `renderMarkdown`
   signature stays identical so the two import sites
   ([web/src/components/ChatWindow.vue#L6](../../../../web/src/components/ChatWindow.vue#L6),
   [web/src/components/FormattedContent.vue#L4](../../../../web/src/components/FormattedContent.vue#L4))
   do not change.
3. Edit
   [web/src/components/FormattedContent.vue](../../../../web/src/components/FormattedContent.vue):
   delete the `:deep(.md-*)` rules at
   [L91-L110](../../../../web/src/components/FormattedContent.vue#L91-L110),
   change `white-space: pre-wrap` → `normal` at
   [L84](../../../../web/src/components/FormattedContent.vue#L84), and
   insert the new `:deep(...)` block from §3a. No template change.
4. Edit
   [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue):
   delete the `:deep(.md-*)` rules at
   [L535-L554](../../../../web/src/components/ChatWindow.vue#L535-L554),
   change `white-space: pre-wrap` → `normal` at
   [L494](../../../../web/src/components/ChatWindow.vue#L494), and
   insert the new `:deep(...)` block from §3b. No template change —
   role gating at
   [L314-L315](../../../../web/src/components/ChatWindow.vue#L314-L315)
   stays intact.
5. Create
   [web/src/utils/markdown.test.ts](../../../../web/src/utils/markdown.test.ts)
   with the body in §5.
6. Post-edit guard: run `rg -n 'md-' web` from
   `/home/salva/g/ml/saivage`. The command must produce no output;
   any hit means a stale `.md-*` class reference survived the rewrite
   and must be removed before continuing.
7. Run validation gate §6 steps 1–7 in order; on first failure, stop
   and diagnose.
8. Single commit on `master` (no feature branch — workspace policy
   forbids backward-compat staging):
   `feat(web): replace hand-rolled markdown with marked+DOMPurify; add GFM table support`.

## 8. Risks & explicit non-goals

### Risks (with mitigations)

- **`pre-wrap → normal` may change line-wrap behaviour of plain text
  without explicit newlines.** Mitigation: `marked` with
  `breaks: true`
  ([node_modules/marked/lib/marked.d.ts#L445](../../../../node_modules/marked/lib/marked.d.ts#L445))
  converts every single `\n` to `<br>` and paragraph-grouped lines to
  `<p>`, so the visual line-break behaviour the renderer used to get
  from `pre-wrap` is preserved structurally.
- **Assistant content that previously relied on `pre-wrap` to display
  raw multi-line tool output may be re-flowed.** Acceptance: this is
  correct behaviour — JSON-shaped tool output is already routed through
  [web/src/components/JsonHighlight.vue](../../../../web/src/components/JsonHighlight.vue)
  via the JSON branch of `FormattedContent.vue`
  ([L13-L34](../../../../web/src/components/FormattedContent.vue#L13-L34),
  [L68-L74](../../../../web/src/components/FormattedContent.vue#L68-L74)),
  and free-form assistant prose was never `pre`-formatted by design.
  Confirmed in
  [02-proposals-r2.md#D-new-css-to-add](02-proposals-r2.md) ("keep +
  override in table subtree" was Proposal B's r2 OQ3 answer; this
  design supersedes it with the `normal` choice on the wrapper because
  `breaks: true` plus native `<p>`/`<br>` removes the original reason
  for `pre-wrap`).
- **Bundle size grows by ~55 KB pre-gzip** (estimate per
  [02-proposals-r2.md#D-bundle-impact](02-proposals-r2.md)). Acceptance:
  internal operator UI with no public concurrency target; the cost is
  documented and acceptable per
  [02-proposals-r2.md#F](02-proposals-r2.md) recommendation point 5.

### Non-goals (carry forward to implementation)

- Footnote rendering — out of scope per
  [02-proposals-r2.md#G](02-proposals-r2.md).
- KaTeX / Mermaid in chat messages — out of scope per
  [02-proposals-r2.md#G](02-proposals-r2.md).
- Syntax highlighting beyond `marked`'s default `<pre><code>` emission
  (no highlight.js / Shiki / Prism) — out of scope per
  [02-proposals-r2.md#G](02-proposals-r2.md).
- Changing the JSON branch in `FormattedContent.vue`
  ([L13-L34](../../../../web/src/components/FormattedContent.vue#L13-L34))
  — out of scope per
  [02-proposals-r2.md#G](02-proposals-r2.md).
- Backend `telegramify-markdown` or VitePress docs site — out of scope
  per [02-proposals-r2.md#G](02-proposals-r2.md).

## 9. Out-of-scope guardrails (verbatim from `02-proposals-r2.md` §G)

Reproduced verbatim from
[02-proposals-r2.md#G](02-proposals-r2.md). The implementer must not
touch:

- **User and system chat messages remain non-markdown.**
  `renderMarkdown` continues to apply **only** to assistant messages —
  cite the role branch at
  [web/src/components/ChatWindow.vue#L314](../../../../web/src/components/ChatWindow.vue#L314)
  (`v-if="msg.role === 'assistant'"` selects
  `v-html="renderMarkdown(...)"`; the `v-else` branch on the next line
  keeps `{{ msg.content }}` as plain text). This proposal does not
  change that role gating.
- **No changes to chat history storage, WebSocket transport payloads,
  or backend agent output formatting.** Markdown rendering is a
  presentation concern owned entirely by the `web/` client; the wire
  format and on-disk shapes of agent messages are left untouched.
- **Footnote rendering** (per review item 4). Default `marked@16.4.2`
  with `{ gfm: true, breaks: true }` does **not** render Pandoc-style
  footnotes (`[^1]` references + `[^1]: …` definitions); they pass
  through as literal text. This is deliberately out of scope. If
  footnote rendering becomes required, it must be added in a separate
  proposal via a vetted maintained `marked` extension (with license and
  advisory-tracking review), not bolted onto this F01 implementation.
- **DOMPurify profile / URL-scheme allowlist broadening** (per review
  item 5). Implementation must not introduce custom `ADD_TAGS`,
  `ADD_ATTR`, `ALLOWED_URI_REGEXP` relaxations, or non-default protocol
  allowances; the sanitizer call is pinned to
  `USE_PROFILES: { html: true }`. Default DOMPurify already permits
  `table` / `thead` / `tbody` / `tr` / `th` / `td` plus the `align`
  attribute that `marked` emits for aligned tables, so the default
  profile is sufficient. Any future profile relaxation requires a
  separate security review under `SPEC/.../sanitizer-policy/`.
- **Image handling beyond `marked`'s default sanitized `<img>`
  rendering.** No lazy-loading attributes, no width/height constraints,
  no domain allowlist on `src`, no thumbnail proxying. `marked` emits a
  plain `<img>`; DOMPurify strips `on*` handlers and non-allowed
  schemes via the default html profile. Anything beyond that (e.g.
  CSP-aware image loading, hot-link prevention, lazy decode) is a
  separate concern.

STATUS: READY_FOR_REVIEW
