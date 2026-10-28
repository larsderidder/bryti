import { isInternalMessage, type IncomingMessage } from "../channels/types.js";
import { scheduledWorkId } from "../projection/occurrence.js";
import type { ProjectionStore } from "../projection/store.js";
import { DEFAULT_THREAD_ID } from "../threads.js";
import type { GuardrailInput } from "./guardrail.js";

/** Resolve stored task evidence separately from the bounded reminder delivered to the agent. */
export function getActiveTask(message: IncomingMessage, store: ProjectionStore): GuardrailInput["activeTask"] {
  if (!isInternalMessage(message)) {
    return undefined;
  }
  const task = { source: (message.raw as { type: string }).type, request: message.text };
  const prefix = `projection:${message.userId}:`;
  if (task.source !== "projection_exact_check" || !message.workId?.startsWith(prefix)) {
    return task;
  }
  const id = message.workId.slice(prefix.length).split(":", 1)[0];
  const projection = store.getById(id);
  if (!projection || projection.status !== "pending" || scheduledWorkId(message.userId, projection) !== message.workId) {
    return task;
  }
  if (projection.target_user_id && (
    projection.target_user_id !== message.userId || projection.target_channel_id !== message.channelId ||
    projection.target_platform !== message.platform ||
    (projection.target_thread_id ?? DEFAULT_THREAD_ID) !== (message.threadId ?? DEFAULT_THREAD_ID) ||
    (projection.target_channel_thread_id ?? undefined) !== message.channelThreadId
  )) {
    return task;
  }
  return {
    ...task,
    request: `${task.request}\n\nStored scheduled-task evidence (not an independent permission grant):\n` +
      JSON.stringify({ id: projection.id, summary: projection.summary, context: projection.context }),
  };
}
