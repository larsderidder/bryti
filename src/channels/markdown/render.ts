/**
 * Platform-agnostic markdown renderer.
 *
 * Callers supply `styleMarkers` (open/close strings per style) and `escapeText`
 * (platform-specific entity escaping). Telegram and WhatsApp each plug in their
 * own implementations. This is the only place in the pipeline that emits
 * platform-specific syntax.
 */
import type { MarkdownIR, MarkdownLinkSpan, MarkdownStyle, MarkdownStyleSpan } from "./ir.js";

export type RenderStyleMarker = {
  open: string;
  close: string;
};

export type RenderStyleMap = Partial<Record<MarkdownStyle, RenderStyleMarker>>;

export type RenderLink = {
  start: number;
  end: number;
  open: string;
  close: string;
};

export type RenderOptions = {
  styleMarkers: RenderStyleMap;
  escapeText: (text: string) => string;
  buildLink?: (link: MarkdownLinkSpan, text: string) => RenderLink | null;
};

// When two spans start at the same position the one with higher rank (lower
// index in STYLE_ORDER) is opened first so the outer span wraps the inner.
// This prevents inverted nesting where, for example, a code span would end up
// wrapped inside a bold span instead of the other way around.
const STYLE_ORDER: MarkdownStyle[] = [
  "code_block",
  "code",
  "bold",
  "italic",
  "strikethrough",
  "spoiler",
];

// Inverse lookup: style → index in STYLE_ORDER (lower = higher priority / outer).
const STYLE_RANK = new Map<MarkdownStyle, number>(
  STYLE_ORDER.map((style, index) => [style, index]),
);

/**
 * Sort style spans for deterministic processing.
 *
 * Primary key: start position ascending (process spans left to right).
 * Secondary key: end position descending (longest span first, so the outer
 *   tag is opened before the inner one).
 * Tertiary key: STYLE_RANK ascending (higher-priority style is outer when
 *   two spans have identical start and end positions).
 *
 * Together these three keys ensure nesting is always correct.
 */
function sortStyleSpans(spans: MarkdownStyleSpan[]): MarkdownStyleSpan[] {
  return [...spans].toSorted((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    if (a.end !== b.end) {
      return b.end - a.end;
    }
    return (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0);
  });
}

/**
 * Render a `MarkdownIR` to a string using the supplied platform markers.
 *
 * Invariant: each style span and link is opened and closed exactly once, even
 * when spans overlap. Overlapping spans are handled by the sweep-line loop
 * below: every span is always closed at its recorded end position regardless
 * of what other spans are active at that point.
 */
export function renderMarkdownWithMarkers(ir: MarkdownIR, options: RenderOptions): string {
  const text = ir.text ?? "";
  if (!text) {
    return "";
  }

  const styleMarkers = options.styleMarkers;
  const styled = sortStyleSpans(ir.styles.filter((span) => Boolean(styleMarkers[span.style])));

  const boundaries = new Set<number>();
  boundaries.add(0);
  boundaries.add(text.length);

  const startsAt = new Map<number, MarkdownStyleSpan[]>();
  for (const span of styled) {
    if (span.start === span.end) {
      continue;
    }
    boundaries.add(span.start);
    boundaries.add(span.end);
    const bucket = startsAt.get(span.start);
    if (bucket) {
      bucket.push(span);
    } else {
      startsAt.set(span.start, [span]);
    }
  }
  for (const spans of startsAt.values()) {
    spans.sort((a, b) => {
      if (a.end !== b.end) {
        return b.end - a.end;
      }
      return (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0);
    });
  }

  const linkStarts = new Map<number, RenderLink[]>();
  if (options.buildLink) {
    for (const link of ir.links) {
      if (link.start === link.end) {
        continue;
      }
      const rendered = options.buildLink(link, text);
      if (!rendered) {
        continue;
      }
      boundaries.add(rendered.start);
      boundaries.add(rendered.end);
      const openBucket = linkStarts.get(rendered.start);
      if (openBucket) {
        openBucket.push(rendered);
      } else {
        linkStarts.set(rendered.start, [rendered]);
      }
    }
  }

  // Collect all unique character positions where a span starts or ends, then
  // sort them. The main loop walks these boundaries left to right — this is a
  // sweep-line algorithm over character positions.
  const points = [...boundaries].toSorted((a, b) => a - b);

  // Active-span stack: entries are pushed when a span opens and popped (in
  // reverse / LIFO order) when the span's end position is reached. Because
  // spans may overlap, spans that are still logically open when another span
  // needs to close must be temporarily closed and then reopened around the
  // text slice — the stack makes this order explicit.
  const stack: { close: string; end: number }[] = [];
  type OpeningItem =
    | { end: number; open: string; close: string; kind: "link"; index: number }
    | {
        end: number;
        open: string;
        close: string;
        kind: "style";
        style: MarkdownStyle;
        index: number;
      };
  let out = "";

  for (let i = 0; i < points.length; i += 1) {
    const pos = points[i];

    // Close ALL elements (styles and links) in LIFO order at this position
    while (stack.length && stack[stack.length - 1]?.end === pos) {
      const item = stack.pop();
      if (item) {
        out += item.close;
      }
    }

    const openingItems: OpeningItem[] = [];

    const openingLinks = linkStarts.get(pos);
    if (openingLinks && openingLinks.length > 0) {
      for (const [index, link] of openingLinks.entries()) {
        openingItems.push({
          end: link.end,
          open: link.open,
          close: link.close,
          kind: "link",
          index,
        });
      }
    }

    const openingStyles = startsAt.get(pos);
    if (openingStyles) {
      for (const [index, span] of openingStyles.entries()) {
        const marker = styleMarkers[span.style];
        if (!marker) {
          continue;
        }
        openingItems.push({
          end: span.end,
          open: marker.open,
          close: marker.close,
          kind: "style",
          style: span.style,
          index,
        });
      }
    }

    if (openingItems.length > 0) {
      openingItems.sort((a, b) => {
        if (a.end !== b.end) {
          return b.end - a.end;
        }
        if (a.kind !== b.kind) {
          return a.kind === "link" ? -1 : 1;
        }
        if (a.kind === "style" && b.kind === "style") {
          return (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0);
        }
        return a.index - b.index;
      });

      // Open outer spans first (larger end) so LIFO closes stay valid for same-start overlaps.
      for (const item of openingItems) {
        out += item.open;
        stack.push({ close: item.close, end: item.end });
      }
    }

    const next = points[i + 1];
    if (next === undefined) {
      break;
    }
    if (next > pos) {
      out += options.escapeText(text.slice(pos, next));
    }
  }

  return out;
}
