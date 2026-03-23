/**
 * Agent template registry.
 *
 * Add new templates here to make them available via `bryti init --template <id>`.
 */

export type { AgentTemplate } from "./personal-assistant.js";
export { PERSONAL_ASSISTANT_TEMPLATE } from "./personal-assistant.js";
export { DEVOPS_MONITOR_TEMPLATE } from "./devops-monitor.js";

import { PERSONAL_ASSISTANT_TEMPLATE } from "./personal-assistant.js";
import { DEVOPS_MONITOR_TEMPLATE } from "./devops-monitor.js";
import type { AgentTemplate } from "./personal-assistant.js";

/** All built-in templates, keyed by id. */
export const TEMPLATES: Record<string, AgentTemplate> = {
  [PERSONAL_ASSISTANT_TEMPLATE.id]: PERSONAL_ASSISTANT_TEMPLATE,
  [DEVOPS_MONITOR_TEMPLATE.id]: DEVOPS_MONITOR_TEMPLATE,
};
