# F18 — Plan r1 (recommended Proposal B)

## Ordered edit steps

### Step 1 — Create `prompts/` tree at the repo root

Files to create (paths relative to repo root `/home/salva/g/ml/saivage/`):

- `prompts/shared/roster.md` — paste the "Saivage system / agent hierarchy" paragraph currently duplicated in Planner/Manager/Inspector/Chat, lightly merged to remove wording drift.
- `prompts/shared/communication-protocol.md` — "structured returns" paragraph.
- `prompts/shared/persistence.md` — `.saivage/plan.json`, `plan-history.json`, `stages/`, `tmp/state/runtime.json` paragraph. Drop the `.saivage/runtime/runtime-state.json` mention (per workspace memory, that path is a compatibility mirror, not authoritative).
- `prompts/shared/corrective-action.md` — "evaluate, fix or escalate" paragraph.
- `prompts/shared/execution-style.md` — content of `VISIBLE_EXECUTION_STYLE_PROMPT` from [src/agents/base.ts](src/agents/base.ts#L83-L89).
- `prompts/shared/worker-contract.md` — `TaskReport` shape + checklist + issues_found rules, distilled from Coder/Researcher/Reviewer/Data Agent prompts.
- `prompts/planner.md` — role-specific Planner content from [src/agents/planner.ts](src/agents/planner.ts#L18-L159), with shared sections replaced by `{{> shared/roster}}`, `{{> shared/communication-protocol}}`, `{{> shared/persistence}}`, `{{> shared/corrective-action}}`, and trailing `{{> shared/execution-style}}`.
- `prompts/manager.md` — same treatment for [src/agents/manager.ts](src/agents/manager.ts#L21-L265).
- `prompts/coder.md` — [src/agents/coder.ts](src/agents/coder.ts#L20-L139); includes `{{> shared/worker-contract}}`, `{{> shared/execution-style}}`.
- `prompts/researcher.md` — [src/agents/researcher.ts](src/agents/researcher.ts#L18-L136); same shared includes.
- `prompts/data-agent.md` — [src/agents/data-agent.ts](src/agents/data-agent.ts#L17-L71); same shared includes.
- `prompts/reviewer.md` — [src/agents/reviewer.ts](src/agents/reviewer.ts#L17-L77); same shared includes.
- `prompts/inspector.md` — [src/agents/inspector.ts](src/agents/inspector.ts#L18-L131); shared includes (roster, communication-protocol, execution-style).
- `prompts/chat.md` — [src/agents/chat.ts](src/agents/chat.ts#L33-L128); contains `{{slash_commands_table}}` placeholder.
- `prompts/designer.md` — [src/agents/designer.ts](src/agents/designer.ts#L17-L72); kept even though F01 marks the agent orphan (deletion is F01's call, not F18's).

### Step 2 — Add slash-command source of truth (F30 alignment)

Create `src/agents/chat-commands.ts` with a single declarative array:

```ts
export interface ChatCommand {
  name: string;
  aliases?: string[];
  usage: string;
  help: string;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  { name: "/help",            usage: "/help",                    help: "..." },
  { name: "/status",          usage: "/status",                  help: "..." },
  { name: "/plan",            usage: "/plan",                    help: "..." },
  { name: "/history",         usage: "/history [n]",             help: "..." },
  { name: "/replan",          usage: "/replan [reason]",         help: "..." },
  { name: "/restart-planner", aliases: ["/planner-restart"],     usage: "/restart-planner [reason]", help: "..." },
  { name: "/note",            usage: "/note <message>",          help: "..." },
  { name: "/note!",           usage: "/note! <message>",         help: "..." },
  { name: "/notep",           usage: "/notep <message>",         help: "..." },
];

export function renderSlashCommandsTable(): string { /* markdown table */ }
```

This is the source consumed by both the prompt substitution and the `/help` handler. Update `tryHandleCommand` at [src/agents/chat.ts](src/agents/chat.ts#L297-L358) and `cmdHelp` at [src/agents/chat.ts](src/agents/chat.ts#L369-L378) to consume `CHAT_COMMANDS` instead of hand-typing the lists.

(Note: full F30 closure may require additional cleanup; F18's contract is just to remove the prompt-text copy from `chat.ts`.)

### Step 3 — Add the prompt loader

Create `src/agents/prompts.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderSlashCommandsTable } from "./chat-commands.js";

export type RolePromptName =
  | "planner" | "manager" | "coder" | "researcher"
  | "data-agent" | "reviewer" | "inspector" | "chat" | "designer";

const INCLUDE_RE = /\{\{>\s+([a-z0-9/_-]+)\s*\}\}/g;
const VAR_RE     = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;

let promptsRootCache: string | undefined;
function promptsRoot(): string {
  if (promptsRootCache) return promptsRootCache;
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled: dist/cli.js + dist/prompts. Source: src/agents/prompts.ts + <repo>/prompts.
  for (const candidate of [resolve(here, "prompts"), resolve(here, "../prompts"), resolve(here, "../../prompts")]) {
    try { readFileSync(resolve(candidate, "shared/execution-style.md")); promptsRootCache = candidate; return candidate; } catch { /* try next */ }
  }
  throw new Error("prompts/ directory not found relative to " + here);
}

function readMd(name: string): string {
  return readFileSync(resolve(promptsRoot(), name.endsWith(".md") ? name : `${name}.md`), "utf8");
}

function substitutions(): Record<string, string> {
  return { slash_commands_table: renderSlashCommandsTable() };
}

function render(source: string, depth = 0): string {
  if (depth > 4) throw new Error("prompt include depth exceeded");
  const withIncludes = source.replace(INCLUDE_RE, (_, p) => render(readMd(p), depth + 1));
  const subs = substitutions();
  return withIncludes.replace(VAR_RE, (raw, name) => subs[name] ?? raw);
}

const cache = new Map<RolePromptName, string>();
export function loadRolePrompt(role: RolePromptName): string {
  const hit = cache.get(role); if (hit) return hit;
  const out = render(readMd(role));
  cache.set(role, out);
  return out;
}
```

### Step 4 — Wire each agent to the loader, delete TS prompt constants

For each file below: delete the `*_PROMPT` template-literal constant, import `loadRolePrompt`, replace `systemPrompt: XXX_PROMPT` with `systemPrompt: loadRolePrompt("<role>")`:

- [src/agents/planner.ts](src/agents/planner.ts#L18-L159), [src/agents/planner.ts](src/agents/planner.ts#L176)
- [src/agents/manager.ts](src/agents/manager.ts#L21-L265), [src/agents/manager.ts](src/agents/manager.ts#L282)
- [src/agents/coder.ts](src/agents/coder.ts#L20-L139), [src/agents/coder.ts](src/agents/coder.ts#L151)
- [src/agents/researcher.ts](src/agents/researcher.ts#L18-L136), [src/agents/researcher.ts](src/agents/researcher.ts#L148)
- [src/agents/data-agent.ts](src/agents/data-agent.ts#L17-L71), [src/agents/data-agent.ts](src/agents/data-agent.ts#L82)
- [src/agents/reviewer.ts](src/agents/reviewer.ts#L17-L77), [src/agents/reviewer.ts](src/agents/reviewer.ts#L89)
- [src/agents/inspector.ts](src/agents/inspector.ts#L18-L131), [src/agents/inspector.ts](src/agents/inspector.ts#L143)
- [src/agents/chat.ts](src/agents/chat.ts#L33-L128), [src/agents/chat.ts](src/agents/chat.ts#L157)
- [src/agents/designer.ts](src/agents/designer.ts#L17-L72), [src/agents/designer.ts](src/agents/designer.ts#L83)

### Step 5 — Update `base.ts`

- Delete `VISIBLE_EXECUTION_STYLE_PROMPT` at [src/agents/base.ts](src/agents/base.ts#L83-L89). It now lives in `prompts/shared/execution-style.md` and is included by each role file (Step 1).
- Remove its concatenation at [src/agents/base.ts](src/agents/base.ts#L171-L175); the assembled string becomes `[config.systemPrompt, skillBlock].filter(Boolean).join("\n\n")`. (Role prompts now embed execution-style themselves.)
- Rewrite the JSDoc at [src/agents/base.ts](src/agents/base.ts#L104-L105) to: `/** Rendered role prompt (see prompts/<role>.md and src/agents/prompts.ts). */`. This closes F31.

### Step 6 — Update `tsup.config.ts` to ship `prompts/`

At [tsup.config.ts](tsup.config.ts#L14-L19), inside `onSuccess`, add:

```ts
await mkdir("dist/prompts", { recursive: true });
await cp("prompts", "dist/prompts", { recursive: true });
```

### Step 7 — Add the "no prompt template literals in src/agents" guard

Add a vitest test `src/agents/prompts.test.ts` that:

1. Asserts `loadRolePrompt("<role>")` returns a non-empty string for each of the nine roles and contains a known marker phrase from the role-specific section.
2. Asserts no file under `src/agents/` (excluding `prompts.ts` itself and its test) contains the regex `_PROMPT\s*=\s*\``. Implementation: read the directory and scan. This is the lint that prevents regression.
3. Asserts `loadRolePrompt("chat")` contains a rendered slash-commands Markdown table including every `name` in `CHAT_COMMANDS`.

### Step 8 — Delete the obsolete `prompts/<role>.md` JSDoc tracking note in F31

Once Step 5 lands, F31's "stale promise" condition is resolved. F31's own writer will close it; F18 does not need to edit F31's spec text.

## Test strategy

### Existing tests that must keep passing
- `npx vitest run src/agents/` — all agent tests. They use stub `systemPrompt: "sys"` ([src/agents/base.compaction.test.ts](src/agents/base.compaction.test.ts#L113-L159), [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts#L97)). They never touch the loader, so they should stay green.
- `npx vitest run` — full suite.

### New tests
- `src/agents/prompts.test.ts` — see Step 7.
- `src/agents/chat-commands.test.ts` — asserts `CHAT_COMMANDS` is consumed by `tryHandleCommand` (every entry has a case) and by `renderSlashCommandsTable`.

### Validation commands

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run src/agents/prompts.test.ts src/agents/chat-commands.test.ts
npx vitest run src/agents/
npx vitest run
```

### Smoke validation against a live runtime
After `npm run build`, verify `dist/prompts/` exists:

```bash
ls dist/prompts/shared/
ls dist/prompts/planner.md
```

Restart `saivage-v3.service` per the workspace LXC conventions; confirm the Planner boots (no "prompts/ directory not found" exception in the journal).

## Rollback strategy

Single feature branch, single squashed commit. Rollback = `git revert <sha>` — restores the TS prompt constants, the `tsup.config.ts`, and `base.ts` in one shot. The `prompts/` directory is removed by the revert.

## Cross-issue ordering

- **Before**: nothing depends on F18 being merged first.
- **After**:
  - F31 should be closed once F18 lands (its only ask — make the JSDoc honest — is done in Step 5).
  - F30 becomes a smaller cleanup (the prompt-text copy is gone after Step 2; F30 owner can then remove the remaining duplication between `/help` table and `tryHandleCommand` if not already done as part of Step 2).
  - F02 roster-drift fix should land **after** F18, because F18 collapses the drift hosts to a single file (`prompts/shared/roster.md`); F02's writer should update its plan to point at that file instead of the four TS prompts.
  - F09 (worker base) is orthogonal but benefits from F18 landing first: `prompts/shared/worker-contract.md` becomes the single home for the worker contract prose, which F09's refactor can reference.
  - F33 is orthogonal; this plan only ensures prompts stop naming defaults.
