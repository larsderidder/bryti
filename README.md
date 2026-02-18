# pibot

A personal AI agent for Telegram, built on the [pi SDK](https://github.com/mariozechner/pi).
Self-hosted, small enough to read in an afternoon, built for one user (you).

![codebase size](repo-tokens/badge.svg)

---

## What it does

- **Persistent memory** across conversations: core memory (always in context) and archival memory (vector search via local embeddings)
- **Scheduled tasks**: tell the agent to check the weather every morning, and it creates the cron job itself
- **Web search and URL fetching** via Brave Search
- **File management** in a configurable base directory
- **Model fallback chain**: if your primary model goes down, it automatically tries the next one
- **HTML-formatted Telegram messages**: bold, italic, code blocks, tables rendered as bullet lists

## Why it's small

The entire production source is ~43k tokens. That is 21.5% of a 200k-context Claude session.
You can paste the whole codebase into a model and ask it anything.

## Self-hosting

See [docs/self-hosting.md](docs/self-hosting.md) *(coming soon)*.

## Architecture

```
src/
  index.ts            entry point, wires everything together
  agent.ts            pi session management, model fallback, system prompt
  config.ts           YAML config loading with env var substitution
  scheduler.ts        unified cron (config-driven + agent-managed)
  message-queue.ts    per-channel FIFO queue with merge window
  history.ts          JSONL conversation audit log
  usage.ts            per-message cost tracking
  channels/
    telegram.ts       Telegram bridge (grammy), markdown-to-HTML rendering
  memory/
    core-memory.ts    always-in-context markdown file (4KB limit)
    store.ts          SQLite + sqlite-vec archival memory
    embeddings.ts     local embeddings via node-llama-cpp
  compaction/
    transcript-repair.ts  fix tool-call/result pairing before each prompt
    history.ts            trim session to last N turns
  tools/
    core-memory-tool.ts   core_memory_append / core_memory_replace
    archival-memory-tool.ts  archival_memory_insert / archival_memory_search
    conversation-search-tool.ts  search JSONL history
    schedule.ts           create_schedule / list_schedules / delete_schedule
    files.ts              read / write / list files
    web-search.ts         Brave Search
    fetch-url.ts          fetch and extract URL content
  markdown/
    ir.ts             markdown-it IR pipeline (tables, links, styles)
    render.ts         render IR to Telegram HTML
```

## Token count

Run `node scripts/count-tokens.mjs` to recount and regenerate `repo-tokens/badge.svg`.
Requires Python with `tiktoken` installed (`pip install tiktoken`).
