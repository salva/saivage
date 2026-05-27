# F01 — Markdown Table Rendering — Design + Plan Review r2

Reviewed [03-design-plan-r2.md](03-design-plan-r2.md) only for the five R1 requested fixes, plus a light source spot-check. I did not modify the plan or source code.

## Finding

### 1. CSS deletion citations are still stale in the detailed delete bullets

R2 fixed the summary and implementation-order ranges to [web/src/components/FormattedContent.vue](../../../../web/src/components/FormattedContent.vue#L91-L110) and [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue#L535-L554), but the detailed delete bullets still cite the old offsets.

- [03-design-plan-r2.md](03-design-plan-r2.md#L120-L130) still points the [web/src/components/FormattedContent.vue](../../../../web/src/components/FormattedContent.vue#L91-L110) delete bullets at L93-L112 (`md-h1/h2/h3` at L93-L95 and `md-bullet-text` at L112), while the source currently has the complete legacy block at L91-L110.
- [03-design-plan-r2.md](03-design-plan-r2.md#L194-L205) still points the [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue#L535-L554) delete bullets at L538-L557 (`md-h1/h2/h3` at L538-L540 and `md-bullet-text` at L557), while the source currently has the complete legacy block at L535-L554.

This leaves R1 item 1 only partially addressed. Correct the detailed delete bullets so every cited subrange lines up with the verified source positions: [web/src/components/FormattedContent.vue](../../../../web/src/components/FormattedContent.vue#L91-L110) and [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue#L535-L554).

## Verified R1 Items

- R1 item 2 is addressed: `@types/dompurify` is no longer a fallback and is explicitly forbidden if `vue-tsc` fails; DOMPurify package metadata on disk exposes bundled ESM types via `dist/purify.es.d.mts`.
- R1 item 3 is addressed: the task-list checkbox test only asserts `toContain('type="checkbox"')`, which tolerates attribute order and boolean serialization.
- R1 item 4 is addressed: §7 step 6 adds the post-edit guard `rg -n 'md-' web` and requires no output.
- R1 item 5 is addressed: the `white-space: normal` rationale now mentions blank-line-separated list-item content becoming nested `<p>` blocks.

## Spot Check

The unchanged design direction still matches the disk state: `renderMarkdown` is shared by [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue#L6-L314) and [web/src/components/FormattedContent.vue](../../../../web/src/components/FormattedContent.vue#L4-L74); both wrappers still use `white-space: pre-wrap` at [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue#L494) and [web/src/components/FormattedContent.vue](../../../../web/src/components/FormattedContent.vue#L84); [web/package.json](../../../../web/package.json#L12-L16) still lacks direct `marked` / `dompurify`; and [web/package-lock.json](../../../../web/package-lock.json) has no direct web install of those packages. The plan continues to replace the regex renderer outright, delete legacy `.md-*` hooks, and avoid fallback shims, so it does not regress the project rule requiring clean architecture and no backward compatibility.

VERDICT: CHANGES_REQUESTED