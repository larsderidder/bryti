/**
 * Test: can two pi SDK createAgentSession() instances run concurrently?
 *
 * Spawns two sessions and prompts them simultaneously.
 * If both complete without error, concurrent sessions are supported.
 *
 * Usage: npx tsx scripts/test-concurrent-sessions.ts
 */

import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";

async function runSession(label: string, prompt: string): Promise<{ label: string; ok: boolean; error?: string; output?: string }> {
  try {
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      tools: [],
      systemPrompt: `You are a test assistant. Respond briefly.`,
    });

    let output = "";
    session.subscribe((event) => {
      if (event.type === "assistant_message" && event.content?.type === "text") {
        output += event.content.text;
      }
    });

    console.log(`[${label}] Prompting...`);
    const start = Date.now();
    await session.prompt(prompt);
    const elapsed = Date.now() - start;
    console.log(`[${label}] Done in ${elapsed}ms`);

    session.dispose();
    return { label, ok: true, output: output.slice(0, 100) };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[${label}] Failed: ${msg}`);
    return { label, ok: false, error: msg };
  }
}

async function main() {
  console.log("Testing concurrent pi SDK sessions...\n");

  const [a, b] = await Promise.all([
    runSession("Session A", "What is 2 + 2? Reply with just the number."),
    runSession("Session B", "What is 3 + 3? Reply with just the number."),
  ]);

  console.log("\nResults:");
  console.log(`  A: ${a.ok ? "OK" : "FAIL"} ${a.ok ? a.output : a.error}`);
  console.log(`  B: ${b.ok ? "OK" : "FAIL"} ${b.ok ? b.output : b.error}`);

  if (a.ok && b.ok) {
    console.log("\n✅ Concurrent sessions work!");
  } else {
    console.log("\n❌ Concurrent sessions failed. Need subprocess approach.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
