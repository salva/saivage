# F17 — Review r2

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F17/04-review-r1.md](SPEC/v2/review-2026-05/F17/04-review-r1.md)
- [SPEC/v2/review-2026-05/F17/01-analysis-r2.md](SPEC/v2/review-2026-05/F17/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F17/02-design-r2.md](SPEC/v2/review-2026-05/F17/02-design-r2.md)
- [SPEC/v2/review-2026-05/F17/03-plan-r2.md](SPEC/v2/review-2026-05/F17/03-plan-r2.md)
- Spot-checks: [src/channels/telegram.ts](src/channels/telegram.ts), [src/channels/telegram.test.ts](src/channels/telegram.test.ts), [src/server/telegram-bot.ts](src/server/telegram-bot.ts), [package.json](package.json)
- Package metadata checked with `npm view telegramify-markdown@1.3.3 dependencies dist.unpackedSize main types --json` and by inspecting the packed tarball metadata.

## Findings

### Analysis

The analysis now satisfies the r1 correction. The `markdownToTelegramHtml` call site is correctly identified as [src/channels/telegram.ts](src/channels/telegram.ts#L98), and the ownership/call-site summary remains accurate: the converter is private to [src/channels/telegram.ts](src/channels/telegram.ts) and the parse mode is only forwarded by [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L60).

No analysis changes are required.

### Design

Proposal A remains the right direction: delete the custom HTML converter, switch to Telegram MarkdownV2, and keep the channel-local surface small. The r2 design also fixes the largest r1 factual issue by listing the 9 direct `telegramify-markdown@1.3.3` dependencies accurately in [SPEC/v2/review-2026-05/F17/02-design-r2.md](SPEC/v2/review-2026-05/F17/02-design-r2.md#L37-L49).

The dependency-footprint justification is still too factual for the evidence it cites. [SPEC/v2/review-2026-05/F17/02-design-r2.md](SPEC/v2/review-2026-05/F17/02-design-r2.md#L51) says `tsup` will tree-shake ESM, side-effect-free dependencies and estimates an `80–120 kB` minified bundle delta. The packed `telegramify-markdown@1.3.3` package is CommonJS (`module.exports = require('./lib/convert')`) and its types use `export = convert`; npm metadata does not declare `type: module` or `sideEffects: false`. The recommendation can still choose this package, but the design must either measure the post-install bundle delta in this repo or make the footprint argument conservative instead of relying on unverified ESM/tree-shaking claims.

There is also a test-coverage mismatch in the design. [SPEC/v2/review-2026-05/F17/02-design-r2.md](SPEC/v2/review-2026-05/F17/02-design-r2.md#L65) says the tests cover nested emphasis spanning fragments and a very long inline-code span. Plan r2 does not contain those tests; it contains a short nested-emphasis smoke test and a short inline-code preservation test.

### Plan

The core chunking model is materially better than r1. The design and plan now use a single source-side splitting model, and the plan removes the r1 fallback that sliced already-converted MarkdownV2. That addresses the highest-risk executable gap from [SPEC/v2/review-2026-05/F17/04-review-r1.md](SPEC/v2/review-2026-05/F17/04-review-r1.md#L34-L42).

However, the structured-boundary test requirement is not fully met. R1 explicitly required tests for escaped-output expansion plus structured Markdown boundaries, including a long inline-code-or-fenced-code case and a long formatted/nested-emphasis case ([SPEC/v2/review-2026-05/F17/04-review-r1.md](SPEC/v2/review-2026-05/F17/04-review-r1.md#L42)). Plan r2 claims this coverage in [SPEC/v2/review-2026-05/F17/03-plan-r2.md](SPEC/v2/review-2026-05/F17/03-plan-r2.md#L6), and it does add the fenced-code and punctuation-expansion cases. But the nested-emphasis test at [SPEC/v2/review-2026-05/F17/03-plan-r2.md](SPEC/v2/review-2026-05/F17/03-plan-r2.md#L114-L124) is short and never approaches a split boundary, while the inline-code test at [SPEC/v2/review-2026-05/F17/03-plan-r2.md](SPEC/v2/review-2026-05/F17/03-plan-r2.md#L175-L198) explicitly covers only a short inline span.

This is not just a bookkeeping issue. The proposed `splitOversizedBlock` contract splits oversized paragraphs by newline, sentence boundary, whitespace, and finally source code point ([SPEC/v2/review-2026-05/F17/03-plan-r2.md](SPEC/v2/review-2026-05/F17/03-plan-r2.md#L68-L76)). It does not state how inline code, links, or emphasis spans inside an oversized paragraph are kept atomic. That can still split source fragments inside `**...**`, `_..._`, `[...]()` or `` `...` `` when a single formatted paragraph exceeds 4096 after conversion. Feeding each fragment through `telegramifyMarkdown` is safer than slicing converted output, but it is not the same as the plan's promise that fragments are syntactically self-contained ([SPEC/v2/review-2026-05/F17/03-plan-r2.md](SPEC/v2/review-2026-05/F17/03-plan-r2.md#L5)). The implementation plan needs either span-aware splitting for oversized paragraphs or an explicit, tested degradation rule for overlong inline spans.

## Required changes

1. Revise the dependency-footprint paragraph in [SPEC/v2/review-2026-05/F17/02-design-r2.md](SPEC/v2/review-2026-05/F17/02-design-r2.md#L51-L52). Either measure the actual post-install bundle delta for this repo, or replace the ESM/side-effect-free/tree-shaking claim with a conservative statement based on verified package metadata: CommonJS package, 12,951 byte unpacked package, 9 direct dependencies, roughly 40 transitives, actual bundled delta to be validated by `npm run build`.
2. Make [SPEC/v2/review-2026-05/F17/02-design-r2.md](SPEC/v2/review-2026-05/F17/02-design-r2.md#L65) and [SPEC/v2/review-2026-05/F17/03-plan-r2.md](SPEC/v2/review-2026-05/F17/03-plan-r2.md#L6) match the real test strategy. If the plan claims coverage for very long inline code and nested emphasis spanning fragments, add those tests; otherwise remove the claim.
3. Add the missing long formatted/nested-emphasis boundary test required by r1. It should force a split around a formatted paragraph, not just assert that `**bold *italic* end**` converts when it is short. The test should fail if the splitter creates chunks with dangling MarkdownV2 escapes or unbalanced formatting semantics at the cut point.
4. Clarify the oversized-paragraph splitting contract in [SPEC/v2/review-2026-05/F17/03-plan-r2.md](SPEC/v2/review-2026-05/F17/03-plan-r2.md#L68-L76): either make inline code/link/emphasis spans atomic during splitting, or explicitly define and test the fallback behavior when a single inline span is longer than Telegram's limit.

## Strengths

- The line-reference correction from r1 is fixed.
- The design now chooses one chunking model instead of contradicting itself.
- Proposal A still honors the project guideline to delete the brittle converter rather than preserving it behind a shim.
- The plan uses the right validation command family for this repo: `npm run typecheck`, focused Vitest, and `npm run build`.

VERDICT: CHANGES_REQUESTED