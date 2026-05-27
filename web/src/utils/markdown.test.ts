// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("renders a GFM table with header and body", () => {
    const html = renderMarkdown("| h1 | h2 |\n|---|---|\n| a | b |");
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>h1</th>");
    expect(html).toContain("<tbody>");
    expect(html).toContain("<td>a</td>");
  });

  it("respects column alignment markers", () => {
    const html = renderMarkdown("| L | R | C |\n|:---|---:|:---:|\n| a | b | c |");
    expect(html).toContain('align="left"');
    expect(html).toContain('align="right"');
    expect(html).toContain('align="center"');
  });

  it("renders bold and italics correctly", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("*it*")).toContain("<em>it</em>");
  });

  it("renders inline code and fenced code", () => {
    expect(renderMarkdown("`x`")).toContain("<code>x</code>");
    expect(renderMarkdown("```\nblock\n```")).toContain("<pre>");
  });

  it("renders headings as native h1/h2/h3", () => {
    expect(renderMarkdown("# H")).toContain("<h1");
    expect(renderMarkdown("### H3")).toContain("<h3");
  });

  it("renders bullet and ordered lists", () => {
    expect(renderMarkdown("- a\n- b")).toContain("<ul>");
    expect(renderMarkdown("1. a\n2. b")).toContain("<ol>");
  });

  it("sanitizes inline script tags", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nhello');
    expect(html).not.toContain("<script");
    expect(html).toContain("hello");
  });

  it("sanitizes javascript: hrefs", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toMatch(/href="javascript:/);
  });

  it("renders strikethrough via GFM", () => {
    expect(renderMarkdown("~~strike~~")).toContain("<del>strike</del>");
  });

  it("renders task-list checkboxes via GFM", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo");
    expect(html).toContain('type="checkbox"');
  });

  it("converts hard line breaks via breaks:true", () => {
    expect(renderMarkdown("a\nb")).toContain("<br");
  });

  it("renders blockquote", () => {
    expect(renderMarkdown("> quoted")).toContain("<blockquote>");
  });

  it("renders horizontal rule", () => {
    expect(renderMarkdown("---")).toContain("<hr");
  });
});
