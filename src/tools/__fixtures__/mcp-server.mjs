import readline from "node:readline";

let writes = 0;
const lines = readline.createInterface({ input: process.stdin });

/** A local protocol fixture. It never reads files, accesses the network, or calls a model. */
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) {
    return;
  }
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "bryti-test", version: "1" },
    });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: [{
      name: "write", description: "Write a fixture record",
      inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      outputSchema: { type: "object", properties: { pid: { type: "integer" }, writes: { type: "integer" } }, required: ["pid", "writes"] },
      annotations: { readOnlyHint: true },
    }] });
  } else if (message.method === "tools/call") {
    writes += 1;
    const structuredContent = { pid: process.pid, writes };
    reply(message.id, {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent,
    });
  } else if (message.method === "ping") {
    reply(message.id, {});
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id,
      error: { code: -32601, message: "Method not found" } })}\n`);
  }
});
