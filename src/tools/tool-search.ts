import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const TOOL_SEARCH_NAME = "search_tools";

const searchSchema = Type.Object({
  query: Type.String({
    description: "Capability or task to search for",
    minLength: 1,
    maxLength: 200,
  }),
  limit: Type.Optional(Type.Integer({
    description: "Maximum tools to load (default: 6)",
    minimum: 1,
    maximum: 10,
  })),
});

interface ToolSearchBinding {
  getTools(): ToolInfo[];
  getActiveToolNames(): string[];
  setActiveToolNames(names: string[]): void;
}

export interface ToolSearchController {
  tool: AgentTool<typeof searchSchema>;
  bind(binding: ToolSearchBinding): void;
}

interface DynamicToolSession {
  getAllTools(): ToolInfo[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
}

interface RankedTool {
  tool: ToolInfo;
  score: number;
}

/**
 * Keep Bryti-owned core tools active while deferring extension tools until needed.
 */
export function getInitialToolNames(
  tools: ToolInfo[],
  extensionToolNames: Set<string>,
): string[] {
  return tools
    .filter((tool) => !extensionToolNames.has(tool.name))
    .map((tool) => tool.name);
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreTool(tool: ToolInfo, query: string, terms: string[]): number {
  const name = normalizeSearchText(tool.name);
  const description = normalizeSearchText(tool.description ?? "");
  const searchable = `${name} ${description}`;
  let score = 0;

  if (searchable.includes(query)) {
    score += 8;
  }

  for (const term of terms) {
    if (name.includes(term)) {
      score += 3;
    }
    if (description.includes(term)) {
      score += 1;
    }
  }

  return score;
}

function rankInactiveTools(
  tools: ToolInfo[],
  activeToolNames: string[],
  query: string,
): RankedTool[] {
  const normalizedQuery = normalizeSearchText(query);
  const terms = normalizedQuery.split(" ").filter((term) => term.length > 0);
  const active = new Set(activeToolNames);
  const ranked: RankedTool[] = [];

  for (const tool of tools) {
    if (tool.name === TOOL_SEARCH_NAME || active.has(tool.name)) {
      continue;
    }

    const score = scoreTool(tool, normalizedQuery, terms);
    if (score === 0) {
      continue;
    }
    ranked.push({ tool, score });
  }

  ranked.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.tool.name.localeCompare(right.tool.name);
  });
  return ranked;
}

/**
 * Bind the loader to a pi session and activate only core tools initially.
 */
export function configureDynamicToolLoading(
  controller: ToolSearchController,
  session: DynamicToolSession,
  extensionToolNames: Set<string>,
  onActiveToolsChanged: (tools: ToolInfo[]) => void,
  excludedToolNames: Set<string> = new Set(),
): void {
  const applyActiveToolNames = (names: string[]): void => {
    const uniqueNames = [...new Set(names)].filter((name) => !excludedToolNames.has(name));
    session.setActiveToolsByName(uniqueNames);
    const activeNames = new Set(session.getActiveToolNames());
    const activeTools = session.getAllTools().filter((tool) => activeNames.has(tool.name));
    onActiveToolsChanged(activeTools);
  };

  controller.bind({
    getTools: () => session.getAllTools().filter((tool) => !excludedToolNames.has(tool.name)),
    getActiveToolNames: () => session.getActiveToolNames(),
    setActiveToolNames: applyActiveToolNames,
  });

  const initialToolNames = getInitialToolNames(
    session.getAllTools(),
    extensionToolNames,
  );
  applyActiveToolNames(initialToolNames);
}

/**
 * Create a loader tool that can be bound after pi has discovered extension tools.
 */
export function createToolSearch(): ToolSearchController {
  let binding: ToolSearchBinding | null = null;

  const tool: AgentTool<typeof searchSchema> = {
    name: TOOL_SEARCH_NAME,
    label: TOOL_SEARCH_NAME,
    description:
      "Search for and load tools relevant to a task. Use this when the active tools " +
      "cannot access a service or capability the user needs.",
    parameters: searchSchema,
    async execute(
      _toolCallId: string,
      params: Static<typeof searchSchema>,
    ): Promise<AgentToolResult<unknown>> {
      if (!binding) {
        throw new Error("Tool catalog is not ready");
      }

      // TypeBox applies positive length and range validation at the tool boundary
      // before the query controls catalog scanning (ASVS 2.2.1, 2.2.2).
      const limit = params.limit ?? 6;
      const activeToolNames = binding.getActiveToolNames();
      const matches = rankInactiveTools(
        binding.getTools(),
        activeToolNames,
        params.query,
      ).slice(0, limit);

      if (matches.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No inactive tools found for: ${params.query}`,
          }],
          details: { matches: [], added: [] },
        };
      }

      const added = matches.map((match) => match.tool.name);
      binding.setActiveToolNames([...activeToolNames, ...added]);

      return {
        content: [{
          type: "text",
          text: `Loaded tools: ${added.join(", ")}`,
        }],
        addedToolNames: added,
        details: {
          matches: matches.map((match) => ({
            name: match.tool.name,
            description: match.tool.description,
          })),
          added,
        },
      };
    },
  };

  return {
    tool,
    bind(nextBinding) {
      binding = nextBinding;
    },
  };
}
