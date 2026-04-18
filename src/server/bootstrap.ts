/**
 * Bootstrap — wires all pieces together and starts Saivage.
 */
import { loadConfig, type SaivageConfig } from "../config.js";
import { ModelRouter } from "../providers/router.js";
import { EventBus } from "../orchestrator/eventBus.js";
import { McpRuntime } from "../mcp/runtime.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { ensureBuiltinServices } from "../mcp/builtins.js";
import {
  orchestratorTools,
  createOrchestratorToolHandler,
} from "../orchestrator/mcpService.js";
import {
  telemetryTools,
  createTelemetryToolHandler,
} from "../telemetry/mcpService.js";
import { startMetricsCollector } from "../telemetry/metrics.js";
import { getOAuthApiKey, hasOAuthCredentials } from "../auth/index.js";
import { TelegramBot } from "./telegram.js";
import { log } from "../log.js";
import { cleanStash } from "../agents/stash.js";

export interface SaivageRuntime {
  config: SaivageConfig;
  router: ModelRouter;
  eventBus: EventBus;
  runtime: McpRuntime;
  orchestrator: Orchestrator;
  telegramBot?: TelegramBot;
}

export async function bootstrap(): Promise<SaivageRuntime> {
  const config = loadConfig();
  log.info("Config loaded");

  // Expose key paths as env vars so MCP service subprocesses can inherit them
  process.env["SAIVAGE_ROOT"] = process.cwd();
  if (config.project.root) {
    process.env["PROJECT_ROOT"] = config.project.root;
  }

  const router = new ModelRouter(config);

  // Pre-inject OAuth tokens for providers that have stored credentials
  const oauthMap: Record<string, string> = {
    "openai-codex": "openai-codex",
    "anthropic": "anthropic",
    "github-copilot": "github-copilot",
  };
  for (const providerName of router.listProviders()) {
    const oauthId = oauthMap[providerName] ?? providerName;
    if (hasOAuthCredentials(oauthId)) {
      const key = await getOAuthApiKey(oauthId);
      const provider = router.getProvider(providerName);
      if (key && provider?.setApiKey) {
        provider.setApiKey(key);
        log.info(`OAuth credentials loaded for ${providerName}`);
      }
    }
  }

  log.info(`Providers: ${router.listProviders().join(", ")}`);

  const eventBus = new EventBus();
  const runtime = new McpRuntime(config.runtime);

  // Ensure built-in services are registered
  ensureBuiltinServices();

  const orchestrator = new Orchestrator({ config, router, runtime, eventBus });
  await orchestrator.start();

  // Register orchestrator tools as in-process service (no subprocess)
  runtime.registerInProcess(
    "orchestrator",
    orchestratorTools,
    createOrchestratorToolHandler(orchestrator),
  );

  // Register telemetry tools as in-process service
  runtime.registerInProcess(
    "telemetry",
    telemetryTools,
    createTelemetryToolHandler(),
  );

  // Start telemetry collector
  if (config.telemetry.enabled) {
    startMetricsCollector(config.telemetry.intervalMs);
  }

  // Clean stale stash files on startup
  cleanStash();

  // Start Telegram bot if configured
  let telegramBot: TelegramBot | undefined;
  if (config.telegram.botToken) {
    telegramBot = new TelegramBot({
      botToken: config.telegram.botToken,
      allowedUserIds: config.telegram.allowedUserIds,
      config,
      router,
      orchestrator,
      eventBus,
    });
    await telegramBot.start();
  }

  return { config, router, eventBus, runtime, orchestrator, telegramBot };
}
