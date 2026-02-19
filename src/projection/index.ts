/**
 * Projection: forward-looking agent memory.
 *
 * Separate from the memory layer (which is backward-looking).
 * Memory answers "what do I know?" Projection answers "what do I expect?"
 */

export { createProjectionStore } from "./store.js";
export type {
  Projection,
  ProjectionResolution,
  ProjectionStatus,
  ProjectionStore,
  ProjectionDependency,
  ProjectionDependencyInput,
  DependencyConditionType,
} from "./store.js";
export { formatProjectionsForPrompt } from "./format.js";
export { createProjectionTools } from "./tools.js";
export { runReflection } from "./reflection.js";
export type { ReflectionResult } from "./reflection.js";
