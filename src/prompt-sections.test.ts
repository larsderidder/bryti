import { describe, expect, it } from "vitest";
import { buildSystemPromptSections } from "./system-prompt.js";
import { PERSONAL_ASSISTANT_DEFAULTS, type Config } from "./config.js";

const config = { agent: { system_prompt: "Standing instructions", timezone: "UTC" },
  agent_def: PERSONAL_ASSISTANT_DEFAULTS, data_dir: "/fixture" } as Config;

describe("independently replaceable prompt sections", () => {
  it("keeps instructions stable when memory, projections, and tools change", () => {
    const first = buildSystemPromptSections(config, "Old memory", [{ name: "read" }], new Set(), "Old commitments");
    const next = buildSystemPromptSections(config, "New memory", [{ name: "read" }, { name: "ls" }], new Set(), "New commitments");
    expect(next.instructions).toBe(first.instructions);
    expect(first.sections.bryti_memory).toContain("Old memory");
    expect(next.sections.bryti_memory).toContain("New memory");
    expect(next.sections.bryti_projections).toContain("New commitments");
    expect(next.sections.bryti_tools).toContain("ls");
    expect(first.instructions).not.toContain("Old memory");
    expect(first.instructions).not.toContain("Current Date & Time");
  });

  it("respects selected sections and removes empty memory", () => {
    const reduced = { ...config, agent_def: { ...PERSONAL_ASSISTANT_DEFAULTS, prompt_sections: ["core_memory"] } } as Config;
    expect(buildSystemPromptSections(reduced, "", [], new Set(), "").sections).toEqual({});
  });
});
