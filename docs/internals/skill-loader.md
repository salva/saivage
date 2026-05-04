# Skill Loader

[`src/skills/loader.ts`](https://github.com/salva/saivage/blob/main/src/skills/loader.ts)

The skill loader resolves the **top-N skills** to inject into an agent's
system prompt for a given task.

## Inputs

```ts
interface SkillMatchContext {
  agentRole: AgentRole;
  description?: string;   // task / stage description
  tools?: string[];       // tools available
  filePaths?: string[];   // file context
  tags?: string[];        // stage tags
}
```

## Resolution

1. Discover skills from the project (`<project>/.saivage/skills/`) and
   from the built-in catalog (`<saivage>/skills/`). Project entries
   override built-ins by id.
2. Filter by `target_agents` — keep only skills that target the current
   role (or have no target list).
3. Score by trigger match:
   - `triggers.tags` ∩ `context.tags` → boost.
   - `triggers.keywords` matched in description → boost.
   - `triggers.tools` ∩ `context.tools` → boost.
4. Sort by score (desc), then `updated_at` (most recent first).
5. Take top N, where N = `min(maxSkills, ProjectConfig.skills.max_per_agent)`.

The selected skills are loaded from disk and joined into the system
prompt as labelled blocks (`--- SKILL: name ---` / `---`).

## Where it's called

`BaseAgent.assembleSystemPrompt()` invokes the loader with the
appropriate context. The agent then concatenates the role's base prompt
with the rendered skill block.

## Trigger schema

```ts
interface SkillTriggers {
  tags?: string[];
  keywords?: string[];
  tools?: string[];
}
```

All match types are case-insensitive.

## Cost

Loading is synchronous file I/O and runs once per agent run. The loader
caches `index.json` reads but not skill bodies (they are usually small).

## Tradeoffs

The N cap is a deliberate context-budget trade-off: more skills give the
agent more guidance but bloat the system prompt. Keep individual skill
files lean (≤200 lines) and rely on cross-references rather than copy-
paste.
