# Writing Extensions for Bryti

Extensions add new tools to the agent. They are TypeScript files in
`data/files/extensions/`. The agent loads them on startup and the tools
become available immediately.

## The one thing you need to know

Bryti runs headlessly — no terminal, no TUI. Extensions work through
`pi.registerTool()` only. Everything else in the pi extension API
(commands, UI, TUI components, session navigation) requires an interactive
terminal and does nothing here.

**Use:** `pi.registerTool()`  
**Ignore:** `pi.registerCommand()`, `pi.registerShortcut()`, `ctx.ui.*`,
`ctx.sessionManager`, `pi.on()` events — these are no-ops or unavailable.

## Minimal template

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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

- `fetch()` for HTTP requests
- `process.env.MY_VAR` for secrets and config (set in .env)
- `node:fs`, `node:path`, `node:child_process` for local system access
- Any npm package if you install it in `data/files/extensions/`

## Returning results

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

Config and secrets go in `.env`, not hardcoded:

```typescript
const apiKey = process.env.MY_SERVICE_API_KEY;

if (!apiKey) {
  return {
    content: [{ type: "text", text: JSON.stringify({
      error: "MY_SERVICE_API_KEY is not set. Add it to .env and restart."
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

Extensions the agent has written for itself (if present):

- `extensions/shell.ts` — child_process, env var for paths, elevated tool
- `extensions/weather_weert.ts` — simple fetch, single tool, hardcoded location
