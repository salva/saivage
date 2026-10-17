import { buildToolDisplay } from "../../utils/toolDisplay";
import type { ToolGroup, ToolListItem, ToolPair } from "./types";

function groupKey(pair: ToolPair): string | null {
  if (pair.status !== "ok") return null;
  const display = buildToolDisplay(pair);
  if (!display.groupable || display.mutation || display.important) return null;
  if (display.category === "filesystem") return "context";
  if (display.category === "web") return "web";
  if (display.category === "git") return "git";
  if (display.category === "plan" || display.category === "stage_artifact") return "plan";
  if (display.category === "skill" || display.category === "memory" || display.category === "rag") return "context";
  return null;
}

function groupLabel(key: string): string {
  switch (key) {
    case "web": return "Web research";
    case "git": return "Checked git";
    case "plan": return "Read plan";
    default: return "Gathered context";
  }
}

function summarize(pairs: ToolPair[]): string {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const action = buildToolDisplay(pair).action;
    counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  return [...counts.entries()].map(([action, count]) => `${count} ${action}`).join(", ");
}

function makeGroup(roundId: string, key: string, pairs: ToolPair[]): ToolGroup {
  return {
    kind: "tool_group",
    id: `${roundId}:group:${key}:${pairs.map((pair) => pair.toolUseId).join("|")}`,
    label: groupLabel(key),
    summary: summarize(pairs),
    pairs,
    status: "ok",
  };
}

export function groupToolPairs(roundId: string, pairs: ToolPair[]): ToolListItem[] {
  const result: ToolListItem[] = [];
  let activeKey: string | null = null;
  let active: ToolPair[] = [];

  function flush() {
    if (active.length === 0) return;
    if (active.length >= 2 && activeKey) result.push(makeGroup(roundId, activeKey, active));
    else result.push(...active);
    active = [];
    activeKey = null;
  }

  for (const pair of pairs) {
    const key = groupKey(pair);
    if (!key) {
      flush();
      result.push(pair);
      continue;
    }
    if (activeKey !== key) flush();
    activeKey = key;
    active.push(pair);
  }
  flush();
  return result;
}

export function isToolGroup(item: ToolListItem): item is ToolGroup {
  return "kind" in item && item.kind === "tool_group";
}
