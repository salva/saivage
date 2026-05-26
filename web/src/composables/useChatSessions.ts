import type { ChatLog } from "../api/types";
import { apiFetchJson } from "../utils/api";

export interface ChatSessionsHandle {
  loadSession(sessionId: string): Promise<ChatLog | null>;
}

export function useChatSessions(): ChatSessionsHandle {
  async function loadSession(sessionId: string): Promise<ChatLog | null> {
    try {
      return await apiFetchJson<ChatLog>(`/api/chats/${sessionId}`);
    } catch {
      return null;
    }
  }

  return { loadSession };
}
