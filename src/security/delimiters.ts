/**
 * Content delimiters — wraps external data with clear boundaries
 * to help the LLM distinguish external content from instructions.
 */

const EXTERNAL_OPEN = "<external_data>";
const EXTERNAL_CLOSE = "</external_data>";

/** Wrap external content in delimiters to make it obvious to the LLM */
export function wrapExternal(content: string, source?: string): string {
  const sourceAttr = source ? ` source="${escapeAttr(source)}"` : "";
  return `<external_data${sourceAttr}>\n${content}\n${EXTERNAL_CLOSE}`;
}

/** Strip external data delimiters (for display) */
export function unwrapExternal(content: string): string {
  return content
    .replace(/<external_data[^>]*>\n?/g, "")
    .replace(new RegExp(`\n?${escapeRegex(EXTERNAL_CLOSE)}`, "g"), "");
}

/** Check if content is already wrapped */
export function isWrapped(content: string): boolean {
  return content.includes(EXTERNAL_OPEN) && content.includes(EXTERNAL_CLOSE);
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
