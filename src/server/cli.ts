/**
 * Saivage — CLI entry point
 */

import { Command } from "commander";

const PLANNER_SHUTDOWN_TIMEOUT_MS = 30_000;

const program = new Command();

installRecoverableSocketErrorGuard();

program
  .name("saivage")
  .description("Saivage — Autonomous AI agent system")
  .version("2.0.0");

function installRecoverableSocketErrorGuard(): void {
  process.on("uncaughtException", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPIPE" || code === "ECONNRESET") {
      console.warn(
        `[warn] Ignoring recoverable socket error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    console.error(err);
    process.exit(1);
  });
}

// --- Init ---
program
  .command("init <project-path>")
  .description("Initialize a new .saivage/ project directory")
  .option("-n, --name <name>", "Project name")
  .option("-o, --objectives <objectives...>", "Project objectives")
  .action(async (projectPath: string, opts) => {
    const { resolve } = await import("node:path");
    const { seedProject } = await import("../store/project.js");
    const path = resolve(projectPath);

    try {
      const ctx = await seedProject(path, {
        name: opts.name,
        objectives: opts.objectives,
      });
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
      : await discoverProject(process.cwd());

    if (!root) {
      console.error("No .saivage/ project found.");
      process.exitCode = 1;
      return;
    }

    const project = await loadProject(root);
    const plan = await readDocOrNull(project.paths.plan, PlanSchema);
    const state = await readDocOrNull(project.paths.runtimeState, RuntimeStateSchema);

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
    const project = await loadProject(root);
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

    await ensureDir(project.paths.notes);
    const notePath = join(project.paths.notes, `${id}.json`);
    await writeDoc(notePath, note, UserNoteSchema);

    console.log(`Note created: ${id}`);
    if (opts.urgent) {
      console.log("Urgent — the Planner will prioritize this note on its next turn.");
    }
    if (opts.permanent) {
      console.log("This note is permanent and will persist across replans.");
    }
  });

// --- Shutdown Handoff ---
program
  .command("request-shutdown <project-path>")
  .description("Record a shutdown/restart reason for the next Planner session")
  .option("-r, --reason <reason>", "Reason to give the Planner after restart")
  .option("--reason-stdin", "Read the shutdown reason from stdin")
  .option("--requested-by <name>", "Who or what requested the shutdown", "external")
  .action(async (projectPath: string, opts) => {
    const { resolve } = await import("node:path");
    const { loadProject } = await import("../store/project.js");
    const { writeShutdownRequest } = await import("../runtime/shutdown-handoff.js");

    try {
      const project = await loadProject(resolve(projectPath));
      const stdinReason = opts.reasonStdin ? await readAllStdin() : "";
      const reason = String(opts.reason ?? stdinReason).trim();
      if (!reason) {
        console.error("Error: provide --reason or --reason-stdin.");
        process.exitCode = 1;
        return;
      }
      await writeShutdownRequest(project, reason, opts.requestedBy ?? "external");
      console.log(`Shutdown request recorded: ${reason}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
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
        modelSpec: runtime.routing.resolve("inspector").modelSpec,
        authProfileKey: runtime.routing.resolve("inspector").authProfile,
        accountRef: runtime.routing.resolve("inspector").accountRef,
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

      await runtime.shutdown();
    } catch (err) {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
  });

// --- Models ---
program
  .command("models [project-path]")
  .description("List registered providers and their available models")
  .option("--provider <provider>", "Only list models for one provider")
  .action(async (projectPath: string | undefined, opts) => {
    const { resolve } = await import("node:path");
    const { discoverProject } = await import("../store/project.js");
    const { loadConfig } = await import("../config.js");
    const { ModelRouter } = await import("../providers/router.js");

    try {
      const root = projectPath ? resolve(projectPath) : await discoverProject(process.cwd());
      if (root) {
        process.env["PROJECT_ROOT"] = root;
        process.env["SAIVAGE_ROOT"] = resolve(root, ".saivage");
      }

      const config = loadConfig(true, root ?? undefined);
      const router = new ModelRouter(config);
      await router.init();
      const providers = opts.provider ? [opts.provider as string] : router.listProviders();

      for (const provider of providers) {
        const models = await router.listModels(provider);
        console.log(`${provider}${models.length ? ` (${models.length})` : ""}`);
        for (const model of models) console.log(`  ${model}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
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
    const { bootstrap, runPlannerWithRecovery } = await import("./bootstrap.js");
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

      // Start Telegram bot if configured
      let telegramBot: { stop: () => Promise<void> } | undefined;
      if (runtime.config.telegram.botToken) {
        try {
          const { startTelegramBot } = await import("./telegram-bot.js");
          telegramBot = await startTelegramBot(runtime);
          console.log("Telegram bot started.");
        } catch (err) {
          console.error(`Telegram bot failed to start: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Start the planner with recovery loop (auto-restarts after 5min on exit)
      const plannerPromise = runPlannerWithRecovery(runtime).then((result) => {
        console.log(`Planner finished: ${result.kind}`);
      }).catch((err) => {
        console.error(`Planner error: ${err}`);
      });

      // Handle graceful shutdown. Re-entrant SIGINT (operator hits Ctrl+C
      // twice) must not double-call server.close / runtime.shutdown — both
      // are not idempotent and the second call would race the first.
      let shuttingDown = false;
      let forceCount = 0;
      const shutdown = async () => {
        if (shuttingDown) {
          forceCount += 1;
          if (forceCount >= 2) {
            console.log("Force exit requested.");
            process.exit(1);
          }
          console.log("Shutdown already in progress. Press Ctrl+C again to force exit.");
          return;
        }
        shuttingDown = true;
        console.log("\nShutting down...");
        try { await telegramBot?.stop(); } catch (err) {
          console.error(`Telegram stop error: ${err instanceof Error ? err.message : err}`);
        }
        // Cancel and await the planner so its in-flight tool calls/state
        // writes have a chance to finish before we tear down MCP runtime.
        try {
          runtime.plannerControl.requestRestart("shutdown", "system");
        } catch { /* control may not be ready */ }
        await Promise.race([
          plannerPromise,
          new Promise<void>((resolve) => setTimeout(resolve, PLANNER_SHUTDOWN_TIMEOUT_MS).unref()),
        ]);
        try { await server.close(); } catch (err) {
          console.error(`Server close error: ${err instanceof Error ? err.message : err}`);
        }
        try { await runtime.shutdown(); } catch (err) {
          console.error(`Runtime shutdown error: ${err instanceof Error ? err.message : err}`);
        }
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      console.error(
        `Fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });

// --- Login ---
program
  .command("login [project-path]")
  .description("Authenticate with an LLM provider via OAuth")
  .option("--provider <provider>", "OAuth provider ID", "openai-codex")
  .option("--profile <profile>", "Named auth profile to save credentials under")
  .action(async (projectPath: string | undefined, opts) => {
    const { resolve } = await import("node:path");
    const { discoverProject } = await import("../store/project.js");
    const { getOAuthProvider, saveProfile } = await import("../auth/index.js");

    // Resolve project root so auth-profiles.json goes in the right .saivage/
    const root = projectPath
      ? resolve(projectPath)
      : await discoverProject(process.cwd());

    if (root) {
      process.env["PROJECT_ROOT"] = root;
      process.env["SAIVAGE_ROOT"] = resolve(root, ".saivage");
    }

    const providerId = opts.provider as string;
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      const { getOAuthProviders } = await import("../auth/index.js");
      const available = getOAuthProviders().map((p) => p.id).join(", ");
      console.error(`Unknown provider: ${providerId}. Available: ${available}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Logging in with ${provider.name}...`);

    let loginHeaders: Record<string, string> | undefined;
    if (providerId === "github-copilot") {
      try {
        const { loadConfig } = await import("../config.js");
        const cfg = loadConfig();
        const cfgHeaders = (cfg as unknown as { providers?: Record<string, { headers?: Record<string, string> }> })
          .providers?.["github-copilot"]?.headers;
        if (cfgHeaders && Object.keys(cfgHeaders).length > 0) loginHeaders = cfgHeaders;
      } catch {
        // ignore config-load failures; fall back to defaults
      }
    }

    try {
      const { exec: execCallback } = await import("node:child_process");
      const creds = await provider.login({
        onAuth: (info) => {
          console.log(`\nOpen this URL in your browser:\n  ${info.url}\n`);
          if (info.instructions) console.log(info.instructions);
          // Try to open browser automatically
          execCallback(`xdg-open "${info.url}" 2>/dev/null || open "${info.url}" 2>/dev/null || true`);
        },
        onPrompt: async (prompt) => {
          const { createInterface } = await import("node:readline");
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          return new Promise<string>((resolve) => {
            rl.question(prompt.message + " ", (answer) => {
              rl.close();
              resolve(answer);
            });
          });
        },
        onProgress: (msg) => console.log(msg),
      }, { headers: loginHeaders });

      const profileKey = (opts.profile as string | undefined) ?? `${providerId}-${creds.accountId ?? "default"}`;
      await saveProfile(profileKey, {
        type: "oauth",
        provider: providerId,
        access: creds.access,
        refresh: creds.refresh,
        expires: creds.expires,
        accountId: creds.accountId,
        email: creds.email,
      });

      console.log(`\nAuthenticated successfully.`);
      if (creds.email) console.log(`Account: ${creds.email}`);
      console.log(`Credentials saved. Restart the service to pick them up.`);
    } catch (err) {
      console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

// --- Logout ---
program
  .command("logout [project-path]")
  .description("Remove stored OAuth credentials")
  .option("--provider <provider>", "OAuth provider ID to remove")
  .option("--profile <profile>", "Exact auth profile key to remove")
  .action(async (projectPath: string | undefined, opts) => {
    const { resolve } = await import("node:path");
    const { discoverProject } = await import("../store/project.js");
    const { removeProfiles } = await import("../auth/index.js");

    const root = projectPath
      ? resolve(projectPath)
      : await discoverProject(process.cwd());

    if (root) {
      process.env["PROJECT_ROOT"] = root;
      process.env["SAIVAGE_ROOT"] = resolve(root, ".saivage");
    }

    const providerId = opts.provider as string | undefined;
    const profileKey = opts.profile as string | undefined;

    if (profileKey) {
      const n = await removeProfiles((k) => k === profileKey);
      if (n === 0) {
        console.log(`No credentials found for profile ${profileKey}.`);
        return;
      }
      console.log(`Removed credential profile ${profileKey}.`);
    } else if (providerId) {
      const n = await removeProfiles((_, p) => p.provider === providerId);
      if (n === 0) {
        console.log(`No credentials found for ${providerId}.`);
        return;
      }
      console.log(`Removed ${n} credential(s) for ${providerId}.`);
    } else {
      const n = await removeProfiles(() => true);
      if (n === 0) {
        console.log("No stored credentials.");
        return;
      }
      console.log(`Removed all ${n} credential(s).`);
    }

    console.log("Restart the service to apply changes.");
  });

// --- Repo-layout: validate-stage-id ---
program
  .command("validate-stage-id <stage-id>")
  .description(
    "Resolve a stage id against the target project's .saivage/repo-layout.json contract.",
  )
  .option("-p, --project <project-path>", "Project root (defaults to CWD)")
  .action(async (stageId: string, opts: { project?: string }) => {
    const { resolve } = await import("node:path");
    const projectRoot = resolve(opts.project ?? process.cwd());
    const { loadContract } = await import("../repo-layout/contract.js");
    const { validateStageId } = await import("../repo-layout/validate-stage-id.js");

    const result = loadContract(projectRoot);
    if (!result.present) {
      console.log(
        JSON.stringify({ status: "skipped", reason: "contract_absent", stage_id: stageId }),
      );
      return;
    }
    if (result.error) {
      console.error(
        JSON.stringify({ status: "error", reason: "contract_invalid", detail: result.error }),
      );
      process.exitCode = 2;
      return;
    }
    const v = validateStageId(result.contract!, stageId);
    const payload = {
      status: v.topic ? "accepted" : "rejected",
      stage_id: stageId,
      topic: v.topic,
      reason: v.reason,
      matches: v.matches,
    };
    console.log(JSON.stringify(payload));
    if (!v.topic) {
      process.exitCode = 1;
    }
  });

program.parse();

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
