/**
 * Secret redactor — removes sensitive data from logs and outputs.
 */

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: "api-key",
    pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/g,
    replacement: "sk-***REDACTED***",
  },
  {
    name: "bearer-token",
    pattern: /\b(Bearer\s+[a-zA-Z0-9._-]{20,})\b/gi,
    replacement: "Bearer ***REDACTED***",
  },
  {
    name: "jwt",
    pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
    replacement: "***JWT_REDACTED***",
  },
  {
    name: "env-api-key",
    pattern: /(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)\s*[=:]\s*['"]?([^\s'"]{8,})['"]?/gi,
    replacement: "$1=***REDACTED***",
  },
  {
    name: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: "***PRIVATE_KEY_REDACTED***",
  },
];

/** Redact sensitive patterns from text */
export function redact(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    // Clone regex to reset lastIndex for each call
    const regex = new RegExp(pattern.source, pattern.flags);
    result = result.replace(regex, replacement);
  }
  return result;
}
