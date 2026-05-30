# G12 — Plan (Round 2)

**Companion docs**: [01-analysis-r2.md](01-analysis-r2.md), [02-design-r2.md](02-design-r2.md)
**R1 review addressed**: [04-review-r1.md](04-review-r1.md)

All edits land in [saivage](../../../../) (Saivage v2 tree). No changes to `saivage-v3/`.

## R2 deltas vs R1

| Area | R1 plan | R2 plan |
| --- | --- | --- |
| New module | none | E5: new file [src/security/status-ring.ts](../../../../src/security/status-ring.ts) (in-memory ring) |
| Bootstrap | move `eventBus` up; wire observer | E3 also constructs `securityStatusRing`; observer pushes to ring and publishes; `SaivageRuntime` carries the ring |
| HTTP routes | none | E6: new `GET /api/debug/security` in [src/server/server.ts](../../../../src/server/server.ts) |
| Web UI | none ("event lands in existing dashboard feed") | E7: fourth `security` tab in [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue) |
| Cop branches | three causes wired | E1 wires five causes (`provider_missing`, `provider_unavailable`, `provider_availability_error`, `llm_call_failed`, `llm_unparseable`) |
| Redaction | mentioned without rule | E2 adds `redactSource()` and `redactError()` helpers and unit tests for both |
| Cop request | unchanged | E1 adds `toolName?` and `sourceKind?` to `PromptInjectionScanRequest`; `scanUntrustedText` passes them |
| MCP fail-closed tests | fetch_url, fetch_page_text, download_file | E12 adds `download_with_fallbacks` assertions (no target file written; attempt errors contain `"scanner degraded"`; manifest preserves the cause) |
| Validation | tsc, focused vitest, full vitest, build | adds `npm run build:web` (DebugView change) and a `grep -c "<script setup>"` guard from user memory |
| Acceptance | "manual smoke run optional" | Operator must see the degraded scanner in DebugView without an active chat session |

## Edit set

### E1 — Cop: structured degraded result + observer hook (all five causes)

File: [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts)

Changes:

- At [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L10-L14), extend `PromptInjectionScanRequest`:

  ```ts
  export interface PromptInjectionScanRequest {
    source: string;
    content: string;
    contentType?: string;
    toolName?: string;
    sourceKind?: "url" | "tool_input" | "other";
  }
  ```

- At [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L17-L24), widen `scanner`:

  ```ts
  scanner: "llm" | "disabled" | "skipped" | "degraded";
  ```

- Below the interfaces (before `createPromptInjectionCop`), add:

  ```ts
  export type CopDegradedCause =
    | "provider_missing"
    | "provider_unavailable"
    | "provider_availability_error"
    | "llm_call_failed"
    | "llm_unparseable";

  export interface CopDegradedDetail {
    toolName: string;
    sourceKind: "url" | "tool_input" | "other";
    sourceSummary: string;
    contentType?: string;
    inputLength: number;
    cause: CopDegradedCause;
    errorMessage?: string;
    timestamp: string;
  }

  export interface CopObserver {
    onDegraded(detail: CopDegradedDetail): void;
  }
  ```

- `createPromptInjectionCop` ([src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L30-L42)) gains `observer?: CopObserver`. Forward into `DefaultPromptInjectionCop`. `disabledCop()` ignores it.

- `DefaultPromptInjectionCop` constructor takes `private observer?: CopObserver`.

- Rewrite `scan` and `scanWithModel` per design §Cop wiring. The five degraded branches:

  1. `provider_missing` — at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L82) (the `if (!provider) return null` path), call `this.notifyDegraded("provider_missing", request)` and return the degraded result.
  2. `provider_unavailable` — at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L84-L85) (when `await provider.isAvailable()` resolves false), same pattern with cause `provider_unavailable`.
  3. `provider_availability_error` — at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L86-L88) (the `catch` block of the availability check). Capture the error message; pass to `notifyDegraded` with cause `provider_availability_error`.
  4. `llm_call_failed` — at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L122-L126) (chat throw). Replace the existing `log.warn` with one that uses the redacted message; cause `llm_call_failed`. **Remove** the old `return null`.
  5. `llm_unparseable` — at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L117-L118) (parse-fail). Cause `llm_unparseable`, no `errorMessage`.

  After these changes, `scanWithModel` returns `Promise<PromptInjectionScanResult>` (no `| null`). The fallback in `scan` at [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L68-L74) is **deleted** — that path is unreachable.

- Add a private helper:

  ```ts
  private notifyDegraded(
    cause: CopDegradedCause,
    request: PromptInjectionScanRequest,
    errorMessage?: string,
  ): PromptInjectionScanResult {
    const sourceKind = request.sourceKind ?? inferSourceKind(request.source);
    const sourceSummary = redactSource(request.source, sourceKind);
    const redactedErr = errorMessage !== undefined ? redactError(errorMessage) : undefined;
    const detail: CopDegradedDetail = {
      toolName: request.toolName ?? "<unknown>",
      sourceKind,
      sourceSummary,
      contentType: request.contentType,
      inputLength: request.content.length,
      cause,
      errorMessage: redactedErr,
      timestamp: new Date().toISOString(),
    };
    log.warn(
      `[prompt-injection-cop] degraded (${cause}) in ${detail.toolName} on ${sourceSummary}` +
      (redactedErr ? ` — ${redactedErr}` : ""),
    );
    if (this.observer) {
      try { this.observer.onDegraded(detail); }
      catch (e) { log.error(`[prompt-injection-cop] observer threw: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return {
      allowed: true,
      verdict: "allow",
      reason: `scanner degraded (${cause})${redactedErr ? `: ${redactedErr}` : ""}`,
      confidence: 0,
      scanner: "degraded",
      model: this.options.modelSpec,
    };
  }
  ```

### E2 — Redaction helpers + unit tests

File: [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts) (same file as E1; add at module scope, *not* exported)

```ts
function inferSourceKind(raw: string): "url" | "tool_input" | "other" {
  if (raw.startsWith("http://") || raw.startsWith("https://")) return "url";
  return "other";
}

function redactSource(raw: string, kind: "url" | "tool_input" | "other"): string {
  if (kind === "url" || raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const u = new URL(raw);
      u.username = "";
      u.password = "";
      u.search = "";
      u.hash = "";
      const path = u.pathname.length > 80 ? u.pathname.slice(0, 77) + "..." : u.pathname;
      return u.origin + path;
    } catch {
      return "<malformed-url>";
    }
  }
  return raw.length > 80 ? raw.slice(0, 77) + "..." : raw;
}

function redactError(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0] ?? raw;
  const scrubbed = firstLine
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <redacted>")
    .replace(/(authorization|api[-_]?key|token)\s*[:=]\s*[^\s,;]+/gi, "$1 <redacted>");
  return scrubbed.length > 240 ? scrubbed.slice(0, 237) + "..." : scrubbed;
}
```

Export `redactSource` and `redactError` only if tests live in a separate file; otherwise inline in [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts) via direct call (no export needed). **Decision**: keep them private to the module; the redaction behaviour is exercised through `notifyDegraded` indirectly. Add an additional small surface test that drives a known URL through the public `scan(...)` API and asserts the redacted shape appears on the observer detail (see E9 test "redacts url userinfo/query/fragment in observer detail").

### E3 — Bootstrap: ring + reordering + observer wire-up

File: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts)

- Add import: `import { SecurityStatusRing } from "../security/status-ring.js";`
- Extend `SaivageRuntime` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L52):

  ```ts
  export interface SaivageRuntime {
    // ...existing fields...
    securityStatusRing: SecurityStatusRing;
  }
  ```

- Move the existing `// 8. Event bus\nconst eventBus = new EventBus();` from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L200-L201) to immediately before step 4 (currently at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L143-L144)). Add the ring on the next line:

  ```ts
  // 3b. Event bus + security status ring (must precede MCP runtime / cop).
  const eventBus = new EventBus();
  const securityStatusRing = new SecurityStatusRing();
  ```

- Rewrite the `createPromptInjectionCop` call at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L148-L154) to pass the observer:

  ```ts
  promptInjectionCop: createPromptInjectionCop(
    config,
    router,
    config.security.injectionScanner ? routing.resolve("security").modelSpec : undefined,
    {
      onDegraded: (detail) => {
        const entry = securityStatusRing.record(detail);
        void eventBus.publish({
          type: "security_cop_degraded",
          summary:
            `prompt-injection cop degraded (${entry.cause}) in ${entry.toolName} on ${entry.sourceSummary}` +
            ` [${entry.inputLength}b${entry.contentType ? `, ${entry.contentType}` : ""}]` +
            (entry.errorMessage ? ` — ${entry.errorMessage}` : ""),
          timestamp: entry.timestamp,
        });
      },
    },
  ),
  ```

- Add `securityStatusRing` to the `SaivageRuntime` assembly at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L216-L221).

- Delete the now-duplicate `// 8. Event bus\nconst eventBus = new EventBus();` block at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L200-L201). Renumber the surrounding comments (8 → 7b, etc.) only if convenient; the comment numbers are not functional.

### E4 — SystemEvent taxonomy + severity

File: [src/types.ts](../../../../src/types.ts)

At [src/types.ts](../../../../src/types.ts#L295-L302), add `"security_cop_degraded"` to the `z.enum([...])` array immediately after `"plan_updated"`.

File: [src/events/bus.ts](../../../../src/events/bus.ts)

At [src/events/bus.ts](../../../../src/events/bus.ts#L27-L34), add `security_cop_degraded: "warning",` to `EVENT_SEVERITY`. (TypeScript exhaustiveness on `Record<SystemEvent["type"], string>` guards this — without the entry, `npx tsc` fails.)

### E5 — New module: `SecurityStatusRing`

File: [src/security/status-ring.ts](../../../../src/security/status-ring.ts) (new)

```ts
import type { CopDegradedCause, CopDegradedDetail } from "./prompt-injection-cop.js";

export interface SecurityStatusEntry {
  id: string;
  timestamp: string;
  toolName: string;
  sourceKind: "url" | "tool_input" | "other";
  sourceSummary: string;
  contentType?: string;
  inputLength: number;
  cause: CopDegradedCause;
  errorMessage?: string;
}

export class SecurityStatusRing {
  private readonly capacity: number;
  private readonly entries: SecurityStatusEntry[] = [];
  private counter = 0;

  constructor(capacity = 100) {
    this.capacity = capacity;
  }

  record(detail: CopDegradedDetail): SecurityStatusEntry {
    this.counter += 1;
    const entry: SecurityStatusEntry = {
      id: `sec-${this.counter}`,
      timestamp: detail.timestamp,
      toolName: detail.toolName,
      sourceKind: detail.sourceKind,
      sourceSummary: detail.sourceSummary,
      contentType: detail.contentType,
      inputLength: detail.inputLength,
      cause: detail.cause,
      errorMessage: detail.errorMessage,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return entry;
  }

  list(limit = 50): SecurityStatusEntry[] {
    const slice = this.entries.slice(-Math.max(0, limit));
    return slice.slice().reverse();
  }

  clear(): void {
    this.entries.length = 0;
  }
}
```

No public re-export from `index.ts` is required — `bootstrap.ts` and `server.ts` import directly.

### E6 — New debug HTTP route

File: [src/server/server.ts](../../../../src/server/server.ts)

After the `/api/debug/timeline` block at [src/server/server.ts](../../../../src/server/server.ts#L598-L657), add:

```ts
app.get("/api/debug/security", async () => {
  return { entries: runtime.securityStatusRing.list(50) };
});
```

No other server-side change needed. The route inherits the existing API token guard.

### E7 — DebugView: security tab

File: [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue)

Per user-memory "Vue SFC corruption" guidance: after every edit, run `grep -c "<script setup>" web/src/components/DebugView.vue`; the count must remain `1`.

Script-section changes:

- Import `ShieldAlert` from `lucide-vue-next` at [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L3).
- Add interface:

  ```ts
  interface SecurityEntry {
    id: string;
    timestamp: string;
    toolName: string;
    sourceKind: string;
    sourceSummary: string;
    contentType?: string;
    inputLength: number;
    cause: string;
    errorMessage?: string;
  }
  ```

- Add reactive ref `const security = ref<SecurityEntry[]>([]);`.
- Add fetch helper:

  ```ts
  async function fetchSecurity() {
    try {
      const res = await apiFetch("/api/debug/security");
      if (res.ok) {
        const data = await res.json();
        security.value = data.entries ?? [];
      }
    } catch { /* ignore */ }
  }
  ```

- Widen `activeTab` ref at [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L23) to `"state" | "errors" | "timeline" | "security"`.
- Add `fetchSecurity()` to `fetchAll`'s `Promise.all` at [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L62-L66).
- Extend `tabItems` at [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L111-L115) with:

  ```ts
  { id: "security", label: "Security", icon: ShieldAlert, count: security.value.length },
  ```

Template-section changes (insert after the timeline block at [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L171-L184)):

```vue
<div v-if="activeTab === 'security'" class="debug-content list-content">
  <div v-if="security.length === 0" class="debug-empty">No degraded scans recorded since startup</div>
  <article v-for="entry in security" :key="entry.id" class="error-card">
    <div class="error-header">
      <span class="severity" :style="{ color: 'var(--warn)' }">degraded</span>
      <strong>{{ entry.cause }}</strong>
      <code>{{ entry.toolName }}</code>
      <time>{{ formatTime(entry.timestamp) }}</time>
    </div>
    <p><strong>source:</strong> <code>{{ entry.sourceSummary }}</code> ({{ entry.sourceKind }}, {{ entry.inputLength }} bytes{{ entry.contentType ? `, ${entry.contentType}` : '' }})</p>
    <p v-if="entry.errorMessage"><strong>error:</strong> {{ entry.errorMessage }}</p>
  </article>
</div>
```

No new CSS rules — `error-card` and `error-header` reuse existing styles.

### E8 — MCP boundary: fail-closed + toolName propagation

File: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts)

- Extend `scanUntrustedText` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L149-L161):

  ```ts
  async function scanUntrustedText(
    scanner: PromptInjectionCop,
    source: string,
    content: string,
    contentType: string | undefined,
    toolName: string,
  ): Promise<PromptInjectionScanResult> {
    const scan = await scanner.scan({ source, content, contentType, toolName, sourceKind: "url" });
    if (!scan.allowed) throw new Error(`Prompt injection blocked: ${scan.reason}`);
    if (scan.scanner === "degraded") {
      throw new Error(
        `Prompt injection scanner degraded; refusing untrusted content from ${toolName}: ${scan.reason}`,
      );
    }
    return scan;
  }
  ```

- Update `downloadUrl` signature ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L162-L171)) to take `toolName: string` in its `options` object, and forward to `scanUntrustedText` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L214-L216).
- Call sites:
  - `data.fetch_url` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L770-L772)): pass `"fetch_url"`.
  - `data.fetch_page_text` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L802-L804)): pass `"fetch_page_text"`.
  - `data.download_file` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L832-L851)): pass `toolName: "download_file"` into `downloadUrl`'s options.
  - `data.download_with_fallbacks` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L858-L884)): pass `toolName: "download_with_fallbacks"` into `downloadUrl`'s options.

### E9 — Rewrite cop tests

File: [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts)

Per project rules: rewrite, not extend. Old fail-open tests are removed.

Add a helper at the top of the file:

```ts
function makeRecordingObserver() {
  const events: CopDegradedDetail[] = [];
  return {
    events,
    onDegraded(d: CopDegradedDetail) { events.push(d); },
  };
}
```

Rewrite/add the following tests inside the `describe("prompt injection cop (LLM-only)", ...)`:

1. Keep "blocks when the LLM returns verdict: block" ([src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts#L32-L42)) — asserts `scanner === "llm"`, `allowed === false`.
2. Keep "allows when the LLM returns verdict: allow" ([src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts#L44-L52)) — asserts `scanner === "llm"`.
3. **Replace** "fails open when the LLM call throws" with "returns degraded result when the LLM call throws":
   - Router from `makeRouterThrowing()`.
   - Construct cop with `makeRecordingObserver()`.
   - Assert `result.allowed === true`, `result.scanner === "degraded"`, `result.reason.startsWith("scanner degraded (llm_call_failed)")`.
   - Assert `observer.events[0].cause === "llm_call_failed"`.
4. **Replace** "fails open when the LLM returns unparseable content" with "returns degraded when the LLM returns unparseable content"; assert `cause: "llm_unparseable"` and `errorMessage === undefined` on the observer event.
5. **New** "returns degraded when the parsed provider is missing":
   - Router whose `getProvider` returns `undefined` (already the default in `makeRouterReturning`); modelSpec set to `"acme/foo"` so `parsed` is truthy and the missing-provider branch fires.
   - Assert `cause: "provider_missing"`.
6. **New** "returns degraded when provider.isAvailable() resolves false":
   - Router whose `getProvider` returns `{ isAvailable: async () => false }`.
   - Assert `cause: "provider_unavailable"`, `errorMessage === undefined`.
7. **New** "returns degraded when provider.isAvailable() throws":
   - Router whose `getProvider` returns `{ isAvailable: async () => { throw new Error("network"); } }`.
   - Assert `cause: "provider_availability_error"`, `errorMessage === "network"`.
8. **New** "redacts url userinfo, query, fragment, and signed-URL tokens in observer detail":
   - One sub-test per shape:
     - `"https://user:pw@example.com/path"` → `sourceSummary === "https://example.com/path"`.
     - `"https://example.com/path?token=abcd"` → `sourceSummary === "https://example.com/path"`.
     - `"https://example.com/path#frag"` → `sourceSummary === "https://example.com/path"`.
     - `"https://files.example.com/x?X-Amz-Signature=deadbeef"` → `sourceSummary === "https://files.example.com/x"`.
   - Drive each through a degraded path (e.g. router that throws) and inspect `observer.events[0].sourceSummary`.
9. **New** "redacts bearer tokens and credential-shaped substrings in observer error message":
   - Router that throws `new Error("HTTP 401: Authorization: Bearer abcd1234.efghij")`.
   - Assert observer's `errorMessage` contains `"Bearer <redacted>"` and `"authorization <redacted>"` (case-insensitive).
10. **New** "truncates long URL pathnames in observer detail":
    - Source = `"https://example.com/" + "a".repeat(200)`.
    - Assert observer's `sourceSummary.length <= 80 + "https://example.com".length` and ends with `"..."`.
11. **New** "an observer that throws is swallowed and a result still returned":
    - Observer whose `onDegraded` throws.
    - Run the chat-throw path; assert the scan still returns `{ scanner: "degraded", allowed: true }`.
12. Keep "passes through when scanner disabled" ([src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts#L77-L82)) unchanged — `scanner === "disabled"`.

The helper `makeCop` is updated to accept an optional `observer`:

```ts
function makeCop(router: ModelRouter, observer?: CopObserver): DefaultPromptInjectionCop {
  return new DefaultPromptInjectionCop(router, { modelSpec: "gpt-test", maxScanChars: 4000 }, observer);
}
```

For the missing-provider and provider-availability tests, change the local `modelSpec` to `"acme/foo"` so `tryParseModelId` returns a truthy value and the cop reaches the `getProvider`/`isAvailable` branches.

### E10 — New test file for the ring

File: `src/security/status-ring.test.ts` (new)

Three tests:

1. "records up to capacity and drops oldest" — capacity 3, push 5 details, assert `list(10).length === 3` and the entries are the last three pushed, most-recent-first.
2. "list returns most-recent-first" — push 3 details with strictly increasing timestamps, assert order.
3. "clear empties the ring" — push, clear, assert `list().length === 0`.

### E11 — Event bus test for the new severity

File: [src/events/bus.test.ts](../../../../src/events/bus.test.ts)

Add one `it("delivers security_cop_degraded to warning-min subscribers but not error-min", ...)` block that:

1. Subscribes a recorder with `{ minSeverity: "warning" }` and asserts it receives the event.
2. Subscribes a second recorder with `{ minSeverity: "error" }` and asserts it does not.
3. Reuses existing helpers in that file (do not introduce a new fixture style).

### E12 — MCP fail-closed test, including `download_with_fallbacks`

File: [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)

After "does not write downloaded files rejected by the prompt-injection cop" at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L243-L262), add:

```ts
it("fails closed when the prompt-injection cop is degraded (fetch_url, fetch_page_text, download_file, download_with_fallbacks)", async () => {
  const degradedCop: PromptInjectionCop = {
    async scan() {
      return {
        allowed: true,
        verdict: "allow",
        reason: "scanner degraded (llm_call_failed): network",
        confidence: 0,
        scanner: "degraded",
      };
    },
  };
  registerBuiltinServices(runtime, cfg.mcp, { promptInjectionCop: degradedCop });

  await withTextServer("benign content", async (url) => {
    // fetch_url
    const a = await runtime.callTool("data", "fetch_url", { url });
    expect(a.isError).toBe(true);
    expect(String((a.content as { error?: string }).error)).toContain("scanner degraded");

    // fetch_page_text
    const b = await runtime.callTool("data", "fetch_page_text", { url });
    expect(b.isError).toBe(true);
    expect(String((b.content as { error?: string }).error)).toContain("scanner degraded");

    // download_file
    const dlPath = "cache/source-a/dl.txt";
    const c = await runtime.callTool("data", "download_file", { url, path: dlPath });
    expect(c.isError).toBe(true);
    expect(existsSync(join(projectRoot, dlPath))).toBe(false);
    const cAttempts = (c.content as { attempts?: Array<{ error?: string }> }).attempts ?? [];
    expect(cAttempts.some((a) => (a.error ?? "").includes("scanner degraded"))).toBe(true);

    // download_with_fallbacks — single URL, single retry; assert target file not written,
    // attempts retain the scanner-degraded cause, and the manifest does not mask the failure.
    const fbPath = "cache/source-a/fb.txt";
    const manifest = "tmp/g12/fb-manifest.json";
    const d = await runtime.callTool("data", "download_with_fallbacks", {
      urls: [url],
      path: fbPath,
      manifest_path: manifest,
      retries_per_url: 1,
    });
    expect(d.isError).toBe(true);
    expect(existsSync(join(projectRoot, fbPath))).toBe(false);
    const dContent = d.content as { error?: string; attempts?: Array<{ error?: string }> };
    expect(dContent.error).toBe("All download sources failed");
    expect((dContent.attempts ?? []).some((a) => (a.error ?? "").includes("scanner degraded"))).toBe(true);

    const manifestAbs = join(projectRoot, manifest);
    expect(existsSync(manifestAbs)).toBe(true);
    const persisted = JSON.parse(readFileSync(manifestAbs, "utf-8"));
    expect(persisted.error).toBe("All download sources failed");
    expect(JSON.stringify(persisted.attempts)).toContain("scanner degraded");
  });
});
```

The assertion `persisted.error === "All download sources failed"` is paired with the substring check on `attempts`: the aggregate error stays as-is (it is, mechanically, the case that all downloads failed), but the manifest cannot mask **why** they failed — the per-attempt `error` field carries the scanner-degraded cause. That matches the reviewer's wording "manifest does not mask the security failure as an ordinary network miss".

### E13 — `SaivageRuntime` shutdown cleanup

File: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) (same edit as E3 + one more)

If the shutdown path at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L241) (where `eventBus.clear()` lives) is the chosen reset point for runtime singletons, also call `securityStatusRing.clear()` there. If not, omit — the ring is process-local and dies with the process anyway. **Decision**: include the `securityStatusRing.clear()` call beside `eventBus.clear()` for symmetry. One line.

### E14 — Touch-up grep

Run from `/home/salva/g/ml/saivage`:

```bash
rg -n "PromptInjectionScanResult|promptInjectionCop|prompt_injection_scan|cop\\.scan" --type ts -g '!**/node_modules/**'
```

Expected non-test consumers after E1–E13: [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts), [src/security/status-ring.ts](../../../../src/security/status-ring.ts), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), [src/server/server.ts](../../../../src/server/server.ts). Anything else needs audit before V1.

## Out of edit set (explicitly)

- No change to `SaivageConfig.security` ([src/config.ts](../../../../src/config.ts#L112-L118)).
- No new `src/observability/` module.
- No persistence of the ring across restarts.
- No JSDoc/docstring/comment additions on lines that did not change.
- No changes to `disabledCop()` semantics.
- No saivage-v3 changes.
- No Vue test harness for DebugView (no existing harness; out of scope for G12).

## Validation

Run from `/home/salva/g/ml/saivage` unless otherwise noted.

### V0 — Consumer grep (E14 above)

```bash
rg -n "PromptInjectionScanResult|promptInjectionCop|prompt_injection_scan|cop\\.scan" --type ts -g '!**/node_modules/**'
```

### V0b — Vue SFC integrity guard

```bash
grep -c "<script setup>" web/src/components/DebugView.vue
```

Must return `1`. Per user memory, this catches duplicate `<script setup>` blocks before any build.

### V1 — Typecheck

```bash
npx tsc --noEmit
```

Must be clean. `EVENT_SEVERITY` exhaustiveness (E4) and `scanner` union widening (E1) are the compile-time anchors. The new `SaivageRuntime.securityStatusRing` field is required at the assembly site (E3).

### V2 — Focused vitest

```bash
npx vitest run src/security/prompt-injection-cop.test.ts src/security/status-ring.test.ts src/mcp/builtins.test.ts src/events/bus.test.ts
```

Covers E9, E10, E11, E12.

### V3 — Full vitest

```bash
npx vitest run
```

Catches any incidental consumer that destructures `scanner`/`reason` or that depended on the old `"llm unavailable; allowing"` string.

### V4 — Server build

```bash
npm run build
```

Confirms tsup ships the dist bundle including the new route in [src/server/server.ts](../../../../src/server/server.ts) and the new module [src/security/status-ring.ts](../../../../src/security/status-ring.ts).

### V5 — Web build

```bash
npm run build:web
```

(or whatever Vite build script the repo uses — check `package.json`'s `scripts` block; the active script as of round 2 is `build:web`. If it is named differently, substitute.) Confirms the new `security` tab in `DebugView.vue` compiles, no template parser errors, no duplicate script-setup blocks. Re-run V0b after if anything regressed.

### V6 — End-to-end: ring + route + DebugView

This step closes the reviewer's acceptance requirement that an operator can see the degraded scanner without an active chat session. Two flavours:

**V6a (server-side integration, automated)** — added to [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts) or a new `src/server/server.security.test.ts` (implementer's choice). Spin up the route, simulate a degraded scan by directly invoking `securityStatusRing.record(...)`, fetch `/api/debug/security`, assert the entry shape.

**V6b (manual)** — operator opens the saivage v2 web UI (without opening chat), navigates to the Debug view, switches to the new Security tab. With a deliberately-broken security model (e.g. set `injectionModel` to `acme/foo` where provider `acme` is not configured), driving any data tool that exercises `scanUntrustedText` should produce a visible entry on the Security tab within ~8 s (the existing `setInterval(fetchAll, 8000)` polling cadence). No chat session is required. This step is the human-side acceptance.

### V7 — Lint

```bash
npx eslint --max-warnings 0 src/security/prompt-injection-cop.ts src/security/status-ring.ts src/mcp/builtins.ts src/events/bus.ts src/types.ts src/server/bootstrap.ts src/server/server.ts
```

## Operator-gated saivage-v3 restart

**Not required for this finding.** G12 changes live entirely in `/home/salva/g/ml/saivage` (Saivage v2). The `saivage-v3` LXC at 10.0.3.112 runs from `/work/saivage-v3` and is unaffected.

If, during implementation, the saivage v2 dist is being exercised against the legacy `saivage` LXC at 10.0.3.111 (running on GetRich), the operator decides whether to restart `saivage.service` on that container. The default for this finding is "no restart". Do not restart any container as part of normal implementation.

## Acceptance

The finding closes when **all** of the following hold:

1. E1–E13 are implemented and merged.
2. V0, V0b, V1, V2, V3, V4, V5 pass.
3. V6a passes (automated route-level proof).
4. V6b is performed by an operator (or equivalent manual flow): driving a degraded scan with no chat session open results in a visible entry on `DebugView.vue`'s Security tab. This is the explicit "operator can see the degraded scanner without an active chat session" criterion.
5. Redaction tests (E9 #8, #9, #10) pass — no raw URL userinfo/query/fragment, no raw Bearer tokens, no oversize pathnames appear in observer detail or ring entries.
6. `download_with_fallbacks` test (E12) passes: target file not written, per-attempt error contains `"scanner degraded"`, manifest preserves the cause.
7. All five no-scan branches in `scanWithModel` route to the typed degraded result. No call site reads a `null` from `scanWithModel`. The old `"llm unavailable; allowing"` string does not appear anywhere under [saivage/src](../../../../src) (`rg "llm unavailable; allowing" src/` returns no hits).
8. No `failurePolicy` config knob has been introduced and no parallel metrics façade has been added.
