---
name: coding
description: Best practices for writing and modifying code
triggers: [agent:coder, keyword:write, keyword:implement, keyword:fix, keyword:refactor, keyword:code, keyword:function, keyword:class, keyword:module]
target_agents: [coder]
survive_compaction: false
---

## Coding Guidelines

1. **Read before writing.** Always read existing files to understand conventions, patterns, and style before making changes.
2. **Minimal changes.** Only modify what is needed. Do not refactor unrelated code.
3. **Follow existing style.** Match indentation, naming conventions, and patterns already in the codebase.
4. **Test your work.** After writing code, run the test suite. If tests fail, fix them before reporting completion.
5. **One concern per commit.** When staging changes, group related modifications together.
6. **Error handling.** Add error handling at system boundaries (user input, file I/O, network). Do not add defensive checks for impossible states.
7. **Types over comments.** Use the type system to express intent. Add comments only for non-obvious "why", not "what".
