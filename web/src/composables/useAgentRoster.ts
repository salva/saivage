import { onUnmounted, ref, type Ref } from "vue";
import type { AgentState, ChatSession, ApiState } from "../api/types";
import { ApiError, apiFetchJson } from "../utils/api";
import { CLOCK_TICK_MS, ROSTER_POLL_INTERVAL_MS } from "../components/agents/constants";

export interface AgentRoster {
  activeAgents: Ref<AgentState[]>;
  chatSessions: Ref<ChatSession[]>;
  now: Ref<number>;
  refresh(): Promise<void>;
}

export function useAgentRoster(): AgentRoster {
  const activeAgents = ref<AgentState[]>([]);
  const chatSessions = ref<ChatSession[]>([]);
  const now = ref(Date.now());

  async function refresh(): Promise<void> {
    try {
      const [state, chats] = await Promise.all([
        apiFetchJson<ApiState>("/api/state"),
        apiFetchJson<{ sessions?: ChatSession[] }>("/api/chats"),
      ]);
      activeAgents.value = (state.state?.active_agents ?? [])
        .filter((agent) => agent.agent_type !== "chat");
      chatSessions.value = chats.sessions ?? [];
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        activeAgents.value = [];
        chatSessions.value = [];
      }
    }
  }

  void refresh();
  const pollTimer = setInterval(refresh, ROSTER_POLL_INTERVAL_MS);
  const clockTimer = setInterval(() => { now.value = Date.now(); }, CLOCK_TICK_MS);

  onUnmounted(() => {
    clearInterval(pollTimer);
    clearInterval(clockTimer);
  });

  return { activeAgents, chatSessions, now, refresh };
}
