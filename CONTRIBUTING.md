# Contributing

## Source layout

~50 source files, ~10K lines.

```
src/
  index.ts                  entry point, supervisor loop
  agent.ts                  pi session setup, model fallback, system prompt
  config.ts                 YAML loading, env substitution, validation
  cli.ts                    management CLI
  guardrail.ts              LLM-based safety evaluation
  trust.ts                  tool permission registry and approval store
  trust-wrapper.ts          wraps tools with trust + guardrail checks

  channels/
    telegram.ts             grammy bridge, markdown-to-HTML, chunking
    whatsapp.ts             baileys bridge, QR auth, auto-reconnect

  memory/
    core-memory.ts          always-in-context markdown
    store.ts                per-user SQLite (FTS5 + sqlite-vec)
    embeddings.ts           local embeddings (node-llama-cpp)
    search.ts               hybrid keyword + vector + RRF

  projection/
    store.ts                projection storage, triggers, dependencies
    tools.ts                create/list/resolve/link
    format.ts               system prompt injection
    reflection.ts           background extraction pass

  workers/
    tools.ts                dispatch/check/interrupt/steer
    scoped-tools.ts         sandboxed file I/O
    registry.ts             in-memory tracking

  tools/                    tool definitions (memory, files, search, fetch)
  compaction/               proactive session compaction (idle + nightly)
  markdown/                 Telegram HTML rendering
  scheduler.ts             projection-driven cron
  message-queue.ts         per-channel FIFO
```
