# F01 — Markdown Table Rendering — Design + Plan Review r1

Reviewed `/home/salva/g/ml/saivage/SPEC/2026-05/markdown-table-rendering/F01-markdown-tables/03-design-plan-r1.md` against the current `/home/salva/g/ml/saivage` source tree and installed packages. I did not modify source code or the plan file.

## Findings

### 1. Proposed module body is valid for the web/Vite runtime

The proposed `web/src/utils/markdown.ts` body is syntactically valid TypeScript ESM:

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

`marked.use({ gfm, breaks, async })` is accepted by `MarkedExtension`: `async` is declared in `node_modules/marked/lib/marked.d.ts:441`, `breaks` at `:445`, and `gfm` at `:453`.

`marked.parse` is the right sync API. The instance `parse` overload has the `async: false` branch returning `ParserOutput` at `node_modules/marked/lib/marked.d.ts:625-627`; the exported `marked(...)` overload has the `async: false` branch returning `string` at `:688-690`; and `marked.parse` is aliased to `typeof marked` at `:719`. Runtime probe confirmed `typeof marked.parse === "function"` and `marked.parse === marked` for installed `marked@16.4.2`.

DOMPurify default import is correct for browser/Vite. `dompurify@3.4.5` is installed in the root lock at `package-lock.json:6051-6058` and ships its own ESM types: `node_modules/dompurify/package.json` declares `exports["."].import.types = "./dist/purify.es.d.mts"`; that type file declares the default export at `node_modules/dompurify/dist/purify.es.d.mts:215` and `sanitize(...)` returning `string` at `:293`.

Important runtime wrinkle: in plain Node without `window`, `import DOMPurify from "dompurify"` returns a factory with no `.sanitize` because `src/purify.ts:132-142` returns early for non-browser environments. In a browser-like DOM, `sanitize` is attached at `src/purify.ts:1710` and `export default createDOMPurify()` is at `src/purify.ts:1957`. A `happy-dom` probe produced `shape function function true`, stripped `href="javascript:..."`, and preserved table/align markup. This is fine for Vite/browser and root Vitest `happy-dom`, but implementers should not validate this module with plain `node`.

### 2. CSS line citations are currently wrong

The plan's cited delete ranges for the `:deep(.md-*)` blocks are off in both Vue files. The requested verification command produced the current truth:

```text
web/src/components/FormattedContent.vue:91:.formatted-text :deep(.md-h1) ...
web/src/components/FormattedContent.vue:92:.formatted-text :deep(.md-h2) ...
web/src/components/FormattedContent.vue:93:.formatted-text :deep(.md-h3) ...
web/src/components/FormattedContent.vue:94:.formatted-text :deep(.md-code) ...
web/src/components/FormattedContent.vue:95:.formatted-text :deep(.md-code-block) ...
web/src/components/FormattedContent.vue:96:.formatted-text :deep(.md-code-block code) ...
web/src/components/FormattedContent.vue:97:.formatted-text :deep(.md-bullet) {
web/src/components/FormattedContent.vue:104:.formatted-text :deep(.md-marker) {
web/src/components/FormattedContent.vue:110:.formatted-text :deep(.md-bullet-text) ...

web/src/components/ChatWindow.vue:535:.msg.assistant .msg-content :deep(.md-h1) ...
web/src/components/ChatWindow.vue:536:.msg.assistant .msg-content :deep(.md-h2) ...
web/src/components/ChatWindow.vue:537:.msg.assistant .msg-content :deep(.md-h3) ...
web/src/components/ChatWindow.vue:538:.msg.assistant .msg-content :deep(.md-code) ...
web/src/components/ChatWindow.vue:539:.msg.assistant .msg-content :deep(.md-code-block) ...
web/src/components/ChatWindow.vue:540:.msg.assistant .msg-content :deep(.md-code-block code) ...
web/src/components/ChatWindow.vue:541:.msg.assistant .msg-content :deep(.md-bullet) {
web/src/components/ChatWindow.vue:548:.msg.assistant .msg-content :deep(.md-marker) {
web/src/components/ChatWindow.vue:554:.msg.assistant .msg-content :deep(.md-bullet-text) ...
```

So `FormattedContent.vue` should cite `91-110`, not `93-112`; `ChatWindow.vue` should cite `535-554`, not `538-557`. The white-space declarations remain where the plan says: `FormattedContent.vue:84` and `ChatWindow.vue:495`.

### 3. `white-space: normal` rationale is mostly correct, with one useful nuance

`marked` with `breaks: true` preserves single source newlines structurally. Probe results:

```html
marked.parse("a\nb") => <p>a<br>b</p>
marked.parse("- a\n  b") => <ul><li>a<br>b</li></ul>
marked.parse("- a\n\n  b") => <ul><li><p>a</p><p>b</p></li></ul>
```

So the plan is correct that ordinary single-newline visual breaks no longer need inherited `white-space: pre-wrap`. The wrinkle is only paragraph breaks inside list items: they become real nested `<p>` blocks, not pre-wrapped text. That is Markdown-correct and should be accepted, but the plan should mention it so visual review does not treat it as a regression.

### 4. Proposed tests are mostly valid for `marked@16.4.2`

Probe with installed `marked@16.4.2`, `marked.use({ gfm: true, breaks: true, async: false })`:

- GFM table emits bare `<table>` with no class.
- Header emits `<th>h1</th>` exactly, not `<th>h1\n</th>`.
- Aligned tables emit `align="left"`, `align="center"`, and `align="right"` on both headers and body cells.
- `**bold**` emits `<strong>bold</strong>` inside a paragraph.
- `~~strike~~` emits `<del>strike</del>` with `gfm: true`.
- `a\nb` emits `<p>a<br>b</p>` with `breaks: true`.
- DOMPurify default HTML profile strips the `javascript:` href: probe output for `<a href="javascript:alert(1)">x</a>` was `<a>x</a>`.

The task-list checkbox should not be asserted as the literal string `<input type="checkbox" checked disabled>`. Installed marked emits:

```html
<li><input checked="" disabled="" type="checkbox"> done</li>
```

The plan's current test only checks `type="checkbox"`, so that specific `expect(...).toContain(...)` is valid. If the test is expanded to check checked/disabled, use a DOM parse or regex that does not depend on attribute order or boolean-attribute serialization.

### 5. Validation gate step 2 should drop `@types/dompurify`

`@types/dompurify` is not needed for `dompurify@3.4.5`. The installed package bundles types in `dist/purify.cjs.d.ts` / `dist/purify.es.d.mts`; the ESM default export and `sanitize` overload are present in the package types as noted above.

The plan currently says to install `@types/dompurify@^3` conditionally if `vue-tsc` cannot resolve types. That fallback should be removed. If type resolution fails after adding the runtime dependency to `web/package.json`, the right action is to diagnose module resolution / package-lock / install state, not to add a stale DefinitelyTyped package.

### 6. Dependency and implementation order is close, but should add one post-edit grep

`web/package.json:12-16` currently declares only `lucide-vue-next`, `vue`, and `zod`; `web/package-lock.json` currently has no `marked`, `dompurify`, or `@types/dompurify` entries. The plan correctly adds `marked` and `dompurify` as direct `web/` runtime deps and regenerates `web/package-lock.json`. Root `package-lock.json` already contains `dompurify@3.4.5` and `marked@16.4.2` as dev/transitive entries via the docs/mermaid path, but that does not make them direct web deps.

`rg -n 'md-' web` currently finds only the old hand-rolled pipeline and the two component CSS blocks:

- `web/src/utils/markdown.ts:8,11-14,21,25`
- `web/src/components/FormattedContent.vue:91-110`
- `web/src/components/ChatWindow.vue:535-554`

Because the plan rewrites `markdown.ts` and replaces both CSS blocks, it removes the legacy pipeline and does not sneak in a compat shim. Add a validation check after edits: `rg -n 'md-' web` should produce no output.

### 7. Snapshot risk under `web/` is low

`rg -n 'toMatchSnapshot|toMatchInlineSnapshot' web` produced no output. There are no web snapshot tests currently snapshotting HTML from `renderMarkdown` callers.

### 8. DOMPurify HTML profile is sufficient for tables and alignment

`USE_PROFILES: { html: true }` is enough for the table output proposed here. DOMPurify applies the HTML profile by adding `TAGS.html` and `ATTRS.html` at `node_modules/dompurify/src/purify.ts:659-661`. The HTML tag list includes `table`, `tbody`, `td`, `tfoot`, `th`, `thead`, and `tr` at `node_modules/dompurify/src/tags.ts:106-115`; the HTML attribute list includes `align` at `node_modules/dompurify/src/attrs.ts:6`. A browser-like probe preserved table tags and `align="right"` / `align="center"`.

### 9. Project rule compliance

The plan complies with the workspace architecture rule. It replaces the entire old regex renderer in `web/src/utils/markdown.ts`, deletes old `.md-*` hooks in the two consumers, and does not preserve a fallback compatibility shim. That is the right direction for this workspace.

## Required fixes before implementation

1. Correct the CSS citation ranges and delete targets in the plan: `FormattedContent.vue` old `.md-*` rules are `91-110`; `ChatWindow.vue` old `.md-*` rules are `535-554`. Keep the white-space mutation references at `FormattedContent.vue:84` and `ChatWindow.vue:495`.

2. Remove the conditional `@types/dompurify@^3` fallback from validation gate step 2. `dompurify@3.4.5` bundles types; if `vue-tsc` cannot resolve them, diagnose the dependency install/module-resolution state instead of adding DefinitelyTyped scaffolding.

3. Tighten the test notes for task-list checkboxes: do not assert the exact literal `<input type="checkbox" checked disabled>`. Installed `marked@16.4.2` emits `checked="" disabled="" type="checkbox"`; use DOM assertions or order-insensitive regexes for `checked`, `disabled`, and `type="checkbox"`.

4. Add a post-edit validation check: `rg -n 'md-' web` should produce no output after replacing `markdown.ts` and the two CSS blocks. Current matches are only in `web/src/utils/markdown.ts`, `web/src/components/FormattedContent.vue`, and `web/src/components/ChatWindow.vue`, so this is a precise stale-reference guard.

5. Add the list-item paragraph nuance to the `white-space: normal` rationale: single newlines are preserved as `<br>`, including simple list continuations, but blank-line paragraph breaks inside list items become nested `<p>` blocks. That behavior is correct Markdown output and should be accepted in visual review.

VERDICT: CHANGES_REQUESTED