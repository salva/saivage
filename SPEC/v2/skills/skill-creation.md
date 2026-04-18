# Skill: Skill Creation

## When to Use
When the Manager assigns a task to create a new skill file documenting a reusable pattern or tool.

## What Is a Skill
A skill is a markdown file under `.saivage/skills/` that teaches agents how to perform a specific type of task. Skills are auto-loaded into agent contexts when their triggers match the current task.

## Creating a Skill

### 1. Write the Skill File
Create `.saivage/skills/<skill-name>.md` with this structure:

```markdown
# Skill: <Human-Readable Name>

## When to Use
<One sentence: the situation that triggers this skill.>

## Rules
<Numbered or bulleted list of specific, actionable instructions.>
<Include examples where helpful.>
<Be concrete — "use X pattern" not "follow best practices".>
```

Guidelines:
- Keep skills focused — one skill per topic. Don't create omnibus skills.
- Write instructions as imperative commands: "Use", "Do not", "Always", "When X, do Y".
- Include concrete examples (code snippets, file paths, command invocations).
- Do not repeat instructions that are already in the agent's system prompt. Skills add project-specific knowledge, not generic advice.
- Keep skills concise. Target 40-100 lines. If longer, split into multiple skills.

### 2. Define Triggers
Choose triggers that will correctly match tasks where this skill is relevant:

| Trigger type     | Format            | Matches when                           |
|------------------|-------------------|----------------------------------------|
| `keyword:<word>` | case-insensitive  | Task description contains the word     |
| `tool:<name>`    | exact match       | Task uses or mentions the named tool   |
| `path:<glob>`    | glob pattern      | Any file in task scope matches         |
| `tag:<label>`    | exact match       | Task or stage has the given tag        |
| `agent:<type>`   | exact match       | Current agent is the given type        |

Choose triggers that are **precise enough** to avoid loading the skill for unrelated tasks, but **broad enough** to catch all relevant ones. Usually 2-4 triggers per skill.

### 2b. Define Target Agents (optional)
If the skill only applies to certain agent types, set `target_agents` in the index entry. For example, a code-quality skill might target `["coder"]`, while a planning-strategy skill might target `["planner", "manager"]`. **Omit** `target_agents` if the skill applies to all agents.

### 3. Update the Index
Add an entry to `.saivage/skills/index.json`:

```json
{
  "name": "skill-name",
  "file": "skills/skill-name.md",
  "description": "One-line description of what this skill teaches.",
  "triggers": ["keyword:oauth", "tag:authentication", "path:src/auth/*"],
  "target_agents": ["coder"],
  "created_at": "<ISO 8601>",
  "updated_at": "<ISO 8601>"
}
```

If `index.json` doesn't exist, create it with `{ "skills": [...] }`.

### 4. Commit
Commit both the skill file and the updated `index.json` in a single commit:
```
[tsk-<id>] skill: <skill-name>
```

## When to Create Skills

Skills should be created when:
- A pattern or convention has been established that will recur in future tasks.
- A tool or library has project-specific usage patterns worth documenting.
- A non-obvious workflow was discovered that would save time for future agents.

Skills should **not** be created for:
- One-off procedures unlikely to recur.
- Generic programming knowledge (the LLM already knows this).
- Information that belongs in project documentation (README, API docs) rather than agent instructions.
