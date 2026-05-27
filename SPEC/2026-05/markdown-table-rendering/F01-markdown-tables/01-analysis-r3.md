# F01 — Markdown Table Rendering — Analysis r3

Round-3 revision of `01-analysis-r2.md`. Only the three reviewer-flagged
items from R2 are changed: (1) markdown-it provenance + typedoc version
in §7, (2) mermaid child line citations in §7, (3) open question 2 in
§9. Every other section is carried forward verbatim from r2 because R2
marked it Verified. No code touched.

## 1. Scope & current symptom

"Markdown table rendering" here means GitHub-Flavored Markdown (GFM) pipe-tables
of the form

```
| col A | col B |
| ----- | ----- |
| 1     | 2     |
```

emitted by LLM agent messages and surfaced through the saivage v2 web UI
(`/home/salva/g/ml/saivage/web`).

Current behaviour: the user sees the **raw markdown source** — literal `|`
pipes and `-----` separator rows — line-wrapped as preformatted text. No
table layout, no header/body distinction, no alignment. This happens because
the single shared renderer
([web/src/utils/markdown.ts](web/src/utils/markdown.ts#L1-L29)) has no rule
that recognises pipe rows; pipes are HTML-safe characters and pass through
[web/src/utils/markdown.ts](web/src/utils/markdown.ts#L3-L5) unchanged, then
land in a `v-html` block whose CSS forces `white-space: pre-wrap`
([web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L494),
[web/src/components/FormattedContent.vue](web/src/components/FormattedContent.vue#L84)).

User-facing impact is broad. Every surface that funnels agent text through
the shared renderer is affected:

- Operator chat panel —
  [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L314)
  (`v-html="renderMarkdown(msg.content)"` on every assistant message).
- Generic content preview —
  [web/src/components/FormattedContent.vue](web/src/components/FormattedContent.vue#L38),
  used by:
  - [web/src/components/agents/AgentConversationPane.vue](web/src/components/agents/AgentConversationPane.vue#L142),
    [L156](web/src/components/agents/AgentConversationPane.vue#L156),
    [L178](web/src/components/agents/AgentConversationPane.vue#L178)
  - [web/src/components/agents/ChatSessionPane.vue](web/src/components/agents/ChatSessionPane.vue#L52)
  - [web/src/components/agents/AgentRoundCard.vue](web/src/components/agents/AgentRoundCard.vue#L54),
    [L76](web/src/components/agents/AgentRoundCard.vue#L76),
    [L84](web/src/components/agents/AgentRoundCard.vue#L84)
  - [web/src/components/agents/ToolCallRow.vue](web/src/components/agents/ToolCallRow.vue#L95),
    [L99](web/src/components/agents/ToolCallRow.vue#L99)
  - [web/src/components/FilesView.vue](web/src/components/FilesView.vue#L393)
    (markdown files in the file browser)
  - [web/src/components/DebugView.vue](web/src/components/DebugView.vue#L359),
    [L392](web/src/components/DebugView.vue#L392),
    [L425](web/src/components/DebugView.vue#L425)
    (prompts, skill bodies, memory bodies)

A fix to the shared renderer therefore propagates to every panel above
simultaneously.

## 2. Where markdown is rendered (inventory)

### Single shared renderer

- [web/src/utils/markdown.ts](web/src/utils/markdown.ts#L1-L29) — exports
  `renderMarkdown(text: string): string`. 29 lines, regex-only.

### Two consumers

- **Chat**
  [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue) —
  imports at [L6](web/src/components/ChatWindow.vue#L6); calls at
  [L314](web/src/components/ChatWindow.vue#L314). Applied only to
  `msg.role === 'assistant'`; user/system messages render as `{{ msg.content }}`
  ([L315](web/src/components/ChatWindow.vue#L315)).
- **Generic preview**
  [web/src/components/FormattedContent.vue](web/src/components/FormattedContent.vue)
  — imports at [L4](web/src/components/FormattedContent.vue#L4); calls at
  [L38](web/src/components/FormattedContent.vue#L38).

### JSON-vs-text branching inside `FormattedContent.vue`

[web/src/components/FormattedContent.vue](web/src/components/FormattedContent.vue#L13-L38)
classifies the incoming `content` string:

1. `trimmed` starts with `{` or `[` → try `JSON.parse`; success → `{ kind: "json", data }`.
2. Otherwise try `extractEmbeddedJson`
   ([L41-L57](web/src/components/FormattedContent.vue#L41-L57)) — accepts a
   short textual prefix matching
   `^(Tool call|Tool result|Result|Error|Response|Request)\b` followed by JSON.
3. Otherwise → `{ kind: "text", text: content }`.

Markdown is invoked **only** in the text branch
([L36-L39](web/src/components/FormattedContent.vue#L36-L39)). JSON branches
render via `JsonHighlight`
([L70-L74](web/src/components/FormattedContent.vue#L70-L74)) and are out of
scope for table rendering.

Content that lands in the text branch in practice: assistant reasoning
entries, plain diagnostic/context strings, tool call/result text payloads
that are not pure JSON, markdown files from `FilesView`, prompt/skill/memory
bodies from `DebugView`. Tables are most likely to appear in
assistant/reasoning content and in markdown files.

### Out of scope

- Backend `telegramify-markdown`
  ([package.json#L45](package.json#L45)) — Telegram bot transport only, no
  web UI.
- `typedoc-plugin-markdown`
  ([package.json#L64](package.json#L64)) — TypeDoc → Markdown conversion at
  docs build time; unrelated to runtime chat.
- VitePress docs site (`docs:dev`, `docs:build`, `docs:preview` —
  [package.json#L22-L25](package.json#L22-L25)). `markdown-it` enters only
  here, transitively via typedoc (see §7); not bundled into `web/`.

## 3. Current renderer behaviour (verbatim from `web/src/utils/markdown.ts`)

Pipeline, in the order applied to the input string
([web/src/utils/markdown.ts#L2-L28](web/src/utils/markdown.ts#L2-L28)):

1. **HTML-escape first** — `&`, `<`, `>` replaced with `&amp;`, `&lt;`,
   `&gt;` ([L2-L5](web/src/utils/markdown.ts#L2-L5)). Everything below
   operates on already-escaped text, which is what makes regex-based emission
   of literal `<pre>`, `<span>`, `<strong>` tags safe.
2. **Fenced code blocks** —
   `/```(\w*)\n([\s\S]*?)```/g` → `<pre class="md-code-block"><code>…</code></pre>`
   ([L7-L9](web/src/utils/markdown.ts#L7-L9)). Trailing newline stripped.
3. **Inline code** — `` /`([^`]+)`/g `` → `<code class="md-code">…</code>`
   ([L11](web/src/utils/markdown.ts#L11)).
4. **Headings** `# / ## / ###` → `<strong class="md-h1|h2|h3">…</strong>`
   ([L12-L14](web/src/utils/markdown.ts#L12-L14)). Multiline mode.
5. **Bold (and bold-italic shorthand)** —
   `\*\*\*(.+?)\*\*\*` → `<strong><em>…</em></strong>`,
   `\*\*(.+?)\*\*` → `<strong>…</strong>`
   ([L15-L16](web/src/utils/markdown.ts#L15-L16)).
6. **Bullets and ordered list** — `^[-*] (.+)$` and `^(\d+)\. (.+)$` →
   `<span class="md-bullet"><span class="md-marker">…</span><span class="md-bullet-text">…</span></span>`
   ([L19-L26](web/src/utils/markdown.ts#L19-L26)). Rendered as a 2-column
   CSS grid via
   [web/src/components/FormattedContent.vue#L98-L110](web/src/components/FormattedContent.vue#L98-L110)
   (`md-bullet`/`md-marker`/`md-bullet-text` `:deep(...)` rules) and the
   parallel block in
   [web/src/components/ChatWindow.vue#L541-L554](web/src/components/ChatWindow.vue#L541-L554).

What is **not** supported. (R2-4: task-list and nested-bullet entries
corrected.) Each item is either silently dropped, left as raw characters,
or — for the two corrected cases — coerced into a different markdown shape:

- **Tables** (the topic of this analysis) — pipe rows pass through verbatim.
- **Italics alone** — `*x*` / `_x_` never match; only `**…**` and `***…***`
  are recognised.
- **Links / autolinks / images** — `[text](url)`, `<https://…>`, `![alt](url)`
  none handled. URLs render as plain text.
- **Blockquotes** — `> …` lines.
- **Thematic breaks** — `---`, `***`, `___` on their own line.
- **Task lists** — `- [ ] x` and `- [x] x` are **not** recognised as
  checkboxes, but they *do* match the bullet regex `^[-*] (.+)$`
  ([web/src/utils/markdown.ts#L20-L23](web/src/utils/markdown.ts#L20-L23)),
  so they render as ordinary bullets whose `md-bullet-text` is the literal
  string `[ ] x` or `[x] x`. The brackets survive intact because the HTML
  escape step ([L3-L5](web/src/utils/markdown.ts#L3-L5)) does not touch
  `[` or `]`.
- **Strikethrough** — `~~x~~`.
- **Footnotes** — `[^1]` references and definitions.
- **Hard line breaks** via trailing two-space convention — relies entirely
  on `white-space: pre-wrap` to preserve any newline.
- **Nested lists** — the bullet regexes
  ([web/src/utils/markdown.ts#L20-L26](web/src/utils/markdown.ts#L20-L26))
  are anchored with `^` and allow **no** leading whitespace before `-`,
  `*`, or `N.`. An indented sub-bullet line such as `␠␠- child` does not
  match either rule and is emitted **raw** (the leading spaces and the
  `-` survive the HTML escape step unchanged). It therefore appears as a
  literal `  - child` line in the output, *not* as an extra bullet with
  extra whitespace inside its `md-bullet-text` span.
- **Paragraph grouping** — no `<p>` wrapping; the renderer never groups
  adjacent text lines into paragraphs. Wrapping is delegated to the
  consumer's `white-space: pre-wrap` CSS.

## 4. Why tables specifically fail

- **Escape step is harmless to pipes.** Step 1
  ([web/src/utils/markdown.ts#L3-L5](web/src/utils/markdown.ts#L3-L5))
  rewrites only `&`, `<`, `>`. The `|` character is unaffected and survives
  to the output.
- **No regex recognises pipe rows.** None of the rules in
  [web/src/utils/markdown.ts#L7-L27](web/src/utils/markdown.ts#L7-L27)
  match the `| … | … |` shape, the `| --- | :---: |` separator, or any
  alignment colon syntax. There is no header/body split, no `<table>`
  emission.
- **The wrapper CSS dumps it verbatim.** The output of `renderMarkdown` is
  bound via `v-html` to two `.formatted-text` / `.msg-content` containers
  that both apply `white-space: pre-wrap`:
  - chat: [web/src/components/ChatWindow.vue#L486-L496](web/src/components/ChatWindow.vue#L486-L496)
    (`pre-wrap` at [L494](web/src/components/ChatWindow.vue#L494))
  - preview: [web/src/components/FormattedContent.vue#L83-L87](web/src/components/FormattedContent.vue#L83-L87)
    (`pre-wrap` at [L84](web/src/components/FormattedContent.vue#L84))

  `pre-wrap` preserves newlines and runs of spaces, so each pipe row appears
  as one visual line with the source pipes intact, soft-wrapped only when
  the line exceeds the container width.
- **Future `<table>` injection would conflict with this CSS.** A future
  rule that emits an actual `<table>` would inherit `white-space: pre-wrap`
  on its descendants and lose normal table cell layout (cells would not
  collapse internal whitespace the way table rendering normally assumes).
  Any approach that introduces real table markup must either change
  `white-space` on the wrapper or override it for `:deep(table)`,
  `:deep(td)`, `:deep(th)`.
- **Multi-line state is the missing ingredient.** (R2-5: prior "header/body
  and alignment are unrecoverable" phrasing was too strong.) The header
  row, the `| --- | :---: |` separator row, and per-column alignment are
  all present in the same input string and *can* be recovered by any
  future approach that adds block-level awareness — for example a
  pre-pass that segments the input into block tokens before the existing
  inline rules run, or a full parser. What is genuinely unrecoverable is
  doing it under the **current** rule set: every existing rule is a single
  global/multiline `String.prototype.replace` with no notion of
  consecutive-line buffering, so it cannot, in isolation, decide whether
  the line above an `| --- | --- |` row should become a `<thead>`. The
  constraint is "current renderer architecture", not "the source text".

## 5. Safety / XSS model

The renderer relies on a strict **escape-first, emit-from-literals** model:

- Step 1 ([web/src/utils/markdown.ts#L3-L5](web/src/utils/markdown.ts#L3-L5))
  HTML-escapes `&`, `<`, `>` before any rule fires. Note: `"` and `'` are
  **not** escaped, but no later rule emits a tag with an attribute whose
  value interpolates user input — every attribute is a constant class name
  (`md-code-block`, `md-code`, `md-h1/2/3`, `md-bullet`, `md-marker`,
  `md-bullet-text`).
- Every subsequent `.replace(…, '<tag class="…">$1</tag>')` writes HTML
  tags from string literals owned by the renderer; capture groups (`$1`,
  `$2`) are interpolated as text content only.
- There is **no DOMPurify**, **no sanitize-html**, **no DOMParser**
  whitelist *in the web bundle*. The safety guarantee is structural:
  escape, then only emit whitelisted tag shapes. (DOMPurify exists in the
  lockfile as a transitive of `mermaid`, used in the docs build only —
  see §7.)
- `web/package.json`
  ([web/package.json#L12-L16](web/package.json#L12-L16)) confirms the only
  runtime deps are `lucide-vue-next`, `vue`, `zod` — no sanitizer is bundled.

Implication for table support: any new approach must preserve this
property. A library that hands user-supplied HTML straight to `v-html`
without escaping (e.g. naïve `marked` usage with `html: true`, or
`markdown-it` with `html: true`) would regress the XSS posture. The two
safe shapes are (a) extend the existing escape-first regex pipeline with a
table rule whose emitted tags are literals, or (b) introduce a parser
together with an explicit sanitizer pass (or use a parser with
`html: false` / equivalent option).

## 6. Test coverage

(R2-1: corrected. Round-1 claimed the web tree contained no vitest tests,
which is wrong.)

Verification run (May 2026, from `/home/salva/g/ml/saivage`):

```
$ find web/src -name '*.test.ts' -o -name '*.spec.ts'
web/src/components/agents/round-id.test.ts
web/src/components/agents/timeline.test.ts
web/src/composables/useAuthState.test.ts
web/src/composables/useWebSocket.test.ts
```

There are **four** vitest test files under `web/src/`:

- [web/src/components/agents/round-id.test.ts](web/src/components/agents/round-id.test.ts)
- [web/src/components/agents/timeline.test.ts](web/src/components/agents/timeline.test.ts)
- [web/src/composables/useAuthState.test.ts](web/src/composables/useAuthState.test.ts)
- [web/src/composables/useWebSocket.test.ts](web/src/composables/useWebSocket.test.ts)

They are picked up by the **root** `vitest` setup, not by `web/` itself.
The root [vitest.config.ts](vitest.config.ts) sets
`test.include = ["src/**/*.test.ts", "tests/**/*.test.ts", "web/src/**/*.test.ts"]`,
and the root scripts at
[package.json#L17-L19](package.json#L17-L19) (`"test": "vitest run"`,
`"test:watch": "vitest"`, `"test:bundle": "..."`) drive the harness with
`happy-dom` ([package.json#L59](package.json#L59)) and
`vitest@^4.1.7` ([package.json#L70](package.json#L70)). `web/package.json`
declares **no** `test` script of its own ([web/package.json#L6-L11](web/package.json#L6-L11)).

None of the four existing web tests touches the markdown renderer or its
consumers:

- The two `agents/*` tests exercise round-id parsing and timeline ordering.
- The two `composables/*` tests exercise `useAuthState` and `useWebSocket`.
- No file under `web/` references `renderMarkdown`, `markdown.ts`,
  `FormattedContent.vue`, or `ChatWindow.vue` from a `*.test.ts`.

The root `tests/` tree is also clean: the only `markdown` hits there are
unrelated RAG chunker config strings —
[tests/rag/e2e-drift.test.ts#L47](tests/rag/e2e-drift.test.ts#L47),
[tests/rag/e2e-drift.test.ts#L79](tests/rag/e2e-drift.test.ts#L79),
[tests/rag/e2e-ingest-query.test.ts#L35](tests/rag/e2e-ingest-query.test.ts#L35),
[tests/rag/e2e-ingest-query.test.ts#L45](tests/rag/e2e-ingest-query.test.ts#L45)
(all reference `chunker: { kind: "markdown" }` for the RAG markdown chunker,
unrelated to the web renderer).

**Conclusion: no markdown coverage exists.** The infrastructure to host
new web-side renderer tests is already wired up — root vitest +
happy-dom, picking up `web/src/**/*.test.ts` — so a future change can drop
a `web/src/utils/markdown.test.ts` next to the renderer without adding a
test runner. The decision a proposal still has to make is whether
renderer tests assert against raw HTML strings or use `happy-dom`'s
`querySelector`.

## 7. Dependency landscape (factual)

(R2-2: re-greped against the current `package-lock.json`. R2-7: size
estimates removed; replaced with a reproducible measurement plan.
R3 fixes: markdown-it parent chain reduced to what `npm ls --all`
actually shows; mermaid child line citations corrected against the
current lockfile; typedoc version updated to the currently-declared
range.)

### Direct web runtime deps

[web/package.json#L12-L16](web/package.json#L12-L16) declares exactly:

- `lucide-vue-next` ([L13](web/package.json#L13))
- `vue` ([L14](web/package.json#L14))
- `zod` ([L15](web/package.json#L15))

Dev deps ([web/package.json#L17-L22](web/package.json#L17-L22)):
`@vitejs/plugin-vue`, `typescript`, `vite`, `vue-tsc`. **No markdown
library, no sanitizer, no HTML parser** ships in the web bundle.

### Transitive backend / dev / docs lock entries

Verification commands (from `/home/salva/g/ml/saivage`):

```
$ npm ls markdown-it --all
saivage@0.1.0 /home/salva/g/ml/saivage
└─┬ typedoc@0.28.19
  └── markdown-it@14.1.1

$ grep -n '"node_modules/dompurify"\|"node_modules/marked"\|"node_modules/markdown-it"\|"node_modules/typedoc"\|"node_modules/vitepress"\|"node_modules/mermaid"\|"node_modules/micromark"\|"node_modules/markdown-table"' package-lock.json
6051:    "node_modules/dompurify": {
8069:    "node_modules/markdown-it": {
8086:    "node_modules/markdown-table": {
8098:    "node_modules/marked": {
8362:    "node_modules/mermaid": {
8391:    "node_modules/micromark": {
11426:    "node_modules/typedoc": {
12219:    "node_modules/vitepress": {
```

Results — cross-checked against `package-lock.json` `node_modules/<pkg>`
blocks:

- **`markdown-it@14.1.1`** —
  block at [package-lock.json#L8069-L8085](package-lock.json#L8069-L8085).
  The **only** consumer-declared parent recorded in this repo's lockfile
  is **typedoc** (root devDependency
  [package.json#L63](package.json#L63) `"typedoc": "^0.28.19"`; lock
  block [package-lock.json#L11426-L11447](package-lock.json#L11426-L11447);
  declares `"markdown-it": "^14.1.1"` at
  [package-lock.json#L11434](package-lock.json#L11434)). This is what
  `npm ls markdown-it --all` reports verbatim — a single parent chain
  `saivage@0.1.0 → typedoc@0.28.19 → markdown-it@14.1.1`. VitePress's own
  dev metadata (its package README and changelog) mentions `markdown-it`
  and its plugin family (`markdown-it-anchor`, `markdown-it-attrs`,
  `markdown-it-container`, `markdown-it-emoji`, `markdown-it-mathjax3`),
  but the consumer dependency path recorded in this repo's
  `package-lock.json` does not require `markdown-it` through VitePress:
  inspecting the VitePress lock block at
  [package-lock.json#L12219](package-lock.json#L12219) does not surface
  `markdown-it` as a declared dependency of `node_modules/vitepress`
  itself, and no `node_modules/vitepress/node_modules/markdown-it`
  nested entry exists. The lockfile-recorded path therefore is the
  `typedoc → markdown-it` edge only. (Removing `typedoc` would require
  re-running `npm install` to observe what VitePress actually pulls in;
  this analysis does not speculate on that hypothetical.)

  This path does not reach the web bundle: typedoc runs at docs API
  generation time ([package.json#L22](package.json#L22)
  `"docs:api": "typedoc && …"`), VitePress runs in `docs:dev` /
  `docs:build` / `docs:preview`
  ([package.json#L23-L25](package.json#L23-L25)).

- **`marked@16.4.2`** —
  package block at [package-lock.json#L8098-L8109](package-lock.json#L8098-L8109).
  Sole parent is **`mermaid@11.15.0`**
  (package block [package-lock.json#L8362-L8390](package-lock.json#L8362-L8390);
  declares `"marked": "^16.3.0"` at
  [package-lock.json#L8384](package-lock.json#L8384)). `mermaid` itself
  is pulled in by the dev dep `vitepress-plugin-mermaid`
  ([package.json#L69](package.json#L69)), used only by the VitePress
  docs build.

- **`dompurify@3.4.5`** —
  package block at [package-lock.json#L6051-L6058](package-lock.json#L6051-L6058).
  Sole parent is **`mermaid@11.15.0`** (declares `"dompurify": "^3.3.1"`
  at [package-lock.json#L8380](package-lock.json#L8380)). Same docs-only
  path as `marked`.

- **`micromark@2.11.4`** and the GFM extension family —
  blocks at [package-lock.json#L8391](package-lock.json#L8391)
  (`micromark`), [L8410](package-lock.json#L8410)
  (`micromark-extension-gfm`),
  [L8427](package-lock.json#L8427)
  (`micromark-extension-gfm-autolink-literal`),
  [L8439](package-lock.json#L8439)
  (`micromark-extension-gfm-strikethrough`),
  [L8451](package-lock.json#L8451)
  (`micromark-extension-gfm-table`),
  [L8463](package-lock.json#L8463)
  (`micromark-extension-gfm-tagfilter`),
  [L8472](package-lock.json#L8472)
  (`micromark-extension-gfm-task-list-item`). All reach the root via
  **`telegramify-markdown@1.3.3`**
  ([package.json#L45](package.json#L45)) →
  `remark-gfm@1.0.0` → `mdast-util-gfm` / `micromark-extension-gfm` →
  `micromark`. Backend / Telegram transport only; not bundled into web.

- **`markdown-table@2.0.0`** —
  block at [package-lock.json#L8086-L8097](package-lock.json#L8086-L8097).
  Parent is `mdast-util-gfm-table@0.1.6`, itself transitively under
  **`telegramify-markdown`**. Backend only.

- **`sanitize-html`** — **not present** in `package-lock.json` (`grep`
  for `"node_modules/sanitize-html"` returns no match). No transitive
  pulls it in either.

### Implications

`markdown-it`, `marked`, `dompurify`, `micromark`, and `markdown-table`
all exist in the lockfile, but none is on a path that reaches the web
bundle today. Treat any web-side use of any of these as **introducing a
new direct web runtime dependency** even if the package is already
"available" via `node_modules/`; the Vite build will not pull a docs-only
or backend-only transitive into `web/dist`.

### Bundle-size measurement plan

(R2-7: replaces prior approximate numbers.) Numbers belong in the
proposal, not in this factual analysis. The recommended reproducible
procedure, once a candidate library is chosen and installed under
`web/`:

1. `cd web && npm pack --dry-run <candidate-package>` (or, if it is not
   the package being packed, `cd <its node_modules>` and inspect).
2. `du -sh node_modules/<candidate>/dist` and
   `du -h node_modules/<candidate>/dist/*.{js,mjs,cjs}` for per-file size.
3. `npx vite build` and then `du -h dist/assets/*.js | sort -h` to see
   the candidate's contribution to the final bundle.
4. Optionally `gzip -c dist/assets/<chunk>.js | wc -c` for gzip size.

Record both pre-gzip and gzip numbers next to each candidate in the
proposal so the trade-off discussion has comparable figures.

## 8. Constraints for any solution (code-derived only)

(R2-6: project-policy items moved to §8b. This subsection is restricted
to constraints that fall out of the current code paths.)

- **XSS safety must be preserved.** Either keep the escape-first model
  (extend the regex pipeline) or add an explicit sanitizer when introducing
  a parser. No raw HTML in user content may reach `v-html`. The current
  guarantee comes from
  [web/src/utils/markdown.ts#L3-L5](web/src/utils/markdown.ts#L3-L5)
  followed by emit-from-literals only.
- **Must coexist with `FormattedContent.vue`'s JSON detection**
  ([web/src/components/FormattedContent.vue#L13-L38](web/src/components/FormattedContent.vue#L13-L38)).
  Markdown is only applied in the `text` branch; any change must keep
  this branching intact so JSON and `Tool call: { … }` shapes still route
  to `JsonHighlight`
  ([web/src/components/FormattedContent.vue#L70-L74](web/src/components/FormattedContent.vue#L70-L74)).
- **Current syntax behaviour must be preserved or explicitly redefined.**
  The set actually implemented today (fenced code, inline code,
  `# / ## / ###`, `**bold**` / `***bold-italic***`, unordered bullets
  `- ` / `* `, and `N. ` ordered lists) is what existing operator content
  has been authored against. The unsupported-but-coerced cases catalogued
  in §3 (task-list lines rendered as plain bullets; indented sub-bullets
  surviving as raw text) are also part of the current observable
  behaviour. A change must either preserve each of these or call out the
  redefinition explicitly.
- **Two scoped-CSS consumers depend on the renderer's class names.** Both
  consumers style output via `:deep(…)` selectors that depend on the
  renderer's existing classes:
  - chat: [web/src/components/ChatWindow.vue#L533-L554](web/src/components/ChatWindow.vue#L533-L554)
  - preview: [web/src/components/FormattedContent.vue#L89-L110](web/src/components/FormattedContent.vue#L89-L110)

  If new tag names (`<table>`, `<thead>`, `<tbody>`, `<th>`, `<td>`) or
  class names are introduced, both stylesheets need matching `:deep(…)`
  rules; otherwise tables will inherit defaults that look out of place.
- **`white-space: pre-wrap` interacts with any future block-level
  `<table>`.** Both consumers set `pre-wrap` on the wrapper — chat at
  [web/src/components/ChatWindow.vue#L494](web/src/components/ChatWindow.vue#L494)
  and preview at
  [web/src/components/FormattedContent.vue#L84](web/src/components/FormattedContent.vue#L84).
  The current chat / preview experience depends on `pre-wrap` to preserve
  newlines within paragraphs (the renderer never emits `<br>` or `<p>`).
  Either preserve `pre-wrap` and special-case the table subtree
  (`:deep(table)` / `:deep(td)` / `:deep(th)` with `white-space: normal`),
  or change the renderer to emit explicit paragraph / break elements and
  drop `pre-wrap` globally. A proposal must pick one and apply it
  consistently to both `.msg-content` (chat) and `.formatted-text`
  (preview).

## 8b. Project policy bearing on proposals

(R2-6: factored out of §8 so policy is explicit but not conflated with
code-derived constraints.)

The workspace operates under an **architecture-first, no-backward-compat**
rule, recorded in user memory `preferences.md`:

> *"Clean code and proper architecture are the top priority… Do NOT
> preserve backward compatibility with old data structures, on-disk
> formats, configs, or tests. Actively REMOVE code supporting old
> features/structures rather than keeping migration shims. Never apply
> 'minimal change' defaults — refactor broadly when it improves the
> design."*

Two concrete consequences proposals are free — and in fact encouraged —
to exploit:

1. **The current renderer can be removed entirely.** If a proposal calls
   for replacing
   [web/src/utils/markdown.ts](web/src/utils/markdown.ts#L1-L29) with a
   parser-backed implementation (or any other architecture), the
   29-line regex pipeline should be deleted wholesale rather than kept
   as a fallback or migration shim. Likewise, the bullet-marker DOM
   shape (`md-bullet` / `md-marker` / `md-bullet-text`) is not a
   contract; if a new architecture produces idiomatic `<ul><li>` / a
   real `<table>` tree, the two consumer stylesheets should be updated
   in the same change rather than wrapped around the old class names.
2. **Class names, tag shapes, and consumer CSS may change freely**,
   provided both consumers (`ChatWindow.vue` and `FormattedContent.vue`)
   are updated atomically in the same change.

This policy does **not** relax the code-derived constraints in §8 — XSS
safety, JSON-vs-text routing, scoped-CSS coupling, and `pre-wrap`
interaction all still apply.

## 9. Open questions to resolve in proposals

1. **Extend or replace?** Should table support be a new rule appended to
   the existing regex pipeline in
   [web/src/utils/markdown.ts](web/src/utils/markdown.ts), or should the
   whole hand-rolled pipeline be replaced with a proper parser? What
   weighs more here — the 29-line renderer's auditability and zero-dep
   posture, or removing the long list of unsupported / coerced syntax in
   §3?
2. **Sanitizer / HTML-disabled configuration.** Should the web
   renderer remain dependency-free or add an explicit web dependency?
   Any candidate library that emits HTML from user content does not
   sanitize on its own per its own docs (see for example the installed
   `marked@16.4.2`: its options are declared in
   [node_modules/marked/lib/marked.d.ts#L443-L490](node_modules/marked/lib/marked.d.ts#L443-L490),
   and [node_modules/marked/README.md#L53-L56](node_modules/marked/README.md#L53-L56)
   states explicitly that Marked does not sanitize the output HTML and
   recommends running the output through a sanitizer such as
   `DOMPurify`). A proposal that introduces such a library must
   therefore specify either (a) configuring it to disable raw HTML
   passthrough where the chosen version's API supports that, or (b)
   running its output through a sanitizer such as `DOMPurify` before
   `v-html`. The proposal must justify the chosen path against the
   current escape-first XSS posture documented in §5, and must cite the
   actual option names / hook surface present in the version it
   proposes to install — not invented options.
3. **Does `white-space: pre-wrap` need to change?** Keep `pre-wrap` on
   `.msg-content` / `.formatted-text` and override it for `:deep(table)`
   / `:deep(td)` / `:deep(th)` only, or switch to emitting explicit
   `<p>` / `<br>` and drop `pre-wrap` site-wide? Either choice must be
   applied identically in
   [web/src/components/ChatWindow.vue#L486-L496](web/src/components/ChatWindow.vue#L486-L496)
   and
   [web/src/components/FormattedContent.vue#L83-L87](web/src/components/FormattedContent.vue#L83-L87).
4. **Should the two consumers continue to share a single renderer?**
   `ChatWindow.vue` ([L314](web/src/components/ChatWindow.vue#L314)) and
   `FormattedContent.vue` ([L38](web/src/components/FormattedContent.vue#L38))
   currently both call `renderMarkdown`. If they diverge (e.g. chat
   wants compact tables, file preview wants full-width), where does the
   split live — two functions in `markdown.ts`, or a configuration
   argument?
5. **Test harness placement.** Given §6, renderer tests can live under
   `web/src/**/*.test.ts` and run through the root `vitest` +
   `happy-dom` setup with no new infrastructure. Should renderer tests
   sit beside the renderer (e.g. `web/src/utils/markdown.test.ts`) or
   under a feature folder, and should they assert against raw HTML
   strings or use `happy-dom` `querySelector` (`'table > thead > tr > th'`)?

STATUS: READY_FOR_REVIEW
