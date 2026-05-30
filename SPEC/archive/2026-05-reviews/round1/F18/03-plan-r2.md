# F18 — Plan r2 (recommended Proposal B)

## Changes from r1

- **Step 2 narrowed to the local-Chat command family only.** r1 proposed a `CHAT_COMMANDS` array in a new `src/agents/chat-commands.ts` and rewired both `tryHandleCommand` and `cmdHelp` against it. The reviewer flagged that this would either drop `/skills`, `/memories`, `/remember`, `/forget` from `/help` (they are wired through `parseSlashCommand` in [src/chat/slashCommands.ts](src/chat/slashCommands.ts), not the local `switch`) or pull memory/skill behaviour into the wrong module. Per the F18 r2 brief, the skills/memory subsystem is owned by another agent and is out of scope for F18. r2 therefore:
  - Adds `LOCAL_CHAT_COMMANDS` + `renderLocalChatCommandsTable()` to `src/agents/conventions.ts` (no new file), covering only the nine local commands the current `switch` already owns.
  - Uses it ONLY to substitute `{{slash_commands_table}}` in `prompts/chat.md`.
  - Does NOT edit `tryHandleCommand`, does NOT edit `cmdHelp`, does NOT edit `src/chat/slashCommands.ts`, does NOT edit the `parseSlashCommand` hook at [src/agents/chat.ts](src/agents/chat.ts#L300-L329).
- **Step 7's test updated.** The chat-commands test no longer asserts "every entry has a `tryHandleCommand` case". The local switch remains hand-coded under F18; F30 will deduplicate it. The retained assertions are: `LOCAL_CHAT_COMMANDS` is non-empty; `renderLocalChatCommandsTable()` contains every command name; `loadRolePrompt("chat")` contains the rendered table and does not contain the literal placeholder.
- **Smoke-validation service name corrected.** r1 said restart `saivage-v3.service`. The deployed systemd unit on the `saivage-v3` LXC is `saivage.service` per [deploy/Makefile](deploy/Makefile#L44-L58) and [deploy/scripts/provision.sh](deploy/scripts/provision.sh#L127-L147). r2 uses the right unit name and the workspace's classic-LXC / SSH conventions.
- **Cross-issue ordering note for F30** clarified: F18 closes the prompt-text copy only. F30 still owns deduplicating the local `switch` against the `cmdHelp` Markdown table.

## Ordered edit steps

### Step 1 — Create `prompts/` tree at the repo root

Files to create (paths relative to repo root `/home/salva/g/ml/saivage/`):

- `prompts/shared/roster.md` — "Saivage system / agent hierarchy" paragraph currently duplicated in Planner/Manager/Inspector/Chat, lightly merged to remove wording drift.
- `prompts/shared/communication-protocol.md` — "structured returns" paragraph.
- `prompts/shared/persistence.md` — `.saivage/plan.json`, `plan-history.json`, `stages/`, `tmp/state/runtime.json` paragraph. Drop the `.saivage/runtime/runtime-state.json` mention.
- `prompts/shared/corrective-action.md` — "evaluate, fix or escalate" paragraph.
- `prompts/shared/execution-style.md` — content of `VISIBLE_EXECUTION_STYLE_PROMPT` from [src/agents/base.ts](src/agents/base.ts#L83-L89).
- `prompts/shared/worker-contract.md` — `TaskReport` shape + checklist + issues_found rules, distilled from Coder/Researcher/Reviewer/Data Agent prompts.
- `prompts/planner.md` — role-specific Planner content from [src/agents/planner.ts](src/agents/planner.ts#L18-L159) with shared sections replaced by `{{> shared/roster}}`, `{{> shared/communication-protocol}}`, `{{> shared/persistence}}`, `{{> shared/corrective-action}}`, and trailing `{{> shared/execution-style}}`.
- `prompts/manager.md` — same treatment for [src/agents/manager.ts](src/agents/manager.ts#L21-L265).
- `prompts/coder.md` — [src/agents/coder.ts](src/agents/coder.ts#L20-L139); includes `{{> shared/worker-contract}}`, `{{> shared/execution-style}}`.
- `prompts/researcher.md` — [src/agents/researcher.ts](src/agents/researcher.ts#L18-L136); same shared includes.
- `prompts/data-agent.md` — [src/agents/data-agent.ts](src/agents/data-agent.ts#L17-L71); same shared includes.
- `prompts/reviewer.md` — [src/agents/reviewer.ts](src/agents/reviewer.ts#L17-L77); same shared includes.
- `prompts/inspector.md` — [src/agents/inspector.ts](src/agents/inspector.ts#L18-L131); shared includes (roster, communication-protocol, execution-style).
- `prompts/chat.md` — [src/agents/chat.ts](src/agents/chat.ts#L33-L128); the existing "Slash Commands" section (currently at [src/agents/chat.ts](src/agents/chat.ts#L102-L110), and listing only the nine local commands — no skills/memories rows) is replaced by `{{slash_commands_table}}`. The rest is content-preserving.
- `prompts/designer.md` — [src/agents/designer.ts](src/agents/designer.ts#L17-L72); kept even though F01 marks the agent orphan (deletion is F01's call).

### Step 2 — Add local-Chat slash-command source of truth in `conventions.ts`

Append to [src/agents/conventions.ts](src/agents/conventions.ts):

```ts
export interface LocalChatCommand {
  name: string;
  aliases?: string[];
  usage: string;
  help: string;
}

/**
 * Local Chat-handled slash commands. The memory/skill family
 * (`/skills`, `/memories`, `/remember`, `/forget`) is routed through
 * `parseSlashCommand` in `src/chat/slashCommands.ts` and is intentionally
 * NOT listed here — that subsystem is owned separately.
 */
export const LOCAL_CHAT_COMMANDS: LocalChatCommand[] = [
  { name: "/help",            usage: "/help",                     help: "Show available commands." },
  { name: "/status",          usage: "/status",                   help: "Current system status (running agents, current stage, recent completions)." },
  { name: "/plan",            usage: "/plan",                     help: "Show the current plan (all stages with status)." },
  { name: "/history",         usage: "/history [n]",              help: "Show completed/failed stages (last n, default 5)." },
  { name: "/replan",          usage: "/replan [reason]",          help: "Create an urgent note asking the Planner to replan." },
  { name: "/restart-planner", aliases: ["/planner-restart"],      usage: "/restart-planner [reason]", help: "Cancel the current Planner turn and immediately restart it with the provided reason." },
  { name: "/note",            usage: "/note <message>",           help: "Create a volatile note for the Planner." },
  { name: "/note!",           usage: "/note! <message>",          help: "Create an urgent high-priority note for the Planner." },
  { name: "/notep",           usage: "/notep <message>",          help: "Create a permanent note for the Planner." },
];

export function renderLocalChatCommandsTable(): string {
  return LOCAL_CHAT_COMMANDS
    .map((c) => `- \`${c.usage}\` — ${c.help}`)
    .join("\n");
}
```

**Do NOT** edit `tryHandleCommand` ([src/agents/chat.ts](src/agents/chat.ts#L297-L361)), `cmdHelp` ([src/agents/chat.ts](src/agents/chat.ts#L363-L390)), or [src/chat/slashCommands.ts](src/chat/slashCommands.ts) under F18. Cross-link F30 in the commit message: "F18 closes only the prompt-text copy; F30 owns deduplicating the local switch and the /help table."

### Step 3 — Add the prompt loader

Create `src/agents/prompts.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderLocalChatCommandsTable } from "./conventions.js";

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
    try {
      readFileSync(resolve(candidate, "shared/execution-style.md"));
      promptsRootCache = candidate;
      return candidate;
    } catch { /* try next */ }
  }
  throw new Error("prompts/ directory not found relative to " + here);
}

function readMd(name: string): string {
  return readFileSync(resolve(promptsRoot(), name.endsWith(".md") ? name : `${name}.md`), "utf8");
}

function substitutions(): Record<string, string> {
  return { slash_commands_table: renderLocalChatCommandsTable() };
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

Note: this module imports from `./conventions.js` only. It deliberately does not import from `../chat/slashCommands.js` or anything under `src/skills/`. The substitution map has exactly one key.

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

The `parseSlashCommand` hook and the local `switch` in [src/agents/chat.ts](src/agents/chat.ts#L297-L361) and the entire `cmdHelp` method ([src/agents/chat.ts](src/agents/chat.ts#L363-L390)) are **untouched** by this step.

### Step 5 — Update `base.ts`

- Delete `VISIBLE_EXECUTION_STYLE_PROMPT` at [src/agents/base.ts](src/agents/base.ts#L83-L89). It now lives in `prompts/shared/execution-style.md` and is included by each role file.
- Remove its concatenation at [src/agents/base.ts](src/agents/base.ts#L171-L175); the assembled string becomes `[config.systemPrompt, skillBlock].filter(Boolean).join("\n\n")`. Role prompts now embed execution-style themselves.
- Rewrite the JSDoc at [src/agents/base.ts](src/agents/base.ts#L104-L105) to: `/** Rendered role prompt (see prompts/<role>.md and src/agents/prompts.ts). */`. Closes F31.

### Step 6 — Update `tsup.config.ts` to ship `prompts/`

At [tsup.config.ts](tsup.config.ts#L14-L19), inside `onSuccess`, add:

```ts
await mkdir("dist/prompts", { recursive: true });
await cp("prompts", "dist/prompts", { recursive: true });
```

### Step 7 — Add tests

`src/agents/prompts.test.ts`:

1. For each of the nine roles, assert `loadRolePrompt(role)` returns a non-empty string and contains a known marker phrase from the role-specific section.
2. Assert no file under `src/agents/` (excluding `prompts.ts` itself and its test) contains the regex `_PROMPT\s*=\s*\``. Implementation: read the directory and scan. This prevents regression.
3. Assert `loadRolePrompt("chat")` contains every `name` from `LOCAL_CHAT_COMMANDS` and does not contain the literal string `{{slash_commands_table}}`.
4. Assert `loadRolePrompt(role)` for every role does not contain unrendered `{{> ` or `{{` markers (catches typo'd includes / missing substitutions).

`src/agents/chat-commands.test.ts`:

1. `LOCAL_CHAT_COMMANDS` is non-empty, every entry has a `usage` and `help`, names start with `/`.
2. `renderLocalChatCommandsTable()` contains every `name` in `LOCAL_CHAT_COMMANDS` exactly once.
3. **Explicitly does NOT** assert pairing with `tryHandleCommand`'s switch. F30 will own that. The test file contains a comment to that effect.

## Test strategy

### Existing tests that must keep passing
- `npx vitest run src/agents/` — all agent tests. They use stub `systemPrompt: "sys"` ([src/agents/base.compaction.test.ts](src/agents/base.compaction.test.ts#L113-L159), [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts#L97)). They never touch the loader, so they stay green.
- `npx vitest run` — full suite.
- `npx vitest run src/chat/` — must stay green. `src/chat/slashCommands.ts` and any companion tests are untouched.

### New tests
- `src/agents/prompts.test.ts` — see Step 7.
- `src/agents/chat-commands.test.ts` — see Step 7.

### Validation commands

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run build
npx vitest run src/agents/prompts.test.ts src/agents/chat-commands.test.ts
npx vitest run src/agents/
npx vitest run src/chat/
npx vitest run
```

### Smoke validation against a live runtime

After `npm run build`, verify `dist/prompts/` exists:

```bash
ls dist/prompts/shared/
ls dist/prompts/planner.md
```

The Saivage v2 runtime is deployed to the `saivage-v3` LXC container via the systemd unit `saivage.service` (NOT `saivage-v3.service` — that unit does not exist; `saivage-v3` is the container name, not the unit name). Restart and verify per workspace LXC conventions:

```bash
# Preferred (passwordless SSH, per ml-workspace-saivage memory)
ssh root@10.0.3.112 'systemctl restart saivage.service'
ssh root@10.0.3.112 'systemctl status saivage.service --no-pager'
ssh root@10.0.3.112 'journalctl -u saivage.service -n 200 --no-pager'

# Fallback via classic LXC
sudo lxc-attach -n saivage-v3 -- systemctl restart saivage.service
sudo lxc-attach -n saivage-v3 -- journalctl -u saivage.service -n 200 --no-pager
```

Confirm the Planner boots: no `prompts/ directory not found` exception in the journal, and `curl -fsS http://10.0.3.112:8080/health` returns the healthy payload.

## Rollback strategy

Single feature branch, single squashed commit. Rollback = `git revert <sha>` — restores the TS prompt constants, the `tsup.config.ts`, `base.ts`, and `conventions.ts` in one shot. The `prompts/` directory is removed by the revert.

## Cross-issue ordering

- **Before**: nothing depends on F18 being merged first.
- **After**:
  - **F30** (chat-slash-commands-triplicated): F18 closes the prompt-text copy of the local-command list. F30's remaining work is to make `tryHandleCommand`'s `switch` and `cmdHelp`'s Markdown table consume `LOCAL_CHAT_COMMANDS` (or otherwise deduplicate). F30 is NOT subsumed by F18.
  - **F31** is closed once F18 lands (its only ask — make the JSDoc honest — is done in Step 5).
  - **F02** roster-drift: should land after F18, which collapses the drift hosts to `prompts/shared/roster.md`.
  - **F09** (worker base) is orthogonal but benefits from F18: `prompts/shared/worker-contract.md` becomes the single home for worker-contract prose.
  - **F33** is orthogonal; this plan only ensures prompts stop naming defaults.
  - **Skills/memory subsystem** work (other agent, out of scope): unaffected by F18. F18 never reads from or imports `src/skills/` or `src/chat/slashCommands.ts`.
