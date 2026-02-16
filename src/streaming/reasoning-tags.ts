/**
 * Reasoning tag stripper for LLM output.
 * Strips <think>, <thinking>, <thought>, <antthinking>, <reasoning>, <scratchpad>
 * tags while preserving content inside code blocks.
 */

export interface StripOptions {
  /** "strict": truncate at unclosed tag open. "preserve": keep content, strip tag syntax. Default "strict". */
  mode?: "strict" | "preserve";
  /** "both" | "start" | "none". Default "both". */
  trim?: "both" | "start" | "none";
}

interface CodeSpan {
  start: number;
  end: number;
}

/**
 * Find all fenced code block spans (backtick or tilde) in text.
 * Returns array of [start, end] positions for code content (excluding fences).
 */
function findFencedCodeSpans(text: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  const fencePattern = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/gm;

  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    const indent = match[1].length;
    const openFence = match[2];
    const openIndex = match.index;
    const contentStart = openIndex + match[0].length + 1; // +1 for newline

    // Find closing fence
    const closePattern = new RegExp(
      `^( {0,${indent}})\\${openFence}\\s*$`,
      "gm"
    );
    closePattern.lastIndex = contentStart;

    const closeMatch = closePattern.exec(text);
    if (closeMatch) {
      const contentEnd = closeMatch.index - 1; // -1 for newline before fence
      spans.push({ start: contentStart, end: Math.max(contentStart, contentEnd) });
      fencePattern.lastIndex = closeMatch.index + closeMatch[0].length;
    }
    // If no closing fence, it's not a valid code block
  }

  return spans;
}

/**
 * Find all inline code spans in text.
 * Returns array of [start, end] positions for code content (excluding backticks).
 */
function findInlineCodeSpans(text: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  // Match inline code: `...` or ``...`` (not ``` which is fence)
  // Negative lookbehind and lookahead to ensure exact backtick count
  const pattern = /(?<!`)`([^`\n]+)`(?!`)|(?<!`)``([^`\n]+)``(?!`)/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const content = match[1] ?? match[2];
    const start = match.index + (match[1] ? 1 : 2); // 1 or 2 backticks
    spans.push({ start, end: start + content.length });
  }

  return spans;
}

/**
 * Find all code spans (fenced + inline) in text.
 */
function findAllCodeSpans(text: string): CodeSpan[] {
  const fenced = findFencedCodeSpans(text);
  const inline = findInlineCodeSpans(text);
  return [...fenced, ...inline].sort((a, b) => a.start - b.start);
}

/**
 * Check if a position is inside any code span.
 */
function isInCodeSpan(pos: number, spans: CodeSpan[]): boolean {
  return spans.some((span) => pos >= span.start && pos < span.end);
}

/**
 * Reasoning tag names to strip (case insensitive).
 */
const REASONING_TAGS = [
  "think",
  "thinking",
  "thought",
  "antthinking",
  "reasoning",
  "scratchpad",
];

/**
 * Build regex for reasoning tag open pattern.
 * Matches: <think>, <think >, <think id="x">, <think id='x' class="y">
 * With optional whitespace around tag name and inside brackets.
 */
function buildOpenTagPattern(tag: string): RegExp {
  // Match: <whitespace* tag whitespace* attributes? whitespace* >
  return new RegExp(
    `<\\s*${tag}\\b[^>]*?>`,
    "gi"
  );
}

/**
 * Build regex for reasoning tag close pattern.
 */
function buildCloseTagPattern(tag: string): RegExp {
  return new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi");
}

/**
 * Find all reasoning tag ranges that are outside code spans.
 * Returns array of { start, end, tag } for matched tag pairs.
 */
function findReasoningTagRanges(
  text: string,
  codeSpans: CodeSpan[]
): Array<{ start: number; end: number; tag: string }> {
  const ranges: Array<{ start: number; end: number; tag: string }> = [];

  for (const tag of REASONING_TAGS) {
    const openPattern = buildOpenTagPattern(tag);
    const closePattern = buildCloseTagPattern(tag);

    // Find all open tags not in code
    const openTags: Array<{ index: number; length: number }> = [];
    let openMatch: RegExpExecArray | null;
    while ((openMatch = openPattern.exec(text)) !== null) {
      if (!isInCodeSpan(openMatch.index, codeSpans)) {
        openTags.push({ index: openMatch.index, length: openMatch[0].length });
      }
    }

    // Find all close tags not in code
    const closeTags: Array<{ index: number; length: number }> = [];
    let closeMatch: RegExpExecArray | null;
    while ((closeMatch = closePattern.exec(text)) !== null) {
      if (!isInCodeSpan(closeMatch.index, codeSpans)) {
        closeTags.push({ index: closeMatch.index, length: closeMatch[0].length });
      }
    }

    // Match opens with closes (first close ends first open)
    for (const open of openTags) {
      const close = closeTags.find((c) => c.index > open.index);
      if (close) {
        ranges.push({
          start: open.index,
          end: close.index + close.length,
          tag,
        });
        // Remove used close tag to prevent reuse
        const idx = closeTags.indexOf(close);
        closeTags.splice(idx, 1);
      } else {
        // Unclosed tag - handle based on mode
        ranges.push({
          start: open.index,
          end: -1, // marker for unclosed
          tag,
        });
      }
    }
  }

  // Sort by start position and merge overlapping ranges
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

/**
 * Find <final> tag ranges outside code spans.
 * Returns array of { start, end } for tag positions to strip (keeping content).
 */
function findFinalTagRanges(
  text: string,
  codeSpans: CodeSpan[]
): Array<{ start: number; end: number; isOpen: boolean }> {
  const ranges: Array<{ start: number; end: number; isOpen: boolean }> = [];

  // Match <final> and </final>
  const openPattern = /<\s*final\s*>/gi;
  const closePattern = /<\s*\/\s*final\s*>/gi;

  let match: RegExpExecArray | null;
  while ((match = openPattern.exec(text)) !== null) {
    if (!isInCodeSpan(match.index, codeSpans)) {
      ranges.push({ start: match.index, end: match.index + match[0].length, isOpen: true });
    }
  }

  while ((match = closePattern.exec(text)) !== null) {
    if (!isInCodeSpan(match.index, codeSpans)) {
      ranges.push({ start: match.index, end: match.index + match[0].length, isOpen: false });
    }
  }

  return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Strip reasoning tags from text while preserving tags in code blocks.
 *
 * @param text - Input text potentially containing reasoning tags
 * @param options - Stripping options
 * @returns Text with reasoning tags removed
 */
export function stripReasoningTags(
  text: string,
  options: StripOptions = {}
): string {
  if (!text || typeof text !== "string") {
    return text;
  }

  const { mode = "strict", trim = "both" } = options;

  // Find all code spans
  const codeSpans = findAllCodeSpans(text);

  // Find reasoning tag ranges and final tag ranges
  const reasoningRanges = findReasoningTagRanges(text, codeSpans);
  const finalRanges = findFinalTagRanges(text, codeSpans);

  // Separate closed and unclosed ranges
  const closedRanges = reasoningRanges.filter((r) => r.end !== -1);
  const unclosedRanges = reasoningRanges.filter((r) => r.end === -1);

  // Build result by excluding tag ranges
  let result = "";
  let lastPos = 0;

  // Process closed reasoning tags
  for (const range of closedRanges) {
    // Add text before this tag
    if (range.start > lastPos) {
      result += text.slice(lastPos, range.start);
    }
    // Skip the tag range (content between tags is not added)
    lastPos = range.end;
  }

  // Add remaining text up to first unclosed tag (if any)
  const firstUnclosed = unclosedRanges[0];
  const endPos = firstUnclosed ? firstUnclosed.start : text.length;
  if (lastPos < endPos) {
    result += text.slice(lastPos, endPos);
  }

  // Handle unclosed tags
  if (firstUnclosed) {
    if (mode === "preserve") {
      // In preserve mode, keep content after each unclosed tag
      for (let i = 0; i < unclosedRanges.length; i++) {
        const range = unclosedRanges[i];
        const nextUnclosed = unclosedRanges[i + 1];
        const contentStart = range.start;
        const tagMatch = text.slice(contentStart).match(/^<[^>]+>/);
        const contentAfterTag = tagMatch
          ? contentStart + tagMatch[0].length
          : contentStart;

        // Content goes up to next unclosed tag or end of text
        const contentEnd = nextUnclosed ? nextUnclosed.start : text.length;
        if (contentAfterTag < contentEnd) {
          result += text.slice(contentAfterTag, contentEnd);
        }
      }
    }
    // In strict mode, we already truncated at first unclosed tag
  }

  // Process final tags - strip them but keep content
  if (finalRanges.length > 0) {
    let finalResult = "";
    let pos = 0;
    for (const range of finalRanges) {
      finalResult += result.slice(pos, range.start);
      pos = range.end;
    }
    finalResult += result.slice(pos);
    result = finalResult;
  }

  // Apply trimming
  if (trim === "both") {
    result = result.trim();
  } else if (trim === "start") {
    result = result.replace(/^\s+/, "");
  }
  // trim === "none" does nothing

  return result;
}
