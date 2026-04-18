# Skill: Code Quality Conventions

## When to Use
When writing or modifying project source code.

## Rules

### Read Before You Write
- Before modifying any file, read it fully. Understand the existing structure, patterns, and style.
- Before creating a new module, check the project for similar existing modules. Match their structure.
- If the project has a linter config, style guide, or `.editorconfig`, follow it.

### Match Project Style
- Use the same indentation, naming conventions, and code organization as the existing codebase.
- If the project uses a specific framework or library pattern (e.g., dependency injection, repository pattern), follow it.
- Do not introduce a new pattern when an existing one is already established, unless the task explicitly calls for it.

### Clean Code
- No debug artifacts: remove `console.log`, `print()`, `debugger`, `TODO: remove`, and commented-out code before committing.
- No placeholder implementations: if a function is supposed to do something, implement it. Do not leave `// TODO` stubs unless the task explicitly scopes out that functionality.
- No dead code: do not commit functions, imports, or variables that are unused.

### Error Handling
- Handle errors at system boundaries (API endpoints, file I/O, external service calls).
- Use the project's established error handling pattern (custom errors, result types, exceptions).
- Do not silently swallow errors. At minimum, log them.
- Do not add defensive error handling for conditions that cannot occur in the current code path.

### Dependencies
- Do not add new dependencies unless the task requires it and no existing dependency covers the need.
- If you add a dependency, note it in the task report's `issues_found` with `severity: "info"`.
- Use exact versions or the project's existing version strategy.

### File Organization
- Place new files where they logically belong in the project structure.
- If unsure, look at how similar files are organized.
- Do not create utility files or abstractions for one-off operations.

### Documentation
- Add/update inline comments only where the code's intent is non-obvious.
- If the task creates a public API, document its interface (parameters, return values, errors).
- Do not add boilerplate docstrings to self-explanatory functions.
