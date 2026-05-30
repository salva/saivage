# G46 — Plan (r4, Design A)

This plan supersedes [03-plan-r3.md](./03-plan-r3.md) only on the round-id consumer audit step raised by [04-review-r3.md](./04-review-r3.md). All other r3 steps — Step 8.4 bucket classifier port through `parseRoundId`, the new `r-compacted-3x` timeline test (Step 6 delta), the ≤300 SFC cap with CSS-extraction fallback (Step 11), and every step inherited from r2 (Steps 1–4, 7–10, 12) — are unchanged.

Assumes G41 ([../G41/APPROVED.md](../G41/APPROVED.md)) has landed, identical to r3.

## Steps changed in r4

### Step 8.4 (boundary invariant grep, revised)

The substantive port from [03-plan-r3.md](./03-plan-r3.md#L9-L48) — bucket classifier reading `parseRoundId(id).kind`, `unknown` buckets dropped, sort tiebreaker via `roundIdSortKey`, pending inference via `parseRoundId(e.roundId).kind === "round"` — is unchanged.

Only the post-port boundary-invariant check moves. Replace the r3 grep block at [03-plan-r3.md](./03-plan-r3.md#L51-L58) with the literal-pattern audit:

```bash
rg -nF \
  -e 'startsWith("r-msg:' \
  -e 'startsWith("r-compacted-' \
  -e 'startsWith("r-pre' \
  -e '=== "r-pre"' \
  -e '/^r(' \
  -e '/^r\d' \
  -e '/^r-msg:' \
  -e '/^r-compacted-' \
  -e 'RegExp("r' \
  -e "RegExp('r" \
  web/src/components/agents/ \
  web/src/composables/ \
  --glob '!web/src/components/agents/round-id.ts'
```

Expected output: zero matches. If any line is reported, the corresponding consumer must be ported to `parseRoundId(id).kind` (or `roundIdSortKey(id)`) before merge.

Pattern coverage rationale is documented in [02-design-r4.md](./02-design-r4.md#L26-L42). Brief summary:

- Patterns 1–3 (`startsWith("r-…`) cover every prefix-style classifier.
- Pattern 4 (`=== "r-pre"`) covers the literal equality test against the synthetic pre-conversation bucket id.
- Patterns 5–8 (`/^r(`, `/^r\d`, `/^r-msg:`, `/^r-compacted-`) cover every anchored regex literal whose body starts with `r`, with or without a capture group, for all three round-id namespaces.
- Patterns 9–10 (`RegExp("r`, `RegExp('r`) cover dynamic `new RegExp("r…")` construction in either quote style.

Smoke-test on the three live anchored forms:

| Live spelling | Caught by |
|---|---|
| `/^r(\d+)$/` | pattern 5 (`/^r(`) |
| `/^r-msg:(\d+)$/` | pattern 7 (`/^r-msg:`) |
| `/^r-compacted-(\d+)$/` | pattern 8 (`/^r-compacted-`) |
| `id.startsWith("r-compacted-")` | pattern 2 |
| `id === "r-pre"` | pattern 4 |

All five caught. The r3 pattern caught only the last two.

### Step 6 (delta) — unchanged from r3

The new `r-compacted-3x` timeline test row from [03-plan-r3.md](./03-plan-r3.md#L60-L86) stands verbatim.

### Step 11 (revised) — unchanged from r3

The ≤300 SFC cap and CSS-extraction fallback from [03-plan-r3.md](./03-plan-r3.md#L88-L111) stand verbatim. No slack; no `≤330`.

## Validation (revised)

From the repo root:

```bash
npm run build:web    # cd web && vite build — must succeed
npm test             # vitest run — must pass src/, tests/, and web/src/**/*.test.ts
```

Per-component size enforcement:

```bash
wc -l web/src/components/agents/*.vue
```

Every `.vue` file must report **≤300 lines**. Anything over triggers the fallback in Step 11; after the fallback every file must still report ≤300 lines.

Round-id consumer audit (widened):

```bash
rg -nF \
  -e 'startsWith("r-msg:' \
  -e 'startsWith("r-compacted-' \
  -e 'startsWith("r-pre' \
  -e '=== "r-pre"' \
  -e '/^r(' \
  -e '/^r\d' \
  -e '/^r-msg:' \
  -e '/^r-compacted-' \
  -e 'RegExp("r' \
  -e "RegExp('r" \
  web/src/components/agents/ \
  web/src/composables/ \
  --glob '!web/src/components/agents/round-id.ts'
```

Must report zero matches. If any match appears, the consumer in question must be ported to `parseRoundId(id).kind` (or `roundIdSortKey(id)`) before merge. The single exempt file is `web/src/components/agents/round-id.ts`, excluded by the `--glob` argument.

Test report (at minimum, unchanged from r3):

- `web/src/components/agents/round-id.test.ts`: 27 strictness cases + 4 sort-ordering assertions. All pass.
- `web/src/components/agents/timeline.test.ts`: 10 r2 cases + 1 "malformed bucket dropped" case = 11 cases. All pass.
- `web/src/composables/useAuthState.test.ts`: existing assertions, all pass.

Manual smoke checks from [03-plan-r1.md](./03-plan-r1.md) §"Validation" (Agents tab, agent selection, session selection, agent finish closeout, `open-file` bubbling) are retained verbatim.

## Rollback

`git checkout -- web/src/App.vue web/src/api/types.ts vitest.config.ts && git clean -fd web/src/components/agents web/src/composables/useAgentRoster.ts web/src/composables/useAgentConversation.ts web/src/composables/useChatSessions.ts && git checkout HEAD -- web/src/components/AgentsView.vue` restores the pre-change state. Unchanged from r3.

## Files touched (delta vs r3)

No source-file delta vs r3. The r4 change is documentation-only: the validation audit command in this plan is widened from a fragile `grep -E` alternation to a literal-pattern `rg -F` invocation. The `timeline.ts` port, the `timeline.test.ts` new case, and the SFC cap remain as r3 specified them.

No new dependencies. No `web/package.json` script changes. No `jsdom`. `ripgrep` (`rg`) is already required by the saivage repo tooling (see existing usage in `package.json` scripts and CI); no additional install step.
