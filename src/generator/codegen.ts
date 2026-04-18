/**
 * Code generation — drives the Coder agent to implement tool logic.
 */
import type { ModelRouter } from "../providers/router.js";
import { parseModelId } from "../providers/types.js";
import { readFileSync, writeFileSync } from "node:fs";
import { log } from "../log.js";

export interface CodegenRequest {
  servicePath: string; // Path to the scaffolded service dir
  sourceFile: string; // Path to the source file to implement
  spec: {
    name: string;
    description: string;
    tools: Array<{
      name: string;
      description: string;
      parameters: Array<{ name: string; type: string; description: string }>;
      returnDescription: string;
    }>;
  };
}

/**
 * Use the LLM to generate implementation code for a scaffolded service.
 */
export async function generateCode(
  router: ModelRouter,
  request: CodegenRequest,
): Promise<string> {
  const currentCode = readFileSync(request.sourceFile, "utf-8");

  const prompt = buildCodegenPrompt(request, currentCode);

  const modelSpec = router.resolveModelForRole("coder");
  const { model } = parseModelId(modelSpec);

  const response = await router.chat({
    modelSpec,
    model,
    system: `You are an expert TypeScript developer. You write clean, working MCP service implementations.
Output ONLY the complete TypeScript source file. No markdown fences, no explanations.`,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 4096,
  });

  const code = cleanCodeResponse(response.content);

  // Write the generated code
  writeFileSync(request.sourceFile, code);
  log.info(`Generated code for ${request.spec.name}`);

  return code;
}

function buildCodegenPrompt(request: CodegenRequest, currentCode: string): string {
  const toolDescs = request.spec.tools
    .map((t) => {
      const params = t.parameters
        .map((p) => `  - ${p.name} (${p.type}): ${p.description}`)
        .join("\n");
      return `Tool: ${t.name}
Description: ${t.description}
Parameters:
${params}
Returns: ${t.returnDescription}`;
    })
    .join("\n\n");

  return `Implement the following MCP service.

Service: ${request.spec.name}
Description: ${request.spec.description}

Tools to implement:
${toolDescs}

Current scaffold code:
\`\`\`typescript
${currentCode}
\`\`\`

Replace the TODO placeholder implementations with working code.
Keep the MCP server setup and transport code intact.
Output the complete file.`;
}

/**
 * Strip markdown fences if the LLM wraps the code.
 */
function cleanCodeResponse(response: string): string {
  let code = response.trim();

  // Remove markdown code fences
  if (code.startsWith("```")) {
    const firstNewline = code.indexOf("\n");
    code = code.slice(firstNewline + 1);
  }
  if (code.endsWith("```")) {
    code = code.slice(0, -3);
  }

  return code.trim() + "\n";
}
