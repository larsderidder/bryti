/**
 * URL fetch and content extraction tool.
 *
 * HTTP GET, extract readable text via @mozilla/readability + linkedom.
 * Truncates to ~4000 chars to avoid blowing up context.
 */

import axios from "axios";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { toolError, toolSuccess } from "./result.js";
import { Type } from "@sinclair/typebox";

const MAX_CONTENT_LENGTH = 4000;

const fetchUrlSchema = Type.Object({
  url: Type.String({ description: "The URL to fetch" }),
});

type FetchUrlInput = Static<typeof fetchUrlSchema>;

/**
 * Check if a URL is private (SSRF protection).
 */
function isPrivateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Check localhost variants
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.startsWith("127.")
    ) {
      return true;
    }

    // Check private IP ranges
    if (hostname.startsWith("10.")) return true;
    if (hostname.startsWith("192.168.")) return true;
    if (hostname.startsWith("172.")) {
      const parts = hostname.split(".");
      if (parts.length >= 2) {
        const second = parseInt(parts[1], 10);
        if (second >= 16 && second <= 31) return true;
      }
    }

    // Check metadata endpoints (cloud providers)
    if (hostname === "169.254.169.254") return true;

    return false;
  } catch {
    return true; // Invalid URLs are treated as private
  }
}

/**
 * Create the fetch URL tool.
 */
export function createFetchUrlTool(timeoutMs: number = 10000): AgentTool<typeof fetchUrlSchema> {
  return {
    name: "fetch_url",
    label: "fetch_url",
    description: "Fetch a URL and extract its readable text content. Useful for getting details from a specific webpage.",
    parameters: fetchUrlSchema,
    async execute(
      _toolCallId: string,
      { url }: FetchUrlInput,
    ): Promise<AgentToolResult<unknown>> {
      // SSRF protection
      if (isPrivateUrl(url)) {
        const text = JSON.stringify({ error: "Cannot fetch private URLs" });
        return {
          content: [{ type: "text", text }],
          details: { error: "Cannot fetch private URLs" },
        };
      }

      try {
        const response = await axios.get(url, {
          timeout: timeoutMs,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Bryti/1.0)",
            Accept: "text/html,application/xhtml+xml",
          },
          maxContentLength: 2 * 1024 * 1024, // 2MB max
        });

        const html = response.data as string;

        // Parse HTML and extract content
        const { document } = parseHTML(html);
        const reader = new Readability(document as unknown as Document);
        const article = reader.parse();

        if (!article) {
          const text = JSON.stringify({ error: "Could not extract content from page" });
          return {
            content: [{ type: "text", text }],
            details: { error: "Could not extract content from page" },
          };
        }

        let content = article.textContent || "";
        const title = article.title || "";

        // Truncate if too long
        if (content.length > MAX_CONTENT_LENGTH) {
          content = content.substring(0, MAX_CONTENT_LENGTH) + "\n\n[Content truncated...]";
        }

        return toolSuccess({ title, content: content.trim() });
      } catch (error) {
        return toolError(error, "Failed to fetch URL");
      }
    },
  };
}
