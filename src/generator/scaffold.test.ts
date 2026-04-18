import { describe, it, expect, afterEach } from "vitest";
import { scaffoldService, type ServiceSpec } from "./scaffold.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("scaffold", () => {
  const testDirs: string[] = [];

  afterEach(() => {
    for (const dir of testDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    testDirs.length = 0;
  });

  const spec: ServiceSpec = {
    name: "test-service",
    description: "A test service",
    tools: [
      {
        name: "greet",
        description: "Greet someone",
        parameters: [
          {
            name: "name",
            type: "string",
            description: "Name to greet",
            required: true,
          },
        ],
        returnDescription: "A greeting string",
      },
    ],
  };

  it("creates project structure", () => {
    const baseDir = join(tmpdir(), `saivage-test-${randomUUID()}`);
    const projectDir = scaffoldService(baseDir, spec);
    testDirs.push(baseDir);

    expect(existsSync(join(projectDir, "package.json"))).toBe(true);
    expect(existsSync(join(projectDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(projectDir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(projectDir, "src", "index.test.ts"))).toBe(true);
  });

  it("generates valid package.json", () => {
    const baseDir = join(tmpdir(), `saivage-test-${randomUUID()}`);
    const projectDir = scaffoldService(baseDir, spec);
    testDirs.push(baseDir);

    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("@saivage/service-test-service");
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBeDefined();
  });

  it("generates service code with tool registration", () => {
    const baseDir = join(tmpdir(), `saivage-test-${randomUUID()}`);
    const projectDir = scaffoldService(baseDir, spec);
    testDirs.push(baseDir);

    const code = readFileSync(join(projectDir, "src", "index.ts"), "utf-8");
    expect(code).toContain('server.tool("greet"');
    expect(code).toContain("McpServer");
    expect(code).toContain("StdioServerTransport");
  });
});
