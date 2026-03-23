/**
 * Tests for composable system prompt assembly.
 *
 * Verifies that:
 * - Personal-assistant preset includes all sections
 * - Operational preset includes only the declared sections
 * - Tone variants produce different content for communication_style and projections
 * - Sections absent from the list are not included
 * - Backward compat: existing behavior unchanged when all sections are on
 */

import { describe, it, expect } from "vitest";
import { buildSystemPrompt, SILENT_REPLY_TOKEN } from "./system-prompt.js";
import type { Config } from "./config.js";
import { PERSONAL_ASSISTANT_DEFAULTS } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config["agent_def"]> = {}): Config {
  return {
    agent: {
      name: "TestBot",
      system_prompt: "You are TestBot.",
      model: "anthropic/claude-test",
      fallback_models: [],
      timezone: "Europe/Amsterdam",
    },
    telegram: { token: "tok", allowed_users: [1] },
    whatsapp: { enabled: false, allowed_users: [] },
    models: { providers: [] },
    tools: {
      web_search: { enabled: false, searxng_url: "" },
      fetch_url: { timeout_ms: 5000 },
      workers: { max_concurrent: 1 },
    },
    integrations: {},
    cron: [],
    trust: { approved_tools: [] },
    agent_def: { ...PERSONAL_ASSISTANT_DEFAULTS, ...overrides },
    data_dir: "/tmp",
  } as unknown as Config;
}

const noTools = [];
const noExtensions = new Set<string>();
const noProjections = "(none)";

// ---------------------------------------------------------------------------
// Personal-assistant preset (all sections on)
// ---------------------------------------------------------------------------

describe("personal-assistant preset", () => {
  it("includes all sections", () => {
    const config = makeConfig();
    const prompt = buildSystemPrompt(config, "some memory", noTools, noExtensions, noProjections);

    expect(prompt).toContain("You are TestBot.");
    expect(prompt).toContain("Image Handling");
    expect(prompt).toContain("Current Date & Time");
    expect(prompt).toContain("Communication Style");
    expect(prompt).toContain("currently loaded tools");
    expect(prompt).toContain("Extensions");
    expect(prompt).toContain("Skills");
    expect(prompt).toContain("Core Memory");
    expect(prompt).toContain("Upcoming events and commitments");
    expect(prompt).toContain("Background Workers");
    expect(prompt).toContain(SILENT_REPLY_TOKEN);
  });

  it("uses conversational tone for communication style", () => {
    const config = makeConfig({ prompt_tone: "conversational" });
    const prompt = buildSystemPrompt(config, "", noTools, noExtensions, noProjections);
    expect(prompt).toContain("Never mention tool names");
    expect(prompt).toContain("Say \"I'll remember that\"");
  });

  it("uses conversational framing for projections", () => {
    const config = makeConfig({ prompt_tone: "conversational" });
    const prompt = buildSystemPrompt(config, "", noTools, noExtensions, noProjections);
    expect(prompt).toContain("Never mention \"projections\" to the user");
  });

  it("includes first_conversation section when isNewUser is true", () => {
    const config = makeConfig();
    const prompt = buildSystemPrompt(config, "", noTools, noExtensions, noProjections, { isNewUser: true });
    expect(prompt).toContain("First Conversation");
    expect(prompt).toContain("Hail them warmly");
  });

  it("omits first_conversation section when isNewUser is false", () => {
    const config = makeConfig();
    const prompt = buildSystemPrompt(config, "", noTools, noExtensions, noProjections, { isNewUser: false });
    expect(prompt).not.toContain("First Conversation");
  });

  it("omits core_memory section when memory is empty", () => {
    const config = makeConfig();
    const prompt = buildSystemPrompt(config, "", noTools, noExtensions, noProjections);
    expect(prompt).not.toContain("Core Memory");
  });
});

// ---------------------------------------------------------------------------
// Operational preset (devops-monitor style)
// ---------------------------------------------------------------------------

describe("operational preset", () => {
  const operationalDef: Partial<Config["agent_def"]> = {
    prompt_tone: "operational",
    prompt_sections: ["datetime", "tools", "core_memory", "projections", "silent_reply"],
  };

  it("omits personal-assistant sections", () => {
    const config = makeConfig(operationalDef);
    const prompt = buildSystemPrompt(config, "mem", noTools, noExtensions, noProjections);

    expect(prompt).not.toContain("Image Handling");
    expect(prompt).not.toContain("never mention tool names");
    expect(prompt).not.toContain("Extensions");
    expect(prompt).not.toContain("Skills");
    expect(prompt).not.toContain("Background Workers");
    expect(prompt).not.toContain("First Conversation");
  });

  it("includes declared sections", () => {
    const config = makeConfig(operationalDef);
    const prompt = buildSystemPrompt(config, "mem", noTools, noExtensions, noProjections);

    expect(prompt).toContain("You are TestBot.");
    expect(prompt).toContain("Current Date & Time");
    expect(prompt).toContain("currently loaded tools");
    expect(prompt).toContain("Core Memory");
    expect(prompt).toContain(SILENT_REPLY_TOKEN);
  });

  it("uses operational tone for communication style when section is included", () => {
    const config = makeConfig({
      prompt_tone: "operational",
      prompt_sections: ["communication_style"],
    });
    const prompt = buildSystemPrompt(config, "", noTools, noExtensions, noProjections);
    expect(prompt).toContain("Be terse and direct");
    expect(prompt).not.toContain("never mention tool names");
  });

  it("uses operational framing for projections", () => {
    const config = makeConfig({
      prompt_tone: "operational",
      prompt_sections: ["projections"],
    });
    const prompt = buildSystemPrompt(config, "", noTools, noExtensions, noProjections);
    expect(prompt).toContain("Scheduled observations and commitments");
    expect(prompt).not.toContain("Never mention \"projections\" to the user");
  });

  it("does not include first_conversation even for new users", () => {
    const config = makeConfig(operationalDef);
    const prompt = buildSystemPrompt(config, "", noTools, noExtensions, noProjections, { isNewUser: true });
    expect(prompt).not.toContain("First Conversation");
  });
});

// ---------------------------------------------------------------------------
// Minimal agent (only persona + datetime)
// ---------------------------------------------------------------------------

describe("minimal section set", () => {
  it("produces a short prompt with just the declared sections", () => {
    const config = makeConfig({
      prompt_sections: ["datetime"],
      prompt_tone: "operational",
    });
    const prompt = buildSystemPrompt(config, "mem", noTools, noExtensions, noProjections);

    expect(prompt).toContain("You are TestBot.");
    expect(prompt).toContain("Current Date & Time");
    expect(prompt).not.toContain("Image Handling");
    expect(prompt).not.toContain("Communication Style");
    expect(prompt).not.toContain("Extensions");
    expect(prompt).not.toContain("Core Memory");
    expect(prompt).not.toContain(SILENT_REPLY_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Timezone
// ---------------------------------------------------------------------------

describe("datetime section", () => {
  it("includes timezone in the date/time block when configured", () => {
    const config = makeConfig({ prompt_sections: ["datetime"] });
    const prompt = buildSystemPrompt(config, "", noTools, noExtensions, noProjections);
    expect(prompt).toContain("Europe/Amsterdam");
  });

  it("shows only UTC when no timezone configured", () => {
    const config = makeConfig({ prompt_sections: ["datetime"] });
    config.agent.timezone = undefined;
    const prompt = buildSystemPrompt(config, "", noTools, noExtensions, noProjections);
    expect(prompt).toContain("UTC");
    expect(prompt).not.toContain("Europe/Amsterdam");
  });
});
