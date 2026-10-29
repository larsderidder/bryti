import { isInternalMessage, type IncomingMessage } from "../channels/types.js";
import { scheduledWorkId } from "../projection/occurrence.js";
import type { ProjectionStore } from "../projection/store.js";
import { DEFAULT_THREAD_ID } from "../threads.js";
import type { GuardrailInput } from "./guardrail.js";
import { sameCommandOwner, type CommandStore, type CommandRecord } from "../work/commands.js";
import type { WorkStore } from "../work/store.js";

interface TaskReceipts {
  work: Pick<WorkStore, "get">;
  commands: Pick<CommandStore, "get">;
}

/** Resolve stored task evidence separately from the bounded reminder delivered to the agent. */
export function getActiveTask(
  message: IncomingMessage,
  store: ProjectionStore,
  receipts?: TaskReceipts,
): GuardrailInput["activeTask"] {
  if (!isInternalMessage(message)) {
    return undefined;
  }
  const task = { source: (message.raw as { type: string }).type, request: message.text };
  let owner = message;
  let command: CommandRecord | null = null;
  if (task.source === "command_completion") {
    const match = /^command:(c-[a-f0-9]{24}):completion$/.exec(message.workId ?? "");
    if (!match || !receipts) {
      return task;
    }
    const review = receipts.work.get(message.workId!);
    command = receipts.commands.get(match[1]);
    if (!review || review.execution !== "running" || !sameCommandOwner(review.message, message)
      || (review.message.raw as { type?: string } | null)?.type !== "command_completion"
      || !command || ["queued", "running"].includes(command.status)
      || !sameCommandOwner(command.owner, message) || command.parentWorkIds.length !== 1) {
      return task;
    }
    const parent = receipts.work.get(command.parentWorkIds[0]);
    if (!parent || parent.execution !== "completed" || !sameCommandOwner(parent.message, message)) {
      return task;
    }
    owner = parent.message;
  }
  const prefix = `projection:${owner.userId}:`;
  if ((owner.raw as { type?: string } | null)?.type !== "projection_exact_check" || !owner.workId?.startsWith(prefix)) {
    return task;
  }
  const id = owner.workId.slice(prefix.length).split(":", 1)[0];
  const projection = store.getById(id);
  if (!projection || projection.status !== "pending" || scheduledWorkId(owner.userId, projection) !== owner.workId
    || (command && projection.delivery_work_id !== owner.workId)) {
    return task;
  }
  if (projection.target_user_id && (
    projection.target_user_id !== owner.userId || projection.target_channel_id !== owner.channelId ||
    projection.target_platform !== owner.platform ||
    (projection.target_thread_id ?? DEFAULT_THREAD_ID) !== (owner.threadId ?? DEFAULT_THREAD_ID) ||
    (projection.target_channel_thread_id ?? undefined) !== owner.channelThreadId
  )) {
    return task;
  }
  const evidence: {
    id: string; summary: string; context: string | null;
    owningRequest?: string; command?: { id: string; status: string; exitCode: number | null };
  } = { id: projection.id, summary: projection.summary, context: projection.context };
  if (command) {
    evidence.owningRequest = owner.text;
    evidence.command = { id: command.id, status: command.status, exitCode: command.exitCode };
  }
  return {
    ...task,
    request: `${task.request}\n\nStored scheduled-task evidence (not an independent permission grant):\n` + JSON.stringify(evidence),
  };
}
