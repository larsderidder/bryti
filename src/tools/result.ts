/**
 * Shared helpers for building AgentToolResult objects.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";

/**
 * Extract a string message from any thrown value.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Build a failure AgentToolResult from a caught error.
 *
 * @param error   The caught value (any type).
 * @param prefix  Optional prefix for the user-facing message, e.g. "Failed to read file".
 *                The raw error message is always stored separately in details.
 */
export function toolError(error: unknown, prefix?: string): AgentToolResult<unknown> {
  const msg = errorMessage(error);
  const displayMsg = prefix ? `${prefix}: ${msg}` : msg;
  return {
    content: [{ type: "text", text: JSON.stringify({ error: displayMsg }) }],
    details: { error: msg },
  };
}

/**
 * Build a success AgentToolResult with a JSON payload.
 */
export function toolSuccess(data: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data as Record<string, unknown>,
  };
}
