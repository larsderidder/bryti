import { describe, expect, it } from "vitest";
import { sessionControlsFromConfig } from "./session-controls.js";

describe("session controls", () => {
  it("defaults cleanup and provider capture off", () => {
    expect(sessionControlsFromConfig({})).toMatchObject({ context_management: { enabled: false }, diagnostics: { capture_provider: false } });
  });

  it.each([
    { context_management: { enabled: "false" } },
    { context_management: { min_chars: 1000, keep_chars: 1000 } },
    { context_management: { keep_recent_turns: 0 } },
    { context_management: { min_chars: Number.POSITIVE_INFINITY } },
    { context_management: [] },
    { diagnostics: { capture_provider: "true" } },
    { diagnostics: { max_file_bytes: 0 } },
  ])("rejects unsafe controls %j", (value) => {
    expect(() => sessionControlsFromConfig(value)).toThrow("Invalid session");
  });
});
