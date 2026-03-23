/**
 * DevOps monitoring agent template.
 *
 * Focused read-only monitoring agent. Operational tone, no self-modification,
 * no workers, no file writes. Learns patterns via archival memory and
 * reflection. Suitable for watching Loki logs, Kubernetes state, and databases.
 */

import type { AgentTemplate } from "./personal-assistant.js";

const agentYml = `# DevOps monitor agent definition
# Focused read-only monitoring agent.

name: "DevOps Monitor"

# Model to use. A cheaper model is fine for routine monitoring.
model: anthropic/claude-sonnet-4-6
fallback_models: []
timezone: "Europe/Amsterdam"

# Replace with your monitoring bot token and your Telegram user ID
channel:
  telegram:
    token: "\${DEVOPS_BOT_TOKEN}"
    allowed_users: []

# Persona injected at the top of every system prompt
persona: |
  You are a DevOps monitoring agent.
  Watch the configured observability sources, identify anomalies, and alert
  the operator when something needs attention.
  Be terse. No pleasantries. Facts and context only.

  Guidelines:
  - Alert only when something actually looks wrong or unusual
  - Include relevant context (pod name, error count, time range) in alerts
  - For scheduled checks: respond NOOP if everything looks normal
  - Store observed patterns in archival memory for trend detection

# Tool groups: read-only monitoring tools only.
# Domain-specific tools (loki_query, kubectl_get, db_query) come from extensions.
tools:
  groups:
    - memory_core
    - memory_archival
    - projections
    - system_log
    # Note: no workers, no files, no extensions_management, no pi_sessions
    # Add these back if your use case needs them.

# Extensions providing domain-specific monitoring tools.
# Write these as TypeScript files in files/extensions/ after init.
extensions: []
# Example:
#   - ./files/extensions/loki-monitor.ts
#   - ./files/extensions/kubectl-ro.ts
#   - ./files/extensions/db-readonly.ts

# Prompt sections: operational, stripped down
prompt:
  tone: operational
  sections:
    - datetime
    - tools
    - core_memory
    - projections
    - silent_reply
  # Omitted: communication_style, image_handling, extensions, skills,
  #           workers, first_conversation

# Memory background jobs
memory:
  reflection: true      # Learn error patterns from conversation history
  daily_review: false   # No morning briefing for a 24/7 monitor
  compaction: operational

# Guardrails: all tools are read-only so no guardrail needed
guardrails:
  enabled: false

# Scheduled checks — adjust schedules and messages for your project
cron:
  - schedule: "*/15 * * * *"
    message: >-
      Routine check: query your monitoring tools for errors or anomalies in the
      last 15 minutes. Alert if anything looks concerning. NOOP if all is well.
  - schedule: "0 8 * * *"
    message: >-
      Morning summary: check all services for overnight issues, recent error
      trends, and resource usage. Report any findings worth noting.

# No active-hours restriction — this agent monitors 24/7
active_hours: ~
`;

const coreMemory = `# Core Memory

*This file is always visible to the agent. Keep it under 4KB.*

## Project

*(Describe the project being monitored: services, infrastructure, key contacts.)*

## Known patterns

*(The agent will fill this in as it observes recurring events.)*

## Alert thresholds

*(Optional: document expected error rates, SLOs, or escalation rules.)*
`;

export const DEVOPS_MONITOR_TEMPLATE: AgentTemplate = {
  id: "devops-monitor",
  name: "DevOps Monitor",
  description: "Read-only 24/7 monitoring agent. Watches Loki, Kubernetes, and databases. Operational tone.",
  agentYml,
  coreMemory,
};
