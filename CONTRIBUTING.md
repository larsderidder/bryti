# Contributing

## Source layout

~50 source files, ~10K lines.

```
src/
  index.ts            entry point, supervisor loop, restart protocol
  agent.ts            pi session setup, model fallback, system prompt assembly
  config.ts           YAML loading, env substitution, validation
  cli.ts              operator management CLI
  guardrail.ts        LLM-based safety evaluation for tool calls
  trust.ts            capability taxonomy, approval store
  trust-wrapper.ts    wraps tool execute() with trust + guardrail

  channels/
    types.ts          channel bridge interface
    telegram.ts       grammy bridge, markdown-to-HTML, media groups
    whatsapp.ts       baileys bridge, QR auth, auto-reconnect

  memory/
    core-memory.ts    always-in-context markdown file (4KB cap)
    store.ts          per-user SQLite with FTS5 + embeddings
    embeddings.ts     local embeddings via node-llama-cpp
    search.ts         hybrid keyword + vector search with RRF

  projection/
    store.ts          SQLite storage, triggers, dependency DAG
    tools.ts          create / list / resolve / link
    format.ts         system prompt injection
    reflection.ts     background extraction pass (30-min cron)

  workers/
    tools.ts          dispatch / check / interrupt / steer
    scoped-tools.ts   sandboxed file I/O for worker sessions
    registry.ts       in-memory tracking of active workers

  tools/              tool definitions (memory, files, search, fetch)
  compaction/         transcript repair, proactive session compaction
  markdown/           IR-based markdown-to-Telegram-HTML renderer
  scheduler.ts        projection-driven cron (daily review, exact-time checks)
  message-queue.ts    per-channel FIFO with merge window
  model-infra.ts      shared model registry, auth, and resolution
```
