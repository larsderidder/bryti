import { describe, it, expect } from "vitest";
import { stripReasoningTags } from "./reasoning-tags.js";

describe("stripReasoningTags", () => {
  describe("basic stripping", () => {
    it("should return text unchanged when no tags present", () => {
      const text = "Hello world, this is normal text.";
      expect(stripReasoningTags(text)).toBe(text);
    });

    it("should strip <think> tags", () => {
      expect(stripReasoningTags("<think>reasoning</think>")).toBe("");
      // Note: double space because content between words is removed
      expect(stripReasoningTags("Before <think>reasoning</think> after")).toBe(
        "Before  after"
      );
    });

    it("should strip <thinking> tags", () => {
      expect(stripReasoningTags("<thinking>deep thought</thinking>")).toBe("");
      expect(stripReasoningTags("A <thinking>B</thinking> C")).toBe("A  C");
    });

    it("should strip <thought> tags", () => {
      expect(stripReasoningTags("<thought>my thought</thought>")).toBe("");
    });

    it("should strip <antthinking> tags", () => {
      expect(stripReasoningTags("<antthinking>ai reasoning</antthinking>")).toBe(
        ""
      );
    });

    it("should strip <reasoning> tags", () => {
      expect(stripReasoningTags("<reasoning>logic here</reasoning>")).toBe("");
    });

    it("should strip <scratchpad> tags", () => {
      expect(stripReasoningTags("<scratchpad>notes</scratchpad>")).toBe("");
    });

    it("should strip multiple reasoning blocks", () => {
      const text =
        "Start <think>first</think> middle <thinking>second</thinking> end";
      expect(stripReasoningTags(text)).toBe("Start  middle  end");
    });

    it("should handle tags with attributes", () => {
      expect(stripReasoningTags("<think id='test'>content</think>")).toBe("");
      expect(
        stripReasoningTags('<think class="foo" id="bar">content</think>')
      ).toBe("");
    });

    it("should be case insensitive", () => {
      expect(stripReasoningTags("<THINK>content</THINK>")).toBe("");
      expect(stripReasoningTags("<Think>content</Think>")).toBe("");
      expect(stripReasoningTags("<tHiNkInG>content</tHiNkInG>")).toBe("");
    });

    it("should handle whitespace in tags", () => {
      expect(stripReasoningTags("< think >content< /think >")).toBe("");
      expect(stripReasoningTags("<  thinking  >content<  /thinking  >")).toBe(
        ""
      );
    });
  });

  describe("code block preservation", () => {
    it("should preserve tags inside backtick fenced blocks", () => {
      const text = "```\n<think>inside code</think>\n```";
      expect(stripReasoningTags(text)).toBe("```\n<think>inside code</think>\n```");
    });

    it("should preserve tags inside tilde fenced blocks", () => {
      const text = "~~~\n<thinking>inside code</thinking>\n~~~";
      expect(stripReasoningTags(text)).toBe("~~~\n<thinking>inside code</thinking>\n~~~");
    });

    it("should preserve tags inside fenced blocks with language specifier", () => {
      const text = '```typescript\n<think>code</think>\n```';
      expect(stripReasoningTags(text)).toBe('```typescript\n<think>code</think>\n```');
    });

    it("should preserve tags inside inline code (single backtick)", () => {
      expect(stripReasoningTags("Use `<think>` tag")).toBe("Use `<think>` tag");
      expect(stripReasoningTags("Text `<thinking>test</thinking>` more")).toBe(
        "Text `<thinking>test</thinking>` more"
      );
    });

    it("should preserve tags inside double-backtick inline code", () => {
      expect(stripReasoningTags("``<think>test</think>``")).toBe(
        "``<think>test</think>``"
      );
    });

    it("should strip real tags while preserving code-block tags", () => {
      const text = "<think>strip this</think> and `<think>keep this</think>`";
      expect(stripReasoningTags(text)).toBe("and `<think>keep this</think>`");
    });

    it("should handle code block followed by real tag", () => {
      const text = "```\n<think>code</think>\n```\n<think>strip</think>";
      expect(stripReasoningTags(text)).toBe(
        "```\n<think>code</think>\n```"
      );
    });

    it("should handle code block at EOF without trailing newline", () => {
      const text = "```\n<think>code</think>\n```";
      expect(stripReasoningTags(text)).toBe("```\n<think>code</think>\n```");
    });

    it("should handle multiple code blocks with tags", () => {
      const text =
        "```\n<think>first</think>\n```\ntext\n```\n<think>second</think>\n```";
      expect(stripReasoningTags(text)).toBe(
        "```\n<think>first</think>\n```\ntext\n```\n<think>second</think>\n```"
      );
    });
  });

  describe("<final> tag handling", () => {
    it("should strip <final> tags but preserve content", () => {
      expect(stripReasoningTags("<final>content</final>")).toBe("content");
    });

    it("should preserve <final> in inline code", () => {
      expect(stripReasoningTags("`<final>code</final>`")).toBe(
        "`<final>code</final>`"
      );
    });

    it("should preserve <final> in fenced block", () => {
      const text = "```\n<final>code</final>\n```";
      expect(stripReasoningTags(text)).toBe("```\n<final>code</final>\n```");
    });
  });

  describe("streaming partial (unclosed tags)", () => {
    it("should truncate at unclosed tag in strict mode", () => {
      expect(stripReasoningTags("Hello <think>unclosed")).toBe("Hello");
    });

    it("should preserve content in preserve mode", () => {
      expect(stripReasoningTags("Hello <think>unclosed", { mode: "preserve" })).toBe(
        "Hello unclosed"
      );
    });

    it("should handle multiple unclosed tags in strict mode", () => {
      expect(stripReasoningTags("A <think>B <thinking>C")).toBe("A");
    });

    it("should handle multiple unclosed tags in preserve mode", () => {
      expect(
        stripReasoningTags("A <think>B <thinking>C", { mode: "preserve" })
      ).toBe("A B C");
    });
  });

  describe("trim options", () => {
    it("should trim both sides by default", () => {
      expect(stripReasoningTags("  <think>test</think>  ")).toBe("");
    });

    it("should trim only start with trim: start", () => {
      // After stripping tags, we have 4 spaces; trim start removes leading spaces -> empty
      expect(
        stripReasoningTags("  <think>test</think>  ", { trim: "start" })
      ).toBe("");
    });

    it("should not trim with trim: none", () => {
      expect(
        stripReasoningTags("  <think>test</think>  ", { trim: "none" })
      ).toBe("    ");
    });
  });

  describe("edge cases", () => {
    it("should return empty string for empty input", () => {
      expect(stripReasoningTags("")).toBe("");
    });

    it("should handle null/undefined", () => {
      expect(stripReasoningTags(null as unknown as string)).toBe(null);
      expect(stripReasoningTags(undefined as unknown as string)).toBe(undefined);
    });

    it("should handle unicode content inside tags", () => {
      expect(stripReasoningTags("<think>日本語</think>")).toBe("");
      expect(stripReasoningTags("<think>🎉 emoji</think>")).toBe("");
    });

    it("should handle nested think tags (first close ends block)", () => {
      // <think>a<think>b</think>c</think>d -> should become "d"
      expect(stripReasoningTags("<think>a<think>b</think>c</think>d")).toBe("d");
    });

    it("should handle long content between tags", () => {
      const longContent = "x".repeat(10000);
      const text = `<think>${longContent}</think>`;
      const start = performance.now();
      const result = stripReasoningTags(text);
      const duration = performance.now() - start;
      expect(result).toBe("");
      expect(duration).toBeLessThan(100);
    });

    it("should not hang on pathological backtick patterns", () => {
      const text = "`".repeat(100) + "<think>test</think>" + "`".repeat(100);
      const start = performance.now();
      const result = stripReasoningTags(text);
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(1000);
      // Tags should be stripped since they're not in valid inline code
      expect(result).not.toContain("<think>");
    });

    it("should not affect normal HTML-like tags", () => {
      expect(stripReasoningTags("<b>bold</b>")).toBe("<b>bold</b>");
      expect(stripReasoningTags('<a href="test">link</a>')).toBe(
        '<a href="test">link</a>'
      );
    });

    it("should handle adjacent tags", () => {
      expect(stripReasoningTags("<think>A</think><thinking>B</thinking>")).toBe(
        ""
      );
    });

    it("should handle self-closing style reasoning content", () => {
      // Some models output thinking without close tags
      expect(stripReasoningTags("Text<think>thought", { mode: "preserve" })).toBe(
        "Textthought"
      );
    });
  });
});
