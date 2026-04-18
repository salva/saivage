#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("saivage")
  .description("Self-extending autonomous AI agent")
  .version("0.1.0");

// --- Models ---
const models = program.command("models").description("Manage model providers");

models
  .command("list")
  .description("List configured models")
  .action(async () => {
    const { listModels } = await import("./commands/models.js");
    await listModels();
  });

models
  .command("test [model]")
  .description("Test model connectivity")
  .action(async (model?: string) => {
    const { testModels } = await import("./commands/models.js");
    await testModels(model);
  });

// --- Services ---
const services = program
  .command("services")
  .description("Manage MCP services");

services
  .command("list")
  .description("List registered services")
  .action(async () => {
    const { listServices } = await import("./commands/services.js");
    await listServices();
  });

// --- Config ---
const config = program.command("config").description("Configuration");

config
  .command("show")
  .description("Show current configuration")
  .action(async () => {
    const { showConfig } = await import("./commands/config.js");
    await showConfig();
  });

// --- Login (OAuth) ---
program
  .command("login [provider]")
  .description("Authenticate with a model provider via OAuth")
  .action(async (provider?: string) => {
    const { loginCommand } = await import("./commands/login.js");
    await loginCommand(provider);
  });

// --- Chat (interactive CLI) ---
program
  .command("chat")
  .description("Start an interactive CLI chat session")
  .action(async () => {
    const { bootstrap } = await import("./server/bootstrap.js");
    const { ChatAgent } = await import("./agents/chat.js");
    const { CLIChannel } = await import("./channels/cli.js");

    const sys = await bootstrap();
    const channel = new CLIChannel();
    const chat = new ChatAgent({
      channel,
      router: sys.router,
      orchestrator: sys.orchestrator,
      eventBus: sys.eventBus,
      config: sys.config,
    });

    chat.start();
    channel.send("Saivage v0.1.0 — type your message (Ctrl+C to exit)");
    channel.prompt();

    // Re-prompt after each response
    channel.onMessage(() => {
      setTimeout(() => channel.prompt(), 100);
    });

    process.on("SIGINT", async () => {
      chat.stop();
      await sys.orchestrator.stop();
      process.exit(0);
    });
  });

// --- Server ---
program
  .command("serve")
  .description("Start the Saivage server (HTTP + WebSocket)")
  .option("-p, --port <port>", "Port to listen on")
  .option("-H, --host <host>", "Host to bind to")
  .action(async (opts) => {
    const { bootstrap } = await import("./server/bootstrap.js");
    const { startServer } = await import("./server/server.js");

    const sys = await bootstrap();
    await startServer({
      host: opts.host ?? sys.config.server.host,
      port: opts.port ? parseInt(opts.port, 10) : sys.config.server.port,
      config: sys.config,
      router: sys.router,
      orchestrator: sys.orchestrator,
      eventBus: sys.eventBus,
    });
  });

// --- Versions ---
const versions = program.command("versions").description("Version store management");

versions
  .command("list [name]")
  .description("List version snapshots")
  .action(async (name?: string) => {
    const { showVersions } = await import("./commands/versions.js");
    showVersions(name);
  });

versions
  .command("prune [keep]")
  .description("Prune old snapshots (default: keep 5 per service)")
  .action(async (keep?: string) => {
    const { pruneVersions } = await import("./commands/versions.js");
    pruneVersions(keep ? parseInt(keep, 10) : undefined);
  });

// --- Default action: one-shot message or help ---
program
  .argument("[message...]", "Send a one-shot message")
  .action(async (messageParts: string[]) => {
    if (messageParts.length === 0) {
      program.help();
      return;
    }

    const message = messageParts.join(" ");
    const { bootstrap } = await import("./server/bootstrap.js");
    const { ChatAgent } = await import("./agents/chat.js");
    const { OneShotChannel } = await import("./channels/oneshot.js");

    const sys = await bootstrap();
    const channel = new OneShotChannel(message);
    const chat = new ChatAgent({
      channel,
      router: sys.router,
      orchestrator: sys.orchestrator,
      eventBus: sys.eventBus,
      config: sys.config,
    });

    channel.onDone(async () => {
      chat.stop();
      await sys.orchestrator.stop();
      process.exit(0);
    });

    chat.start();
  });

program.parse();
