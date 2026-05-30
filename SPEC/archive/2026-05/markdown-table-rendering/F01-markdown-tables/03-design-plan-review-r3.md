# F01 — Markdown Table Rendering — Design + Plan Review r3

Reviewed [03-design-plan-r3.md](03-design-plan-r3.md) against current disk content under `/home/salva/g/ml/saivage` using `rg -n` on [web/src/components/FormattedContent.vue](../../../../web/src/components/FormattedContent.vue) and [web/src/components/ChatWindow.vue](../../../../web/src/components/ChatWindow.vue). I did not modify the plan or source code.

## Findings

### 1. §3b kept `strong` / `em` citation is stale

[03-design-plan-r3.md](03-design-plan-r3.md#L227-L229) cites the kept `.msg.assistant .msg-content :deep(strong)` / `:deep(em)` rules as [web/src/components/ChatWindow.vue#L536-L537](../../../../web/src/components/ChatWindow.vue#L536-L537). Disk has those rules at [web/src/components/ChatWindow.vue#L533-L534](../../../../web/src/components/ChatWindow.vue#L533-L534); [web/src/components/ChatWindow.vue#L536-L537](../../../../web/src/components/ChatWindow.vue#L536-L537) are `.md-h2` / `.md-h3`.

### 2. §3b user/system CSS range is incomplete

[03-design-plan-r3.md](03-design-plan-r3.md#L221-L225) cites the user/system `.msg-content` branches as [web/src/components/ChatWindow.vue#L500-L509](../../../../web/src/components/ChatWindow.vue#L500-L509). Disk has the full user/system CSS blocks at [web/src/components/ChatWindow.vue#L498-L508](../../../../web/src/components/ChatWindow.vue#L498-L508); the cited range omits the `.msg.user .msg-content` selector and `border-color` line.

## Verified

- R2's blocker is fixed for the per-rule DELETE bullets: `FormattedContent.vue` cites [web/src/components/FormattedContent.vue#L91-L110](../../../../web/src/components/FormattedContent.vue#L91-L110) correctly, and `ChatWindow.vue` cites [web/src/components/ChatWindow.vue#L535-L554](../../../../web/src/components/ChatWindow.vue#L535-L554) correctly.
- R1 accepted fixes remain present: no `@types/dompurify` fallback, task-list test asserts only `type="checkbox"`, §7 has the `rg -n 'md-' web` guard, and the `white-space: normal` rationale includes the nested-`<p>` list-item note.
- The plan still complies with the workspace clean-code rule: it replaces the renderer outright, deletes `.md-*` hooks, says no fallback / no migration shim, and does not add backward-compat staging.

VERDICT: CHANGES_REQUESTED