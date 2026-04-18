# Skill: Testing Conventions

## When to Use
When writing, running, or evaluating tests as part of any coding task.

## Rules

### When Tests Are Required
- Every task that modifies existing code behavior must run existing tests and confirm they pass.
- Every task that adds new functionality should add tests (unless the Manager's checklist explicitly says otherwise).
- Bug fix tasks must include a regression test that demonstrates the fix.

### Test Quality
- Tests must be **meaningful** — they should verify behavior, not just cover lines.
- Each test should have a clear name describing what it verifies.
- Tests must be deterministic — no random data, no timing-dependent assertions, no external service dependencies without mocks.
- Test edge cases and error paths, not just the happy path.

### Test Execution
- Run tests using the project's existing test runner and configuration.
- If the project has no test infrastructure, set it up as part of the task (note it in the task report).
- Run the full relevant test suite, not just new tests. This catches regressions.
- Capture test output (truncated if large) in the task report's `tests_run` field.

### Test Report Format
In the task report, record each test run:
```json
{
  "name": "test suite or test name",
  "passed": true | false,
  "output": "truncated stdout/stderr (first 500 chars on failure)"
}
```

### Test Failures
- If existing tests fail before your changes: note this as an `issue_found` with `severity: "warning"` and proceed with your task. Do not fix unrelated test failures unless your task requires it.
- If your changes break existing tests: fix them if the existing behavior should change (and note it in the report), or revert your approach if the existing tests are correct.
- If new tests fail: debug and fix. Report failure only if you cannot resolve it.

### Test File Placement
- Place tests alongside the code they test or in the project's conventional test directory.
- Match the project's existing test naming conventions (e.g., `*.test.ts`, `*.spec.ts`, `test_*.py`).
- List all new test files in the task report's `tests_added` field.
