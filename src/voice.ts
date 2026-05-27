// src/voice.ts 
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config, VoiceConfig } from "./config.js";
import type { AudioAttachment } from "./channels/types.js";

export interface VoiceService {
  transcribe(audio: AudioAttachment[]): Promise<string>;
  synthesize(text: string): Promise<string>;
}

export class VoiceCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceCommandError";
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function ensureVoiceTempDir(dataDir: string): string {
  const dir = path.join(dataDir, "files", "voice");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTempPath(dataDir: string, suffix: string): string {
  const dir = ensureVoiceTempDir(dataDir);
  const safeSuffix = suffix.startsWith(".") ? suffix : `.${suffix}`;
  return path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}${safeSuffix}`);
}

function substitutePlaceholders(command: string[], inputPath: string, outputPath: string): string[] {
  return command.map((part) => part
    .replaceAll("{input}", inputPath)
    .replaceAll("{output}", outputPath));
}

async function runCommand(command: string[], timeoutMs: number): Promise<CommandResult> {
  if (command.length === 0) {
    throw new VoiceCommandError("Voice command is empty");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // If process doesn't exit within 1 second after SIGTERM, force kill with SIGKILL
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 1000);
      finish(() => reject(new VoiceCommandError(`Voice command timed out after ${timeoutMs}ms: ${command[0]}`)));
    }, timeoutMs);

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (err) => {
      finish(() => reject(new VoiceCommandError(`Voice command failed to start: ${err.message}`)));
    });

    child.on("close", (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = stderr.trim() || stdout.trim() || (signal ? `signal ${signal}` : `exit code ${code}`);
        reject(new VoiceCommandError(`Voice command failed (${command[0]}): ${detail}`));
      });
    });
  });
}

export class CommandVoiceService implements VoiceService {
  constructor(
    private readonly dataDir: string,
    private readonly config: VoiceConfig,
  ) {}

  async transcribe(audio: AudioAttachment[]): Promise<string> {
    const first = audio[0];
    if (!first) {
      throw new VoiceCommandError("No audio attachment to transcribe");
    }

    const outputPath = makeTempPath(this.dataDir, ".txt");
    const command = substitutePlaceholders(this.config.transcribe_command, first.path, outputPath);
    await runCommand(command, this.config.command_timeout_ms);

    let transcript: string;
    try {
      transcript = fs.readFileSync(outputPath, "utf-8").trim();
    } catch (err) {
      throw new VoiceCommandError(`Voice transcription output was not written: ${(err as Error).message}`);
    }

    if (!transcript) {
      throw new VoiceCommandError("Voice transcription output was empty");
    }
    return transcript;
  }

  async synthesize(text: string): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new VoiceCommandError("No text to synthesize");
    }

    const inputPath = makeTempPath(this.dataDir, ".txt");
    const outputPath = makeTempPath(this.dataDir, this.config.synthesized_audio_extension);
    const maxChars = this.config.max_tts_chars;
    const ttsText = maxChars > 0 && trimmed.length > maxChars
      ? `${trimmed.slice(0, maxChars).trimEnd()}…`
      : trimmed;
    fs.writeFileSync(inputPath, ttsText, "utf-8");

    const command = substitutePlaceholders(this.config.synthesize_command, inputPath, outputPath);
    await runCommand(command, this.config.command_timeout_ms);

    if (!fs.existsSync(outputPath)) {
      throw new VoiceCommandError("Voice synthesis output was not written");
    }
    return outputPath;
  }
}

export function createVoiceService(config: Config): VoiceService | null {
  if (!config.voice?.enabled) {
    return null;
  }
  return new CommandVoiceService(config.data_dir, config.voice);
}
