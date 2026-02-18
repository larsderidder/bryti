/**
 * Schedule management tools.
 *
 * Give the agent the ability to create, list, and delete its own scheduled
 * tasks. Each schedule fires a message through the normal agent loop on the
 * cron expression, directed at the user who created it.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import type { Scheduler } from "../scheduler.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createScheduleSchema = Type.Object({
  schedule: Type.String({
    description:
      'Cron expression for when the job should run (UTC). Examples: ' +
      '"0 8 * * *" = every day at 08:00, "0 9 * * 1" = every Monday at 09:00, ' +
      '"*/30 * * * *" = every 30 minutes.',
  }),
  message: Type.String({
    description:
      "The message to send as if the user typed it. Should be a clear, self-contained " +
      "instruction for what to do when the schedule fires.",
  }),
  description: Type.String({
    description: "Short human-readable label for the schedule (shown in list_schedules).",
  }),
});

type CreateScheduleInput = Static<typeof createScheduleSchema>;

const deleteScheduleSchema = Type.Object({
  id: Type.String({ description: "Schedule ID returned by create_schedule or list_schedules." }),
});

type DeleteScheduleInput = Static<typeof deleteScheduleSchema>;

const listSchedulesSchema = Type.Object({});

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

/**
 * Create the three schedule management tools.
 *
 * @param scheduler  The running Scheduler instance.
 * @param userId     The id of the user on whose behalf these tools run.
 * @param channelId  The channel to send scheduled results to.
 */
export function createScheduleTools(
  scheduler: Scheduler,
  userId: string,
  channelId: string,
): AgentTool<any>[] {
  const createScheduleTool: AgentTool<typeof createScheduleSchema> = {
    name: "create_schedule",
    label: "create_schedule",
    description:
      "Create a recurring scheduled task. The task fires on the given cron expression (UTC) " +
      "and runs the given message through the agent loop, sending the result back to the user. " +
      "Use this when the user asks you to do something periodically or at a specific time.",
    parameters: createScheduleSchema,
    async execute(
      _toolCallId: string,
      { schedule, message, description }: CreateScheduleInput,
    ): Promise<AgentToolResult<unknown>> {
      let record;
      try {
        record = scheduler.create({ schedule, message, description, userId, channelId });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: JSON.stringify({ error }) }],
          details: { error },
        };
      }

      const result = {
        id: record.id,
        schedule: record.schedule,
        message: record.message,
        description: record.description,
        created_at: record.created_at,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };

  const listSchedulesTool: AgentTool<typeof listSchedulesSchema> = {
    name: "list_schedules",
    label: "list_schedules",
    description:
      "List all active agent-managed schedules. Shows id, cron expression, message, " +
      "description, and when each was created.",
    parameters: listSchedulesSchema,
    async execute(
      _toolCallId: string,
      _input: Record<string, never>,
    ): Promise<AgentToolResult<unknown>> {
      const records = scheduler.list();
      const result = records.map((r) => ({
        id: r.id,
        schedule: r.schedule,
        message: r.message,
        description: r.description,
        enabled: r.enabled,
        created_at: r.created_at,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { count: result.length, schedules: result },
      };
    },
  };

  const deleteScheduleTool: AgentTool<typeof deleteScheduleSchema> = {
    name: "delete_schedule",
    label: "delete_schedule",
    description:
      "Delete an agent-managed schedule by its ID. The schedule stops immediately and " +
      "is removed from disk. Use list_schedules to find the ID.",
    parameters: deleteScheduleSchema,
    async execute(
      _toolCallId: string,
      { id }: DeleteScheduleInput,
    ): Promise<AgentToolResult<unknown>> {
      const deleted = scheduler.delete(id);
      const result = deleted
        ? { deleted: true, id }
        : { deleted: false, error: `Schedule not found: ${id}` };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };

  return [createScheduleTool, listSchedulesTool, deleteScheduleTool];
}
