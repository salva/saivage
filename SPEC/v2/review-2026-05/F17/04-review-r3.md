# F17 - Review r3

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F17/04-review-r2.md](SPEC/v2/review-2026-05/F17/04-review-r2.md)
- [SPEC/v2/review-2026-05/F17/01-analysis-r2.md](SPEC/v2/review-2026-05/F17/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F17/02-design-r3.md](SPEC/v2/review-2026-05/F17/02-design-r3.md)
- [SPEC/v2/review-2026-05/F17/03-plan-r3.md](SPEC/v2/review-2026-05/F17/03-plan-r3.md)
- Context spot-checks: [SPEC/v2/review-2026-05/F17-telegram-markdown-converter.md](SPEC/v2/review-2026-05/F17-telegram-markdown-converter.md), [SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05/00-SUBSYSTEM-MAP.md), [src/channels/telegram.ts](src/channels/telegram.ts), [src/channels/telegram.test.ts](src/channels/telegram.test.ts), [src/server/telegram-bot.ts](src/server/telegram-bot.ts), [package.json](package.json), [tsconfig.json](tsconfig.json)
- Package metadata spot-checks: `npm view telegramify-markdown@1.3.3 main types dependencies dist.unpackedSize type sideEffects --json`, plus packed tarball entrypoint/types inspection.

## Findings

### Analysis

The r2 analysis remains acceptable and no r3 analysis revision was needed. It correctly scopes the custom converter to [src/channels/telegram.ts](src/channels/telegram.ts#L38-L82), identifies the single conversion call in [src/channels/telegram.ts](src/channels/telegram.ts#L98), and keeps the failure contract tied to the Telegram send path in [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L55-L65). The out-of-scope boundary from the subsystem map is still respected; the proposed work touches only channel, bot wiring, tests, and package metadata.

### Design

Design r3 resolves the remaining r2 design blockers. The dependency-footprint section removes the unsupported ESM/tree-shaking/bundle-size prediction and now states only verified facts about `telegramify-markdown`: CommonJS entrypoint, `export =` types, no declared `type` or `sideEffects`, 12,951-byte unpacked package size, 9 direct dependencies, and approximately 40 transitives ([SPEC/v2/review-2026-05/F17/02-design-r3.md](SPEC/v2/review-2026-05/F17/02-design-r3.md#L5), [SPEC/v2/review-2026-05/F17/02-design-r3.md](SPEC/v2/review-2026-05/F17/02-design-r3.md#L39-L43)). I spot-checked the package metadata and tarball entrypoint; the CommonJS/export facts are accurate.

The chunking design is now one consistent model: split source Markdown into block and span-aware fragments, convert each fragment independently, and never slice converted MarkdownV2 ([SPEC/v2/review-2026-05/F17/02-design-r3.md](SPEC/v2/review-2026-05/F17/02-design-r3.md#L24-L35)). The previously missing oversized-paragraph rule is also explicit: inline code, links, and emphasis are atomic during normal packing, while a single over-limit span degrades via source-side hard-cut with formatting preservation intentionally surrendered for deliverability ([SPEC/v2/review-2026-05/F17/02-design-r3.md](SPEC/v2/review-2026-05/F17/02-design-r3.md#L31-L35)). That is an acceptable engineering tradeoff and is documented clearly enough for implementation.

Proposal A remains the right recommendation. It deletes the brittle regex converter instead of preserving it behind compatibility code, avoids replacing it with another full hand-rolled MarkdownV2 escaper, and keeps the blast radius local ([SPEC/v2/review-2026-05/F17/02-design-r3.md](SPEC/v2/review-2026-05/F17/02-design-r3.md#L155-L163)).

### Plan

Plan r3 is executable and now matches the design. The edit steps cover the dependency install, package lock refresh, channel rewrite, parse-mode type change, bot send function update, tests, validation commands, rollback, and cross-issue ordering ([SPEC/v2/review-2026-05/F17/03-plan-r3.md](SPEC/v2/review-2026-05/F17/03-plan-r3.md#L13-L15), [SPEC/v2/review-2026-05/F17/03-plan-r3.md](SPEC/v2/review-2026-05/F17/03-plan-r3.md#L17-L104), [SPEC/v2/review-2026-05/F17/03-plan-r3.md](SPEC/v2/review-2026-05/F17/03-plan-r3.md#L273-L290)). The default-import caveat is reasonable because the repo has `esModuleInterop` enabled in [tsconfig.json](tsconfig.json#L14), and the plan explicitly lets typecheck settle the exact import form if the CommonJS `export =` declaration needs adjustment.

The r2 test-coverage mismatch is fixed. Plan r3 adds the long nested-emphasis boundary case, the many-inline-code-spans boundary case, and the worst-case single-span degradation case ([SPEC/v2/review-2026-05/F17/03-plan-r3.md](SPEC/v2/review-2026-05/F17/03-plan-r3.md#L178-L255)). The test list and validation commands now match the design's risk section and use the repo's expected Vitest/typecheck/build workflow ([SPEC/v2/review-2026-05/F17/03-plan-r3.md](SPEC/v2/review-2026-05/F17/03-plan-r3.md#L270-L281)).

## Required changes

## Strengths

- The r3 revision directly addresses every r2 blocker without widening the issue scope.
- The package-footprint argument is now conservative and evidence-based.
- The source-side splitter contract is specific enough to implement and test.
- The test strategy targets the actual failure class: expanded escapes, fenced/code boundaries, formatted spans, and deterministic degradation for pathological spans.

VERDICT: APPROVED