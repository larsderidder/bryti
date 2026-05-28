import type { AgentSession } from "@mariozechner/pi-coding-agent";

export interface ToolSchemaIssue {
  toolName: string;
  path: string;
  message: string;
}

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$ref",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependencies",
  "dependentSchemas",
  "unevaluatedProperties",
  "contains",
  "propertyNames",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeAnyOf(value: unknown): string | null {
  if (!Array.isArray(value)) return "anyOf must be an array";
  const allLiteralStrings = value.every((entry) =>
    isObject(entry) && typeof entry.const === "string" && entry.type === "string",
  );
  if (allLiteralStrings) return null;
  return "anyOf is only allowed for simple string literal unions";
}

function walkSchema(value: unknown, path: string, issues: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkSchema(item, `${path}[${index}]`, issues));
    return;
  }
  if (!isObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) {
      issues.push(`${childPath}: unsupported schema keyword "${key}"`);
      continue;
    }
    if (key === "anyOf") {
      const detail = describeAnyOf(child);
      if (detail) issues.push(`${childPath}: ${detail}`);
      continue;
    }
    walkSchema(child, childPath, issues);
  }
}

export function validateToolSchema(toolName: string, parameters: unknown): ToolSchemaIssue[] {
  const messages: string[] = [];
  if (!isObject(parameters)) {
    return [{ toolName, path: "parameters", message: "parameters must be a JSON schema object" }];
  }
  if (parameters.type !== "object") {
    messages.push("parameters.type must be object");
  }
  walkSchema(parameters, "parameters", messages);
  return messages.map((message) => ({ toolName, path: "parameters", message }));
}

export function quarantineInvalidExtensionTools(
  session: AgentSession,
  extensionToolNames: Set<string>,
): ToolSchemaIssue[] {
  if (extensionToolNames.size === 0) return [];

  const issues: ToolSchemaIssue[] = [];
  const invalidToolNames = new Set<string>();
  for (const tool of session.getAllTools()) {
    if (!extensionToolNames.has(tool.name)) continue;
    const toolIssues = validateToolSchema(tool.name, tool.parameters);
    if (toolIssues.length > 0) {
      issues.push(...toolIssues);
      invalidToolNames.add(tool.name);
    }
  }

  if (invalidToolNames.size > 0) {
    const nextActiveTools = session
      .getActiveToolNames()
      .filter((name) => !invalidToolNames.has(name));
    session.setActiveToolsByName(nextActiveTools);
  }

  return issues;
}
