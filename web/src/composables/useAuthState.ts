import { ref, readonly } from "vue";

/**
 * Shared authentication state for the SPA.
 *
 * `unauthorized` is module-scoped so every consumer (WS composable,
 * App.vue title watcher, ChatWindow chip and token form) reads the
 * same source of truth. `requestRetry()` is called by the API token
 * setter once a fresh token lands, and synchronously fans out to
 * every registered retry handler (currently `useWebSocket().reconnect`).
 */
const unauthorized = ref(false);
const retryHandlers = new Set<() => void>();

function markUnauthorized(): void {
  unauthorized.value = true;
}

function clearUnauthorized(): void {
  unauthorized.value = false;
}

function onRetry(handler: () => void): () => void {
  retryHandlers.add(handler);
  return () => {
    retryHandlers.delete(handler);
  };
}

function requestRetry(): void {
  unauthorized.value = false;
  for (const handler of retryHandlers) handler();
}

export function useAuthState() {
  return {
    unauthorized: readonly(unauthorized),
    markUnauthorized,
    clearUnauthorized,
    onRetry,
    requestRetry,
  };
}
