# Writing Extensions for Bryti

Extensions add new tools to the agent. They are TypeScript files in
`data/files/extensions/`. The agent loads them on startup and the tools
become available immediately.

## The one thing you need to know

Bryti runs headlessly, with no terminal and no TUI. The safest extension pattern is still `pi.registerTool()`, but headless-safe pi events are also available.

**Use:** `pi.registerTool()` for model-callable capabilities. Use `pi.on()` for observability and lifecycle hooks that do not require a UI.

**Gate carefully:** `pi.registerCommand()`, `pi.registerShortcut()`, `ctx.ui.*`, and TUI components require an interactive terminal. Only use them behind `ctx.hasUI` or `ctx.mode === "tui"` checks.

Useful headless events include `before_agent_start`, `after_provider_response`, `tool_result`, `session_before_compact`, and `session_compact`. They are good for telemetry, redaction, and policy checks. Do not log prompt bodies, tool outputs, API keys, or other secrets.

## Minimal template

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "tool_name",           // snake_case, unique across all extensions
    label: "tool_name",          // same as name
    description: "What this tool does and when to use it.",
    parameters: Type.Object({
      input: Type.String({ description: "What this parameter is" }),
    }),
    async execute(_toolCallId, { input }) {
      // Do work here
      return {
        content: [{ type: "text", text: JSON.stringify({ result: input }) }],
      };
    },
  });
}
```

## What you can do inside execute()

Anything Node.js supports:

- `fetch()` for HTTP requests. Always wrap it with an `AbortController` timeout, see the helper below.
- `process.env.MY_VAR` for secrets and config (set in .env)
- `node:fs`, `node:path`, `node:child_process` for local system access
- Any npm package if you install it in `data/files/extensions/`

### Fetch timeout helper

```typescript
async function fetchWithTimeout(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
```

## Returning results

Bryti wraps extension tool output in an untrusted-content boundary before it reaches the model. This protects against prompt injection in API responses, feed entries, calendar descriptions, email bodies, and other external data. Still keep results compact and structured.

If a tool is explicitly a final report-and-stop action, return `terminate: true` with the result. The pi runtime will end the turn once all tool calls in that batch are terminal.

Always return JSON-stringified text so the agent can parse the result:

```typescript
// Success
return {
  content: [{ type: "text", text: JSON.stringify({ key: "value" }) }],
};

// Error
return {
  content: [{ type: "text", text: JSON.stringify({ error: "What went wrong" }) }],
};
```

## Using environment variables

Non-secret config (URLs, feature flags) goes in `config.yml` under `integrations`.
Secrets (API keys, tokens) go in `.env` and are referenced from config.yml via `${VAR}`.

Bryti injects `integrations.<name>.<key>` as `NAME_KEY` (uppercased) into `process.env`
at startup, so extensions read them the same way regardless of where they came from.

```yaml
# config.yml
integrations:
  my_service:
    url: "https://api.example.com"
    api_key: "${MY_SERVICE_API_KEY}"   # secret stays in .env
```

```typescript
// extension reads it the same way either way
const url = process.env.MY_SERVICE_URL;
const apiKey = process.env.MY_SERVICE_API_KEY;

if (!url) {
  return {
    content: [{ type: "text", text: JSON.stringify({
      error: "MY_SERVICE_URL not set. Add integrations.my_service.url to config.yml and restart."
    })}],
  };
}
```

## Optional tools (register only when configured)

If a tool requires env vars to work, check at registration time and skip
if they're missing. This keeps the tool list clean:

```typescript
export default function (pi: ExtensionAPI) {
  const apiKey = process.env.MY_SERVICE_API_KEY;
  if (!apiKey) return;  // Not configured — skip registration

  pi.registerTool({ ... });
}
```

## Multiple tools in one file

Group related tools in a single file:

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "thing_get", ... });
  pi.registerTool({ name: "thing_set", ... });
  pi.registerTool({ name: "thing_list", ... });
}
```

## Parameter types

```typescript
Type.String()                              // text
Type.Number()                              // number
Type.Boolean()                             // true/false
Type.Integer()                             // whole number
Type.Optional(Type.String())               // optional field
Type.Array(Type.String())                  // list of strings
Type.Union([                               // one of several string values
  Type.Literal("option_a"),
  Type.Literal("option_b"),
])
```

## Disabling an extension

Write an empty file over it. An empty file is a permanent tombstone —
the extension will not be restored on restart, even if it was a default.

```
file_write("extensions/some-extension.ts", "")
```

Do not delete extension files. Always overwrite with empty content.

## Real examples

Read the existing extensions in `data/files/extensions/` for patterns.
The bundled default:

- `extensions/documents-hedgedoc.ts` — optional tool (skips if env var missing), fetch API, multiple tools
- `extensions/provider-observability.ts` — headless-safe provider and compaction telemetry hooks

The agent can also write its own extensions at runtime (shell access,
API integrations, etc.). Check `data/files/extensions/` for any that
already exist.
