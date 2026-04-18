/**
 * MCP Generator Pipeline
 *
 * Full flow: analyse → design → scaffold → implement → test → register.
 * Triggered when an agent reports a missing tool.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import type { ModelRouter } from "../providers/router.js";
import { parseModelId } from "../providers/types.js";
import { scaffoldService, type ServiceSpec } from "./scaffold.js";
import { generateCode } from "./codegen.js";
import { validateService, type TestResult } from "./tester.js";
import { registerService, type ServiceEntry } from "../mcp/registry.js";
import { log } from "../log.js";

export interface GeneratorRequest {
  /** Description of the needed capability */
  description: string;
  /** Optional: specific tool name that was missing */
  missingTool?: string;
  /** Optional: context about what the agent was trying to do */
  context?: string;
}

export interface GeneratorResult {
  success: boolean;
  serviceName?: string;
  servicePath?: string;
  error?: string;
  attempts: number;
}

const GENERATED_SERVICES_DIR = join(homedir(), ".saivage", "services");
const MAX_FIX_ATTEMPTS = 3;

/**
 * Run the full MCP Generator pipeline.
 */
export async function runGeneratorPipeline(
  router: ModelRouter,
  request: GeneratorRequest,
): Promise<GeneratorResult> {
  log.info(`Generator pipeline starting: "${request.description}"`);
  let attempts = 0;

  try {
    // Phase 1: Analyse & Design — ask the LLM to produce a ServiceSpec
    const spec = await designService(router, request);
    log.info(`Designed service "${spec.name}" with ${spec.tools.length} tools`);

    // Phase 2: Scaffold
    mkdirSync(GENERATED_SERVICES_DIR, { recursive: true });
    const servicePath = scaffoldService(GENERATED_SERVICES_DIR, spec);
    log.info(`Scaffolded at ${servicePath}`);

    // Phase 3: Implement + Test loop
    const sourceFile = join(servicePath, "src", "index.ts");
    let lastTestResult: TestResult | undefined;

    for (attempts = 1; attempts <= MAX_FIX_ATTEMPTS; attempts++) {
      // Generate/fix code
      await generateCode(router, {
        servicePath,
        sourceFile,
        spec,
      });

      // Validate
      lastTestResult = await validateService(servicePath);
      if (lastTestResult.passed) break;

      if (attempts < MAX_FIX_ATTEMPTS) {
        log.info(
          `Attempt ${attempts} failed (${lastTestResult.phase}), retrying with error context`,
        );
        // Feed the error back to the LLM on next iteration
        // (generateCode will re-read the file, and the pipeline loops)
      }
    }

    if (!lastTestResult?.passed) {
      return {
        success: false,
        error: `Failed after ${attempts} attempts: ${lastTestResult?.output.slice(0, 500)}`,
        attempts,
      };
    }

    // Phase 4: Register
    registerGeneratedService(spec, servicePath);
    log.info(`Registered service "${spec.name}"`);

    return {
      success: true,
      serviceName: spec.name,
      servicePath,
      attempts,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Generator pipeline failed: ${msg}`);
    return { success: false, error: msg, attempts };
  }
}

/**
 * Use the LLM to design the service specification from a description.
 */
async function designService(
  router: ModelRouter,
  request: GeneratorRequest,
): Promise<ServiceSpec> {
  const modelSpec = router.resolveModelForRole("planner");
  const { model } = parseModelId(modelSpec);

  const response = await router.chat({
    modelSpec,
    model,
    system: `You are an MCP service designer. Given a description of a needed capability,
output a JSON service specification. Output ONLY valid JSON, no markdown fences.

The JSON must have this structure:
{
  "name": "kebab-case-name",
  "description": "What the service does",
  "tools": [
    {
      "name": "tool_name",
      "description": "What the tool does",
      "parameters": [
        { "name": "param", "type": "string", "description": "...", "required": true }
      ],
      "returnDescription": "What it returns"
    }
  ]
}

Rules:
- name must be kebab-case, lowercase, no spaces
- tool names must be snake_case
- parameter types: string, number, boolean, object, array
- Keep tools focused — one tool per distinct operation
- 1-5 tools per service`,
    messages: [
      {
        role: "user",
        content: `Design an MCP service for the following need:
${request.description}
${request.missingTool ? `\nThe specifically missing tool was called: "${request.missingTool}"` : ""}
${request.context ? `\nContext: ${request.context}` : ""}`,
      },
    ],
    maxTokens: 2048,
  });

  const json = cleanJsonResponse(response.content);

  try {
    return JSON.parse(json) as ServiceSpec;
  } catch {
    throw new Error(`Failed to parse service spec from LLM: ${json.slice(0, 200)}`);
  }
}

function registerGeneratedService(spec: ServiceSpec, servicePath: string): void {
  const entry: ServiceEntry = {
    name: spec.name,
    command: "node",
    args: [join(servicePath, "dist", "index.js")],
    tools: spec.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: Object.fromEntries(
        t.parameters.map((p) => [p.name, { type: p.type, description: p.description }]),
      ),
    })),
    origin: "generated",
    version: "0.1.0",
    transport: "stdio",
    capabilities: [],
    status: "active",
    createdAt: new Date().toISOString(),
  };

  registerService(entry);
}

function cleanJsonResponse(response: string): string {
  let text = response.trim();

  // Strip markdown fences
  if (text.startsWith("```")) {
    const first = text.indexOf("\n");
    text = text.slice(first + 1);
  }
  if (text.endsWith("```")) {
    text = text.slice(0, -3);
  }

  return text.trim();
}
