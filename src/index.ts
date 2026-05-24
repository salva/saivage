/**
 * Saivage — Main barrel export
 */

// Types
export type {
  ProjectConfig,
  Plan,
  Stage,
  CompletedStage,
  PlanHistory,
  Task,
  TaskList,
  TaskReport,
  StageSummary,
  Escalation,
  UserNote,
  InspectionRequest,
  InspectionReport,
  SystemEvent,
  ChatMessage,
  ChatLog,
  RuntimeState,
  AgentState,
} from "./types.js";

// Store
export {
  readDoc,
  readDocOrNull,
  writeDoc,
  listDir,
  listDocs,
  deleteDoc,
  ensureDir,
} from "./store/documents.js";

export {
  loadProject,
  discoverProject,
  seedProject,
  type ProjectContext,
} from "./store/project.js";

// IDs
export {
  stageId,
  taskId,
  noteId,
  inspectionId,
  chatSessionId,
  agentId,
} from "./ids.js";

// Agents
export { CoderAgent } from "./agents/coder.js";
export { ResearcherAgent } from "./agents/researcher.js";
export { DataAgent } from "./agents/data-agent.js";
export { ReviewerAgent } from "./agents/reviewer.js";
export { DesignerAgent } from "./agents/designer.js";
export { ManagerAgent } from "./agents/manager.js";
export { PlannerAgent } from "./agents/planner.js";
export { InspectorAgent } from "./agents/inspector.js";
export { ChatAgent } from "./agents/chat.js";
export type {
  Agent,
  AgentContext,
  AgentResult,
  AgentRole,
  ManagerInput,
  WorkerInput,
  InspectorInput,
  ChatInput,
} from "./agents/types.js";

// Runtime
export { Dispatcher } from "./runtime/dispatcher.js";
export { EventBus } from "./events/bus.js";
export { PlanService } from "./mcp/plan-server.js";
export { NoteManager } from "./runtime/notes.js";

// Server
export {
  bootstrap,
  runPlanner,
  createChildSpawner,
  type SaivageRuntime,
} from "./server/bootstrap.js";
export { startServer, type ServerOptions } from "./server/server.js";
