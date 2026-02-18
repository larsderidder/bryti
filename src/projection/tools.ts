/**
 * Projection agent tools: project, get_projections, resolve_projection.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { ProjectionResolution, ProjectionStore } from "./store.js";

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const projectSchema = Type.Object({
  summary: Type.String({ description: "One-line description of the future event or expectation" }),
  when: Type.Optional(Type.String({
    description:
      "When this is expected to happen. Use a specific ISO datetime for exact events " +
      "(e.g. '2026-02-19T10:00'), a date for day-resolution (e.g. '2026-02-19'), " +
      "'someday' for no specific time, or a natural phrase for the raw_when field.",
  })),
  resolution: Type.Optional(Type.Union(
    [
      Type.Literal("exact"),
      Type.Literal("day"),
      Type.Literal("week"),
      Type.Literal("month"),
      Type.Literal("someday"),
    ],
    { description: "Granularity of the time expression: exact | day | week | month | someday" },
  )),
  context: Type.Optional(Type.String({
    description: "Optional notes: related events, implications, what to watch for",
  })),
  linked_ids: Type.Optional(Type.Array(Type.String(), {
    description: "IDs of related projections",
  })),
});

const getProjectionsSchema = Type.Object({
  horizon_days: Type.Optional(Type.Number({
    description: "How many days ahead to look (default: 7). Always includes someday items.",
  })),
});

const resolveProjectionSchema = Type.Object({
  id: Type.String({ description: "Projection ID to resolve" }),
  outcome: Type.Union(
    [
      Type.Literal("done"),
      Type.Literal("cancelled"),
      Type.Literal("passed"),
    ],
    { description: "How the projection resolved: done | cancelled | passed" },
  ),
});

type ProjectInput = Static<typeof projectSchema>;
type GetProjectionsInput = Static<typeof getProjectionsSchema>;
type ResolveProjectionInput = Static<typeof resolveProjectionSchema>;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the three projection tools backed by the given store.
 */
export function createProjectionTools(store: ProjectionStore): AgentTool<any>[] {
  const projectTool: AgentTool<typeof projectSchema> = {
    name: "project",
    label: "project",
    description:
      "Store a future event, plan, or expectation in projection memory. " +
      "Use when the user mentions anything about the future: appointments, deadlines, " +
      "plans, reminders, or things they intend to do. " +
      "Resolve the time expression to an ISO datetime or date when possible. " +
      "Link related projections using linked_ids.",
    parameters: projectSchema,
    async execute(
      _toolCallId: string,
      { summary, when, resolution, context, linked_ids }: ProjectInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        let resolved_when: string | undefined;
        let raw_when: string | undefined;
        let res: ProjectionResolution = resolution ?? "day";

        if (when) {
          const isoPattern = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/;
          if (isoPattern.test(when)) {
            resolved_when = when.replace("T", " ");
            res = (when.includes("T") || when.includes(" ")) ? "exact" : (resolution ?? "day");
          } else if (when === "someday") {
            res = "someday";
            raw_when = when;
          } else {
            raw_when = when;
            res = resolution ?? "day";
          }
        }

        const id = store.add({
          summary,
          raw_when,
          resolved_when,
          resolution: res,
          context,
          linked_ids,
        });

        const text = JSON.stringify({ success: true, id }, null, 2);
        return { content: [{ type: "text", text }], details: { success: true, id } };
      } catch (error) {
        const err = error as Error;
        const text = JSON.stringify({ error: err.message });
        return { content: [{ type: "text", text }], details: { error: err.message } };
      }
    },
  };

  const getProjectionsTool: AgentTool<typeof getProjectionsSchema> = {
    name: "get_projections",
    label: "get_projections",
    description:
      "Retrieve your active (pending) projections. Default horizon is 7 days. " +
      "Always includes someday items. Use to review what's coming up or to find " +
      "IDs for resolve_projection.",
    parameters: getProjectionsSchema,
    async execute(
      _toolCallId: string,
      { horizon_days }: GetProjectionsInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const days = horizon_days ?? 7;
        const projections = store.getUpcoming(days);
        const text = JSON.stringify({ projections }, null, 2);
        return { content: [{ type: "text", text }], details: { projections } };
      } catch (error) {
        const err = error as Error;
        const text = JSON.stringify({ error: err.message });
        return { content: [{ type: "text", text }], details: { error: err.message } };
      }
    },
  };

  const resolveProjectionTool: AgentTool<typeof resolveProjectionSchema> = {
    name: "resolve_projection",
    label: "resolve_projection",
    description:
      "Mark a projection as resolved. Use 'done' when something happened as expected, " +
      "'cancelled' when a plan fell through, 'passed' when the time passed without confirmation. " +
      "Call this when the user tells you an outcome, or when you observe that a projected " +
      "time has passed.",
    parameters: resolveProjectionSchema,
    async execute(
      _toolCallId: string,
      { id, outcome }: ResolveProjectionInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const found = store.resolve(id, outcome);
        if (!found) {
          const text = JSON.stringify({ error: `Projection not found or already resolved: ${id}` });
          return { content: [{ type: "text", text }], details: { error: "not found" } };
        }
        const text = JSON.stringify({ success: true, id, outcome }, null, 2);
        return { content: [{ type: "text", text }], details: { success: true, id, outcome } };
      } catch (error) {
        const err = error as Error;
        const text = JSON.stringify({ error: err.message });
        return { content: [{ type: "text", text }], details: { error: err.message } };
      }
    },
  };

  return [projectTool, getProjectionsTool, resolveProjectionTool];
}
