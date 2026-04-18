/**
 * Saivage — CLI entry point
 */

import { Command } from "commander";

const program = new Command();

program
  .name("saivage")
  .description("Saivage — Autonomous AI agent system")
  .version("2.0.0");

// --- Init ---
program
  .command("init <project-path>")
  .description("Initialize a new .saivage/ project directory")
  .option("-n, --name <name>", "Project name")
  .option("-o, --objectives <objectives...>", "Project objectives")
  .action(async (projectPath: string, opts) => {
    const { resolve } = await import("node:path");
    const { initProject } = await import("../store/project.js");
    const path = resolve(projectPath);

    const config = {
      project_name: opts.name ?? "my-project",
      objectives: opts.objectives ?? [],
      provider: "openai-codex/gpt-5.3-codex",
      notifications: {
        channels: [] as ("telegram" | "web")[],
        filters: {
          min_severity: "warning" as const,
          categories: [] as (
            | "stage_completed"
            | "stage_failed"
            | "escalation"
            | "task_failed"
            | "inspector_complete"
            | "plan_updated"
          )[],
        },
      },
      skills: { max_per_agent: 5 },
    };

    try {
      const ctx = initProject(path, config);
      console.log(`Initialized project at ${ctx.saivageDir}`);
    } catch (err) {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
  });

// --- Start ---
program
  .command("start [project-path]")
  .description("Start the autonomous execution loop")
  .action(async (projectPath?: string) => {
    const { resolve } = await import("node:path");
    const { bootstrap, runPlanner } = await import("./bootstrap.js");

    const path = projectPath ? resolve(projectPath) : undefined;

    let runtime;
    try {
      runtime = await bootstrap(path);
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
          console.error(`Plan escalated — manual intervention required.`);
          process.exitCode = 1;
          break;
      }
    } catch (err) {
      console.error(
        `Fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    } finally {
      await runtime?.shutdown();
    }
  });

// --- Status ---
program
  .command("status [project-path]")
  .description("Show current plan, stage, and task status")
  .action(async (projectPath?: string) => {
    const { resolve } = await import("node:path");
    const { discoverProject, loadProject } = await import("../store/project.js");
    const { readDocOrNull } = await import("../store/documents.js");
    const { PlanSchema, RuntimeStateSchema } = await import("../types.js");

    const root = projectPath
      ? resolve(projectPath)
      : discoverProject(process.cwd());

    if (!root) {
      console.error("No .saivage/ project found.");
      process.exitCode = 1;
      return;
    }

    const project = loadProject(root);
    const plan = readDocOrNull(project.paths.plan, PlanSchema);
    const state = readDocOrNull(project.paths.runtimeState, RuntimeStateSchema);

    console.log(`Project: ${project.config.project_name}`);
    console.log(`Root: ${project.projectRoot}`);
    console.log();

    if (!plan) {
      console.log("No plan exists. Run 'saivage start' to begin.");
      return;
    }

    console.log(`Current Stage: ${plan.current_stage_id ?? "(none)"}`);
    console.log(`Stages: ${plan.stages.length}`);
    for (const stage of plan.stages) {
      const marker = stage.id === plan.current_stage_id ? " ← current" : "";
      console.log(`  ${stage.id}: ${stage.objective.slice(0, 60)}${marker}`);
    }

    if (state) {
      console.log();
      console.log(`Runtime: ${state.status} (PID: ${state.pid})`);
    }
  });

// --- Note ---
program
  .command("note <project-path> <message...>")
  .description("Create a user note for the Planner")
  .option("-p, --permanent", "Make the note permanent")
  .option("-u, --urgent", "Make the note urgent (aborts current work)")
  .action(async (projectPath: string, messageParts: string[], opts) => {
    const { resolve, join } = await import("node:path");
    const { discoverProject, loadProject } = await import("../store/project.js");
    const { writeDoc, ensureDir } = await import("../store/documents.js");
    const { noteId } = await import("../ids.js");
    const { UserNoteSchema } = await import("../types.js");

    const root = resolve(projectPath);
    const project = loadProject(root);
    const content = messageParts.join(" ");
    const id = noteId();

    const note = {
      id,
      channel: "cli",
      session_id: "cli",
      content,
      created_at: new Date().toISOString(),
      permanent: opts.permanent ?? false,
      urgent: opts.urgent ?? false,
    };

    ensureDir(project.paths.notes);
    const notePath = join(project.paths.notes, `${id}.json`);
    writeDoc(notePath, note, UserNoteSchema);

    console.log(`Note created: ${id}`);
    if (opts.urgent) {
      console.log("⚠ Urgent — the runtime will abort current work and replan.");
    }
    if (opts.permanent) {
      console.log("This note is permanent and will persist across replans.");
    }
  });

// --- Inspect ---
program
  .command("inspect <project-path> <scope>")
  .description("Dispatch the Inspector from CLI")
  .option("-q, --question <questions...>", "Questions to investigate")
  .action(async (projectPath: string, scope: string, opts) => {
    const { resolve } = await import("node:path");
    const { bootstrap } = await import("./bootstrap.js");
    const { InspectorAgent } = await import("../agents/inspector.js");
    const { agentId, inspectionId } = await import("../ids.js");

    try {
      const runtime = await bootstrap(resolve(projectPath));

      const reqId = inspectionId();
      const request = {
        id: reqId,
        scope,
        questions: opts.question ?? [scope],
        requested_at: new Date().toISOString(),
        requested_by: "chat" as const,
      };

      const ctx = {
        project: runtime.project,
        router: runtime.router,
        mcpRuntime: runtime.mcpRuntime,
        agentId: agentId(),
        role: "inspector" as const,
        modelSpec: runtime.project.config.provider ?? "openai-codex/gpt-5.3-codex",
      };

      const inspector = new InspectorAgent(ctx, { request });
      const result = await inspector.run();

      if (result.kind === "success") {
        console.log("Inspection complete.");
        console.log(JSON.stringify(result.data, null, 2));
      } else {
        console.error(`Inspection failed: ${result.kind}`);
        process.exitCode = 1;
      }

      await runtime.shutdown();
    } catch (err) {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
  });

// --- Serve ---
program
  .command("serve [project-path]")
  .description("Start web server with API and WebSocket chat")
  .option("-p, --port <port>", "Port number")
  .option("-H, --host <host>", "Host to bind")
  .action(async (projectPath: string | undefined, opts) => {
    const { resolve } = await import("node:path");
    const { bootstrap, runPlanner } = await import("./bootstrap.js");
    const { startServer } = await import("./server.js");

    const path = projectPath ? resolve(projectPath) : undefined;

    try {
      const runtime = await bootstrap(path);

      // CLI flags override config, which has its own schema defaults (8080 / 0.0.0.0)
      const port = opts.port ? parseInt(opts.port, 10) : runtime.config.server.port;
      const host = opts.host ?? runtime.config.server.host;

      const server = await startServer(runtime, { port, host });

      console.log(`Saivage server running on ${host}:${port}`);
      console.log(`Project: ${runtime.project.projectRoot}`);

      // Start the planner in the background (does NOT shut down the runtime)
      runPlanner(runtime).then((result) => {
        console.log(`Planner finished: ${result.kind}`);
      }).catch((err) => {
        console.error(`Planner error: ${err}`);
      });

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log("\nShutting down...");
        await server.close();
        await runtime.shutdown();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      console.error(
        `Fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
  });

program.parse();
