import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { TelegramBridge, markdownToHtml, chunkMessage, markdownToTelegramChunks } from "./telegram.js";

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
    expect(markdownToHtml("memory_core_append")).toBe("memory_core_append");
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

describe("markdownToTelegramChunks", () => {
  it("returns a single HTML chunk for short text", () => {
    const chunks = markdownToTelegramChunks("**hello**");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("<b>hello</b>");
  });

  it("never splits a code block across chunks", () => {
    // Build a message where a code block would straddle a naive split boundary.
    const before = "intro\n\n";
    const codeLines = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const code = "```js\n" + codeLines + "\n```";
    const after = "\n\noutro";
    const text = before + code + after;

    // Use a limit just below the full length so chunking is forced
    const limit = Math.floor(text.length * 0.6);
    const chunks = markdownToTelegramChunks(text, limit);

    // Every chunk must have balanced <pre><code> / </code></pre> tags
    for (const chunk of chunks) {
      const opens = (chunk.match(/<pre><code>/g) ?? []).length;
      const closes = (chunk.match(/<\/code><\/pre>/g) ?? []).length;
      expect(opens).toBe(closes);
    }

    // The full content must be present across all chunks
    const combined = chunks.join("");
    expect(combined).toContain("<pre><code>");
    expect(combined).toContain("intro");
    expect(combined).toContain("outro");
  });

  it("returns empty array for empty input", () => {
    expect(markdownToTelegramChunks("")).toEqual([]);
  });
});

describe("approval callback data format", () => {
  // Telegram limits callback_query data to 64 bytes. The approval flow uses
  // a:${12-char-hash}:${result} format to stay well under that limit.

  function buildCallbackData(approvalKey: string, result: string): string {
    const shortKey = crypto.createHash("sha256").update(approvalKey).digest("hex").slice(0, 12);
    return `a:${shortKey}:${result}`;
  }

  it("callback data stays under 64 bytes for tool approval", () => {
    const key = "tool:default-user:system_restart";
    const data = buildCallbackData(key, "always");
    expect(data.length).toBeLessThanOrEqual(64);
  });

  it("callback data stays under 64 bytes for guardrail approval with long tool call ID", () => {
    const key = "guardrail:default-user:toolu_01A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5";
    const data = buildCallbackData(key, "always");
    expect(data.length).toBeLessThanOrEqual(64);
  });

  it("all three results stay under 64 bytes", () => {
    const key = "guardrail:default-user:toolu_01XXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    expect(buildCallbackData(key, "allow").length).toBeLessThanOrEqual(64);
    expect(buildCallbackData(key, "always").length).toBeLessThanOrEqual(64);
    expect(buildCallbackData(key, "deny").length).toBeLessThanOrEqual(64);
  });

  it("same approval key always produces the same short key", () => {
    const key = "tool:12345:shell_exec";
    const a = buildCallbackData(key, "allow");
    const b = buildCallbackData(key, "allow");
    expect(a).toBe(b);
  });

  it("different approval keys produce different short keys", () => {
    const a = buildCallbackData("tool:12345:shell_exec", "allow");
    const b = buildCallbackData("tool:12345:http_request", "allow");
    expect(a).not.toBe(b);
  });

  it("callback data can be parsed back to parts", () => {
    const key = "guardrail:default-user:toolu_abc123";
    const data = buildCallbackData(key, "always");
    const parts = data.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("a");
    expect(parts[1]).toHaveLength(12);
    expect(parts[2]).toBe("always");
  });
});
