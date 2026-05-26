import type { ConversationEntry } from "../../api/types";

export type { ConversationEntry } from "../../api/types";

export type SelectionKind = "agent" | "chat";

export type ToolPairStatus = "pending" | "ok" | "error" | "orphan" | "missing";

export interface ToolPair {
  toolUseId: string;
  toolName: string;
  call?: ConversationEntry;
  result?: ConversationEntry;
  status: ToolPairStatus;
}

export interface Round {
  id: string;
  startedAt: string;
  hasAssistant: boolean;
  reasoning: ConversationEntry[];
  toolPairs: ToolPair[];
  context: ConversationEntry[];
  diagnostics: ConversationEntry[];
  modelSpec?: string;
  requestedModelSpec?: string;
}

export type TimelineItem =
  | { kind: "round"; id: string; timestamp: string; round: Round }
  | { kind: "diagnostic"; id: string; timestamp: string; diagnostic: ConversationEntry }
  | { kind: "context"; id: string; timestamp: string; context: Round }
  | { kind: "compacted"; id: string; timestamp: string; compacted: ConversationEntry[] };
