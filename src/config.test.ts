import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ensureDataDirs, applyIntegrationEnvVars } from "../src/config.js";

describe("Config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/bryti-test-");
    process.env.BRYTI_DATA_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.BRYTI_DATA_DIR;
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
    searxng_url: "https://search.xithing.eu"
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
    searxng_url: "https://search.xithing.eu"
  fetch_url: {}
  files: {}
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();

    expect(config.tools.web_search.enabled).toBe(true);
    expect(config.tools.fetch_url.timeout_ms).toBe(10000);
    expect(config.tools.files.base_dir).toContain("files");
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
    searxng_url: "https://search.xithing.eu"
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
    expect(fs.existsSync(path.join(tempDir, "files", "extensions"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "usage"))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "logs"))).toBe(true);

    // Pi settings should include the extensions directory
    const settingsPath = path.join(tempDir, ".pi", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const extDir = path.resolve(tempDir, "files", "extensions");
    expect(settings.extensions).toContain(extDir);
  });

  it("ensureDataDirs should not duplicate extension path on re-run", () => {
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
    searxng_url: "https://search.xithing.eu"
  fetch_url:
    enabled: false
  files:
    enabled: false
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();
    ensureDataDirs(config);
    ensureDataDirs(config);

    const settingsPath = path.join(tempDir, ".pi", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const extDir = path.resolve(tempDir, "files", "extensions");
    const count = settings.extensions.filter((p: string) => p === extDir).length;
    expect(count).toBe(1);
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
    searxng_url: "https://search.xithing.eu"
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

  it("should not treat template expressions as env vars", () => {
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
    searxng_url: "https://search.xithing.eu"
  fetch_url:
    enabled: false
  files:
    enabled: false
cron:
  - schedule: "0 8 * * *"
    message: "Weather URL: https://wttr.in/\${encodeURIComponent(city)}?format=j1"
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();
    expect(config.cron[0].message).toContain("${encodeURIComponent(city)}");
  });

  it("should not treat lowercase template placeholders as env vars", () => {
    const configContent = `
agent:
  name: TestBot
  model: test/model
  system_prompt: |
    Example:
    \`\`\`ts
    const s = "\${city}: \${tempC}C";
    \`\`\`
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
    searxng_url: "https://search.xithing.eu"
  fetch_url:
    enabled: false
  files:
    enabled: false
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();
    expect(config.agent.system_prompt).toContain("${city}");
    expect(config.agent.system_prompt).toContain("${tempC}");
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
    searxng_url: "https://search.xithing.eu"
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

describe("applyIntegrationEnvVars", () => {
  const minimalConfig = (integrations: string) => `
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
${integrations}
`;

  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/bryti-integrations-test-");
    process.env.BRYTI_DATA_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.BRYTI_DATA_DIR;
    delete process.env.HEDGEDOC_URL;
    delete process.env.HEDGEDOC_PUBLIC_URL;
    delete process.env.MY_SERVICE_URL;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("injects integration values as uppercased env vars", () => {
    fs.writeFileSync(path.join(tempDir, "config.yml"), minimalConfig(`
integrations:
  hedgedoc:
    url: "http://hedgedoc:3000"
    public_url: "https://docs.example.com"
`));
    const config = loadConfig();
    applyIntegrationEnvVars(config);

    expect(process.env.HEDGEDOC_URL).toBe("http://hedgedoc:3000");
    expect(process.env.HEDGEDOC_PUBLIC_URL).toBe("https://docs.example.com");
  });

  it("does not overwrite existing env vars", () => {
    process.env.HEDGEDOC_URL = "http://already-set:3000";
    fs.writeFileSync(path.join(tempDir, "config.yml"), minimalConfig(`
integrations:
  hedgedoc:
    url: "http://hedgedoc:3000"
`));
    const config = loadConfig();
    applyIntegrationEnvVars(config);

    expect(process.env.HEDGEDOC_URL).toBe("http://already-set:3000");
  });

  it("converts snake_case keys to uppercased env vars", () => {
    fs.writeFileSync(path.join(tempDir, "config.yml"), minimalConfig(`
integrations:
  my_service:
    url: "https://api.example.com"
`));
    const config = loadConfig();
    applyIntegrationEnvVars(config);

    expect(process.env.MY_SERVICE_URL).toBe("https://api.example.com");
  });

  it("ignores integrations section when absent", () => {
    fs.writeFileSync(path.join(tempDir, "config.yml"), minimalConfig(""));
    const config = loadConfig();
    expect(() => applyIntegrationEnvVars(config)).not.toThrow();
  });

  it("parses integrations into config.integrations", () => {
    fs.writeFileSync(path.join(tempDir, "config.yml"), minimalConfig(`
integrations:
  hedgedoc:
    url: "http://hedgedoc:3000"
    public_url: "https://docs.example.com"
`));
    const config = loadConfig();

    expect(config.integrations.hedgedoc).toEqual({
      url: "http://hedgedoc:3000",
      public_url: "https://docs.example.com",
    });
  });
});
