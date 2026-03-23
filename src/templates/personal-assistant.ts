/**
 * Personal-assistant agent template.
 *
 * Full-featured: all tool groups, all prompt sections, conversational tone,
 * memory reflection and daily review enabled. Equivalent to current Bryti
 * defaults before the agent definition split was introduced.
 */

export interface AgentTemplate {
  /** Short identifier, used as the --template argument. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** One-line description. */
  description: string;
  /** Content written to agent.yml in the new data directory. */
  agentYml: string;
  /** Content written to core-memory.md as a bootstrap (optional). */
  coreMemory?: string;
}

const agentYml = `# Personal assistant agent definition
# Adjust the persona, model, and channel to suit your needs.

name: "Bryti"

# Model to use. Format: provider/model-id
model: anthropic/claude-sonnet-4-6
fallback_models:
  - opencode/kimi-k2.5-free
timezone: "Europe/Amsterdam"

# Replace with your actual Telegram bot token env var and user ID
channel:
  telegram:
    token: "\${TELEGRAM_BOT_TOKEN}"
    allowed_users: []

# Persona injected at the top of every system prompt
persona: |
  You are Bryti, a personal AI colleague. You help your user stay on top of
  their work, remember what matters, and handle things in the background.
  You are warm, direct, and proactive. You speak like a trusted colleague,
  not a customer service bot.

  ## Your memory
  Your core memory (shown below) persists across conversations. Update it when
  you learn something worth keeping: user preferences, facts, ongoing projects,
  recurring topics. Do this proactively without telling the user unless asked.

  Archival memory is for details that don't need to be always visible but should
  be searchable later.

  ## Projection memory
  Projections are your forward-looking memory. Store anything about the future:
  appointments, deadlines, plans, reminders, commitments.

  ## What you cannot do
  - You cannot modify your own source code or core configuration
  - You cannot access the internet directly. Use worker_dispatch for any web research.

# Tool groups to register. All groups on for a personal assistant.
tools:
  groups:
    - memory_core
    - memory_archival
    - memory_conversation
    - projections
    - workers
    - files
    - extensions_management
    - pi_sessions
    - system_log

# Prompt sections to include and tone
prompt:
  tone: conversational
  sections:
    - datetime
    - communication_style
    - image_handling
    - tools
    - extensions
    - skills
    - core_memory
    - projections
    - workers
    - first_conversation
    - silent_reply

# Memory background jobs
memory:
  reflection: true
  daily_review: true
  compaction: conversational

# Guardrails (LLM-based tool call approval)
guardrails:
  enabled: true
  default_policy: ask
  approved_tools: []

# Cron jobs (optional — add scheduled prompts here)
cron: []
`;

const coreMemory = `# Core Memory

*This file is always visible to the agent. Keep it under 4KB.*

## About me

*(The agent will fill this in as it learns about you.)*
`;

export const PERSONAL_ASSISTANT_TEMPLATE: AgentTemplate = {
  id: "personal-assistant",
  name: "Personal Assistant",
  description: "Full-featured personal AI colleague with memory, projections, workers, and conversational tone.",
  agentYml,
  coreMemory,
};
