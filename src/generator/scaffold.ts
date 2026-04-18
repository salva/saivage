/**
 * MCP service scaffold from templates.
 * Generates the initial project structure for a new MCP service.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ServiceSpec {
  name: string; // e.g. "string-reverser"
  description: string;
  tools: ToolSpec[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: ParameterSpec[];
  returnDescription: string;
}

export interface ParameterSpec {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required: boolean;
}

/**
 * Create the directory structure and template files for a new MCP service.
 * Returns the root path of the scaffolded project.
 */
export function scaffoldService(baseDir: string, spec: ServiceSpec): string {
  const projectDir = join(baseDir, spec.name);
  mkdirSync(projectDir, { recursive: true });

  // package.json
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      {
        name: `@saivage/service-${spec.name}`,
        version: "0.1.0",
        type: "module",
        main: "dist/index.js",
        scripts: {
          build: "tsc",
          test: "vitest run",
        },
        dependencies: {
          "@modelcontextprotocol/sdk": "^1.29.0",
          zod: "^3.25.0",
        },
        devDependencies: {
          typescript: "^5.9.0",
          vitest: "^3.2.0",
        },
      },
      null,
      2,
    ),
  );

  // tsconfig.json
  writeFileSync(
    join(projectDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "Node16",
          moduleResolution: "Node16",
          outDir: "dist",
          rootDir: "src",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
        },
        include: ["src"],
      },
      null,
      2,
    ),
  );

  // src directory
  mkdirSync(join(projectDir, "src"), { recursive: true });

  // Generate index.ts
  writeFileSync(join(projectDir, "src", "index.ts"), generateServiceCode(spec));

  // Generate test file
  writeFileSync(join(projectDir, "src", "index.test.ts"), generateTestCode(spec));

  return projectDir;
}

function generateServiceCode(spec: ServiceSpec): string {
  const toolRegistrations = spec.tools
    .map((tool) => {
      const params = tool.parameters
        .map((p) => {
          const zodType = p.type === "string" ? "z.string()" :
            p.type === "number" ? "z.number()" :
            p.type === "boolean" ? "z.boolean()" :
            "z.unknown()";
          const fullType = p.required ? zodType : `${zodType}.optional()`;
          return `    ${p.name}: ${fullType}.describe("${p.description}"),`;
        })
        .join("\n");

      return `
server.tool("${tool.name}", "${tool.description}", {
${params}
}, async (params) => {
  // TODO: Implement ${tool.name}
  return { content: [{ type: "text", text: JSON.stringify({ result: "not implemented" }) }] };
});`;
    })
    .join("\n");

  return `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "${spec.name}", version: "0.1.0" });
${toolRegistrations}

const transport = new StdioServerTransport();
await server.connect(transport);
`;
}

function generateTestCode(spec: ServiceSpec): string {
  const testCases = spec.tools
    .map(
      (tool) => `
  it("${tool.name} returns a result", () => {
    // Placeholder test — will be filled by the coder agent
    expect(true).toBe(true);
  });`,
    )
    .join("\n");

  return `import { describe, it, expect } from "vitest";

describe("${spec.name}", () => {
${testCases}
});
`;
}
