import { parseRoundId, roundIdSortKey } from "./round-id";
import type { ConversationEntry, Round, TimelineItem, ToolPair } from "./types";

function warnMissingToolUseId(entry: ConversationEntry): void {
  console.warn(
    `[agents-view] tool entry without toolUseId; dropping. kind=${entry.kind} round=${entry.roundId}`,
  );
}

export function entriesToTimeline(
  entries: ConversationEntry[],
  pendingRoundId: string | null,
): TimelineItem[] {
  const buckets = new Map<string, ConversationEntry[]>();
  for (const entry of entries) {
    const list = buckets.get(entry.roundId);
    if (list) list.push(entry);
    else buckets.set(entry.roundId, [entry]);
  }

  const items: TimelineItem[] = [];
  for (const [id, bucket] of buckets) {
    const earliest = bucket.reduce(
      (acc, e) => (acc === "" || e.timestamp < acc ? e.timestamp : acc),
      "",
    );
    const shape = parseRoundId(id);

    if (shape.kind === "pre" || shape.kind === "compacted") {
      items.push({ kind: "compacted", id, timestamp: earliest, compacted: bucket });
      continue;
    }

    if (shape.kind === "unknown") {
      continue;
    }

    const reasoning: ConversationEntry[] = [];
    const userText: ConversationEntry[] = [];
    const diagnostics: ConversationEntry[] = [];
    const callMap = new Map<string, ToolPair>();
    const orphanPairs: ToolPair[] = [];

    for (const entry of bucket) {
      if (
        entry.kind === "model_issue"
        || entry.kind === "model_repair"
        || entry.kind === "model_recovered"
      ) {
        diagnostics.push(entry);
      } else if (entry.kind === "tool_call") {
        if (!entry.toolUseId) {
          warnMissingToolUseId(entry);
          continue;
        }
        const key = entry.toolUseId;
        const existing = callMap.get(key);
        if (existing) {
          existing.call = entry;
          existing.toolName = entry.toolName ?? existing.toolName;
        } else {
          callMap.set(key, {
            toolUseId: key,
            toolName: entry.toolName ?? "unknown",
            call: entry,
            status: "missing",
          });
        }
      } else if (entry.kind === "tool_result" || entry.kind === "tool_error") {
        if (!entry.toolUseId) {
          warnMissingToolUseId(entry);
          continue;
        }
        const key = entry.toolUseId;
        const existing = callMap.get(key);
        const status: ToolPair["status"] = entry.kind === "tool_error" ? "error" : "ok";
        if (existing) {
          existing.result = entry;
          existing.toolName = existing.toolName ?? entry.toolName ?? "unknown";
          existing.status = status;
        } else {
          orphanPairs.push({
            toolUseId: key,
            toolName: entry.toolName ?? "unknown",
            result: entry,
            status: entry.kind === "tool_error" ? "error" : "orphan",
          });
        }
      } else if (entry.kind === "activity" || (entry.kind === "text" && entry.role === "assistant")) {
        reasoning.push(entry);
      } else if (entry.role === "user" && entry.kind === "text") {
        userText.push(entry);
      } else if (entry.role === "system" && entry.kind === "text") {
        userText.push(entry);
      }
    }

    const toolPairs: ToolPair[] = [...callMap.values(), ...orphanPairs];
    const isCurrentRound = pendingRoundId !== null && pendingRoundId === id;
    for (const pair of toolPairs) {
      if (!pair.result && pair.call && isCurrentRound) pair.status = "pending";
    }

    const modelEntry = reasoning.find((e) => e.modelSpec) ?? bucket.find((e) => e.modelSpec);
    const round: Round = {
      id,
      startedAt: earliest,
      hasAssistant: reasoning.length > 0,
      reasoning,
      toolPairs,
      context: userText,
      diagnostics,
      modelSpec: modelEntry?.modelSpec,
      requestedModelSpec: modelEntry?.requestedModelSpec,
    };

    if (reasoning.length > 0) {
      items.push({ kind: "round", id, timestamp: earliest, round });
    } else if (diagnostics.length > 0 && userText.length === 0 && toolPairs.length === 0) {
      for (const d of diagnostics) {
        items.push({
          kind: "diagnostic",
          id: `${d.timestamp}:${d.kind}:${id}`,
          timestamp: d.timestamp,
          diagnostic: d,
        });
      }
    } else {
      items.push({ kind: "context", id, timestamp: earliest, context: round });
    }
  }

  items.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
    const [at, av] = roundIdSortKey(a.id);
    const [bt, bv] = roundIdSortKey(b.id);
    if (at !== bt) return at - bt;
    return av - bv;
  });

  return items;
}
