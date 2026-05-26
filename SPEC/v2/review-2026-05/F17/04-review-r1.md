# F17 — Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F17-telegram-markdown-converter.md](SPEC/v2/review-2026-05/F17-telegram-markdown-converter.md)
- [SPEC/v2/review-2026-05/F17/01-analysis-r1.md](SPEC/v2/review-2026-05/F17/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F17/02-design-r1.md](SPEC/v2/review-2026-05/F17/02-design-r1.md)
- [SPEC/v2/review-2026-05/F17/03-plan-r1.md](SPEC/v2/review-2026-05/F17/03-plan-r1.md)
- Spot-checks: [src/channels/telegram.ts](src/channels/telegram.ts), [src/server/telegram-bot.ts](src/server/telegram-bot.ts)

## Findings

### Analysis

The problem framing is sound: the converter is module-private, regex-based, and called only by `TelegramChannel.send`; the current code path converts to HTML and then chunks the converted string in [src/channels/telegram.ts](src/channels/telegram.ts#L95-L118). The analysis also correctly identifies length splitting as part of the required contract: chunks must not split inside formatting/code boundaries or multi-byte text ([SPEC/v2/review-2026-05/F17/01-analysis-r1.md](SPEC/v2/review-2026-05/F17/01-analysis-r1.md#L41)).

There is one line-reference correction to make in the next revision: the invocation of `markdownToTelegramHtml` is at [src/channels/telegram.ts](src/channels/telegram.ts#L98), not [src/channels/telegram.ts](src/channels/telegram.ts#L101) as stated in [SPEC/v2/review-2026-05/F17/01-analysis-r1.md](SPEC/v2/review-2026-05/F17/01-analysis-r1.md#L5) and [SPEC/v2/review-2026-05/F17/01-analysis-r1.md](SPEC/v2/review-2026-05/F17/01-analysis-r1.md#L31).

### Design

Proposal A is the right architectural direction: delete the custom converter and use a parser/converter built for Telegram Markdown. That satisfies the no-shim / no-backward-compat guideline and keeps the change local to the Telegram channel surface.

However, the dependency-footprint argument is factually wrong. The design says `telegramify-markdown` is a single named export with `~10 kB, no transitive deps` in [SPEC/v2/review-2026-05/F17/02-design-r1.md](SPEC/v2/review-2026-05/F17/02-design-r1.md#L19), and repeats that it has no dependencies in [SPEC/v2/review-2026-05/F17/02-design-r1.md](SPEC/v2/review-2026-05/F17/02-design-r1.md#L29). `npm view telegramify-markdown@1.3.3 dependencies --json` lists dependencies on `remark-*`, `unified`, `mdast-util-*`, and `unist-util-*`. The recommendation can still choose that package, but the design must be honest about the actual dependency shape because dependency footprint is one of the analysis constraints ([SPEC/v2/review-2026-05/F17/01-analysis-r1.md](SPEC/v2/review-2026-05/F17/01-analysis-r1.md#L43)).

There is also an internal inconsistency in Proposal A's chunking description: [SPEC/v2/review-2026-05/F17/02-design-r1.md](SPEC/v2/review-2026-05/F17/02-design-r1.md#L12) says to convert once and then chunk the result, while [SPEC/v2/review-2026-05/F17/02-design-r1.md](SPEC/v2/review-2026-05/F17/02-design-r1.md#L15) says to split input Markdown first and convert each chunk independently. The next revision should choose one model and carry it consistently into the plan.

### Plan

The plan has a genuine executability gap in the chunking implementation. It first splits source Markdown, then converts each chunk, but if escaping makes the result exceed 4096 characters it hard-cuts the escaped MarkdownV2 string at [SPEC/v2/review-2026-05/F17/03-plan-r1.md](SPEC/v2/review-2026-05/F17/03-plan-r1.md#L52-L59). That fallback can split inside an inline code span, a fenced code block, an emphasis delimiter pair, or immediately after a MarkdownV2 escape backslash. In those cases the chunk can still be invalid Telegram markup, which is the same failure class this issue is meant to remove. It also does not satisfy the analysis constraint that splitting must avoid formatting/code boundaries ([SPEC/v2/review-2026-05/F17/01-analysis-r1.md](SPEC/v2/review-2026-05/F17/01-analysis-r1.md#L41)).

The test plan does not catch that failure mode. The proposed chunking test only uses repeated `x` paragraphs and checks length ([SPEC/v2/review-2026-05/F17/03-plan-r1.md](SPEC/v2/review-2026-05/F17/03-plan-r1.md#L112-L126)); it never exercises escaped-output expansion, code fences, inline code, nested emphasis, or a cut point adjacent to a MarkdownV2 escape. The revision needs tests that fail if the fallback emits syntactically unsafe chunks.

## Required changes

1. Revise Proposal A's dependency-footprint claims to match actual `telegramify-markdown` metadata, or choose a different package whose footprint matches the stated constraint. If `telegramify-markdown` remains the recommendation, explain why its transitive dependency set is acceptable for this CLI.
2. Make the design and plan use one chunking model consistently. The implementation must not hard-cut already-converted MarkdownV2 in a way that can create unbalanced formatting/code or dangling escape sequences.
3. Strengthen the chunking tests to cover escaped-output expansion and structured Markdown boundaries, including at least one long inline-code or fenced-code case and one long formatted/nested-emphasis case.
4. Correct the wrong analysis line reference for the `markdownToTelegramHtml` invocation from [src/channels/telegram.ts](src/channels/telegram.ts#L101) to [src/channels/telegram.ts](src/channels/telegram.ts#L98).

## Strengths

- Correctly identifies the local ownership boundary: the converter is private to [src/channels/telegram.ts](src/channels/telegram.ts), with parse-mode forwarding in [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L60).
- The recommended direction deletes the brittle regex converter instead of wrapping it or preserving old behavior.
- The plan includes the right validation command family for this repo: `npm run typecheck`, focused Vitest, and `npm run build`.

VERDICT: CHANGES_REQUESTED