import { marked } from "marked";
import DOMPurify from "dompurify";

marked.use({ gfm: true, breaks: true, async: false });

export function renderMarkdown(text: string): string {
  if (!text || !text.trim()) return "";
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

