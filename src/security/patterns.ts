/**
 * Prompt injection pattern database.
 * Patterns are designed to catch common injection techniques
 * without excessive false positives.
 */

export interface InjectionPattern {
  name: string;
  pattern: RegExp;
  severity: "high" | "medium" | "low";
  description: string;
}

export const INJECTION_PATTERNS: InjectionPattern[] = [
  // Direct instruction overrides
  {
    name: "system-prompt-override",
    pattern: /\b(ignore|disregard|forget)\b.{0,30}\b(previous|above|prior|all)\b.{0,30}\b(instructions?|prompts?|rules?|constraints?)\b/i,
    severity: "high",
    description: "Attempts to override system instructions",
  },
  {
    name: "new-instructions",
    pattern: /\b(new|updated|real|actual|true)\b.{0,20}\b(instructions?|system\s*prompt|directives?)\b/i,
    severity: "high",
    description: "Claims to provide new/replacement instructions",
  },
  {
    name: "role-assumption",
    pattern: /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be|roleplay\s+as|switch\s+to)\b/i,
    severity: "high",
    description: "Attempts to change the AI's role",
  },

  // Delimiter manipulation
  {
    name: "delimiter-injection",
    pattern: /<\/?(?:system|user|assistant|human|ai|prompt|instruction|context)>/i,
    severity: "medium",
    description: "Contains message delimiter tags",
  },
  {
    name: "xml-system-tag",
    pattern: /<system[^>]*>[\s\S]{0,500}<\/system>/i,
    severity: "high",
    description: "Contains XML system message block",
  },

  // Exfiltration attempts
  {
    name: "data-exfiltration",
    pattern: /\b(output|print|display|show|reveal|leak|exfiltrate)\b.{0,30}\b(system\s*prompt|instructions?|api\s*key|secret|password|token|credential)/i,
    severity: "high",
    description: "Attempts to extract sensitive information",
  },

  // Encoded payloads
  {
    name: "base64-payload",
    pattern: /\b(decode|base64|eval|execute)\b.{0,50}[A-Za-z0-9+/]{40,}/i,
    severity: "medium",
    description: "Contains potentially encoded payload",
  },

  // Multi-step manipulation
  {
    name: "chain-of-thought-hijack",
    pattern: /\b(think\s+step\s+by\s+step|let'?s\s+think|chain\s+of\s+thought)\b.{0,100}\b(ignore|override|bypass)\b/i,
    severity: "medium",
    description: "Uses reasoning tricks to bypass safeguards",
  },

  // Tool/action manipulation
  {
    name: "tool-injection",
    pattern: /\b(call|invoke|execute|run)\b.{0,30}\b(tool|function|command)\b.{0,30}\b(rm|delete|drop|curl|wget|eval)\b/i,
    severity: "high",
    description: "Attempts to inject tool calls",
  },
];
