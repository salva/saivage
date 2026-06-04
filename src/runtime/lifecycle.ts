import { writeFileSync } from "node:fs";

import type { EventBus } from "../events/bus.js";
import type { KnowledgeStore } from "../knowledge/init.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { RagManager } from "../rag/index.js";
import { log } from "../log.js";
import type { ProjectContext } from "../store/project.js";
import { createRuntimeState, writeRuntimeState, type RuntimeLock, type RuntimeTracker } from "./recovery.js";
import { writeShutdownSummary } from "./shutdown-handoff.js";
import type { RuntimeSupervisor } from "./supervisor.js";

export interface RuntimeLifecycleDeps {
  project: ProjectContext;
  tracker: RuntimeTracker;
  mcpRuntime: McpRuntime;
  knowledgeStore: KnowledgeStore;
  ragManager: RagManager;
  eventBus: EventBus;
  runtimeLock: RuntimeLock;
  getSupervisor: () => RuntimeSupervisor | null;
}

let fatalHandlersInstalled = false;

export class RuntimeLifecycle {
  private shutdownStarted = false;

  constructor(private readonly deps: RuntimeLifecycleDeps) {}

  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return;
    this.shutdownStarted = true;

    const { project, tracker, mcpRuntime, knowledgeStore, ragManager, eventBus, runtimeLock } = this.deps;
    log.info("[v2] Shutting down...");
    // Freeze the tracker FIRST so any agent activity callbacks firing during
    // teardown cannot race the final "idle" write below.
    tracker.freeze("shutdown");
    try {
      await writeShutdownSummary(project);
    } catch (err) {
      log.warn(`[shutdown] Failed to save shutdown summary: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.deps.getSupervisor()?.stop();
    await mcpRuntime.shutdown();
    knowledgeStore.sidecar.close();
    await ragManager.close();
    eventBus.clear();
    const finalState = createRuntimeState();
    finalState.status = "idle";
    await writeRuntimeState(project.paths.runtimeState, finalState);
    runtimeLock.release();
    log.info("[v2] Shutdown complete");
  }

  installFatalHandlers(): void {
    if (fatalHandlersInstalled) return;
    fatalHandlersInstalled = true;

    const onFatal = (label: string) => (err: unknown) => {
      const { project, tracker, runtimeLock } = this.deps;
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      log.error(`[fatal] ${label}: ${msg}`);
      try {
        tracker.freeze(label);
      } catch { /* ignore */ }
      try {
        const failState = createRuntimeState();
        failState.status = "error";
        // Sync write: fatal handlers cannot reliably await async persistence.
        writeFileSync(
          project.paths.runtimeState,
          JSON.stringify(failState, null, 2),
          "utf-8",
        );
      } catch (writeErr) {
        log.warn(`[fatal] Failed to mark runtime state as error: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
      }
      try { runtimeLock.release(); } catch { /* ignore */ }
      // Exit on next tick so the log line has a chance to flush.
      setImmediate(() => process.exit(1));
    };

    process.on("uncaughtException", onFatal("uncaughtException"));
    process.on("unhandledRejection", onFatal("unhandledRejection"));
  }
}
