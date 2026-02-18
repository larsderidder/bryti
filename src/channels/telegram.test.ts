import { describe, it, expect } from "vitest";
import { TelegramBridge, markdownToHtml } from "./telegram.js";

describe("TelegramBridge", () => {
  it("has correct name and platform", () => {
    const bridge = new TelegramBridge("test-token", []);
    expect(bridge.name).toBe("telegram");
    expect(bridge.platform).toBe("telegram");
  });
});

describe("markdownToHtml", () => {
  it("escapes HTML special characters in plain text", () => {
    expect(markdownToHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("converts bold **text**", () => {
    expect(markdownToHtml("**hello**")).toBe("<b>hello</b>");
  });

  it("converts bold __text__", () => {
    expect(markdownToHtml("__hello__")).toBe("<b>hello</b>");
  });

  it("converts italic *text*", () => {
    expect(markdownToHtml("*hello*")).toBe("<i>hello</i>");
  });

  it("converts italic _text_", () => {
    expect(markdownToHtml("_hello_")).toBe("<i>hello</i>");
  });

  it("converts strikethrough ~~text~~", () => {
    expect(markdownToHtml("~~hello~~")).toBe("<s>hello</s>");
  });

  it("converts inline code", () => {
    expect(markdownToHtml("`const x = 1`")).toBe("<code>const x = 1</code>");
  });

  it("escapes HTML inside inline code", () => {
    expect(markdownToHtml("`a < b`")).toBe("<code>a &lt; b</code>");
  });

  it("converts fenced code block", () => {
    const input = "```\nconst x = 1;\n```";
    expect(markdownToHtml(input)).toBe("<pre><code>const x = 1;\n</code></pre>");
  });

  it("converts fenced code block with language tag", () => {
    const input = "```typescript\nconst x = 1;\n```";
    expect(markdownToHtml(input)).toBe("<pre><code>const x = 1;\n</code></pre>");
  });

  it("escapes HTML inside fenced code blocks", () => {
    const input = "```\na < b && c > d\n```";
    expect(markdownToHtml(input)).toBe("<pre><code>a &lt; b &amp;&amp; c &gt; d\n</code></pre>");
  });

  it("does not apply inline markdown inside code blocks", () => {
    const input = "```\n**not bold**\n```";
    expect(markdownToHtml(input)).toBe("<pre><code>**not bold**\n</code></pre>");
  });

  it("converts ATX headings to bold", () => {
    expect(markdownToHtml("# Title")).toBe("<b>Title</b>");
    expect(markdownToHtml("## Section")).toBe("<b>Section</b>");
    expect(markdownToHtml("### Sub")).toBe("<b>Sub</b>");
  });

  it("strips horizontal rules", () => {
    const input = "before\n---\nafter";
    const result = markdownToHtml(input);
    expect(result).toContain("before");
    expect(result).toContain("after");
    expect(result).not.toContain("---");
  });

  it("handles mixed content correctly", () => {
    const input = "**bold** and _italic_ and `code`";
    expect(markdownToHtml(input)).toBe("<b>bold</b> and <i>italic</i> and <code>code</code>");
  });

  it("returns empty string for empty input", () => {
    expect(markdownToHtml("")).toBe("");
  });

  it("does not double-escape already present HTML entities", () => {
    // A literal ampersand in LLM output should become &amp; exactly once
    const result = markdownToHtml("a & b");
    expect(result).toBe("a &amp; b");
    expect(result).not.toContain("&amp;amp;");
  });
});
