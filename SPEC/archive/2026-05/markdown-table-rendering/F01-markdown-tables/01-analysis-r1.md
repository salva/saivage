# F01 — Markdown Table Rendering — Analysis r1

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
[web/src/components/FormattedContent.vue](web/src/components/FormattedContent.vue#L82)).

User-facing impact is broad. Every surface that funnels agent text through
the shared renderer is affected:

- Operator chat panel —
  [web/src/components/ChatWindow.vue#L314](web/src/components/ChatWindow.vue#L314)
  (`v-html="renderMarkdown(msg.content)"` on every assistant message).
- Generic content preview —
  [web/src/components/FormattedContent.vue#L38](web/src/components/FormattedContent.vue#L38),
  used by:
  - [web/src/components/agents/AgentConversationPane.vue#L142](web/src/components/agents/AgentConversationPane.vue#L142),
    [L156](web/src/components/agents/AgentConversationPane.vue#L156),
    [L178](web/src/components/agents/AgentConversationPane.vue#L178)
  - [web/src/components/agents/ChatSessionPane.vue#L52](web/src/components/agents/ChatSessionPane.vue#L52)
  - [web/src/components/agents/AgentRoundCard.vue#L54](web/src/components/agents/AgentRoundCard.vue#L54),
    [L76](web/src/components/agents/AgentRoundCard.vue#L76),
    [L84](web/src/components/agents/AgentRoundCard.vue#L84)
  - [web/src/components/agents/ToolCallRow.vue#L95](web/src/components/agents/ToolCallRow.vue#L95),
    [L99](web/src/components/agents/ToolCallRow.vue#L99)
  - [web/src/components/FilesView.vue#L393](web/src/components/FilesView.vue#L393)
    (markdown files in the file browser)
  - [web/src/components/DebugView.vue#L359](web/src/components/DebugView.vue#L359),
    [L392](web/src/components/DebugView.vue#L392),
    [L425](web/src/components/DebugView.vue#L425)
    (prompts, skill bodies, memory bodies)

A fix to the shared renderer therefore propagates to every panel above
simultaneously.

## 2. Where markdown is rendered (inventory)

### Single shared renderer

- [web/src/utils/markdown.ts](web/src/utils/markdown.ts#L1-L29) — exports
  `renderMarkdown(text: string): string`. ~29 lines, regex-only.

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

[web/src/components/FormattedContent.vue#L13-L38](web/src/components/FormattedContent.vue#L13-L38)
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
  ([package.json#L43](package.json#L43)) — Telegram bot transport only, no
  web UI.
- `typedoc-plugin-markdown`
  ([package.json#L66](package.json#L66)) — TypeDoc -> Markdown conversion at
  docs build time; unrelated to runtime chat.
- VitePress docs site (`docs:dev`, `docs:build` —
  [package.json#L21-L24](package.json#L21-L24)). `markdown-it` enters only
  here, transitively via VitePress; not bundled into `web/`.

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
   [web/src/components/FormattedContent.vue#L106-L114](web/src/components/FormattedContent.vue#L106-L114)
   and the parallel block in
   [web/src/components/ChatWindow.vue#L541-L550](web/src/components/ChatWindow.vue#L541-L550).

What is **not** supported (each is silently dropped or left as raw
characters):

- **Tables** (the topic of this analysis) — pipe rows pass through verbatim.
- **Italics alone** — `*x*` / `_x_` never match; only `**…**` and `***…***`
  are recognised.
- **Links / autolinks / images** — `[text](url)`, `<https://…>`, `![alt](url)`
  none handled. URLs render as plain text.
- **Blockquotes** — `> …` lines.
- **Thematic breaks** — `---`, `***`, `___` on their own line.
- **Task lists** — `- [ ]` / `- [x]`.
- **Strikethrough** — `~~x~~`.
- **Footnotes** — `[^1]` references and definitions.
- **Hard line breaks** via trailing two-space convention — relies entirely
  on `white-space: pre-wrap` to preserve any newline.
- **Nested lists** — the bullet regex captures only one level; indented
  sub-bullets render with their leading whitespace baked into the bullet
  text.
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
  - preview: [web/src/components/FormattedContent.vue#L81-L85](web/src/components/FormattedContent.vue#L81-L85)

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
- **Alignment is unrecoverable.** Even if a hand-rolled rule were added,
  GFM alignment requires parsing the `| :---: | ---: |` separator row and
  threading per-column alignment into every `<td>`/`<th>`; the current
  line-by-line regex pipeline has no notion of multi-line state.
- **Header/body split is unrecoverable** for the same reason: detecting the
  separator row and treating the row above it as `<thead>` requires
  buffering at least three consecutive lines.

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
  whitelist. The safety guarantee is structural: escape, then only emit
  whitelisted tag shapes.
- `web/package.json`
  ([web/package.json#L11-L15](web/package.json#L11-L15)) confirms the only
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

Grep across the web package and the saivage test tree finds **no tests** of
markdown rendering:

- No file under `web/` defines `describe(…)`, `it(…)`, or imports `vitest`
  (the only matches are inside the built artifact
  `web/dist/assets/index-bvEEWRtp.js`, which is generated Vue runtime code).
- No file under `saivage/tests/` imports `renderMarkdown`, the
  `web/src/utils/markdown.ts` module, `FormattedContent.vue`, or
  `ChatWindow.vue`. The only matches for the string `markdown` in tests are
  unrelated config strings:
  - [saivage/tests/rag/e2e-drift.test.ts#L47](tests/rag/e2e-drift.test.ts#L47)
  - [saivage/tests/rag/e2e-drift.test.ts#L79](tests/rag/e2e-drift.test.ts#L79)
  - [saivage/tests/rag/e2e-ingest-query.test.ts#L35](tests/rag/e2e-ingest-query.test.ts#L35)
  - [saivage/tests/rag/e2e-ingest-query.test.ts#L45](tests/rag/e2e-ingest-query.test.ts#L45)

  (all reference `chunker: { kind: "markdown" }` for the RAG markdown
  chunker, unrelated to the web renderer.)
- `web/package.json` defines no `test` script and declares no test runner
  ([web/package.json#L6-L11](web/package.json#L6-L11)).

**Conclusion:** table behaviour is not currently tested anywhere; in fact
the markdown renderer as a whole has zero unit-test coverage. Any
implementation plan must decide whether to introduce a test harness in
`web/` (currently absent) or place renderer tests under the root
`vitest` + `happy-dom` setup
([package.json#L18](package.json#L18),
[package.json#L57](package.json#L57),
[package.json#L72](package.json#L72)).

## 7. Dependency landscape (factual)

- **Web `package.json`** declares no markdown library. Runtime deps are
  exactly `lucide-vue-next`, `vue`, `zod`
  ([web/package.json#L12-L16](web/package.json#L12-L16)). Dev deps are
  `@vitejs/plugin-vue`, `typescript`, `vite`, `vue-tsc`
  ([web/package.json#L17-L22](web/package.json#L17-L22)).
- **Backend `package.json`** has `telegramify-markdown`
  ([package.json#L43](package.json#L43)) — Telegram-only — and
  `typedoc-plugin-markdown`
  ([package.json#L66](package.json#L66)) — docs build only. Neither is
  reused by the web bundle.
- `markdown-it` is **not** a direct dependency anywhere; it enters only as
  a transitive of VitePress under devDependencies
  ([package.json#L70](package.json#L70)). It cannot be relied on at runtime
  inside the web bundle without being added explicitly.
- Approximate bundle-size facts (current upstream releases, minified, no
  gzip) to weigh in a proposal:
  - `marked` ~30 KB
  - `markdown-it` ~95 KB (+ optional plugins for GFM tables)
  - `micromark` core ~40 KB, but GFM-table extension and the HTML compiler
    add more.
  - A hand-rolled table rule extending the existing pipeline adds roughly
    a few hundred bytes.

  These are stated as facts for the proposal stage; this analysis does not
  select an option.

## 8. Constraints for any solution

- **XSS safety must be preserved.** Either keep the escape-first model
  (extend the regex pipeline) or add an explicit sanitizer when introducing
  a parser. No raw HTML in user content may reach `v-html`.
- **Must coexist with `FormattedContent.vue`'s JSON detection**
  ([L13-L38](web/src/components/FormattedContent.vue#L13-L38)). Markdown is
  only applied in the `text` branch; any change must keep this branching
  intact so JSON and `Tool call: { … }` shapes still route to
  `JsonHighlight`.
- **Must not break currently supported syntax.** Fenced code, inline code,
  `# / ## / ###` headings, `**bold**` / `***bold-italic***`, unordered
  bullets `- ` / `* `, and `N. ` ordered lists all currently work and
  must continue to work.
- **Must work with existing scoped CSS variables.** Both consumers style
  output via `:deep(…)` selectors that depend on the renderer's existing
  class names:
  - chat: [web/src/components/ChatWindow.vue#L533-L550](web/src/components/ChatWindow.vue#L533-L550)
  - preview: [web/src/components/FormattedContent.vue#L92-L115](web/src/components/FormattedContent.vue#L92-L115)

  If new tag names (`<table>`, `<thead>`, `<tbody>`, `<th>`, `<td>`) or
  class names are introduced, both stylesheets need matching `:deep(…)`
  rules; otherwise tables will inherit defaults that look out of place.
- **No backward compatibility shims.** Workspace rule is "architecture
  first, no backward compatibility" (user memory, `preferences.md`). If
  the renderer is replaced, the regex pipeline should be removed wholesale
  rather than kept as a fallback. Class names and DOM shape can change
  freely as long as the two consumer stylesheets are updated in the same
  change.
- **`white-space: pre-wrap` semantics for non-table prose.** The current
  chat experience depends on `pre-wrap` to preserve newlines within
  paragraphs (the renderer never emits `<br>` or `<p>`). Either preserve
  `pre-wrap` and special-case the table subtree (`:deep(table)` /
  `:deep(td)` / `:deep(th)` with `white-space: normal`), or change the
  renderer to emit explicit paragraph/break elements and drop `pre-wrap`
  globally. A proposal must pick one and apply it consistently to both
  `.msg-content` (chat) and `.formatted-text` (preview).

## 9. Open questions to resolve in proposals

1. **Extend or replace?** Should table support be a new rule appended to
   the existing regex pipeline in
   [web/src/utils/markdown.ts](web/src/utils/markdown.ts), or should the
   whole hand-rolled pipeline be replaced with a proper parser? What
   weighs more here — the ~29-line renderer's auditability and zero-dep
   posture, or removing the long list of unsupported syntax in §3?
2. **If a library is introduced, which one and where does it live?**
   Candidates differ by size and feature surface (`marked` ~30 KB, slim
   GFM; `markdown-it` ~95 KB + plugins; `micromark` + extensions). Web
   only, or also share with the backend (e.g. could the backend pre-render
   markdown to HTML so the browser receives sanitised HTML)?
3. **Does `white-space: pre-wrap` need to change?** Specifically: keep
   `pre-wrap` on `.msg-content` / `.formatted-text` and override it for
   `:deep(table)` / `:deep(td)` / `:deep(th)` only, or switch to emitting
   explicit `<p>` / `<br>` and drop `pre-wrap` site-wide? Either choice
   must be applied identically in
   [web/src/components/ChatWindow.vue#L486-L496](web/src/components/ChatWindow.vue#L486-L496)
   and
   [web/src/components/FormattedContent.vue#L81-L85](web/src/components/FormattedContent.vue#L81-L85).
4. **Should the two consumers continue to share a single renderer?**
   `ChatWindow.vue` ([L314](web/src/components/ChatWindow.vue#L314)) and
   `FormattedContent.vue` ([L38](web/src/components/FormattedContent.vue#L38))
   currently both call `renderMarkdown`. If they diverge (e.g. chat wants
   compact tables, file preview wants full-width), where does the split
   live — two functions in `markdown.ts`, or a configuration argument?
5. **Sanitization on top, or escape-first only?** If a parser is
   introduced, do we keep the escape-first guarantee by configuring the
   parser to disable raw HTML (`marked` `breaks/gfm`, `markdown-it`
   `html: false`), or do we add `DOMPurify` as a post-step? The first
   option keeps the dep tree minimal; the second is more defensive against
   future parser bugs.
6. **Test harness location.** Given §6, where do renderer tests go — a new
   `vitest` setup inside `web/`, or under the root `tests/` tree using the
   existing root-level `vitest` + `happy-dom`? This choice determines
   whether a proposal can also assert DOM-level expectations
   (`querySelector('table > thead > tr > th')`) or has to limit itself to
   string assertions on the renderer's output.

STATUS: READY_FOR_REVIEW
