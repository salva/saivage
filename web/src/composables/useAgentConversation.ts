import { nextTick, onUnmounted, ref, type Ref } from "vue";
import type { AgentConversation } from "../api/types";
import { ApiError, apiFetchJson } from "../utils/api";
import {
  AGENT_CONVERSATION_POLL_INTERVAL_MS,
  SCROLL_BOTTOM_TOLERANCE_PX,
} from "../components/agents/constants";

export interface AgentConversationHandle {
  conversation: Ref<AgentConversation | null>;
  loading: Ref<boolean>;
  expanded: Ref<Set<string>>;
  load(agentId: string): Promise<void>;
  stop(): void;
  bindThreadBody(getEl: () => HTMLElement | null): void;
  toggleDetails(id: string): void;
  detailsOpen(id: string): boolean;
}

export function useAgentConversation(): AgentConversationHandle {
  const conversation = ref<AgentConversation | null>(null);
  const loading = ref(false);
  const expanded = ref<Set<string>>(new Set());
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let selectedAgentId: string | null = null;
  let getThreadBodyEl: (() => HTMLElement | null) | null = null;

  function bindThreadBody(getEl: () => HTMLElement | null): void {
    getThreadBodyEl = getEl;
  }

  function isScrolledToBottom(): boolean {
    const el = getThreadBodyEl?.() ?? null;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_TOLERANCE_PX;
  }

  function scrollToBottom(): void {
    const el = getThreadBodyEl?.() ?? null;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function markFinished(agentId: string): void {
    if (!conversation.value || selectedAgentId !== agentId) return;
    const last = conversation.value.entries.at(-1)?.timestamp ?? new Date().toISOString();
    conversation.value = {
      ...conversation.value,
      finished_at: conversation.value.finished_at ?? last,
      activity_status: null,
    };
  }

  async function refreshSelected(agentId: string): Promise<boolean> {
    try {
      const data = await apiFetchJson<AgentConversation>(`/api/agents/${agentId}/conversation`);
      const wasAtBottom = isScrolledToBottom();
      conversation.value = data;
      if (wasAtBottom) {
        await nextTick();
        scrollToBottom();
      }
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        markFinished(agentId);
        stop();
      }
      return false;
    }
  }

  async function load(agentId: string): Promise<void> {
    if (selectedAgentId === agentId && conversation.value) {
      await refreshSelected(agentId);
      return;
    }

    selectedAgentId = agentId;
    loading.value = true;
    expanded.value = new Set();
    const ok = await refreshSelected(agentId);
    loading.value = false;
    if (ok) {
      await nextTick();
      scrollToBottom();
      start(agentId);
    }
  }

  function start(agentId: string): void {
    stop();
    pollTimer = setInterval(() => {
      if (selectedAgentId === agentId) void load(agentId);
      else stop();
    }, AGENT_CONVERSATION_POLL_INTERVAL_MS);
  }

  function stop(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function toggleDetails(id: string): void {
    const next = new Set(expanded.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded.value = next;
  }

  function detailsOpen(id: string): boolean {
    return expanded.value.has(id);
  }

  onUnmounted(() => {
    stop();
    bindThreadBody(() => null);
  });

  return { conversation, loading, expanded, load, stop, bindThreadBody, toggleDetails, detailsOpen };
}
