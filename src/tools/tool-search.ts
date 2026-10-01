import {
  createToolSearchExtension,
  type ExtensionFactory,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";

export const TOOL_SEARCH_NAME = "tool_search";

/** Use native discovery and keep Bryti's prompt catalog synchronized with additive activation. */
export function createToolDiscoveryExtension(
  onActiveToolsChanged: (tools: ToolInfo[]) => void,
): ExtensionFactory {
  return (pi) => {
    let pendingRestoredTools: string[] = [];
    const updateCatalog = () => {
      const active = new Set(pi.getActiveTools());
      onActiveToolsChanged(pi.getAllTools().filter((tool) => active.has(tool.name)));
    };
    createToolSearchExtension()({
      ...pi,
      registerTool(definition) {
        pi.registerTool({ ...definition, defaultActive: true });
      },
      setActiveTools(names) {
        pi.setActiveTools(names);
        updateCatalog();
      },
    });
    pi.on("session_start", (_event, context) => {
      const current = getCurrentSystemMessage(context.sessionManager.buildSessionProjection().messages);
      pendingRestoredTools = (current?.toolsAdded ?? []).map((tool) => tool.name);
      updateCatalog();
    });
    // Register after MCP so its startup wait finishes before reconciliation.
    pi.on("before_agent_start", () => {
      const active = pi.getActiveTools();
      const available = new Set(pi.getAllTools()
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => tool.name));
      const restored = pendingRestoredTools.filter((name) => available.has(name) && !active.includes(name));
      if (restored.length > 0) {
        pi.setActiveTools([...active, ...restored]);
      }
      pendingRestoredTools = pendingRestoredTools.filter((name) => !available.has(name));
      updateCatalog();
    });
  };
}
