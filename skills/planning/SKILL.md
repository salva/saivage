---
name: planning
description: Structured planning for complex tasks
version: 0.1.0
agentTypes: [planner]
triggers: [plan, design, architect, break down, decompose]
---

## Planning Guidelines

1. **Output structured JSON** with a `steps` array.
2. **Each step must be actionable** by a single agent (coder, researcher, executor).
3. **Identify dependencies** between steps with `dependsOn` arrays.
4. **Keep steps small.** A step should take one agent 5-30 iterations.
5. **Include verification.** Add test/check steps after implementation steps.

### Plan Format

```json
{
  "summary": "Brief description of the plan",
  "steps": [
    {
      "id": 1,
      "type": "research",
      "goal": "Find the best approach for X",
      "dependsOn": []
    },
    {
      "id": 2,
      "type": "code",
      "goal": "Implement X using approach from step 1",
      "dependsOn": [1]
    },
    {
      "id": 3,
      "type": "execute",
      "goal": "Run tests to verify implementation",
      "dependsOn": [2]
    }
  ]
}
```
