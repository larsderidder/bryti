/**
 * Trust subsystem: capability taxonomy, approval store, and guardrail checks.
 *
 * Re-exports from:
 * - store.ts: TrustStore, capability registry, permission checks
 * - wrapper.ts: tool wrapping with trust + guardrail checks
 * - guardrail.ts: LLM-based safety evaluation
 */

export {
  type CapabilityLevel,
  type Capability,
  type ToolCapabilities,
  type TrustStore,
  createTrustStore,
  registerToolCapabilities,
  getToolCapabilities,
  type PermissionCheckResult,
  checkPermission,
  setPendingApproval,
  checkPendingApproval,
  isAlwaysApproval,
} from "./store.js";

export {
  type ApprovalCallback,
  type TrustWrapperContext,
  wrapToolWithTrustCheck,
  wrapToolsWithTrustChecks,
} from "./wrapper.js";

export {
  type GuardrailVerdict,
  type GuardrailResult,
  type GuardrailInput,
  evaluateToolCall,
} from "./guardrail.js";
