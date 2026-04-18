# Saivage — Skills System

## 1. Purpose

Skills are **structured instruction files** that teach agents how to perform specific tasks or follow specific processes. They are the primary mechanism for extending agent behaviour without writing code — they shape *how* an agent thinks and acts within its domain.

Inspired by modern programming agents (VS Code Copilot, OpenClaw, Cursor), skills are markdown files loaded into an agent's system prompt on demand.

## 2. Skill File Format

Each skill is a directory containing a `SKILL.md` file, optionally with supporting files:

```
skills/
└── mcp-authoring/
    ├── SKILL.md              # Main skill instructions (required)
    ├── examples/             # Example files referenced by SKILL.md
    │   ├── server.ts
    │   └── tools.ts
    └── templates/            # Templates used by the skill
        └── service-skeleton.ts
```

### 2.1 SKILL.md Structure

```markdown
---
name: mcp-authoring
description: How to write MCP services using the official TypeScript SDK
version: 0.1.0
agents: [coder]                    # Which sub-agent types should load this skill
triggers:                          # When to auto-load (optional)
  - "create.*mcp.*service"
  - "write.*mcp.*tool"
  - "generate.*service"
tags: [mcp, codegen, typescript]
---

# MCP Service Authoring

## When to use this skill
Use this skill when asked to create, modify, or debug an MCP service.

## MCP Server Structure

Every MCP service needs:
1. A server entry point that initialises the MCP Server
2. Tool handler registrations
3. Input validation using zod schemas

## Example: Basic MCP Server

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "my-service", version: "0.1.0" });

server.tool(
  "my_tool",
  "Description of what this tool does",
  { input: z.string().describe("The input parameter") },
  async ({ input }) => {
    // Implementation
    return { content: [{ type: "text", text: `Result: ${input}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

## Rules
- Always validate inputs with zod
- Return structured TextContent results
- Handle errors gracefully — return error messages, never crash the server
- Use environment variables for secrets, never hardcode them
- ...
```

## 3. Frontmatter Schema

```typescript
interface SkillMetadata {
  name: string;                    // Unique skill identifier
  description: string;             // One-line summary
  version: string;                 // Semver
  agents?: string[];               // Sub-agent types that should load this skill
                                   // If omitted, skill must be explicitly requested
  triggers?: string[];             // Regex patterns on task prompt that auto-load this skill
  tags?: string[];                 // For search/discovery
  requires?: string[];             // Other skill names this skill depends on
  priority?: number;               // Loading order when multiple skills match (higher = first)
}
```

## 4. Skill Resolution

When a sub-agent is assigned a task, skills are resolved in this order:

```
1. Explicit skills                 task.skills = ["mcp-authoring"]
       │
       ▼
2. Agent-type defaults             agent config: skills = ["coding"]
       │
       ▼
3. Trigger matching                task.prompt matches skill.triggers regex
       │
       ▼
4. Dependency resolution           loaded skills' `requires` field
       │
       ▼
5. Deduplicate & order by priority
       │
       ▼
6. Inject into system prompt
```

### 4.1 Trigger Matching Example

Task prompt: `"Write an MCP service that queries weather data"`

Skills with matching triggers:
- `mcp-authoring` (trigger: `"create.*mcp.*service|write.*mcp"`) ✓
- `coding` (trigger: `"write.*code|implement|build"`) ✓
- `research` (trigger: `"search|find|lookup"`) ✗

Both `mcp-authoring` and `coding` are loaded.

## 5. Skill Loading

Skills are loaded **into the system prompt** of the agent that needs them:

```typescript
function buildSystemPrompt(agent: SubAgent, task: Task): string {
  const basePrompt = agent.config.systemPrompt;
  const skills = resolveSkills(agent, task);

  const skillSections = skills.map(skill => {
    const content = readFile(skill.path + "/SKILL.md");
    // Strip frontmatter, keep just the markdown body
    return `## Skill: ${skill.name}\n\n${stripFrontmatter(content)}`;
  });

  return [basePrompt, "# Loaded Skills", ...skillSections].join("\n\n");
}
```

### 5.1 Context Budget

Skills consume context window tokens. To manage this:
- Each skill has an estimated token count (computed on load).
- The loader enforces a **skill budget** (configurable, default 30% of context window).
- If the budget is exceeded, lower-priority skills are trimmed or their examples are dropped.
- Skills can mark sections as `<!-- optional -->` to indicate they can be dropped under pressure.

## 6. Skill Sources

### 6.1 Built-in Skills

Shipped with Saivage in the `skills/` directory:

| Skill | Description | Default for |
|---|---|---|
| `coding` | General TypeScript/Node.js best practices | Coder |
| `mcp-authoring` | How to write MCP services with the TS SDK | Coder |
| `research` | Web research methodology, source evaluation | Researcher |
| `planning` | Goal decomposition, step ordering, dependency analysis | Planner |
| `testing` | How to write and run tests (vitest) | Coder |

### 6.2 Workspace Skills

Project-specific skills placed in `./skills/` (relative to working directory). These override built-in skills of the same name.

Example: a project might have `./skills/our-api/SKILL.md` teaching the agent about the project's internal API conventions.

### 6.3 User Skills

Personal skills stored in `~/.saivage/skills/`. Persist across projects.

### 6.4 Generated Skills

The agent can **create new skills** when it learns something reusable:

```typescript
// The Orchestrator can instruct a sub-agent to write a skill
{
  "agentType": "coder",
  "prompt": "Create a skill file that teaches how to interact with the GitHub API using the octokit library. Base it on what we learned in this conversation.",
  "skills": ["coding"]
}
```

The output is saved to `~/.saivage/skills/{name}/SKILL.md`.

## 7. Skill Discovery

### 7.1 CLI

```bash
saivage skills list                          # List all available skills
saivage skills show mcp-authoring            # Show skill content
saivage skills search "api"                  # Search by name/tags/description
saivage skills create my-skill               # Scaffold a new skill
saivage skills validate my-skill             # Check frontmatter & format
```

### 7.2 Agent-Driven Discovery

When the Orchestrator evaluates a task and no matching skill is found, it can:
1. Search existing skills by semantic similarity.
2. Ask the user if they know of relevant instructions.
3. Have the Coder sub-agent generate a skill from documentation or examples.

## 8. Skill Authoring Guidelines

For users writing custom skills:

1. **Be specific.** Skills should cover one focused domain, not be catch-all documents.
2. **Include examples.** Concrete code examples are more effective than abstract rules.
3. **Use imperative language.** "Always validate inputs" not "Inputs should be validated."
4. **Set triggers carefully.** Too broad → skill loads when irrelevant. Too narrow → never auto-loads.
5. **Keep under 2000 tokens.** Shorter skills are more reliably followed.
6. **Reference files, don't inline large blocks.** Use `examples/` directory for code > 20 lines.

## 9. Skill Versioning

- Skills use semver in their frontmatter.
- When the agent updates a generated skill, it increments the version.
- The previous version is kept in `~/.saivage/skills/{name}/.versions/v{old}.md`.
- Users can roll back: `saivage skills rollback my-skill 0.1.0`.
