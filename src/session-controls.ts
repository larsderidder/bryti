import type { ContextManagementConfig } from "./context-management.js";
import type { DiagnosticsConfig } from "./session-diagnostics.js";

/** Validate operator-owned controls; malformed booleans must not accidentally enable capture. */
export function sessionControlsFromConfig(raw: Record<string, unknown>): {
  context_management: ContextManagementConfig;
  diagnostics: DiagnosticsConfig;
} {
  function section(value: unknown): Record<string, unknown> {
    if (value === undefined) {
      return {};
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid session controls");
    }
    return value as Record<string, unknown>;
  }

  function boolean(value: unknown, fallback: boolean): boolean {
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== "boolean") {
      throw new Error("Invalid session control boolean");
    }
    return value;
  }

  function integer(value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error("Invalid session control limit");
    }
    return value;
  }

  const context = section(raw.context_management);
  const diagnostics = section(raw.diagnostics);
  const contextOptions = {
    enabled: boolean(context.enabled, false),
    min_chars: integer(context.min_chars, 8000, 1000, 1_000_000),
    keep_chars: integer(context.keep_chars, 1500, 200, 20_000),
    keep_recent_turns: integer(context.keep_recent_turns, 2, 1, 20),
  };
  if (contextOptions.keep_chars >= contextOptions.min_chars) {
    throw new Error("Invalid session context limits: keep_chars must be less than min_chars");
  }
  return { context_management: contextOptions, diagnostics: {
    capture_provider: boolean(diagnostics.capture_provider, false),
    max_file_bytes: integer(diagnostics.max_file_bytes, 5 * 1024 * 1024, 4096, 50 * 1024 * 1024),
  } };
}
