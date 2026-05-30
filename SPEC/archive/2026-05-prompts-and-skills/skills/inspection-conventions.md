# Skill: Inspection Conventions

## When to Use
When conducting an investigation as the Inspector agent.

## Analysis Approach

### Plan Before Executing
1. Read the `scope` and `questions` from the inspection request.
2. Check `tools/inspector/` for existing reusable tools.
3. Outline your analysis plan: what data to collect, what to look at, what tools to use.
4. Execute systematically — don't jump around.

### Be Thorough, Then Be Concise
- Gather comprehensive data during analysis (cast a wide net).
- In the report, present only what's relevant to the questions. Keep raw data in `data` and artifacts.
- Answer every question in the request. If you can't, explain why.

### Quantify Everything
Prefer:
- "3 of 12 test suites fail (auth, payments, notifications)"
- "Test coverage: 67% lines, 54% branches"
- "Average response time: 230ms (p95: 890ms)"

Over:
- "Some tests fail"
- "Coverage is moderate"
- "Response times are acceptable"

## Tool Management

### Ephemeral Scripts (`tmp/inspector-workspace/`)
- Create analysis scripts freely here during your investigation.
- Name them descriptively: `count-todos.sh`, `parse-coverage.py`, `dependency-graph.ts`.
- These are disposable — no need to polish them.

### Persistent Tools (`tools/inspector/`)
Promote a script here only when:
- It will be useful for future inspections (not one-off).
- It works reliably and handles edge cases.
- It has a header comment explaining usage.

Format for persistent tools:
```
#!/usr/bin/env <interpreter>
# <tool-name>: <one-line description>
# Usage: <how to run it>
# Output: <what it produces>
```

Don't promote:
- Scripts that are specific to one investigation.
- Half-finished prototypes.
- Scripts that depend on temporary data in the workspace.

## Report Writing

### Structure
Use markdown headers in `findings` to organize by question:

```markdown
## Q1: <First question from the request>
<Analysis and findings>

## Q2: <Second question>
<Analysis and findings>

## Additional Observations
<Anything important that wasn't asked but worth noting>
```

### Recommendations
- Be specific and actionable: "Refactor `src/auth/session.ts` to use the `TokenManager` from `src/auth/tokens.ts` instead of raw JWT handling"
- Prioritize: put the highest-impact recommendations first.
- Distinguish quick fixes from structural changes.

### TTL Decision
Set `expires_at` based on the type of analysis:
- **Time-sensitive** (coverage metrics, test results, performance benchmarks): set TTL to 1-2 weeks.
- **Structural** (architecture analysis, code quality review): set to `null` (permanent).
- **Situational** (debugging a specific issue): set TTL to 1-3 days.

### Data Field
Put structured/machine-readable data in the `data` object:
```json
{
  "test_coverage": { "lines": 67, "branches": 54, "functions": 71 },
  "failing_tests": ["auth.session", "payments.refund", "notifications.email"],
  "file_count": { "src": 142, "test": 58, "ratio": 0.41 }
}
```
This lets the Planner compare metrics across multiple inspection reports.
