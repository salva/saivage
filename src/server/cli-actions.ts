/**
 * Saivage — CLI action layer
 *
 * Side-effect-free home for short-lived runtime commands. The executable
 * entrypoint stays in cli.ts; this module can be imported by tests without
 * commander parsing argv or installing process handlers.
 */

import { resolve } from "node:path";
import { bootstrap, runPlanner, type SaivageRuntime } from "./bootstrap.js";
import type { ToolCallContext } from "../mcp/toolContext.js";
import type { AgentRole } from "../agents/types.js";

export type { SaivageRuntime } from "./bootstrap.js";

/**
 * Build a `ToolCallContext` for operator-driven CLI / server entry
 * points. This is the ONLY call site allowed to set
 * `operatorContext: true`; agent dispatcher and chat slash command
 * builders MUST leave the flag unset so that authorisation paths that
 * grant operator-only privileges cannot be reached by agent traffic.
 */
export function buildOperatorToolContext(args: {
  projectRoot: string;
  agentId: string;
  role?: AgentRole;
  author?: string;
}): ToolCallContext {
  return {
    role: args.role ?? "planner",
    agentId: args.agentId,
    projectRoot: args.projectRoot,
    operatorContext: true,
    ...(args.author ? { author: args.author } : {}),
  };
}

export async function withRuntime(
  projectPath: string | undefined,
  fn: (runtime: SaivageRuntime) => Promise<void>,
): Promise<void> {
  const absolutePath = projectPath ? resolve(projectPath) : undefined;
  let runtime: SaivageRuntime | undefined;

  try {
    runtime = await bootstrap(absolutePath);
    await fn(runtime);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    if (runtime) {
      try {
        await runtime.shutdown();
      } catch (err) {
        console.error(
          `Shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    process.exit(process.exitCode ?? 0);
  }
}

export async function startAction(projectPath?: string): Promise<void> {
  await withRuntime(projectPath, async (runtime) => {
    console.log(`Starting Saivage on ${runtime.project.projectRoot}...`);

    const result = await runPlanner(runtime);

    switch (result.kind) {
      case "success":
        console.log("Plan completed successfully.");
        break;
      case "failure":
        console.error(`Plan failed: ${result.reason}`);
        process.exitCode = 1;
        break;
      case "abort":
        console.log(`Plan aborted: ${result.reason}`);
        break;
      case "escalation":
        console.error("Plan escalated — manual intervention required.");
        process.exitCode = 1;
        break;
    }
  });
}

export interface InspectOptions {
  question?: string[];
}

export async function inspectAction(
  projectPath: string,
  scope: string,
  opts: InspectOptions,
): Promise<void> {
  await withRuntime(projectPath, async (runtime) => {
    const { InspectorAgent } = await import("../agents/inspector.js");
    const { agentId, inspectionId } = await import("../ids.js");

    const reqId = inspectionId();
    const request = {
      id: reqId,
      scope,
      questions: opts.question ?? [scope],
      requested_at: new Date().toISOString(),
      requested_by: "chat" as const,
    };

    const inspectorRoute = runtime.routing.resolve("inspector");
    const ctx = {
      project: runtime.project,
      router: runtime.router,
      mcpRuntime: runtime.mcpRuntime,
      noteManager: runtime.noteManager,
      agentId: agentId(),
      role: "inspector" as const,
      modelSpec: inspectorRoute.modelSpec,
      authProfileKey: inspectorRoute.authProfile,
      accountRef: inspectorRoute.accountRef,
    };

    const inspector = await InspectorAgent.create(ctx, { request });
    const result = await inspector.run();

    if (result.kind === "success") {
      console.log("Inspection complete.");
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.error(`Inspection failed: ${result.kind}`);
      process.exitCode = 1;
    }
  });
}
