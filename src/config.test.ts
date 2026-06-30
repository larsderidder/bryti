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
    expect(config.tools.fetch_url.backend).toBe("readability");
    expect(config.tools.fetch_url.require_https).toBe(true);
    expect(config.agent.thinking_level).toBe("high");
    expect(config.tools.workers.thinking_level).toBe("medium");
    expect(config.web_e2ee).toEqual({
      enabled: false,
      listen_host: "127.0.0.1",
      listen_port: 8787,
      public_origin: "https://bryti.tailnet.ts.net",
      allowed_origins: ["https://bryti.tailnet.ts.net"],
      path_prefix: "/",
      pairing: {
        invite_ttl_minutes: 10,
      },
    });
  });

  it("should load configured fetch_url backend", () => {
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
  fetch_url:
    backend: argus
    argus_bin: /usr/local/bin/argus
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();

    expect(config.tools.fetch_url.backend).toBe("argus");
    expect(config.tools.fetch_url.argus_bin).toBe("/usr/local/bin/argus");
  });

  it("should load configured thinking levels", () => {
    const configContent = `
agent:
  name: TestBot
  model: test/model
  thinking_level: high
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
  workers:
    max_concurrent: 2
    thinking_level: low
    types:
      research:
        thinking_level: minimal
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();

    expect(config.agent.thinking_level).toBe("high");
    expect(config.tools.workers.thinking_level).toBe("low");
    expect(config.tools.workers.types?.research.thinking_level).toBe("minimal");
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

  it("should derive web_e2ee.allowed_origins from public_origin when omitted", () => {
    const configContent = `
agent:
  name: TestBot
  model: test/model
web_e2ee:
  enabled: true
  public_origin: https://dragon.example.ts.net
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models: []
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();
    expect(config.web_e2ee.public_origin).toBe("https://dragon.example.ts.net");
    expect(config.web_e2ee.allowed_origins).toEqual(["https://dragon.example.ts.net"]);
  });

  it("should parse explicit web_e2ee config", () => {
    const configContent = `
agent:
  name: TestBot
  model: test/model
web_e2ee:
  enabled: true
  listen_host: 0.0.0.0
  listen_port: 9999
  public_origin: https://chat.example.test
  allowed_origins:
    - https://chat.example.test
    - https://alt.example.test
  path_prefix: /chat
  pairing:
    invite_ttl_minutes: 42
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models: []
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();

    expect(config.web_e2ee).toEqual({
      enabled: true,
      listen_host: "0.0.0.0",
      listen_port: 9999,
      public_origin: "https://chat.example.test",
      allowed_origins: ["https://chat.example.test", "https://alt.example.test"],
      path_prefix: "/chat",
      pairing: {
        invite_ttl_minutes: 42,
      },
    });
  });

  it("should allow web_e2ee as the only enabled channel", () => {
    const configContent = `
agent:
  name: TestBot
  model: test/model
web_e2ee:
  enabled: true
  public_origin: https://chat.example.test
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models: []
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();
    expect(config.web_e2ee.enabled).toBe(true);
    expect(config.telegram.token).toBe("");
    expect(config.whatsapp.enabled).toBe(false);
  });

  it("should reject invalid web_e2ee.listen_port", () => {
    const configContent = `
agent:
  name: TestBot
  model: test/model
web_e2ee:
  enabled: true
  listen_port: 0
  public_origin: https://chat.example.test
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models: []
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    expect(() => loadConfig()).toThrow("web_e2ee.listen_port must be greater than 0");
  });

  it("should reject invalid web_e2ee.path_prefix", () => {
    const configContent = `
agent:
  name: TestBot
  model: test/model
web_e2ee:
  enabled: true
  path_prefix: chat
  public_origin: https://chat.example.test
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models: []
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    expect(() => loadConfig()).toThrow("web_e2ee.path_prefix must start with '/'");
  });

  it("should reject invalid web_e2ee.allowed_origins", () => {
    const configContent = `
agent:
  name: TestBot
  model: test/model
web_e2ee:
  enabled: true
  public_origin: https://chat.example.test
  allowed_origins: https://chat.example.test
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models: []
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    expect(() => loadConfig()).toThrow("web_e2ee.allowed_origins must be a string array");
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

  it("defaults voice support to disabled", () => {
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
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();

    expect(config.voice).toEqual({
      enabled: false,
      transcribe_command: [],
      synthesize_command: [],
      reply_with_voice: true,
      keep_temp_files: false,
      command_timeout_ms: 120000,
      synthesized_audio_extension: ".ogg",
      max_tts_chars: 2500,
    });
  });

  it("loads enabled voice command config", () => {
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
voice:
  enabled: true
  transcribe_command: ["stt", "{input}", "--out", "{output}"]
  synthesize_command: ["tts", "{input}", "--out", "{output}"]
  reply_with_voice: true
  keep_temp_files: true
  command_timeout_ms: 30000
  synthesized_audio_extension: ".opus"
  max_tts_chars: 1000
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();

    expect(config.voice).toEqual({
      enabled: true,
      transcribe_command: ["stt", "{input}", "--out", "{output}"],
      synthesize_command: ["tts", "{input}", "--out", "{output}"],
      reply_with_voice: true,
      keep_temp_files: true,
      command_timeout_ms: 30000,
      synthesized_audio_extension: ".opus",
      max_tts_chars: 1000,
    });
  });

  it("rejects enabled voice config without transcribe placeholders", () => {
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
voice:
  enabled: true
  transcribe_command: ["stt", "audio.wav"]
  synthesize_command: ["tts", "{input}", "{output}"]
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    expect(() => loadConfig()).toThrow("voice.transcribe_command must include {input}");
    expect(() => loadConfig()).toThrow("voice.transcribe_command must include {output}");
  });

  it("requires synthesize command only when voice replies are enabled", () => {
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
voice:
  enabled: true
  reply_with_voice: false
  transcribe_command: ["stt", "{input}", "{output}"]
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    const config = loadConfig();
    expect(config.voice?.enabled).toBe(true);
    expect(config.voice?.reply_with_voice).toBe(false);
  });

  it("rejects missing synthesize command when voice replies are enabled", () => {
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
voice:
  enabled: true
  reply_with_voice: true
  transcribe_command: ["stt", "{input}", "{output}"]
cron: []
`;
    fs.writeFileSync(path.join(tempDir, "config.yml"), configContent);

    expect(() => loadConfig()).toThrow("voice.synthesize_command is required when voice is enabled");
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
    // Clear env vars that may leak from the real environment
    delete process.env.HEDGEDOC_URL;
    delete process.env.HEDGEDOC_PUBLIC_URL;
    delete process.env.MY_SERVICE_URL;
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

describe("AgentDefinition parsing", () => {
  let tempDir: string;

  const baseConfig = `
agent:
  name: TestBot
  system_prompt: "You are a test bot"
  model: "test/test-model"
telegram:
  token: "test-token"
  allowed_users: [1]
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models:
        - id: test-model
`;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/bryti-agentdef-test-");
    process.env.BRYTI_DATA_DIR = tempDir;
    fs.writeFileSync(path.join(tempDir, "config.yml"), baseConfig);
  });

  afterEach(() => {
    delete process.env.BRYTI_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("defaults to empty extension_files and skill_files when agent.yml absent", () => {
    const config = loadConfig();
    expect(config.agent_def.extension_files).toEqual([]);
    expect(config.agent_def.skill_files).toEqual([]);
  });

  it("parses extension_files and skill_files from agent.yml", () => {
    fs.writeFileSync(path.join(tempDir, "agent.yml"), `
extension_files:
  - ~/.pi/agent/extensions/hedgedoc.ts
  - ~/.pi/agent/extensions/loki.ts
skill_files:
  - ~/.pi/agent/skills/scribe/SKILL.md
  - ~/.pi/agent/skills/mkt-copywriting/SKILL.md
`);
    const config = loadConfig();
    expect(config.agent_def.extension_files).toEqual([
      "~/.pi/agent/extensions/hedgedoc.ts",
      "~/.pi/agent/extensions/loki.ts",
    ]);
    expect(config.agent_def.skill_files).toEqual([
      "~/.pi/agent/skills/scribe/SKILL.md",
      "~/.pi/agent/skills/mkt-copywriting/SKILL.md",
    ]);
  });

  it("treats absent extension_files / skill_files keys as empty arrays", () => {
    fs.writeFileSync(path.join(tempDir, "agent.yml"), `name: "Bryti"\n`);
    const config = loadConfig();
    expect(config.agent_def.extension_files).toEqual([]);
    expect(config.agent_def.skill_files).toEqual([]);
  });

  it("extension_files and skill_files are independent", () => {
    fs.writeFileSync(path.join(tempDir, "agent.yml"), `
skill_files:
  - ~/.pi/agent/skills/scribe/SKILL.md
`);
    const config = loadConfig();
    expect(config.agent_def.extension_files).toEqual([]);
    expect(config.agent_def.skill_files).toHaveLength(1);
  });
});
