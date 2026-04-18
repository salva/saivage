# Saivage -- Use Cases

The primary domain of Saivage is **complex software development** where
multiple iterations, exploration of alternatives, and course corrections are
the norm -- not the exception. The use cases below are grouped by category and
progress from simple interactions to multi-day, multi-agent workflows.

See [01-FUNCTIONAL-ANALYSIS.md](01-FUNCTIONAL-ANALYSIS.md) for the functional
requirements these use cases exercise.

---

## Category A: Everyday Interactions

### UC-A1. Codebase Question

> "How does the authentication middleware work?"

Chat agent reads relevant source files (`filesystem.read_file`, `index.search`)
and explains. No work item created. Pure read-only.

### UC-A2. Quick Status Check

> "What's running right now?"

Chat agent calls `orch.get_state`, formats the TODO list and active agents
into a readable summary, and responds.

### UC-A3. Cross-Session Context

> "What did we discuss about the database schema in the other tab?"

Chat agent calls `index.search_conversations` across all sessions, retrieves
the relevant exchanges, and summarises. The user never needs to remember which
session a decision was made in.

### UC-A4. Trivial File Edit

> "Add a .gitignore with standard Node.js defaults."

Chat agent submits to orchestrator. Orchestrator fast-tracks: creates branch,
dispatches Coder, agent writes file, commits, orchestrator merges. Done in
seconds. Tracked in work history even though it was trivial.

### UC-A5. Explain and Suggest

> "This function feels wrong. What do you think?"

Chat agent reads the referenced code, analyses it (read-only), and offers
critique and suggestions. If the user agrees to changes, that becomes a
separate work submission (UC-B1).

---

## Category B: Single-Task Development

### UC-B1. Implement a Feature

> "Add a /users/:id endpoint that returns the user profile with their recent
> transactions."

1. Chat agent submits work to orchestrator.
2. Orchestrator creates work item, creates branch `saivage/todo-12-user-profile-endpoint`.
3. Dispatches Coder agent.
4. Coder reads existing route structure and data models, implements the
   endpoint, writes tests, runs them.
5. If tests fail, Coder iterates -- reads errors, fixes code, re-runs.
   Typical: 2-4 internal iterations.
6. On success: emits `agent:completed`. Orchestrator merges, notifies chat.

### UC-B2. Fix a Bug

> "The invoice total calculation is wrong when there are discounts. Here's a
> failing test case: ..."

1. Orchestrator dispatches Coder with the failing test and the relevant
   source context.
2. Coder runs the test to reproduce, reads the discount logic, identifies
   the root cause, fixes it, re-runs. Iterates if the fix is incomplete.
3. Coder also checks for similar patterns elsewhere ("are there other
   places where discounts are applied?") and fixes those too.

### UC-B3. Refactor with Confidence

> "Extract the payment processing logic into its own module. Don't break
> anything."

1. Orchestrator creates the work item and branch.
2. Coder reads the full dependency graph around payment processing.
3. Coder moves code, updates imports, adjusts tests.
4. Coder runs the full test suite (not just payment tests) to verify.
5. If regressions appear, Coder traces and fixes them. Typically 3-5
   iterations for a non-trivial refactor.

### UC-B4. Write Tests for Existing Code

> "The auth module has zero test coverage. Write comprehensive tests."

1. Coder reads the auth module, its dependencies, and its callers.
2. Writes unit tests for individual functions.
3. Writes integration tests for the auth flow end-to-end.
4. Runs them, discovers actual bugs in the existing code.
5. Reports bugs to the orchestrator as new work items (doesn't fix them
   itself -- that's a separate concern). Alternatively, the user says
   "fix them too" and the orchestrator adds follow-up work items.

### UC-B5. Dependency Update

> "Upgrade Express from v4 to v5 and fix whatever breaks."

1. Coder updates `package.json`, runs `pnpm install`.
2. Runs the full test suite. Multiple failures expected.
3. Iterates through each failure: reads error, reads Express v5 migration
   guide (via web fetch), fixes the code, re-runs.
4. May take 10-20 iterations. The Coder agent handles this autonomously
   with its 30-iteration budget.

---

## Category C: Exploratory & Iterative Development

These reflect the core workflow of Saivage: complex software development
where the right approach is not known in advance.

### UC-C1. Explore Alternatives Before Committing

> "I need a state management solution for the Vue app. Research the options,
> prototype the top 2, then let me decide."

1. Orchestrator plans:
   - Item 1: Research state management options (Researcher).
   - Item 2: Prototype approach A (Coder, depends on 1).
   - Item 3: Prototype approach B (Coder, depends on 1).
   - Item 4: Comparison report (Researcher, depends on 2, 3).
2. Researcher gathers info on Pinia, Vuex, custom composables, signals.
   Produces a summary artifact ranking them.
3. Orchestrator dispatches two Coder agents **in parallel** on separate
   branches: one prototypes Pinia, one prototypes composables.
4. Both produce working prototypes. Researcher produces a comparison.
5. Chat agent presents the comparison. User picks one.
6. Orchestrator merges the winning branch, discards the other.

### UC-C2. Spike and Iterate

> "Try building the PDF export with Puppeteer. If it's too slow, switch to
> pdf-lib."

1. Orchestrator dispatches Coder on branch `saivage/todo-20-pdf-export`.
2. Coder implements PDF export with Puppeteer, writes a performance test.
3. Performance test shows 8 seconds per page. Coder reports completion
   with the benchmark result.
4. Orchestrator evaluates: 8s is too slow (based on user's criterion in
   the original prompt). Creates a new work item: "Reimplement with pdf-lib".
5. Orchestrator **does not** merge the Puppeteer branch. Creates a new branch
   from main for the pdf-lib attempt.
6. Second Coder implements with pdf-lib. Benchmark: 200ms. Success.
7. Orchestrator merges the pdf-lib branch. The Puppeteer branch is kept
   (not deleted) for reference but not merged.

Key: The system preserves both approaches in git history. Nothing is lost.

### UC-C3. Progressive Refinement

> "Build a data pipeline that ingests CSV files, transforms them, and loads
> them into SQLite."

1. First iteration: Coder builds a working but naive pipeline (read all into
   memory, transform, bulk insert). Tests pass.
2. User reviews: "Works, but it'll OOM on large files. Stream it."
3. Orchestrator creates a refinement work item on a new branch. Coder
   rewrites with readable streams. Tests pass, memory stays flat.
4. User: "Good. Now add error recovery -- if a row fails, skip it and log."
5. Another iteration. Coder adds error handling, a skip counter, a log file.
6. User: "Now add a dry-run mode."
7. Each refinement is a tracked work item, on its own branch, merged
   sequentially. The git history tells the story of the design evolution.

### UC-C4. A/B Architecture for a Component

> "I'm not sure whether this service should use REST or gRPC. Build both and
> benchmark them under load."

1. Orchestrator plans two parallel tracks:
   - Track A: REST implementation (Coder on branch `saivage/todo-30-rest`).
   - Track B: gRPC implementation (Coder on branch `saivage/todo-31-grpc`).
   - Final: Load test both (Executor, depends on A and B).
2. Both Coders work simultaneously on separate branches.
3. Executor runs load tests against both implementations, produces a report.
4. Chat agent presents results. User picks REST.
5. Orchestrator merges REST branch. gRPC branch archived.

### UC-C5. Test-Driven Exploration

> "I want to build a rule engine. Start by writing the test suite that defines
> the behaviour I want, then implement until all tests pass."

1. Orchestrator dispatches Coder to write tests first (TDD).
2. Coder produces 25 test cases covering the rule engine's expected API.
   All fail (no implementation).
3. Orchestrator dispatches a second Coder work item to implement.
4. Coder iterates: implement, run tests, fix, run tests. Typical: 15-20
   iterations to go from 0/25 to 25/25.
5. If the Coder agent hits its iteration limit at 22/25 passing, it reports
   completion with a note. Orchestrator creates a follow-up item for the
   remaining 3 failures.

### UC-C6. Large-Scale Refactoring

> "Migrate the entire codebase from CommonJS to ESM."

1. Orchestrator uses Planner to decompose:
   - Item 1: Audit all files, list CJS patterns (Researcher).
   - Item 2: Update `tsconfig.json` and `package.json` (Coder).
   - Item 3-N: Migrate each module (Coder, parallel where independent).
   - Item N+1: Run full test suite and fix regressions (Coder).
2. Items 3-N run in parallel on separate branches. Each Coder handles
   one module (or a cluster of tightly coupled modules).
3. Orchestrator merges completed branches one by one, running tests after
   each merge to catch integration issues early.
4. If a merge breaks tests, orchestrator dispatches a fix agent before
   merging the next branch.
5. Final item: full integration test run.

This is a sub-orchestrator scenario if the file count is large (50+ modules).

---

## Category D: Multi-Phase Projects

### UC-D1. Greenfield Application

> "Build a personal finance tracker: REST API with Express, SQLite database,
> Vue frontend, deploy with Docker."

1. Orchestrator **spawns a sub-orchestrator** (this is a multi-phase project).
2. Sub-orchestrator plans phases:
   - Phase 1: Data model design (Planner + Coder).
   - Phase 2: API implementation (Coder, depends on P1).
   - Phase 3: Frontend (Coder, depends on P2 for API contracts).
   - Phase 4: Dockerisation (Executor + Coder, depends on P2 and P3).
   - Phase 5: Integration testing (Coder, depends on all).
3. Each phase may have 3-10 work items internally. Phases run sequentially
   but items within a phase run in parallel where possible.
4. User provides feedback between phases: "Actually, add a budget
   categorisation feature." Sub-orchestrator re-plans, adds items.
5. Total: 20-40 work items, 15-30 branches, over hours or days.

### UC-D2. Add a Major Feature to an Existing Codebase

> "Add multi-tenancy to our SaaS app. Each tenant gets isolated data, their
> own subdomain, and separate billing."

1. Sub-orchestrator plans:
   - Research: How similar projects handle multi-tenancy (Researcher).
   - Design: Produce an architecture doc (Planner, informed by research).
   - Database: Add tenant_id columns, migrate schema (Coder).
   - Middleware: Tenant resolution from subdomain (Coder).
   - Data isolation: Query scoping, row-level security (Coder).
   - Billing: Stripe integration per tenant (Coder + Researcher for API).
   - Testing: Per-tenant isolation tests (Coder).
2. User reviews the design doc before implementation begins ("show me the
   plan"). Chat agent presents it. User modifies ("use schema-per-tenant
   instead of shared schema").
3. Sub-orchestrator adjusts the plan and proceeds.
4. Throughout, the user can check in from any chat session, redirect work,
   or pause and resume.

### UC-D3. API Design Then Implementation

> "Design a REST API for a project management tool. Get my approval on the
> design, then implement it."

1. Phase 1 -- Design:
   - Researcher studies similar APIs (Jira, Linear, Asana).
   - Planner produces an endpoint list with request/response shapes.
   - Coder generates an OpenAPI spec file.
   - Chat agent presents the spec for review.
2. User iterates on the design: "Add a webhooks endpoint. Remove the
   /labels resource, use tags instead." Multiple rounds of design revision,
   each tracked as a work item.
3. Phase 2 -- Implementation (only after user approval):
   - Coder implements routes, one per work item, testing against the spec.
   - Each route is on its own branch. Parallel where possible.
4. Phase 3 -- Integration:
   - Coder writes integration tests that exercise the full API.
   - Executor runs them.

### UC-D4. Monorepo Setup with Multiple Packages

> "Set up a pnpm monorepo with three packages: @app/core, @app/api, and
> @app/web. Core is shared logic, API is the Express server, web is the Vue
> frontend."

1. Orchestrator plans:
   - Item 1: Scaffold monorepo structure (Coder).
   - Item 2: Implement @app/core (Coder, depends on 1).
   - Item 3: Implement @app/api (Coder, depends on 1, 2).
   - Item 4: Implement @app/web (Coder, depends on 1, 2).
   - Item 5: CI/CD configuration (Coder, depends on all).
2. Items 3 and 4 run in parallel (both depend on core, not on each other).
3. Each package gets its own branches for its work items.

---

## Category E: Debugging & Recovery

### UC-E1. Diagnose a Production Issue

> "The API is returning 500 errors on /invoices. Here's the error log:
> [paste]. Find the root cause and fix it."

1. Researcher: scans the error log, identifies the stack trace, finds the
   failing function.
2. Coder: reads the code, reproduces the bug with a test, finds the cause
   (e.g., null reference when a customer has no address).
3. Coder: fixes the bug, adds a regression test, verifies.
4. If the Coder's first fix doesn't work, it tries another approach. The
   ReAct loop naturally handles this: run test -> fail -> re-read -> fix ->
   run test -> pass.

### UC-E2. Agent Failure and Recovery

> Coder agent fails after 30 iterations trying to make a complex test pass.

1. Orchestrator receives `agent:failed` with reason `max_iterations`.
2. Orchestrator evaluates: retries with a stronger model (e.g., upgrades
   from `claude-sonnet` to `claude-opus`).
3. If that also fails, orchestrator re-plans: breaks the task into smaller
   sub-tasks, dispatches multiple agents.
4. If still stuck, orchestrator broadcasts to chat sessions: "I've tried
   two approaches to make the payment reconciliation test pass and both
   failed. Here's what I tried: [...]. Can you help?"

### UC-E3. Undo Bad Work

> "That last change broke everything. Revert it."

1. Orchestrator identifies the work item and its branch.
2. If already merged: creates a revert commit on a new branch (standard
   `git revert`), dispatches Coder to verify tests pass after revert.
3. If not yet merged: simply cancels the merge. Branch still exists for
   reference.
4. The work item is marked cancelled. All git history preserved.

### UC-E4. Flaky Test Investigation

> "The UserService test suite fails about 30% of the time. Find out why."

1. Executor: runs the test suite 10 times in a row, collects pass/fail
   results and output logs.
2. Researcher: analyses the logs, identifies patterns (timing-dependent
   assertions, shared test state, port conflicts).
3. Coder: fixes the flaky tests (adds proper cleanup, waits, isolation).
4. Executor: runs the suite 20 more times to confirm stability.

---

## Category F: Research & Decision-Making

### UC-F1. Technology Selection

> "I need to add full-text search. Compare Meilisearch, Typesense, and just
> using SQLite FTS5. Consider ease of integration, performance, and hosting."

1. Researcher gathers documentation, benchmarks, and integration examples
   for each option.
2. Researcher may also build a comparison matrix as an artifact.
3. Chat agent presents the results in a structured format.
4. User decides. If they say "go with Meilisearch", that triggers a new
   work item for the Coder.

### UC-F2. Understand an Unfamiliar Codebase

> "I just cloned this repo. Give me a high-level architecture overview and
> tell me where the important entry points are."

1. Chat agent reads the directory structure, `README.md`, `package.json`,
   main entry points.
2. Searches for patterns: route definitions, database connections, config
   files.
3. Produces a structured overview: modules, key files, data flow, external
   dependencies.
4. All read-only. No work items.

### UC-F3. Security Audit

> "Review the auth module for common security vulnerabilities."

1. Orchestrator dispatches Researcher + Coder collaboration:
   - Researcher: lists OWASP Top 10 concerns relevant to auth.
   - Coder: reads the auth code, checks each concern against the
     implementation.
2. Produces a report: vulnerabilities found, severity, suggested fixes.
3. User reviews. Approved fixes become work items.

### UC-F4. Performance Investigation

> "The /reports endpoint takes 12 seconds. Profile it and make it fast."

1. Executor: runs the endpoint with profiling/tracing enabled, captures
   timing data.
2. Researcher: analyses the profile, identifies bottlenecks (N+1 queries,
   missing index, un-cached computation).
3. Coder: implements fixes (adds database index, batches queries, adds
   cache layer), re-runs benchmark.
4. Iterates until target performance is met. May take 3-5 cycles of
   profile -> fix -> profile.

---

## Category G: Infrastructure & DevOps

### UC-G1. Dockerise an Application

> "Create a Dockerfile and docker-compose.yml for the app with PostgreSQL
> and Redis."

1. Coder reads the app structure, identifies runtime dependencies,
   environment variables, ports.
2. Writes Dockerfile (multi-stage build), docker-compose.yml, .dockerignore.
3. Executor: builds the image, runs `docker-compose up`, verifies the app
   starts and responds.
4. If the build fails or the app doesn't start, iterate.

### UC-G2. CI/CD Pipeline

> "Set up GitHub Actions CI: lint, test, build, and deploy to staging on
> push to main."

1. Coder writes `.github/workflows/ci.yml`.
2. Coder also creates any missing scripts in `package.json` (lint, test,
   build).
3. Executor: runs the pipeline locally (using `act` or similar) to verify.
4. Iterates on failures.

### UC-G3. Infrastructure as Code

> "Write Terraform configs to deploy this app on AWS: ECS Fargate, RDS
> PostgreSQL, ElastiCache Redis, ALB, and Route 53."

1. Sub-orchestrator (complex project):
   - Researcher: reads app requirements, existing config.
   - Coder: writes Terraform modules for each resource.
   - Executor: runs `terraform plan` to validate.
   - Coder: fixes any errors, iterates until plan succeeds.
2. User reviews the plan output before applying (this is a natural
   checkpoint -- the chat agent presents the `terraform plan` and waits).

---

## Category H: Maintenance & Evolution

### UC-H1. Keep Dependencies Fresh

> "Check all dependencies for known vulnerabilities and outdated versions.
> Update what you can without breaking tests."

1. Executor: runs `pnpm audit`, `pnpm outdated`.
2. Coder: updates dependencies one by one (or in safe batches), running
   tests after each update.
3. For major version bumps: creates a separate work item per dependency
   (each is its own branch since it might require code changes).
4. Reports a summary: what was updated, what couldn't be updated (and why).

### UC-H2. Documentation Sweep

> "Our API documentation is out of date. Read the actual endpoints and
> generate fresh OpenAPI docs."

1. Coder reads all route files, extracts endpoints, parameters, response
   shapes.
2. Generates an OpenAPI 3.1 YAML spec.
3. Compares with the existing spec (if any), produces a diff.
4. User reviews. On approval, the new spec is committed.

### UC-H3. Code Quality Pass

> "Run a code quality pass: fix all lint errors, add missing types, remove
> dead code."

1. Executor: runs ESLint, TypeScript compiler in strict mode, collects all
   diagnostics.
2. Coder: fixes lint errors (batch-processable), adds missing type
   annotations, identifies and removes dead code (unreachable functions,
   unused exports).
3. Runs tests to ensure nothing broke.
4. Multiple iterations as each fix may reveal new issues.

### UC-H4. Migrate Database Schema

> "Add soft deletes to all models. Add a deleted_at column, update all
> queries to filter, and write a migration."

1. Orchestrator plans:
   - Item 1: Write the migration (Coder).
   - Item 2: Update base query builder / ORM config (Coder, depends on 1).
   - Item 3: Update each model's queries (Coder, depends on 2).
   - Item 4: Update tests (Coder, depends on 3).
   - Item 5: Run full test suite (Executor, depends on 4).
2. Items 3 could be parallelised by module if the codebase is modular
   enough (each module on its own branch).

---

## Category I: Multi-Session Collaboration

### UC-I1. Designer and Developer Workflow

> Session A (design tab): "Here's the Figma spec. Implement the dashboard
> layout first."
> Session B (API tab): "Meanwhile, implement the API endpoints the dashboard
> will need."

1. Both sessions submit work to the orchestrator independently.
2. Orchestrator sees both items, identifies a dependency (dashboard will
   call the API), sequences them: API first (or in parallel if the
   dashboard can use mock data initially).
3. Each session receives updates about both items (they're subscribed to
   events). Session A can ask "how's the API going?" and get an answer
   from the orchestrator state.

### UC-I2. Review and Iterate

> Session A: "Build a caching layer for the database queries."
> [Agent completes work]
> Session B: "I see the caching was done with in-memory maps. That won't
> work with horizontal scaling. Redo it with Redis."

1. Session B's chat agent can see the completed work item via
   `orch.get_state` or `index.search`.
2. Submits a new work item: "Redo caching with Redis."
3. Orchestrator creates a new branch from the post-merge state and
   dispatches a Coder to replace the implementation.
4. The original in-memory version is preserved in git history.

### UC-I3. Parallel Exploration Across Sessions

> Session A: "Explore implementing the auth with Passport.js."
> Session B: "Explore implementing the auth with custom JWT middleware."

1. Orchestrator receives both work requests.
2. Recognises they target the same domain (auth). Plans them as parallel
   alternatives on separate branches.
3. Both Coders work simultaneously.
4. When both complete, orchestrator broadcasts: "Two auth approaches ready.
   Passport.js on branch saivage/todo-40, custom JWT on saivage/todo-41."
5. Either session can say "go with the JWT one" and the orchestrator merges.

---

## Category J: Long-Running & Autonomous

### UC-J1. Overnight Build

> "Build the entire backend, tests included. I'll review in the morning."

1. User submits the goal and goes away.
2. Sub-orchestrator plans 15+ work items across data model, API, auth,
   validation, error handling, tests, docs.
3. Agents work through the night. Scheduler runs everything at P3
   (background) since the user is idle.
4. Orchestrator handles agent failures by retrying, re-planning, or using
   stronger models. No human intervention needed.
5. User returns. Chat agent summarises: "I completed 14/15 items. The
   payment webhook handler is blocked because I couldn't find the Stripe
   webhook secret -- I need you to set it."

### UC-J2. Continuous Improvement

> "Keep improving test coverage until it hits 90%. Work on it whenever I'm
> not asking you for something."

1. Orchestrator creates a standing work item at P3 (background).
2. When the user is idle, dispatcher starts a Coder agent that identifies
   the least-covered module, writes tests, runs them.
3. When the user sends a message, P3 work pauses (or continues if
   concurrency allows), P0 interactive response gets priority.
4. Over hours/days, coverage climbs. Chat agent periodically reports
   progress: "Coverage now at 78% (up from 62%). 12 modules left."

### UC-J3. Multi-Day Feature Development

> "Build a complete integration with the Stripe API: customer management,
> subscription billing, invoicing, webhooks, and a billing admin dashboard."

1. This is a sub-orchestrator project spanning days.
2. Phase 1 (Day 1): Research Stripe API, design data model, implement
   customer management.
3. Phase 2 (Day 1-2): Subscription billing. User provides feedback
   between phases.
4. Phase 3 (Day 2): Invoicing and webhooks.
5. Phase 4 (Day 2-3): Admin dashboard (Vue).
6. Phase 5 (Day 3): Integration testing, edge cases.
7. Throughout, the user checks in periodically, reviews work, redirects.
   The system preserves everything in branches so no work is lost.
8. At any point the user can say "stop, let me rethink the subscription
   model" -- orchestrator pauses pending items, the user discusses the
   new approach in chat, and the plan is adjusted.

### UC-J4. Self-Improving Toolchain

> The system discovers during work that it frequently needs to interact with
> a PostgreSQL database but has no dedicated tool for it.

1. After the third time an agent uses raw SQL via `shell.run_command` +
   `psql`, the orchestrator identifies the pattern.
2. Creates a background work item: "Generate a PostgreSQL MCP service with
   tools for query, insert, schema inspection, and migration."
3. Coder agent builds the service, tests it, registers it.
4. Future agents use `postgresql.query` instead of shelling out to `psql`.
5. Chat agent notifies: "I built a PostgreSQL tool service. Database
   operations will be smoother going forward."

---

## Category K: Error Scenarios & Edge Cases

### UC-K1. Conflicting Instructions

> Session A: "Make the buttons blue."
> Session B: "Make the buttons green."

1. Orchestrator receives both work requests.
2. Both target the same files. Orchestrator detects the conflict at
   planning time (same component, contradictory goals).
3. Broadcasts to both sessions: "I received conflicting instructions about
   button colour. Session A wants blue, Session B wants green. Which
   should I do?"
4. User responds in either session. Orchestrator proceeds with the chosen
   colour, cancels the other.

### UC-K2. Mid-Task Requirement Change

> "Wait, stop. I changed my mind about the database. Use PostgreSQL instead
> of SQLite."

1. Chat submits an update via `orch.update_work` or `orch.cancel_work`.
2. Orchestrator cancels the in-flight SQLite work item and its agent.
3. Branch is preserved but not merged.
4. Orchestrator creates a new work item and branch for the PostgreSQL
   approach. May re-plan dependent items.

### UC-K3. Tool Generation Failure

> Coder agent tries to generate a MCP service for interacting with a
> proprietary API, but the API has no public documentation.

1. Coder fails: can't infer the API shape.
2. Reports `agent:blocked` with reason `needs_clarification`.
3. Orchestrator broadcasts: "I need API documentation or example requests
   for the XYZ API to build a tool for it."
4. User provides curl examples or a Postman collection.
5. Orchestrator creates a new work item with the provided context. Coder
   retries successfully.

### UC-K4. Cascading Test Failures

> A fundamental change causes 47 test failures.

1. Coder makes the change, runs tests, sees 47 failures.
2. Coder categorises them (often a single root cause -- e.g., a renamed
   export causes import failures). Fixes the root cause.
3. Re-runs: down to 12 failures (import-related ones fixed, others remain).
4. Fixes remaining in batches, re-running tests each time.
5. May take 10+ iterations. If the Coder hits iteration limits, the
   orchestrator creates a follow-up work item continuing from the branch's
   current state.

### UC-K5. Deadlock Prevention

> Agent A holds a lock on `src/models/` and needs `src/routes/`.
> Agent B holds a lock on `src/routes/` and needs `src/models/`.

1. Locks have TTLs. After timeout, the older lock is released.
2. Orchestrator detects the stall (both agents blocked waiting for locks)
   via progress timeout.
3. Orchestrator cancels one agent, lets the other proceed first, then
   re-dispatches the cancelled one.
4. In practice this is rare because the orchestrator tries to avoid
   assigning overlapping resources to parallel agents during planning.

---

## Category L: User Interaction & Conversational Workflows

These cover the conversational dimension: how users interact with the system
through chat, from first contact through complex multi-turn guidance, feedback
loops, preferences, and session management.

### UC-L1. First Contact -- Onboarding

> User opens Saivage for the first time on a new project.

1. Chat agent detects no prior conversation history for this workspace.
2. Proactively offers: "I see this is a Node.js project with Express and
   TypeScript. Want me to give you an overview of the codebase, or do you
   have something specific in mind?"
3. User: "Give me the overview."
4. Chat agent reads key files (read-only), produces a structured summary
   of the project: entry point, routes, models, dependencies, test setup.
5. Stores the overview in memory for future reference.

### UC-L2. Vague Request Clarification

> "Make the API faster."

1. Chat agent recognises the request is too vague to submit directly.
2. Asks clarifying questions: "Which endpoints are slow? Do you have
   benchmarks or a specific target response time? Or should I profile all
   endpoints and identify the worst offenders first?"
3. User: "Profile everything. Anything over 500ms should be fixed."
4. Chat agent now has a concrete goal and submits it to the orchestrator
   with clear acceptance criteria.

### UC-L3. Conversational Narrowing

> "I need to add authentication to the app."

1. Chat agent: "What kind of authentication? Options: session-based
   (cookies), JWT with refresh tokens, OAuth2 with a provider (Google,
   GitHub), or something else?"
2. User: "JWT with refresh tokens."
3. Chat agent: "Got it. Should I also add password hashing and a
   registration endpoint, or just login/logout assuming users already
   exist?"
4. User: "Full registration flow, with email verification."
5. Chat agent now has a precise spec: JWT + refresh + registration +
   email verification. Submits to orchestrator.

This dialogue turns a one-line request into a multi-item plan without the
user having to think through every detail upfront.

### UC-L4. Interactive Code Review

> "Show me what the coder did for the payment module."

1. Chat agent queries `orch.get_state` to find the completed work item and
   its branch.
2. Reads the diff (`git.diff` between the branch base and HEAD).
3. Presents a structured code review: file-by-file summary, key changes,
   potential concerns.
4. User: "I don't like the error handling in processPayment. It swallows
   exceptions."
5. Chat agent: "Want me to fix that specific function, or should I review
   all error handling in the payment module?"
6. User: "Fix all of it."
7. Chat agent submits work. The conversation context (what the user
   disliked and why) is included in the work item's context field so the
   Coder understands the intent.

### UC-L5. Guided Debugging Session

> "The dashboard is showing stale data. Help me figure out why."

1. Chat agent starts a diagnostic dialogue:
   - "Is this after a page reload or only with the live WebSocket updates?"
   - User: "Only on the live updates."
   - "Is it all data or just specific panels?"
   - User: "Just the transaction list."
2. Chat agent reads the relevant WebSocket handler and the transaction
   list component (read-only). Identifies a caching issue.
3. Presents the diagnosis: "The WebSocket handler updates the Pinia store
   but the `TransactionList` component uses a computed property with a
   5-second debounce. That's your staleness window."
4. User: "Fix it." -> submits work.

This models pair-programming where the human and AI narrow down the
problem together before any code changes are made.

### UC-L6. Teach the System a Preference

> "Whenever you write tests, always use describe/it blocks, never
> test(). Also, prefer factory functions over raw fixtures."

1. Chat agent stores this as a memory entry with tags `[testing,
   preference, code-style]`.
2. Future Coder agents, when assigned test-writing work, will have this
   preference injected into their context (via memory recall).
3. User can later ask "what are my stored preferences?" and the chat
   agent retrieves and lists them.
4. User can update: "Actually, for integration tests use test() blocks
   instead." Chat agent updates the memory entry.

### UC-L7. Explain a Decision

> "Why did you use a Map instead of a plain object in the cache module?"

1. Chat agent searches the agent transcript for the completed work item
   (`index.search_work`).
2. Finds the Coder's reasoning in its tool-call chain: it considered both
   options, chose Map because the keys are numeric IDs (non-string keys
   in a plain object would be coerced to strings).
3. Presents the reasoning. User can agree or disagree and request changes.

### UC-L8. Progressive Disclosure of Status

> Large project is running. User opens a new chat session.

1. Chat agent detects active work in the orchestrator.
2. Sends a brief summary: "There's a project running -- building the
   billing module. 7/12 work items complete. 2 agents active right now."
3. User: "Show me the full plan."
4. Chat agent presents the full TODO list with status, dependencies,
   completion times, and active agent details.
5. User: "What's taking so long on the webhook handler?"
6. Chat agent queries the agent's progress: "The Coder is on iteration 18.
   It's fighting a flaky test -- the Stripe mock server isn't responding
   consistently. It's tried 3 approaches to stabilise the mock."
7. User: "Tell it to use nock instead of a mock server."
8. Chat agent submits a redirection message via `orch.update_work` with
   the new guidance.

### UC-L9. Abort and Pivot

> User realises mid-project that the whole approach is wrong.

1. User: "Stop everything. The microservices approach is too complex for
   this stage. Let's go monolith."
2. Chat agent: "There are 4 active work items and 6 pending. Do you want
   me to cancel everything and start fresh, or keep the data model work
   (it applies to both architectures)?"
3. User: "Keep the data model, cancel the rest."
4. Chat agent submits: cancel 3 active items, cancel 6 pending items,
   keep item #2 (data model).
5. Orchestrator stops agents, preserves branches (for reference).
6. User and chat agent discuss the new monolith approach. When ready,
   chat agent submits the new plan.

This shows the system gracefully handling a major pivot -- preserving work
that's still valuable and discarding the rest without losing history.

### UC-L10. Ask for Opinions

> "I'm thinking about splitting the monolith into microservices. What do
> you think? Is the codebase ready for that?"

1. Chat agent reads the codebase structure (read-only): module coupling,
   shared state, database access patterns, inter-module calls.
2. Analyses: "The billing and notification modules are already fairly
   isolated -- they could be extracted cleanly. But the user management
   module is deeply coupled to the order module through 14 shared database
   queries. Splitting those would be significant work."
3. Offers a recommendation: "I'd suggest extracting billing and
   notifications first as a pilot. The user/order coupling needs a
   refactoring pass before it can be split cleanly."
4. No work items unless the user says to proceed.

### UC-L11. Side Conversation While Work Runs

> A complex project is running. User wants to chat about something
> unrelated while waiting.

1. Orchestrator has 3 agents working on the billing module (P1 foreground).
2. User: "While that's running, explain how JavaScript Proxies work."
3. Chat agent answers the question immediately (no work item, read-only
   knowledge query). The background agents keep running.
4. User: "Can we use Proxies to implement reactive state in our app?"
5. Chat agent reads the relevant codebase files, analyses feasibility.
6. If the user wants to proceed, the new work enters the queue at P1,
   potentially running in parallel with the billing work (within
   concurrency limits).

### UC-L12. Natural Language Work Item Management

> "Show me the TODO list. Move the testing item to higher priority. And add
> a new item: write a README."

1. Chat agent calls `orch.get_state`, presents the TODO list.
2. Submits `orch.update_work` to reprioritise the testing item.
3. Submits `orch.submit_work` for the README.
4. Presents confirmation: "Updated testing priority to high. Added 'Write
   README' at normal priority. Currently queued behind 2 items."

The user manages work through natural language, never touching a config
file or an admin UI.

### UC-L13. Context Carry-Over Between Sessions

> User closes the browser, reopens it the next day.

1. New WebSocket connection. Session Manager creates a fresh Chat agent.
2. Chat agent queries `orch.get_state` to see if there's active or
   recently completed work.
3. Searches `index.search_conversations` for the most recent session's
   context.
4. Greets: "Welcome back. Since yesterday: the billing module is done (all
   12 tests pass), the notification service is 80% complete (agent hit an
   issue with the email template -- I'll explain). Want the details?"
5. User doesn't need to remember where things were. The system catches
   them up.

### UC-L14. Request Granularity Negotiation

> "Fix all the bugs."

1. Chat agent queries the codebase for known issues: reads test output
   (existing failures), searches for TODO/FIXME comments, checks
   `orch.get_state` for previously reported bugs.
2. Responds: "I found 3 failing tests, 7 TODO/FIXME comments, and 2
   previously flagged bugs. Do you want me to tackle all of them, or
   should we prioritise? Here's the list ranked by likely impact: [...]"
3. User: "Do the 3 failing tests and the 2 flagged bugs. Leave the TODOs."
4. Chat agent submits 5 specific work items with clear scope.

### UC-L15. Pair Programming Mode

> "Let's work on the search feature together. I'll make decisions, you
> write the code."

1. Chat agent enters an interactive, high-frequency exchange mode.
2. User: "Start with the search index. Use SQLite FTS5."
3. Chat agent submits a focused work item. Coder builds it.
4. Chat agent shows the result: "Done. Here's the schema and the index
   builder. It indexes title and description fields."
5. User: "Add the content field too. And add a highlight function."
6. Chat agent submits a refinement. Coder adjusts.
7. User: "Good. Now build the search endpoint."
8. And so on. Each micro-task is tracked, branched, merged. The user
   drives the direction; the system executes instantly.

The difference from a normal conversation is the expected latency: each
step should complete in seconds, not minutes. The orchestrator fast-tracks
these items and the scheduler gives them P0 (interactive) priority.

### UC-L16. Watching Agents Work

> "Don't just tell me when it's done. Show me what the coder is doing in
> real time."

1. Chat agent adjusts its event subscription to surface every
   `agent:progress` event for the active work item, not just milestones.
2. Streams a live feed:
   - "Reading src/routes/invoices.ts..."
   - "Calling shell.run_command: pnpm test -- --filter invoices..."
   - "3 tests failed. Reading test output..."
   - "Modifying src/routes/invoices.ts line 47..."
   - "Re-running tests... 1 failure remaining..."
   - "Fixing the date format assertion..."
   - "All tests pass."
3. User can interject at any point: "Wait, don't change the date format.
   The test expectation is wrong, not the code."
4. Chat agent forwards the redirection.

### UC-L17. Multi-Language / Multi-Framework Guidance

> "I want to add a Python ML service that the TypeScript API calls. How
> should we structure this?"

1. Chat agent discusses architecture (read-only): suggests a Python
   FastAPI service with a REST or gRPC interface, called from the
   Node.js API.
2. User agrees. Chat agent: "Should I build the Python service too, or
   just the TypeScript integration layer?"
3. User: "Build both."
4. Orchestrator plans:
   - Item 1: Scaffold the Python service (Coder -- system can invoke
     Python tools via shell).
   - Item 2: Implement the ML endpoint in Python (Coder).
   - Item 3: Add the TypeScript client for the ML service (Coder).
   - Item 4: Integration test (Executor).
5. Chat agent keeps the user updated as both sides progress.

### UC-L18. Scheduled Check-In

> "I'm going into a meeting. When the API refactoring is done, write a
> summary and wait for me."

1. Chat agent acknowledges. Work continues at P3 (user idle).
2. When the refactoring work item completes, orchestrator emits the event.
3. Chat agent composes a summary but doesn't need the user to be present
   -- it stores the summary and waits.
4. User returns, types anything. Chat agent immediately presents: "The API
   refactoring finished while you were away. Here's what changed: [...]"

### UC-L19. Expressing Dissatisfaction

> "This code is terrible. The variable names are meaningless and there's
> no error handling."

1. Chat agent doesn't take it personally. Acknowledges the concern:
   "I'll fix the naming and add proper error handling. Should I also
   run this through the linter?"
2. Submits a work item with explicit cleanup criteria from the user's
   complaint: meaningful names, proper error handling, lint pass.
3. Stores the feedback as a preference for future work: "User expects
   descriptive variable names and thorough error handling."

### UC-L20. Asking About Cost and Resource Usage

> "How much has this project cost so far? Which tasks were the most
> expensive?"

1. Chat agent queries the work history for token usage and cost estimates.
2. Presents a breakdown:
   - "Total: ~$4.82 across 23 work items."
   - "Most expensive: UC-D1 data model design ($0.95, 8 iterations with
     claude-opus)."
   - "Cheapest average: test-writing ($0.12/item, haiku model)."
3. User: "Can we use a cheaper model for the research tasks?"
4. Chat agent stores the preference and informs the orchestrator to use
   a cheaper model for future Researcher dispatches.

### UC-L21. File and Artifact Sharing

> "Here's the database dump from production. Import it into the dev
> environment and verify the migration works."

1. User uploads a file (via chat attachment or provides a path).
2. Chat agent submits a work item with the file as an artifact.
3. Executor: imports the dump into the dev database.
4. Coder: runs the migration, verifies schema matches expectations.
5. Reports: "Migration applied. 3 new columns added.  2 records failed
   data validation (null email addresses in legacy accounts). Details:
   [...]"

### UC-L22. Resuming After a Crash

> The Saivage process crashed and restarted.

1. User opens the web chat. Chat agent detects the fresh start.
2. Queries `orch.get_state` -- orchestrator has resumed from persisted
   state.
3. Chat agent: "I restarted after an interruption. The orchestrator has
   recovered. 2 work items were in progress when I stopped -- they've
   been re-queued. 5 completed items are intact. Want me to resume the
   in-progress work?"
4. User: "Yes, continue where you left off."
5. Orchestrator re-dispatches the 2 interrupted items.

### UC-L23. Teaching Through Examples

> "Here's how I want API error responses to look: [JSON example]. Apply
> this pattern everywhere."

1. Chat agent stores the pattern as a skill or memory entry.
2. Submits a work item: "Audit all API error responses and standardise
   them to match the provided pattern."
3. Coder reads the example, searches all endpoints, fixes inconsistencies.
4. Future work items automatically get the error response pattern in
   their context.

### UC-L24. Comparing Before and After

> "Show me a before/after comparison of the performance improvements."

1. Chat agent queries the work history for the performance-related items.
2. Finds the benchmark results from before (attached to the profiling
   work item) and after (attached to the fix work item).
3. Presents a side-by-side comparison: endpoint, before (ms), after (ms),
   improvement (%).
4. All read-only -- just retrieval and formatting.

### UC-L25. Delegating a Chat Session to Run Autonomously

> "Here's a list of 20 things I want done. Work through them in order.
> Don't ask me questions -- just make reasonable decisions."

1. Chat agent submits all 20 items to the orchestrator in one batch,
   with a note: "User requested autonomous execution. Default to
   reasonable decisions when ambiguity arises."
2. Orchestrator plans, prioritises (respecting the listed order where
   dependencies allow), and dispatches.
3. Chat agent suppresses clarification requests and makes best-effort
   decisions.
4. When all items are done, chat agent presents a summary: "20/20
   complete. 3 items had ambiguities -- here's what I decided and why:
   [...]"
5. User can retroactively adjust any decision.

---

## Category M: Self-Modification & Dual-Project Operation

These use cases cover Saivage modifying **itself** while simultaneously
working on the target project. Every self-modification goes through
sandboxing, versioning, and hot-replacement.

### UC-M1. Generate a Missing MCP Service

> Agent needs to interact with a PostgreSQL database but no `postgresql.*`
> tools exist.

1. Worker agent reports `agent:blocked` with `reason: "missing_tool"`.
2. Orchestrator creates a **self-project** work item: "Generate postgresql
   MCP service" with `project: "self"`.
3. Creates branch `saivage/self-todo-50-postgresql-service` in the Saivage
   repo.
4. Dispatches Coder to implement the service with tools for `query`,
   `execute`, `schema_info`, `list_tables`.
5. Coder writes code, tests. Orchestrator runs **sandbox validation**:
   spins up the new service in isolation, runs contract tests.
6. On pass: promotes the service, runtime registers it, blocked agent
   retries its original work.
7. Future agents use `postgresql.*` tools natively.

### UC-M2. Upgrade an Existing MCP Service

> The `filesystem` service is missing a `glob_search` tool that agents
> keep working around with `shell.run_command` + `find`.

1. Orchestrator detects the pattern (3+ agents used `find` via shell in
   the last hour) or the user requests "add glob search to the filesystem
   service".
2. Creates a self-project work item on branch
   `saivage/self-todo-51-fs-glob`.
3. Coder reads the current `filesystem` service source (versioned),
   adds the `glob_search` tool, updates tests.
4. Sandbox: new version runs alongside the old one. Contract tests confirm
   all existing tools still work + the new tool works.
5. Runtime performs **hot-replacement**: drains in-flight calls to old
   version, swaps, health-checks. Old version saved to version store.
6. If the new version crashes within the first 60 seconds, automatic
   rollback to the previous version.

### UC-M3. Replace a Built-in Service Entirely

> The built-in `web-fetch` service is too basic. The user says: "Rewrite
> web-fetch to use Playwright for JavaScript-rendered pages."

1. Orchestrator creates self-project work item.
2. Coder reads the current `web-fetch` source and its registered tool
   schemas (these are the contract).
3. Coder writes a new implementation using Playwright, keeping all
   existing tool signatures unchanged + adding a new
   `fetch_rendered_page` tool.
4. Sandbox: full regression suite. Contract tests verify
   `fetch_url` and `fetch_page_content` still work identically.
5. Hot-replacement. Built-in services are treated with the same
   versioning as generated ones — no special status.

### UC-M4. Create a New Agent Type

> "I need a 'DBA agent' specialised in database schema design, query
> optimisation, and migration authoring."

1. Orchestrator creates self-project work item.
2. Coder generates `~/.saivage/agents/dba.json` with system prompt,
   tool patterns (`postgresql.*`, `filesystem.*`, `shell.*`), skills
   (`database-design`), and model assignment.
3. Optionally, Coder also generates a `database-design` skill file.
4. Both are versioned. Sandbox: the orchestrator dispatches a test task
   to the new agent type and verifies it produces sensible output.
5. New agent type is registered — orchestrator can use it for future work.

### UC-M5. Modify the Orchestrator's Own Logic

> "The orchestrator's branch merge strategy is too conservative. Change it
> to always attempt merge and only create a resolution task on conflict."

1. This is a **core module change** — highest risk.
2. Orchestrator creates self-project work item on branch
   `saivage/self-todo-55-merge-strategy`.
3. Coder modifies `src/orchestrator/branchManager.ts`, updates tests.
4. Sandbox: a **secondary Saivage instance** is spawned from the branch.
   A smoke-test suite dispatches work items, verifies merge behaviour,
   checks that the event loop is stable.
5. If tests pass, the primary instance schedules a **graceful restart**:
   persists all state, signals agents to quiesce, restarts from the new
   code, resumes state.
6. Previous version retained in git history. Rollback via
   `saivage rollback core <commit>`.

### UC-M6. Hot-Fix a Crashing Service

> The `memory` service starts crashing after a schema migration gone wrong.

1. Runtime detects repeated crashes, emits `service:unhealthy`.
2. Orchestrator immediately rolls back to the previous version (no
   sandbox needed — rollback is always safe).
3. Creates a self-project work item to fix the issue.
4. Coder reads the crash logs, identifies the bug, fixes it on a branch.
5. Sandbox validates the fix against the schema migration.
6. Hot-replacement with the fixed version.

### UC-M7. Parallel Self-Modification and Target Work

> User asks to build a REST API, but midway through, the coder agent
> discovers it needs a `docker.*` MCP service that doesn't exist.

1. Worker agent on the target project reports `tool_missing: docker.*`.
2. Orchestrator creates two parallel work streams:
   - **Target project** (paused/partial): REST API work continues on its
     branch with non-Docker tasks.
   - **Self-project**: Generate `docker` MCP service.
3. Both use separate branches and separate lock namespaces (`target:*`
   vs `self:*`).
4. Docker service is sandbox-tested and promoted.
5. Orchestrator unblocks the paused target work item, which now has
   `docker.*` tools available.
6. REST API work resumes seamlessly.

### UC-M8. Version Rollback

> "The new version of the filesystem service has a bug in write_file.
> Roll back."

1. User tells the chat agent, which calls `orch.submit_work` with
   `project: "self"`, goal: "rollback filesystem service".
2. Orchestrator queries the version store: filesystem v0.3.0 (current,
   broken), v0.2.0, v0.1.0.
3. Stops v0.3.0, starts v0.2.0 from the version store.
4. Health check passes. Service registry updated to point to v0.2.0.
5. v0.3.0 remains in the version store for debugging.

### UC-M9. Self-Improvement via Pattern Detection

> Over the past week, agents repeatedly struggled with TypeScript path
> alias resolution. No skill exists for it.

1. Orchestrator (or a background analysis task) identifies the pattern:
   5 work items in the last 7 days had iterations wasted on
   `tsconfig.json` path mapping issues.
2. Creates a background self-project work item: "Write a
   `typescript-path-aliases` skill".
3. Researcher: reads tsconfig docs, existing project configs, and the
   failed agent transcripts to understand what went wrong.
4. Coder: writes `~/.saivage/skills/typescript-path-aliases/SKILL.md`
   with clear rules and examples.
5. Skill is versioned and registered. Future Coder agents working with
   TypeScript path aliases get it auto-loaded via trigger matching.

### UC-M10. Upgrade a Core Dependency

> `@modelcontextprotocol/sdk` releases v2.0 with breaking changes. All
> MCP services need updating.

1. Orchestrator creates a self-project sub-orchestrator for the
   migration (multi-phase project).
2. Phase 1: Researcher reads the migration guide.
3. Phase 2: Coder updates each MCP service (built-in and generated),
   one per work item, each on its own branch.
4. Phase 3: Each updated service is sandbox-tested with contract tests.
5. Phase 4: Hot-replacement rolls them out one by one, with automatic
   rollback if any fails.
6. The Saivage core (`src/mcp/client.ts`, `transport.ts`) is updated
   in a final phase with secondary-instance testing.

### UC-M11. Live Schema Evolution

> The orchestrator's `TodoItem` interface needs a new `project` field to
> support dual-project operation.

1. Self-project work item on a branch.
2. Coder modifies the interface, updates all code that creates/reads
   `TodoItem` objects, writes a state migration function that adds the
   field to persisted state files.
3. Sandbox: secondary instance loads the old state file, runs the
   migration, verifies it can resume work.
4. Graceful restart applies the migration.

### UC-M12. Emergency Self-Repair

> A self-modification gone wrong corrupted the event bus. No agents can
> be dispatched.

1. The watchdog (a minimal process separate from the main orchestrator)
   detects that the orchestrator has stopped processing events.
2. Watchdog triggers an automatic rollback of the last self-modification.
3. Restarts the orchestrator from the previous known-good state.
4. Notifies connected chat sessions: "I detected a system failure and
   rolled back to the previous version. The last self-modification
   ([description]) has been reverted."
