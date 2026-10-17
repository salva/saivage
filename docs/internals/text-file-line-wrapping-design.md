# Text File Line Wrapping Design

## Goal

When the web UI displays a text file, every line should wrap at the right edge of its visible container. This includes JSON files, Markdown code blocks, logs, notes, plain text files, and any other text-like file content. Long unbroken strings such as minified JSON, base64 fragments, long paths, hashes, stack traces, and URLs must not force horizontal scrolling or push the layout wider than the panel.

## Current State

Primary file browsing is implemented in `web/src/components/FilesView.vue`.

- JSON files render through `JsonHighlight.vue`.
- Markdown files render through `FormattedContent.vue`.
- Other files render as `<pre class="content-text">` inside `FilesView.vue`.
- `JsonHighlight.vue` already uses `white-space: pre-wrap` and `word-break: break-word`.
- `FilesView.vue` plain text already uses `white-space: pre-wrap` and `word-break: break-word`.
- `FormattedContent.vue` Markdown `<pre>` blocks still use `overflow-x: auto`, so fenced code can horizontally scroll.
- `DetailSectionRenderer.vue` renders tool detail code/diff/stdout/stderr with generic `<pre>` blocks using `overflow: auto`; diffs explicitly force `white-space: pre`.
- `ChatWindow.vue` defines Markdown `<pre>` rules with horizontal overflow. `DebugView.vue` relies on `JsonHighlight.vue` and `FormattedContent.vue` for text/JSON content; its remaining `overflow-x: auto` rules are for the debug tab bar and should not be changed for this feature.

The existing styles solve some file-viewer cases but do not establish a consistent wrapping contract for all text displays. Some long-token cases can still overflow because `word-break: break-word` is less explicit than `overflow-wrap: anywhere` for unbroken content.

`web/src/styles/patterns.css` defines a global `.code-block` utility class with `white-space: pre` and `overflow-x: auto`. This class is part of the project's established pattern library (`patterns.css` is imported by `index.css` -> `main.ts`) but is not currently referenced by any component template. Its existence means a future developer could apply `.code-block` to any element and unwittingly reintroduce horizontal scroll. The implementation must update `.code-block` in `patterns.css` to use the wrapping contract.

**Markdown renderer**: `web/src/utils/markdown.ts` uses `marked` (GFM, `breaks: true`) and passes output through DOMPurify with `USE_PROFILES: { html: true }`. Markdown generates `<pre><code>` structures. CSS selectors in `FormattedContent.vue` target `:deep(pre)` and `:deep(pre code)`. The plan must verify that the wrapping CSS applies to both nested levels, which the current design does address.

## Non-Goals

- Do not add a horizontal-scroll mode or wrap toggle unless the user asks for it later.
- Do not change backend file reading, truncation limits, path filtering, or file type detection.
- Do not introduce virtualized rendering in this change.
- Do not alter semantic text content. Wrapping is purely visual.
- Do not wrap file tree labels, breadcrumbs, tool summaries, or other single-line chrome that intentionally ellipsizes.

## Design Principles

- One visual policy: file/text content wraps by default.
- Preserve explicit newlines and indentation.
- Break long unbroken tokens when necessary to protect layout.
- Keep vertical scrolling; eliminate horizontal scrolling for text content.
- Centralize the CSS contract enough that future text displays inherit it deliberately.

## Architecture

### Text Wrapping Contract

Any component that renders text-like content should use this CSS contract:

```css
white-space: pre-wrap;
overflow-wrap: anywhere;
word-break: normal;
min-width: 0;
max-width: 100%;
overflow-x: hidden;
```

For text blocks with a `maxHeight` that need scrolling, do not use shorthand `overflow: auto` because it can re-enable horizontal scrolling. Use axis-specific overflow instead:

```css
overflow-x: hidden;
overflow-y: auto;
```

For `<pre><code>` structures, apply the wrapping contract to both `pre` and `code` where needed because browser defaults on `<code>` and inherited `white-space` can interact differently across nested blocks:

```css
pre.text-wrap,
pre.text-wrap code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
}
```

Rationale:

- `pre-wrap` preserves spaces, tabs, and newlines while allowing wrapping.
- `overflow-wrap: anywhere` breaks long strings that have no natural breakpoints.
- `word-break: normal` avoids aggressive CJK/word-breaking behavior except when `overflow-wrap` requires it.
- `overflow-x: hidden` prevents accidental horizontal scrollbars in text surfaces.

### Reusable Styling

Add a shared CSS class instead of repeating subtly different rules:

```css
.text-content-wrap {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
  min-width: 0;
  max-width: 100%;
  overflow-x: hidden;
}

.text-content-wrap code {
  white-space: inherit;
  overflow-wrap: inherit;
  word-break: inherit;
}
```

The project has a well-organized style pipeline at `web/src/styles/` (imported in `main.ts`):
- `tokens.css`: design tokens (colors, fonts, radii).
- `semantic.css`: semantic variable mapping.
- `base.css`: element defaults.
- `patterns.css`: reusable utility classes (`panel-heading`, `.btn`, `.card`, `.code-block`, `.pill`, etc.).

The `.text-content-wrap` class should go in `patterns.css` alongside existing `.code-block` and `.code-inline` classes. This is the project's established pattern library and is the single source of truth for reusable visual classes.

Update `.code-block` in the same file because it currently has `white-space: pre` and `overflow-x: auto`. The updated `.code-block` should use the wrapping contract while keeping its background/border/padding/font properties. Apply the change directly rather than creating a parallel class.

### File Viewer Rendering

`FilesView.vue` should continue using the current dispatch:

```vue
<JsonHighlight v-if="fileContent.type === 'json'" />
<FormattedContent v-else-if="fileContent.type === 'md'" />
<pre v-else class="content-text">...</pre>
```

The change should ensure each branch honors the same wrapping contract:

- `JsonHighlight.vue`: keep syntax highlighting and ensure its root `<pre>` uses the shared wrapping contract.
- `FormattedContent.vue`: Markdown text remains normal flow, but Markdown-generated `<pre>` blocks, inline code, links, and table cells must wrap instead of using horizontal scroll.
- `FilesView.vue` plain text: keep `<pre>` rendering, replace or supplement `word-break: break-word` with `overflow-wrap: anywhere`, and ensure no horizontal overflow on `.content-body` for file text.

### Tool And Debug Text Rendering

The user request is framed around files, but the same raw text/JSON components are reused outside the file browser. The implementation should update these only where they are text content panes, not navigation chrome:

- `FormattedContent.vue`: affects Markdown code blocks in conversations, raw payloads, debug prompts, and file Markdown.
- `JsonHighlight.vue`: affects all highlighted JSON views.
- `DetailSectionRenderer.vue`: code/stdout/stderr should wrap. Diff wrapping is acceptable under the stated requirement for any text file/text display, but if diff readability becomes a concern later, add a separate explicit diff policy after user approval.
- `ChatWindow.vue`: update local Markdown/pre CSS if those rules still create horizontal scrolling after `FormattedContent.vue` changes. `DebugView.vue` should inherit text wrapping through `JsonHighlight.vue` and `FormattedContent.vue`; leave its tab-bar horizontal overflow alone.

## Implementation Plan

1. Add `.text-content-wrap` to `web/src/styles/patterns.css` in the Code section.

   - Place it alongside `.code-block` and `.code-inline`.
   - Also update `.code-block`: replace `white-space: pre` and `overflow-x: auto` with the wrapping contract, keeping its existing background, border, padding, font-size, and color properties.

2. Update JSON rendering.

   - In `JsonHighlight.vue`, keep `white-space: pre-wrap`.
   - Replace `word-break: break-word` with `overflow-wrap: anywhere` plus `word-break: normal`.
   - Ensure `max-width: 100%`, `min-width: 0`, and no horizontal overflow.

3. Update plain file text rendering.

   - In `FilesView.vue`, update `.content-text` with the wrapping contract.
   - Keep `.content-body` vertical scrolling. If it still shows horizontal scrollbars due to child sizing, add `overflow-x: hidden` only for the text viewer branch or ensure child `max-width: 100%` is sufficient.

4. Update Markdown code block rendering.

   - In `FormattedContent.vue`, change `.formatted-text :deep(pre)` from `overflow-x: auto` to the wrapping contract.
   - Add matching rules for `.formatted-text :deep(pre code)` so code inherits wrapping.
   - Add wrapping for `.formatted-text :deep(code)`, `.formatted-text :deep(a)`, and Markdown table cells (`th`, `td`) so long inline tokens and table cell values cannot widen the rendered document.

5. Update tool/detail text blocks that use raw `<pre>`.

   - In `DetailSectionRenderer.vue`, the scoped `pre` rule currently has `overflow: auto` without any wrapping properties. Add the wrapping contract properties (`white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; max-width: 100%`).
   - Replace `overflow: auto` with axis-specific overflow: `overflow-x: hidden; overflow-y: auto;`. This preserves vertical scrolling for `maxHeight` sections without reintroducing horizontal scrolling.
   - Explicitly override `.detail-diff code { white-space: pre; }` with `white-space: pre-wrap;`.
   - Apply the same wrapping to `.terminal pre` and `.terminal .stderr`.

6. Audit and update remaining horizontal-scroll text rules.

   Text-surface horizontal overflow risks exist in these locations:

   | File | Rule | Action |
   |---|---|---|
   | `patterns.css` | `.code-block { overflow-x: auto; white-space: pre; }` | Update to wrapping contract (step 1). |
   | `FormattedContent.vue` | `.formatted-text :deep(pre) { overflow-x: auto; }` | Update to wrapping contract (step 4). |
   | `ChatWindow.vue` | `.msg.assistant .msg-content :deep(pre) { overflow-x: auto; }` | Update to wrapping contract. This is a Markdown-rendered message surface, same as `FormattedContent.vue`. |
   | `DetailSectionRenderer.vue` | `pre { overflow: auto; }` (scoped, applies to code/diff/terminal pre) | Update to add wrapping properties (step 5). |
   | `DebugView.vue` tabs | `.debug-tabs { overflow-x: auto; }` (line 459) | **Leave alone** — this is a navigation tab bar, not a text content pane. |

   Additional rules that need a wrapping property (no `overflow-x` but missing `overflow-wrap`):

   | File | Rule | Action |
   |---|---|---|
   | `JsonHighlight.vue` | `.json-hl { white-space: pre-wrap; word-break: break-word; }` | Replace `word-break: break-word` with `overflow-wrap: anywhere; word-break: normal;` and add `max-width: 100%; min-width: 0;` (step 2). |
   | `FilesView.vue` | `.content-text { white-space: pre-wrap; word-break: break-word; }` | Same replacement as `JsonHighlight.vue` (step 3). |
   | `FilesView.vue` | `.note-content { white-space: pre-wrap; }` | Add `overflow-wrap: anywhere; word-break: normal; max-width: 100%; min-width: 0;` so note text follows the same text-pane policy. |
   | `FormattedContent.vue` | `.formatted-text { word-break: break-word; }` | Replace with `overflow-wrap: anywhere; word-break: normal;` so inline long tokens wrap consistently outside fenced code. |
   | `FormattedContent.vue` | `.formatted-text :deep(code)`, `a`, `th`, `td` | Add `overflow-wrap: anywhere; word-break: normal;` so inline code, links, and Markdown tables do not create horizontal overflow. |
   | `ChatWindow.vue` | `.msg-content { word-break: break-word; }` | Replace with `overflow-wrap: anywhere; word-break: normal;` for assistant Markdown text outside fenced code. |
   | `ChatWindow.vue` | `.msg-content :deep(code)`, `a`, `th`, `td` | Match the `FormattedContent.vue` inline/table wrapping rules because `ChatWindow.vue` has its own Markdown styling. |

   Leave intentional one-line UI chrome alone: `.breadcrumbs button`, `.tree-name`, `.agent-tool-status`, `.agent-tool-target`, `.panel-heading`, `.pill`, `.btn` all use `white-space: nowrap` with `text-overflow: ellipsis` or `overflow: hidden` by design.

7. Add browser verification, plus lightweight tests only where useful.

   - Do not rely on Vitest/happy-dom for layout correctness; it cannot prove wrapping at the real display boundary.
   - Add unit tests only for logic affected by the change, such as Markdown rendering behavior if selectors or renderer output change.
   - Use browser/manual verification for actual wrapping and `scrollWidth <= clientWidth` checks.

## Detailed Implementation Notes

### CSS Values

Use this exact policy for text panes:

```css
white-space: pre-wrap;
overflow-wrap: anywhere;
word-break: normal;
tab-size: 2;
max-width: 100%;
min-width: 0;
overflow-x: hidden;
```

Keep existing font, color, padding, and borders unless they directly conflict with wrapping. Preserve vertical scrolling with `overflow-y: auto` where a component uses `maxHeight`; avoid `overflow: auto` shorthand on text panes because it may re-enable horizontal scrolling.

### JSON Behavior

`JsonHighlight.vue` tokenizes `JSON.stringify(data, null, 2)`. Wrapping must not change tokenization or formatting. The rendered text should still preserve indentation and newlines. Long string values should wrap visually inside the panel.

Malformed JSON loaded as `fileContent.type === 'json'` currently passes the original string into `JsonHighlight.vue` because `parseJson()` returns the original content on parse failure. `JsonHighlight.vue` then applies `JSON.stringify()` to that string, so the displayed content becomes a quoted JSON string literal rather than the raw malformed file text. This is pre-existing behavior and not a wrapping requirement, but the plan must not describe it as raw text display. If raw malformed JSON display matters, split that into a separate bug fix or change `FilesView.vue` to render parse failures through the plain text branch.

### Markdown Behavior

Markdown paragraphs already wrap as normal HTML. The risky elements are fenced code blocks, inline code, links, and tables.

- Fenced code blocks should preserve indentation and wrap long lines.
- Inline code should be allowed to break if it is longer than the container.
- Markdown links should wrap even when the URL is a single long token.
- Markdown table cells should wrap long content. Set table/table-cell sizing so a long cell cannot widen the content panel. Do not leave Markdown tables as a deferred follow-up because Markdown files are text files covered by the user requirement.

### Diff Behavior

Diffs are text and should wrap under this requirement. Wrapping diffs may reduce column alignment, but it avoids hiding content behind horizontal scroll. Preserve syntax colors and signs; only change visual wrapping.

### Accessibility

No ARIA changes are required. Wrapping is visual CSS only. Keyboard navigation and copy/paste should continue to operate on the original text content.

### Performance

The backend already truncates file content above 1 MiB in `src/server/file-browser-service.ts`. Wrapping may increase rendered line count for minified files, but the content size cap bounds the worst case. No virtualization is needed for this feature.

## Validation Plan

Run local gates after implementation:

```bash
npm run typecheck
npm run build:web
```

The existing web tests are Vitest/happy-dom unit tests, not browser layout tests. They can check parsing/rendering structure but cannot prove real `scrollWidth`/`clientWidth` wrapping behavior. Use them only for regressions in markdown parsing or component output. The actual wrapping requirement needs browser/manual verification.

Run focused tests if touched logic has existing tests. If no suitable tests exist, perform browser verification with files containing:

- Pretty JSON with a very long string value.
- Minified one-line JSON.
- Plain text/log file with a long unbroken token.
- Markdown file with a fenced code block containing a long line.
- Markdown file with a table cell containing a long unbroken token.
- Tool raw payload JSON in an agent conversation.

Expected result for each: no horizontal scrollbar in the text display area, no layout widening, visible text wraps at the panel edge, vertical scrolling still works, and the relevant content element has `scrollWidth <= clientWidth` in the browser. This last check matters because `overflow-x: hidden` can otherwise hide clipped content while masking the scrollbar.

## Acceptance Criteria

- JSON file content wraps at the visible content boundary.
- Plain text file content wraps at the visible content boundary.
- Markdown code blocks wrap at the visible content boundary.
- Markdown links and table cells wrap at the visible content boundary.
- Long unbroken tokens do not create horizontal scrolling or widen the page.
- Existing newlines and indentation remain visible.
- File tree labels, breadcrumbs, and compact summary rows still use ellipsis where intended.
- `npm run typecheck` and `npm run build:web` pass.

## Future Options

- Add a user-controlled wrap toggle only if operators later need horizontal scrolling for diff/code alignment.
- Add line numbers as a separate feature; wrapping changes line-number semantics and should be designed independently.
- Add virtualized file rendering if large wrapped files become slow despite the current 1 MiB cap.
