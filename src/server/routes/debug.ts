import type { FastifyInstance } from "fastify";
import type { KnowledgeStore } from "../../knowledge/init.js";
import { listSkills, readSkillById, listMemories, getMemory } from "../../knowledge/lifecycle.js";
import { loadAllRolePrompts } from "../../agents/prompts.js";
import type {
  DebugErrorEntry,
  DebugTimelineEvent,
} from "../../store/project-store.js";
import type { ProjectContext } from "../../store/project.js";
import type { PlanDocument } from "../../types.js";
import { safeDebugStateResponse } from "../read-models/debug.js";

export interface DebugReads {
  runtimeState(): Promise<unknown>;
  readPlan(): Promise<PlanDocument | null>;
  debugErrors(): Promise<DebugErrorEntry[]>;
  debugTimeline(): Promise<DebugTimelineEvent[]>;
}

export function registerDebugRoutes(
  app: FastifyInstance,
  deps: {
    reads: DebugReads;
    projectConfig: ProjectContext["config"];
    knowledgeStore: KnowledgeStore;
  },
): void {
  app.get("/api/debug/state", async () => {
    const [runtimeState, doc] = await Promise.all([
      deps.reads.runtimeState(),
      deps.reads.readPlan(),
    ]);

    return safeDebugStateResponse({
      runtimeState,
      planDoc: doc,
      projectConfig: deps.projectConfig,
    });
  });

  app.get("/api/debug/errors", async () => {
    const errors = await deps.reads.debugErrors();
    return { errors };
  });

  app.get("/api/debug/prompts", async () => {
    try {
      const prompts = loadAllRolePrompts();
      return { prompts };
    } catch (err) {
      return { prompts: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get("/api/debug/skills", async () => {
    try {
      const skills = await listSkills(deps.knowledgeStore, {
        include_archived: true,
        include_superseded: true,
      });
      return { skills };
    } catch (err) {
      return { skills: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get<{ Params: { id: string } }>("/api/debug/skills/:id", async (req, reply) => {
    try {
      return await readSkillById(deps.knowledgeStore, req.params.id);
    } catch (err) {
      reply.code(404);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get("/api/debug/memories", async () => {
    try {
      const memories = await listMemories(deps.knowledgeStore, {
        include_archived: true,
      });
      return { memories };
    } catch (err) {
      return { memories: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get<{ Params: { id: string } }>("/api/debug/memories/:id", async (req, reply) => {
    try {
      const result = await getMemory(deps.knowledgeStore, { id: req.params.id });
      if (!result) {
        reply.code(404);
        return { error: "memory " + req.params.id + " not found or not active" };
      }
      return result;
    } catch (err) {
      reply.code(404);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get("/api/debug/timeline", async () => {
    const events = await deps.reads.debugTimeline();
    return { events };
  });
}
