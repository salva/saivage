export function renderMarkdown(text: string): string {
  let rendered = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  rendered = rendered.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) =>
    `<pre class="md-code-block"><code>${code.replace(/\n$/, "")}</code></pre>`
  );

  rendered = rendered.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  rendered = rendered.replace(/^### (.+)$/gm, '<strong class="md-h3">$1</strong>');
  rendered = rendered.replace(/^## (.+)$/gm, '<strong class="md-h2">$1</strong>');
  rendered = rendered.replace(/^# (.+)$/gm, '<strong class="md-h1">$1</strong>');
  rendered = rendered.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  rendered = rendered.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Lists: keep the visible marker. Captures are HTML-escaped above so it
  // is safe to interpolate them as text content.
  rendered = rendered.replace(
    /^[-*] (.+)$/gm,
    '<span class="md-bullet"><span class="md-marker">\u2022</span><span class="md-bullet-text">$1</span></span>',
  );
  rendered = rendered.replace(
    /^(\d+)\. (.+)$/gm,
    '<span class="md-bullet"><span class="md-marker">$1.</span><span class="md-bullet-text">$2</span></span>',
  );

  return rendered;
}
