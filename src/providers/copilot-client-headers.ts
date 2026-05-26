export const DEFAULT_COPILOT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
  "Openai-Intent": "conversation-edits",
});

export function resolveCopilotHeaders(
  override?: Record<string, string>,
): Record<string, string> {
  if (!override) return { ...DEFAULT_COPILOT_HEADERS };
  return { ...DEFAULT_COPILOT_HEADERS, ...override };
}
