import type { IncomingMessage } from "../channels/types.js";
import type { Projection, ProjectionStore } from "./store.js";

export const OBSOLETE_PROJECTION_WORK = "Reminder cancelled or rescheduled before execution; no actions performed";

/** Keep occurrence identities compatible with already accepted work. */
export function scheduledWorkId(ownerUserId: string, projection: Projection): string {
  const scheduledWhen = projection.resolved_when ?? "unscheduled";
  return `projection:${ownerUserId}:${projection.id}:${scheduledWhen}`;
}

/** Validate the live reminder before replaying its accepted input. */
export function isCurrentProjectionWork(msg: IncomingMessage, store: ProjectionStore): boolean {
  const prefix = `projection:${msg.userId}:`;
  if (!msg.workId?.startsWith(prefix)) {
    return false;
  }
  const remainder = msg.workId.slice(prefix.length);
  const separator = remainder.indexOf(":");
  if (separator < 0) {
    return false;
  }
  const projection = store.getById(remainder.slice(0, separator));
  return projection !== null && projection.status === "pending"
    && scheduledWorkId(msg.userId, projection) === msg.workId;
}
