import { describe, it, expect } from "vitest";
import { TelegramBridge, markdownToHtml, chunkMessage } from "./telegram.js";

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

  it("does not treat underscores in identifiers as italic", () => {
    // Tool names, variable names, etc. should not become italic
    expect(markdownToHtml("read_file")).toBe("read_file");
    expect(markdownToHtml("core_memory_append")).toBe("core_memory_append");
    expect(markdownToHtml("**read_file**")).toBe("<b>read_file</b>");
  });

  it("still converts proper underscore italic", () => {
    // Standalone _word_ with spaces around it should still be italic
    expect(markdownToHtml("this is _italic_ text")).toBe("this is <i>italic</i> text");
  });

  it("converts markdown tables to bullet lists", () => {
    const table = "| Idea | Why |\n|------|-----|\n| AI writer | Niche |\n| Chatbot | Support |";
    const result = markdownToHtml(table);
    // No raw pipe characters or separator rows in output
    expect(result).not.toContain("|");
    expect(result).not.toContain("---");
    // Row labels are bolded, columns are bullets
    expect(result).toContain("AI writer");
    expect(result).toContain("Chatbot");
    expect(result).toContain("•");
  });

  it("converts links to HTML anchor tags", () => {
    const result = markdownToHtml("[OpenAI](https://openai.com)");
    expect(result).toBe('<a href="https://openai.com">OpenAI</a>');
  });
});

describe("chunkMessage", () => {
  it("returns single chunk for short text", () => {
    const chunks = chunkMessage("hello world", 100);
    expect(chunks).toEqual(["hello world"]);
  });

  it("returns single chunk for text exactly at limit", () => {
    const text = "a".repeat(100);
    const chunks = chunkMessage(text, 100);
    expect(chunks).toEqual([text]);
  });

  it("splits on paragraph boundary", () => {
    const text = "paragraph one\n\nparagraph two\n\nparagraph three";
    const chunks = chunkMessage(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
    expect(chunks.join("\n\n")).toContain("paragraph one");
    expect(chunks.join("\n\n")).toContain("paragraph three");
  });

  it("splits on newline when no paragraph boundary fits", () => {
    const text = "line one\nline two\nline three\nline four";
    const chunks = chunkMessage(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
  });

  it("splits on sentence boundary as fallback", () => {
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const chunks = chunkMessage(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 40)).toBe(true);
  });

  it("hard cuts when no good boundary exists", () => {
    const text = "a".repeat(200);
    const chunks = chunkMessage(text, 80);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 80)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("preserves all content across chunks", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1} with some text.`);
    const text = paragraphs.join("\n\n");
    const chunks = chunkMessage(text, 100);
    const reassembled = chunks.join("\n\n");
    for (const p of paragraphs) {
      expect(reassembled).toContain(p);
    }
  });

  it("uses default 4096 limit", () => {
    const short = "a".repeat(4096);
    expect(chunkMessage(short)).toEqual([short]);

    const long = "a".repeat(4097);
    expect(chunkMessage(long).length).toBe(2);
  });
});
