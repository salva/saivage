# Saivage — MCP Service Generator

## 1. Purpose

The MCP Service Generator is invoked by the **Coder sub-agent** (with the `mcp-authoring` skill loaded) when the Orchestrator determines that a required tool does not exist. It turns a natural-language capability description into a working MCP service: design → scaffold → implement → test → register.

All generated services are **TypeScript** and use the official `@modelcontextprotocol/sdk`.

## 2. Generation Pipeline

```
Capability Request (from Orchestrator)
        │
        ▼
  ┌─────────────┐
  │  1. Analyse  │  Understand what the service needs to do
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  2. Design   │  Define tool schemas (names, parameters, return types)
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  3. Scaffold │  Create project structure from templates
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  4. Implement│  Coder sub-agent writes the service code
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  5. Test     │  Run automated tests against the service
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  6. Sandbox  │  Isolated validation: contract tests + smoke tests
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  7. Register │  Version store snapshot, registry update, start process
  └──────┬──────┘
         │
         ▼
  Tool available for use
```

## 3. Step Details

### 3.1 Analyse

Input: a description of the desired capability + context from the Orchestrator.

The Coder sub-agent (with `mcp-authoring` skill) produces:
- **Purpose:** One-sentence summary.
- **Required tools:** List of tool names with descriptions.
- **External dependencies:** APIs, npm packages, system commands.
- **Capability requirements:** network, filesystem, secrets, etc.

### 3.2 Design

The sub-agent produces a **tool specification**:

```typescript
interface ServiceDesign {
  name: string;                    // kebab-case, e.g. "weather-lookup"
  description: string;
  tools: ToolDesign[];
  capabilities: CapabilityGrant[];
  npmDependencies: Record<string, string>;  // { "zod": "^3.23", "node-fetch": "^3.3" }
}

interface ToolDesign {
  name: string;                    // snake_case, e.g. "get_weather"
  description: string;
  parameters: Record<string, ParameterDesign>;
  returns: string;                 // Description of return value
}
```

This spec is shown to the user for approval before proceeding — unless the
generation was triggered automatically by a blocked agent, in which case the
orchestrator approves autonomously and proceeds.

### 3.3 Scaffold

Using templates, generate the project skeleton:

```
~/.saivage/services/weather-lookup/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # MCP server entry point
│   └── tools/
│       └── getWeather.ts         # Tool implementation (to be filled)
└── tests/
    └── getWeather.test.ts        # Test skeleton (to be filled)
```

**Template: `src/index.ts`**
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";

const server = new McpServer({
  name: "weather-lookup",
  version: "0.1.0",
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### 3.4 Implement

The Coder sub-agent, with the `mcp-authoring` and `coding` skills loaded, writes:
- `src/tools/*.ts` — full implementation of each tool.
- `tests/*.test.ts` — unit/integration tests.
- Updates to `package.json` if extra dependencies are needed.

The sub-agent has access to:
- The tool specification from step 3.2.
- The scaffolded skeleton.
- Web-fetch tools (to read API docs if needed).
- The `mcp-authoring` skill with SDK examples and patterns.

### 3.5 Test

1. Install dependencies: `pnpm install` in the service directory.
2. Build: `pnpm exec tsc --noEmit` to type-check.
3. Run: `pnpm exec vitest run` to execute tests.
4. If tests fail:
   a. Feed error output back to the Coder sub-agent.
   b. Sub-agent produces a corrected implementation.
   c. Re-run tests.
   d. Repeat up to **3 times**.
5. If still failing after 3 attempts:
   a. Report `status: "blocked"` to Orchestrator.
   b. Orchestrator asks user: register anyway, retry with different approach, or abort.

### 3.6 Sandbox Validation

Before registering, the candidate service runs through the sandbox pipeline
(see [03-ARCHITECTURE.md](03-ARCHITECTURE.md) §3.7):

1. `sandbox.start` — launch the candidate in an isolated process.
2. `sandbox.run_tests` — execute the service's own tests inside the sandbox.
3. `sandbox.smoke_test` — send representative tool calls, verify responses.
4. `sandbox.check_compat` — for **regenerations**, compare tool schemas
   against the live registry to ensure no breaking changes.
5. **Pass** → proceed to Register (§3.7). **Fail** → report failure, retry
   or ask user.

This step is **mandatory** regardless of whether the service is new or a
regeneration of an existing one.

### 3.7 Register

On success:
1. Snapshot the service directory into the version store:
   `~/.saivage/versions/services/{name}/v{semver}/`
2. Add or update entry in `~/.saivage/registry.json` (bumping version).
3. Notify MCP Runtime to start the new service process (or hot-replace if
   updating an existing service).
4. Report `task:complete` to Orchestrator.
5. Orchestrator re-fetches tool schemas and continues the original task.

## 4. Generated Service Lifecycle

```
                      ┌──────────┐
          create ────▶│  active   │◀──── enable
                      └────┬─────┘
                           │
                     disable│        error (repeated crashes)
                           │              │
                      ┌────▼─────┐   ┌────▼─────┐
                      │ disabled │   │ unhealthy │
                      └────┬─────┘   └────┬─────┘
                           │              │
                      delete│         delete│
                           ▼              ▼
                      ┌──────────────────────┐
                      │       removed        │
                      └──────────────────────┘
```

## 5. Regeneration & Iteration

The Orchestrator can ask the Coder sub-agent to **improve** an existing generated service:

- Feed user feedback or observed errors into a new task.
- The Coder reads the existing source, applies changes, re-runs tests.
- The updated service goes through sandbox validation (§3.6) before promotion.
- On promotion, the previous version is preserved in the version store
  (`~/.saivage/versions/services/{name}/v{prev}/`) and the live service is
  hot-replaced via the MCP Runtime (see [10-MCP-RUNTIME.md](10-MCP-RUNTIME.md)).
- On failure, any previous version can be restored via `versions.rollback`.

## 6. Dependency Management

- Each generated service is a self-contained Node.js project with its own `package.json`.
- Dependencies are installed via `pnpm install` (using `--prefix` for isolation).
- The runtime executes the service with `node` or `tsx` pointing at the service's entry point.
- Services do **not** share `node_modules` with the main Saivage installation.

## 7. Built-in MCP Services (shipped with Saivage)

| Service | Tools | Purpose |
|---|---|---|
| `filesystem` | `read_file`, `write_file`, `list_dir`, `search_files` | Local file operations |
| `shell` | `run_command` | Execute shell commands |
| `web-fetch` | `fetch_url`, `fetch_page_content` | HTTP requests and web scraping |
| `memory` | `store`, `recall`, `list`, `delete` | Persistent agent memory / knowledge base |
| `generator` | `design_service`, `scaffold_service`, `register_service` | Meta-tools for the generation pipeline |
