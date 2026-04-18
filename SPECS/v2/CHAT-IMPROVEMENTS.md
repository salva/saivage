# Chat System — Functional Analysis & Improvement Plan

## 1. Current Architecture

### Message Flow

```
                   Browser                              Server
┌────────────┐     WebSocket      ┌──────────────┐     ┌───────────┐
│ ChatWindow │ ──── ws.send ─────▶│ WebSocket    │────▶│ ChatAgent │
│   (Vue)    │◀── ws.onmessage ──│ Channel      │◀────│  (LLM)    │
└────────────┘                    └──────────────┘     └───────────┘
                                         │
                                         ▼
                                  .saivage/tmp/chats/
                                  └── web/
                                      └── chat-xxx.json
```

### Components Involved

| Component | File | Role |
|-----------|------|------|
| ChatWindow.vue | web/src/components/ChatWindow.vue | Live chat UI on Dashboard |
| AgentsView.vue | web/src/components/AgentsView.vue | Historical chat viewer (Agents tab) |
| useWebSocket.ts | web/src/composables/useWebSocket.ts | WS composable with auto-reconnect |
| WebSocketChannel | src/channels/websocket.ts | Server-side WS ↔ ChatChannel adapter |
| ChatChannel | src/channels/types.ts | Transport interface |
| ChatAgent | src/agents/chat.ts | LLM-backed conversational agent |
| server.ts | src/server/server.ts | WS endpoint + chat REST APIs |

### Storage

Chat logs are persisted to `.saivage/tmp/chats/<channel>/<sessionId>.json` using
`ChatLogSchema` validation. Each log contains `session_id`, `channel`, timestamps,
and a `messages[]` array of `{ id, role, content, timestamp, event? }`.

### REST Endpoints

- `GET /api/chats` — lists all chat sessions with metadata
- `GET /api/chats/:sessionId` — returns full chat log with messages

---

## 2. Identified Issues

### Bug: Double-Serialized User Messages

**Severity: High**

The client sends `JSON.stringify({ type: "message", content: text })` over the
WebSocket. The `WebSocketChannel` passes this raw string directly to
`ChatAgent.handleUserMessage(content)`, which:
1. Records it as-is → chat log stores `{"type":"message","content":"hello"}`
2. Injects it as-is into the LLM conversation → the model sees raw JSON

**Impact:**
- The LLM receives JSON markup instead of the user's actual words
- Chat logs contain JSON-wrapped strings instead of clean content
- AgentsView needed a `parseContent()` workaround to unwrap on display

**Fix:** Parse the JSON in `WebSocketChannel` or `ChatAgent.handleUserMessage()`,
extract the `content` field, and pass only the clean text.

### Bug: History Data Never Loads

**Severity: Medium**

`StatusPanel.vue` and `PlanView.vue` read `data.history?.entries` but
`PlanHistorySchema` defines the field as `stages`. The history section is
always empty.

**Fix:** Change `entries` → `stages` in both components.

### Missing: Message Persistence on Refresh

**Severity: Medium**

`ChatWindow.vue` stores messages in a `ref<Message[]>()`. Page refresh loses
the entire conversation. The backend persists the chat log, but the frontend
doesn't reload it on reconnection.

**Fix:** On WS connect, fetch the current session's log via REST API
(`/api/chats/:sessionId`). This requires the server to send the session ID
to the client upon connection.

### Missing: Markdown Rendering

**Severity: Medium**

All assistant messages render as plain text with `white-space: pre-wrap`.
The LLM often generates markdown (headers, lists, bold, code blocks) which
displays as raw characters.

**Fix:** Add a lightweight markdown renderer. Options:
- `marked` (31KB gzipped) — full-featured
- Custom minimal renderer for headers, bold, lists, code blocks

### Missing: Typing/Thinking Indicator

**Severity: Low**

No visual feedback between sending a message and receiving the response.
The user doesn't know if the system is processing.

**Fix:** Send a `{ type: "thinking" }` event from the server when the LLM
starts processing, and `{ type: "done" }` when it finishes.

### Missing: System Event Cards

**Severity: Low**

System events (stage completed, failed, escalated) render as plain text
strings like "✅ Stage xxx completed: ...". These could be richer cards
with structured information.

### Unused: Pinia

Pinia is installed and initialized but no stores exist. All component state
is local. Consider either removing Pinia or using it for shared chat state.

---

## 3. Improvement Design

### 3.1 Fix Message Serialization (Backend)

**Change in `WebSocketChannel`:** Parse incoming messages as JSON and extract
the `content` field before passing to the message handler.

```typescript
// websocket.ts — onMessage handler
ws.on("message", (data) => {
  let msg = data.toString().trim();
  if (!msg) return;
  // Parse client JSON envelope
  try {
    const parsed = JSON.parse(msg);
    if (parsed.type === "message" && typeof parsed.content === "string") {
      msg = parsed.content;
    }
  } catch { /* treat as raw text */ }
  this.messageHandler?.(msg);
});
```

This ensures the LLM receives clean text, and chat logs store clean content.

### 3.2 Session ID on Connection (Backend + Frontend)

**Server:** Send a `{ type: "session", sessionId }` event immediately after
the WebSocket connection is established.

**Client:** Store the session ID and use it to reload messages on reconnect.

### 3.3 Message Persistence on Reconnect (Frontend)

**On WebSocket connect event:**
1. If we have a stored sessionId, fetch `/api/chats/:sessionId`
2. Populate `messages` from the persisted log
3. On new WS connection (different session), clear and start fresh

### 3.4 Thinking Indicator (Backend + Frontend)

**Server (ChatAgent):** Before calling `runLoop()`, send a `{ type: "thinking" }`
event. After the response, the existing `{ type: "message" }` event implicitly
signals completion.

**Client:** Show a pulsing "..." indicator when `thinking` event arrives,
hide it when `message` event arrives.

### 3.5 Markdown Rendering (Frontend)

Add a minimal markdown renderer for assistant messages. Support:
- **Bold** / *italic*
- Headers (##, ###)
- Inline `code` and fenced ```code blocks```
- Bullet/numbered lists
- Links

Implementation: custom function, ~80 lines, no external dependency.

### 3.6 Fix History Data Path (Frontend)

Change `data.history?.entries` → `data.history?.stages` in:
- StatusPanel.vue
- PlanView.vue

---

## 4. Implementation Plan

### Phase 1: Backend Fixes
1. Parse JSON envelope in WebSocketChannel
2. Send session ID on connection
3. Send thinking event before LLM call

### Phase 2: Frontend Chat Improvements
1. Store and use session ID
2. Load messages on reconnect
3. Add thinking indicator
4. Add markdown rendering
5. Fix history data path

### Phase 3: Verification
1. Build frontend + backend
2. Deploy
3. Verify all chat functionality
4. Verify history loads in StatusPanel and PlanView
