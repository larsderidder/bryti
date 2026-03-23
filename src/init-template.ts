/**
 * `bryti init --template <name> --data-dir <path>`
 *
 * Scaffolds a new agent data directory from a built-in template. Non-interactive:
 * all prompts are skipped, producing a working directory the user edits afterward.
 *
 * What gets written:
 * - agent.yml          Agent definition (persona, tools, prompt, memory, cron)
 * - core-memory.md     Bootstrap memory content from the template
 * - files/extensions/  Empty directory with a README pointing at EXTENSIONS.md
 *
 * What is NOT written (user must supply separately):
 * - config.yml / infrastructure.yml  (provider keys, model registry)
 * - .env                             (secrets)
 *
 * The user copies their existing infrastructure config or runs `bryti hail`
 * separately to get those. The separation is intentional: agent.yml is
 * portable and can be committed to version control; config.yml contains secrets.
 */

import fs from "node:fs";
import path from "node:path";
import { TEMPLATES } from "./templates/index.js";
import type { AgentTemplate } from "./templates/index.js";

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/**
 * Write the scaffold for a new agent data directory.
 *
 * @param template  The template to use.
 * @param dataDir   Target data directory (created if it doesn't exist).
 * @param force     Overwrite existing agent.yml if true. Default: false.
 */
export function scaffoldAgent(
  template: AgentTemplate,
  dataDir: string,
  force = false,
): { agentYmlPath: string; coreMemoryPath: string; skipped: string[] } {
  const skipped: string[] = [];

  // Create directory structure
  const dirs = [
    dataDir,
    path.join(dataDir, "files"),
    path.join(dataDir, "files", "extensions"),
    path.join(dataDir, "users"),
    path.join(dataDir, "history"),
    path.join(dataDir, "logs"),
    path.join(dataDir, "skills"),
    path.join(dataDir, "pending"),
    path.join(dataDir, ".pi"),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // agent.yml
  const agentYmlPath = path.join(dataDir, "agent.yml");
  if (fs.existsSync(agentYmlPath) && !force) {
    skipped.push("agent.yml (already exists, use --force to overwrite)");
  } else {
    fs.writeFileSync(agentYmlPath, template.agentYml, "utf-8");
  }

  // core-memory.md
  const coreMemoryPath = path.join(dataDir, "core-memory.md");
  if (fs.existsSync(coreMemoryPath) && !force) {
    skipped.push("core-memory.md (already exists, use --force to overwrite)");
  } else if (template.coreMemory) {
    fs.writeFileSync(coreMemoryPath, template.coreMemory, "utf-8");
  }

  // extensions/README.md — points at the extension guide
  const extReadmePath = path.join(dataDir, "files", "extensions", "README.md");
  if (!fs.existsSync(extReadmePath)) {
    fs.writeFileSync(
      extReadmePath,
      `# Extensions\n\nPlace TypeScript extension files here.\nEach file exports a default function that calls \`pi.registerTool()\`.\n\nSee \`bryti hail\` or the EXTENSIONS.md guide for the template.\n`,
      "utf-8",
    );
  }

  return { agentYmlPath, coreMemoryPath, skipped };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Run `bryti init --template <name> --data-dir <path>`.
 *
 * Prints a summary of what was written and what steps remain.
 */
export async function runInitTemplate(opts: {
  templateId: string;
  dataDir: string;
  force?: boolean;
}): Promise<void> {
  const { templateId, dataDir, force = false } = opts;

  // Validate template
  const template = TEMPLATES[templateId];
  if (!template) {
    const available = Object.keys(TEMPLATES).join(", ");
    console.error(`Unknown template: "${templateId}"`);
    console.error(`Available templates: ${available}`);
    process.exit(1);
  }

  const absDir = path.resolve(dataDir);

  console.log("");
  console.log(`  Scaffolding "${template.name}" agent`);
  console.log(`  Template:   ${template.id}`);
  console.log(`  Directory:  ${absDir}`);
  console.log(`  ${template.description}`);
  console.log("");

  const { agentYmlPath, coreMemoryPath, skipped } = scaffoldAgent(template, absDir, force);

  // Report what was written
  if (!skipped.includes("agent.yml (already exists, use --force to overwrite)")) {
    console.log(`  ✓ ${agentYmlPath}`);
  }
  if (
    template.coreMemory &&
    !skipped.includes("core-memory.md (already exists, use --force to overwrite)")
  ) {
    console.log(`  ✓ ${coreMemoryPath}`);
  }
  console.log(`  ✓ ${path.join(absDir, "files", "extensions")}/ (extensions directory)`);

  if (skipped.length > 0) {
    console.log("");
    console.log("  Skipped (already exist):");
    for (const s of skipped) {
      console.log(`    - ${s}`);
    }
  }

  // Next steps
  console.log("");
  console.log("  Next steps:");
  console.log("");
  console.log(`  1. Edit ${agentYmlPath}`);
  console.log("     - Set your agent name and persona");
  console.log("     - Set channel.telegram.token and allowed_users");
  console.log("     - Adjust cron schedules if needed");
  console.log("");
  console.log("  2. Add a config.yml (provider credentials + model registry)");
  console.log("     Copy from an existing Bryti data dir, or run:");
  console.log(`     bryti hail ${absDir}`);
  console.log("");

  if (templateId === "devops-monitor") {
    console.log("  3. Write monitoring extensions in files/extensions/");
    console.log("     e.g. loki-monitor.ts, kubectl-ro.ts, db-readonly.ts");
    console.log("     Then add them to the 'extensions:' list in agent.yml");
    console.log("");
  }

  console.log("  4. Start the agent:");
  console.log(`     BRYTI_DATA_DIR=${absDir} bryti`);
  console.log("     or:");
  console.log(`     PIBOT_AGENT=${agentYmlPath} bryti`);
  console.log("");
}

// ---------------------------------------------------------------------------
// List templates
// ---------------------------------------------------------------------------

export function listTemplates(): void {
  console.log("");
  console.log("  Available templates:");
  console.log("");
  for (const [id, t] of Object.entries(TEMPLATES)) {
    console.log(`  ${id.padEnd(22)} ${t.description}`);
  }
  console.log("");
}
