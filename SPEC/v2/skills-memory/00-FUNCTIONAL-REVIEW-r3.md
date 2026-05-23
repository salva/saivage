# Phase A — Functional Analysis Review (round 3)

Status: REVIEW
Reviewer: GPT-5.5
Verdict: ACCEPT
Date: 2026-05-23

## Verdict

ACCEPT: the round-2 blocking contradictions are corrected, the new runtime access matrix matches the current code, and no new round-3 regression blocks Phase B.

## Round-2 dispositions audit

| Round-2 disposition | Audit result | Evidence |
|---|---:|---|
| r2-BLOCK: stale `Coder only` in §7 gap matrix | CONFIRMED | The §2.1 row now says skill-write is runtime-granted to Manager/Designer/Chat, not the spec-named Coder, in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1249). The §2.8 row now says every role can call `list_skills` / `read_skill`, with the remaining gap being prompt/instructional, in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1256). |
| r2-WRONG-FIX BLOCK-1 round-log entry | CONFIRMED | The BLOCK-1 rationale now says every role can read skills, skill-write is Manager/Designer/Chat not Coder, and memory/index are unavailable for all roles in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1307-L1314). |
| r2-WRONG-FIX BLOCK-4 round-log entry | CONFIRMED | The BLOCK-4 rationale now states memory/index are registered `{ available: false }`, omitted by `getAllTools()`, and rejected by `callTool()`, regardless of store state, in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1323-L1327). |
| r2-WRONG-FIX FR-31(e) | CONFIRMED | FR-31(e) is now split into two tests: unauthorized skill writes by Manager/Designer/Chat in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L946-L955), and memory/index unavailability for every role in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L956-L961). |
| r2-NOT-APPLIED NB-1 full matrix | CONFIRMED | §1.2.1 now contains the full nine-role by seven-tool-class matrix in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L162-L183), with source notes for the role filter and unavailable registrations in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L164-L171). |
| r2-NB stale `OOS-11` reference in §2.6 | CONFIRMED | The round-3 log says the body citation was reduced to `(§6, OOS-3)` in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1400-L1402). A focused grep found `OOS-11` only in that round-3 disposition line, not as a live body reference. |
| r2-NB §5.11 missing `expires_at` / stale-report wording | CONFIRMED | The disposition is explicitly `ACCEPT-DEFER`, matching the round-2 non-blocking status, with FR-19 and §5.11 carrying the core promotion-path decision in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1403-L1406). |

Confirmed-as-fixed: 7. Not-applied: 0. Wrong-fix: 0.

Stale phrase re-grep: exact stale phrases `only Coder has`, `memory tools are reachable today`, and `hidden when the underlying store is empty` produced no hits. Remaining `Coder only`, `store is empty`, and `OOS-11` hits are allowed contexts: spec discrepancy text in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L132) and [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L187), plus round-3 disposition/finding text in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1380), [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1390), and [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1400).

Status and round marker confirmed: [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L3) is `Status: DRAFT (Phase A, round 3)`, and the round-3 subsection is present in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1378).

## §1.2.1 matrix spot-check

Note: in this checkout, `ROLE_TOOL_FILTER` lives in [src/agents/base.ts](../../../src/agents/base.ts), while [src/mcp/runtime.ts](../../../src/mcp/runtime.ts) supplies the unavailable-service omission/rejection behavior.

- **Planner / skill-read = yes; planner / fs-write = no** — `READ_ONLY_TOOLS` includes `list_skills` and `read_skill` in [src/agents/base.ts](../../../src/agents/base.ts#L970-L973), the planner filter allows `PLAN_TOOLS` / `READ_ONLY_TOOLS` / notes but not `write_file` in [src/agents/base.ts](../../../src/agents/base.ts#L993-L997), and tool schemas are filtered through that function in [src/agents/base.ts](../../../src/agents/base.ts#L605-L611). This matches the planner row in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L175).
- **Manager / skill-write = yes; manager / fs-write = yes** — roles without a `ROLE_TOOL_FILTER` entry get all available tools in [src/agents/base.ts](../../../src/agents/base.ts#L988-L992) and [src/agents/base.ts](../../../src/agents/base.ts#L605-L611). `create_skill` / `update_skill` are active skills tools in [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L1053-L1057), `write_file` is an active filesystem tool in [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L238-L246), and both services are registered active in [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L1159-L1163). This matches [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L176).
- **Coder / skill-write = no; coder / fs-write = yes** — worker-excluded tools include `create_skill` and `update_skill` in [src/agents/base.ts](../../../src/agents/base.ts#L981-L986), and the coder filter excludes only that set in [src/agents/base.ts](../../../src/agents/base.ts#L1008-L1009). Because `write_file` is active and not worker-excluded, the matrix's `fs-write = yes` cell is correct in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L177).
- **Chat / skill-write = yes; chat / fs-write = yes** — `chat` is not present in the `ROLE_TOOL_FILTER` object shown in [src/agents/base.ts](../../../src/agents/base.ts#L992-L1012), so it falls under the unfiltered rule in [src/agents/base.ts](../../../src/agents/base.ts#L988-L992). Active `create_skill`, `update_skill`, and `write_file` registrations back the yes cells in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L183).
- **Memory/index read-write = no for every role** — memory and index tools exist as stubs in [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L1132-L1142) but are registered with `{ available: false }` in [src/mcp/builtins.ts](../../../src/mcp/builtins.ts#L1166-L1168). `getAllTools()` skips unavailable in-process services in [src/mcp/runtime.ts](../../../src/mcp/runtime.ts#L219-L224), and `callTool()` throws for unavailable services in [src/mcp/runtime.ts](../../../src/mcp/runtime.ts#L180-L184). This backs all memory/index `no (unavailable)` cells in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L175-L183).

No checked matrix cell disagreed with the source.

## New regressions

None found.

Focused checks did not find a live broken `OOS-11`, `FR-32`, `UNK-6`, `§2.11`, `§4.10`, or `§5.13` reference. The only remaining `OOS-11` hit is the round-3 disposition noting its removal in [00-FUNCTIONAL-ANALYSIS.md](00-FUNCTIONAL-ANALYSIS.md#L1400). The access matrix does not contradict FR-31(e); both now distinguish unauthorized skill writes from unavailable memory/index tools.

## Sign-off

ACCEPT. Phase B can begin.