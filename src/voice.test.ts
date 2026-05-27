// src/voice.test.ts 
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandVoiceService, createVoiceService, VoiceCommandError } from "./voice.js";
import type { Config, VoiceConfig } from "./config.js";

function baseVoiceConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    enabled: true,
    transcribe_command: [],
    synthesize_command: [],
    reply_with_voice: true,
    keep_temp_files: false,
    command_timeout_ms: 1000,
    synthesized_audio_extension: ".ogg",
    max_tts_chars: 2500,
    ...overrides,
  };
}

function helperScript(dir: string): string {
  const scriptPath = path.join(dir, "voice-helper.cjs");
  fs.writeFileSync(scriptPath, `
const fs = require("fs");
const mode = process.argv[2];
const input = process.argv[3];
const output = process.argv[4];
if (mode === "transcribe") {
  fs.writeFileSync(output, fs.readFileSync(input, "utf8").toUpperCase(), "utf8");
} else if (mode === "synthesize") {
  fs.writeFileSync(output, "AUDIO:" + fs.readFileSync(input, "utf8"), "utf8");
} else if (mode === "empty") {
  fs.writeFileSync(output, "", "utf8");
} else if (mode === "fail") {
  console.error("intentional failure");
  process.exit(7);
} else if (mode === "sleep") {
  setTimeout(() => fs.writeFileSync(output, "late", "utf8"), 5000);
} else if (mode === "args") {
  fs.writeFileSync(output, JSON.stringify(process.argv.slice(3)), "utf8");
} else {
  console.error("unknown mode");
  process.exit(2);
}
`, "utf-8");
  return scriptPath;
}

describe("CommandVoiceService", () => {
  let tempDir: string;
  let helper: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-voice-test-"));
    helper = helperScript(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("transcribes by substituting input and output placeholders", async () => {
    const audioPath = path.join(tempDir, "input with spaces.ogg");
    fs.writeFileSync(audioPath, "hello bryti", "utf-8");
    const service = new CommandVoiceService(tempDir, baseVoiceConfig({
      transcribe_command: [process.execPath, helper, "transcribe", "{input}", "{output}"],
    }));

    await expect(service.transcribe([{ path: audioPath, mimeType: "audio/ogg" }]))
      .resolves.toBe("HELLO BRYTI");
  });

  it("synthesizes text to an output audio path", async () => {
    const service = new CommandVoiceService(tempDir, baseVoiceConfig({
      synthesize_command: [process.execPath, helper, "synthesize", "{input}", "{output}"],
      synthesized_audio_extension: ".voice",
    }));

    const outputPath = await service.synthesize("hello");

    expect(outputPath.endsWith(".voice")).toBe(true);
    expect(fs.readFileSync(outputPath, "utf-8")).toBe("AUDIO:hello");
  });

  it("clips synthesized text when max_tts_chars is set", async () => {
    const service = new CommandVoiceService(tempDir, baseVoiceConfig({
      synthesize_command: [process.execPath, helper, "synthesize", "{input}", "{output}"],
      max_tts_chars: 5,
    }));

    const outputPath = await service.synthesize("hello world");

    expect(fs.readFileSync(outputPath, "utf-8")).toBe("AUDIO:hello…");
  });

  it("fails cleanly on empty transcription output", async () => {
    const audioPath = path.join(tempDir, "input.ogg");
    fs.writeFileSync(audioPath, "hello", "utf-8");
    const service = new CommandVoiceService(tempDir, baseVoiceConfig({
      transcribe_command: [process.execPath, helper, "empty", "{input}", "{output}"],
    }));

    await expect(service.transcribe([{ path: audioPath, mimeType: "audio/ogg" }]))
      .rejects.toThrow("Voice transcription output was empty");
  });

  it("fails cleanly on nonzero command exit", async () => {
    const audioPath = path.join(tempDir, "input.ogg");
    fs.writeFileSync(audioPath, "hello", "utf-8");
    const service = new CommandVoiceService(tempDir, baseVoiceConfig({
      transcribe_command: [process.execPath, helper, "fail", "{input}", "{output}"],
    }));

    await expect(service.transcribe([{ path: audioPath, mimeType: "audio/ogg" }]))
      .rejects.toThrow(/intentional failure/);
  });

  it("times out long-running commands", async () => {
    const audioPath = path.join(tempDir, "input.ogg");
    fs.writeFileSync(audioPath, "hello", "utf-8");
    const service = new CommandVoiceService(tempDir, baseVoiceConfig({
      transcribe_command: [process.execPath, helper, "sleep", "{input}", "{output}"],
      command_timeout_ms: 50,
    }));

    await expect(service.transcribe([{ path: audioPath, mimeType: "audio/ogg" }]))
      .rejects.toThrow(/timed out/);
  });

  it("passes placeholder values as argv without shell interpolation", async () => {
    const audioPath = path.join(tempDir, "input;echo hacked.ogg");
    fs.writeFileSync(audioPath, "hello", "utf-8");
    const service = new CommandVoiceService(tempDir, baseVoiceConfig({
      transcribe_command: [process.execPath, helper, "args", "{input}", "{output}"],
    }));

    const transcript = await service.transcribe([{ path: audioPath, mimeType: "audio/ogg" }]);
    const argv = JSON.parse(transcript) as string[];

    expect(argv[0]).toBe(audioPath);
    expect(argv[0]).toContain(";echo hacked");
  });

  it("returns null when voice config is disabled", () => {
    const config = {
      data_dir: tempDir,
      voice: { ...baseVoiceConfig(), enabled: false },
    } as Config;

    expect(createVoiceService(config)).toBeNull();
  });
});

it("uses a specific error class for predictable voice failures", () => {
  expect(new VoiceCommandError("x").name).toBe("VoiceCommandError");
});
