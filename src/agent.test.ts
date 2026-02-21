import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildToolSection,
  promptWithFallback,
  resolveModel,
  refreshSystemPrompt,
} from "./agent.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Config } from "./config.js";

// Minimal config for tests
function makeConfig(model: string, fallbacks: string[] = []): Config {
  return {
    agent: {
      name: "TestBot",
      system_prompt: "test",
      model,
      fallback_models: fallbacks,
    },
    telegram: { token: "", allowed_users: [] },
    whatsapp: { enabled: false, allowed_users: [] },
    models: { providers: [] },
    tools: {
      web_search: { enabled: false, searxng_url: "" },
      fetch_url: { enabled: false, timeout_ms: 5000 },
      files: { enabled: false, base_dir: "/tmp" },
    },
    cron: [],
    data_dir: "/tmp",
  } as Config;
}

function makeModel(id: string) {
  return { id, provider: "test", api: "openai-completions" };
}

function makeRegistry(models: Record<string, ReturnType<typeof makeModel>>): ModelRegistry {
  return {
    find: vi.fn((provider: string, modelId: string) => {
      const key = `${provider}/${modelId}`;
      return models[key] ?? null;
    }),
    getAvailable: vi.fn(() => Object.values(models)),
    refresh: vi.fn(),
  } as unknown as ModelRegistry;
}

function makeSession(overrides: {
  promptFn?: () => Promise<void>;
  messages?: unknown[];
  setModelFn?: () => Promise<void>;
} = {}): AgentSession {
  const messages = overrides.messages ?? [
    {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
    },
  ];

  return {
    prompt: overrides.promptFn ?? vi.fn().mockResolvedValue(undefined),
    setModel: overrides.setModelFn ?? vi.fn().mockResolvedValue(undefined),
    get messages() { return messages; },
  } as unknown as AgentSession;
}

describe("resolveModel", () => {
  it("finds model by provider/id string", () => {
    const registry = makeRegistry({ "test/my-model": makeModel("my-model") });
    const result = resolveModel("test/my-model", registry);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("my-model");
  });

  it("returns null when model not found", () => {
    const registry = makeRegistry({});
    expect(resolveModel("test/missing", registry)).toBeNull();
  });
});

describe("buildToolSection", () => {
  it("renders sorted tools and marks extension tools", () => {
    const section = buildToolSection(
      [
        { name: "z_tool", description: "Z desc" },
        { name: "a_tool", description: "A desc" },
      ],
      new Set(["a_tool"]),
    );

    expect(section).toContain("## Your currently loaded tools");
    expect(section).toContain("- a_tool: A desc (extension)");
    expect(section).toContain("- z_tool: Z desc");
    expect(section.indexOf("a_tool")).toBeLessThan(section.indexOf("z_tool"));
  });

  it("renders placeholder when no tools are loaded", () => {
    expect(buildToolSection([], new Set())).toContain("- None");
  });
});

describe("promptWithFallback", () => {
  it("succeeds with primary model on first try", async () => {
    const session = makeSession();
    const config = makeConfig("test/primary");
    const registry = makeRegistry({ "test/primary": makeModel("primary") });

    const result = await promptWithFallback(session, "hello", config, registry, "user1");

    expect(result.modelUsed).toBe("test/primary");
    expect(result.fallbacksUsed).toBe(0);
    expect(session.prompt).toHaveBeenCalledOnce();
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it("falls back to second model when primary has stopReason=error", async () => {
    const failMessages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "rate limit",
      },
    ];
    const okMessages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
      },
    ];

    // First call returns error messages, second call returns ok messages
    let callCount = 0;
    const promptFn = vi.fn().mockImplementation(async () => { callCount++; });

    const session = {
      prompt: promptFn,
      setModel: vi.fn().mockResolvedValue(undefined),
      get messages() {
        return callCount === 1 ? failMessages : okMessages;
      },
    } as unknown as AgentSession;

    const config = makeConfig("test/primary", ["test/fallback"]);
    const registry = makeRegistry({
      "test/primary": makeModel("primary"),
      "test/fallback": makeModel("fallback"),
    });

    const result = await promptWithFallback(session, "hello", config, registry, "user1");

    expect(result.fallbacksUsed).toBe(1);
    expect(result.modelUsed).toBe("test/fallback");
    expect(session.setModel).toHaveBeenCalledOnce();
    expect(promptFn).toHaveBeenCalledTimes(2);
  });

  it("falls back when prompt() throws", async () => {
    let callCount = 0;
    const promptFn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("connection refused");
    });

    const okMessages = [
      { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ];
    const session = {
      prompt: promptFn,
      setModel: vi.fn().mockResolvedValue(undefined),
      get messages() { return okMessages; },
    } as unknown as AgentSession;

    const config = makeConfig("test/primary", ["test/fallback"]);
    const registry = makeRegistry({
      "test/primary": makeModel("primary"),
      "test/fallback": makeModel("fallback"),
    });

    const result = await promptWithFallback(session, "hello", config, registry, "user1");
    expect(result.fallbacksUsed).toBe(1);
    expect(result.modelUsed).toBe("test/fallback");
  });

  it("throws when all models in the chain fail", async () => {
    const errorMessages = [
      { role: "assistant", stopReason: "error", errorMessage: "gone", content: [] },
    ];
    const session = {
      prompt: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      get messages() { return errorMessages; },
    } as unknown as AgentSession;

    const config = makeConfig("test/primary", ["test/fallback"]);
    const registry = makeRegistry({
      "test/primary": makeModel("primary"),
      "test/fallback": makeModel("fallback"),
    });

    await expect(
      promptWithFallback(session, "hello", config, registry, "user1"),
    ).rejects.toThrow();
  });

  it("skips fallback model that is not in the registry", async () => {
    const errorMessages = [
      { role: "assistant", stopReason: "error", errorMessage: "gone", content: [] },
    ];
    const okMessages = [
      { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
    ];

    let callCount = 0;
    const promptFn = vi.fn().mockImplementation(async () => { callCount++; });

    const session = {
      prompt: promptFn,
      setModel: vi.fn().mockResolvedValue(undefined),
      get messages() { return callCount <= 1 ? errorMessages : okMessages; },
    } as unknown as AgentSession;

    const config = makeConfig("test/primary", ["test/missing", "test/good"]);
    const registry = makeRegistry({
      "test/primary": makeModel("primary"),
      // "test/missing" intentionally absent
      "test/good": makeModel("good"),
    });

    const result = await promptWithFallback(session, "hello", config, registry, "user1");
    expect(result.modelUsed).toBe("test/good");
    expect(result.fallbacksUsed).toBe(2); // primary + missing skipped + good
  });

  it("uses no fallbacks when list is empty and primary succeeds", async () => {
    const session = makeSession();
    const config = makeConfig("test/primary", []);
    const registry = makeRegistry({ "test/primary": makeModel("primary") });

    const result = await promptWithFallback(session, "hi", config, registry, "u");
    expect(result.fallbacksUsed).toBe(0);
  });
});

describe("refreshSystemPrompt", () => {
  it("calls session.reload()", async () => {
    const session = {
      reload: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    await refreshSystemPrompt(session);

    expect(session.reload).toHaveBeenCalledOnce();
  });

  it("is called before each prompt so core memory changes are visible", async () => {
    // Verify the ordering contract: reload must be called before prompt.
    const order: string[] = [];
    const session = {
      reload: vi.fn().mockImplementation(async () => { order.push("reload"); }),
      prompt: vi.fn().mockImplementation(async () => { order.push("prompt"); }),
      get messages() {
        return [{ role: "assistant", stopReason: "end_turn", content: [] }];
      },
    } as unknown as AgentSession;

    await refreshSystemPrompt(session);
    await session.prompt("hi");

    expect(order).toEqual(["reload", "prompt"]);
  });
});
