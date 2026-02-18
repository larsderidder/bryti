import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ensureDataDirs } from "../src/config.js";

describe("Config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/pibot-test-");
    process.env.PIBOT_DATA_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.PIBOT_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should load minimal config", () => {
    const configContent = `
agent:
  name: TestBot
  system_prompt: "You are a test bot"
  model: "test/model"
telegram:
  token: "test-token"
  allowed_users: [123]
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models:
        - id: test-model
tools:
  web_search:
    enabled: true
    api_key: ""
  fetch_url:
    enabled: true
  files:
    enabled: true
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();

    expect(config.agent.name).toBe("TestBot");
    expect(config.agent.model).toBe("test/model");
    expect(config.telegram.token).toBe("test-token");
    expect(config.models.providers).toHaveLength(1);
  });

  it("should apply defaults", () => {
    const configContent = `
agent:
  name: TestBot
  model: test/model
telegram:
  token: test-token
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models: []
tools:
  web_search:
    api_key: ""
  fetch_url: {}
  files: {}
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();

    expect(config.tools.web_search.enabled).toBe(true);
    expect(config.tools.fetch_url.enabled).toBe(true);
    expect(config.tools.files.enabled).toBe(true);
  });

  it("should create data directories", () => {
    const configContent = `
agent:
  name: TestBot
  model: test/model
telegram:
  token: test-token
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models: []
tools:
  web_search:
    enabled: false
    api_key: ""
  fetch_url:
    enabled: false
  files:
    enabled: false
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();
    ensureDataDirs(config);

    expect(fs.existsSync(path.join(tempDir, "history"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "files"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "usage"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "logs"))).toBe(true);
  });

  it("should substitute env vars", () => {
    process.env.TEST_API_KEY = "my-secret-key";

    const configContent = `
agent:
  name: TestBot
  model: test/model
telegram:
  token: test-token
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: \${TEST_API_KEY}
      models: []
tools:
  web_search:
    enabled: false
    api_key: ""
  fetch_url:
    enabled: false
  files:
    enabled: false
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();

    expect(config.models.providers[0].api_key).toBe("my-secret-key");
  });

  it("should reject missing required fields", () => {
    const configContent = `
agent:
  name: TestBot
telegram:
  token: test-token
models:
  providers: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    expect(() => loadConfig()).toThrow("agent.model is required");
  });

  it("should parse model costs from config values", () => {
    process.env.COST_INPUT = "1.25";
    process.env.COST_OUTPUT = "5.5";

    const configContent = `
agent:
  name: TestBot
  model: test/test-model
telegram:
  token: test-token
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models:
        - id: test-model
          cost:
            input: \${COST_INPUT}
            output: \${COST_OUTPUT}
tools:
  web_search:
    enabled: false
    api_key: ""
  fetch_url:
    enabled: false
  files:
    enabled: false
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();
    expect(config.models.providers[0].models[0].cost).toEqual({
      input: 1.25,
      output: 5.5,
    });

    delete process.env.COST_INPUT;
    delete process.env.COST_OUTPUT;
  });
});
