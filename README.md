# pibot

A personal AI agent that lives in your messaging apps. Telegram and WhatsApp today, Discord and Slack next. Built on the [pi SDK](https://github.com/mariozechner/pi), self-hosted, runs on one machine.

Not a chatbot. An agent with persistent memory, background workers, forward-looking awareness, and the ability to extend its own tools.

## What it does

**Memory that sticks around.** Core memory (always in context, 4KB) for your preferences and ongoing projects. Archival memory (vector search, local embeddings) for everything else. The agent decides what to remember and when to look things up.

**Projections.** The agent tracks future events, deadlines, reminders, and commitments. It connects new information to things it already knows are coming up. "Remind me to email Sarah on Monday" and "when the dentist confirms, book time off" both work.

**Background workers.** Research tasks, web searches, and URL fetching run in isolated worker sessions. The main agent dispatches work and gets a clean summary back. Workers are the security boundary for untrusted web content.

**Self-extending.** The agent can write pi extension files that register new tools. It writes TypeScript to its workspace, and the new tools are available after restart.

**Model fallback.** If the primary model goes down, it tries the next one in the chain. Anthropic OAuth (Claude Pro/Max subscription) as primary, free models as fallbacks.

## Quick start

### Prerequisites

- Node.js 22+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- [pi CLI](https://github.com/mariozechner/pi) installed and authenticated (`pi login anthropic`)

### Setup

```bash
git clone <repo-url> pibot
cd pibot
npm install

# Configure
cp .env.example .env          # add your Telegram bot token
cp config.example.yml data/config.yml  # edit to taste

# Run
./run.sh
```

On first run, the embedding model downloads automatically (~300MB). Subsequent starts are fast.

### Minimal free setup

Don't have a Claude subscription? Use free models only:

```yaml
# In data/config.yml
agent:
  model: "opencode/minimax-m2.5-free"
  fallback_models:
    - "opencode/kimi-k2.5-free"
```

Remove the `anthropic` provider from the `models.providers` section. No API keys needed.

## Configuration

### config.yml

Lives in `data/config.yml`. Copy `config.example.yml` to get started.

**Agent settings:**
- `agent.name` - Bot name
- `agent.system_prompt` - Persona and standing instructions. The framework adds memory, tools, and all other sections automatically; put only your additions here
- `agent.model` - Primary model (`provider/model-id`)
- `agent.fallback_models` - Ordered fallback list
- `agent.timezone` - IANA timezone (e.g., `Europe/Amsterdam`). Used for projection scheduling and time display
- `agent.reflection_model` - Model for background reflection pass (defaults to primary). Set a cheaper model to save tokens

**Channels:**
- `telegram.token` - Bot token (use `${TELEGRAM_BOT_TOKEN}` to read from .env)
- `telegram.allowed_users` - Telegram user IDs. Empty = allow all (not recommended)
- `whatsapp.enabled` - Enable WhatsApp bridge (QR code auth on first run)
- `whatsapp.allowed_users` - Phone numbers, international format without `+` (e.g., `31612345678`)

**Models:**
- `models.providers` - List of model providers with their endpoints, API keys, and model definitions
- Anthropic OAuth: leave `api_key` empty, authenticate with `pi login anthropic`
- OpenCode: use `api_key: "public"` for free models
- See `config.example.yml` for complete provider examples

**Tools:**
- `tools.web_search.searxng_url` - SearXNG instance for worker web searches
- `tools.workers.max_concurrent` - Max parallel workers (default: 3)
- `tools.files.base_dir` - Agent file workspace

**Scheduling:**
- `cron` - Static cron jobs (prompt the agent on a schedule)
- `active_hours` - Time window for scheduler activity

### Environment variables

Config values support `${VAR}` substitution from environment. The `.env` file is loaded automatically.

```
TELEGRAM_BOT_TOKEN=your-token-here
```

### Anthropic OAuth

Pibot shares OAuth credentials with the pi CLI. Run `pi login anthropic` once, and pibot reads the token from `~/.pi/agent/auth.json`. No API key needed. Works with Claude Pro and Max subscriptions.

## Architecture

42 source files, ~9500 lines.

```
src/
  index.ts              entry point, wires everything, supervisor loop
  agent.ts              pi session management, model fallback, system prompt
  config.ts             YAML config loading, env substitution, validation
  cli.ts                operator CLI (memory inspect, reflect, timeskip, import)

  channels/
    telegram.ts         Telegram bridge (grammy), markdown-to-HTML rendering
    whatsapp.ts         WhatsApp bridge (baileys), QR auth, auto-reconnect
    types.ts            shared channel interface

  memory/
    core-memory.ts      always-in-context markdown (4KB cap)
    store.ts            SQLite per-user archival memory (FTS5 + sqlite-vec)
    embeddings.ts       local embeddings (node-llama-cpp, embeddinggemma-300M)
    search.ts           hybrid search: keyword + vector + RRF fusion
    conversation-search.ts  search JSONL audit logs

  projection/
    store.ts            SQLite projection storage, triggers, dependencies
    tools.ts            projection_create/list/resolve/link tools
    format.ts           format projections for system prompt injection
    reflection.ts       background LLM pass to extract missed projections

  workers/
    tools.ts            worker_dispatch/check/interrupt/steer tools
    scoped-tools.ts     sandboxed file tools for worker sessions
    registry.ts         in-memory worker tracking

  compaction/
    transcript-repair.ts  fix tool-call/result pairing before each prompt
    index.ts              proactive compaction (idle + nightly)

  tools/
    index.ts            tool registry, creates all tools for a user session
    archival-memory-tool.ts   memory_archival_insert/search
    core-memory-tool.ts       memory_core_append/replace
    conversation-search-tool.ts  memory_conversation_search
    files.ts                  file_read/write/list
    web-search.ts             SearXNG search (workers only)
    fetch-url.ts              URL fetching (workers only)

  markdown/             Telegram HTML rendering pipeline
  scheduler.ts          projection-driven scheduling (exact-time + daily review)
  message-queue.ts      per-channel FIFO with merge window
  history.ts            JSONL conversation audit log
  usage.ts              per-message cost tracking
  logger.ts             structured logging to stdout + file
  time.ts               timezone utilities
  active-hours.ts       time-of-day guard for scheduler
```

## CLI

Operator tools for inspecting and managing the bot without going through the chat interface.

```bash
npm run cli -- help                          # show all commands
npm run cli -- memory                        # inspect all memory tiers
npm run cli -- memory projections --all      # show all projections (including resolved)
npm run cli -- memory archival --query "work" # search archival memory
npm run cli -- reflect                       # run reflection pass on demand
npm run cli -- timeskip "dentist" --minutes 2 # move a projection to fire in 2 min
npm run cli -- archive-fact "dentist confirmed" # insert fact, check triggers
```

## Docker

```bash
docker compose up -d
```

Mount `data/` as a volume. Config, memory, sessions, and logs all live there. Backup = copy the directory.

## Tool naming convention

All custom tools use `group_action` naming:

| Group | Tools |
|---|---|
| `memory_*` | `memory_archival_insert`, `memory_archival_search`, `memory_core_append`, `memory_core_replace`, `memory_conversation_search` |
| `projection_*` | `projection_create`, `projection_list`, `projection_resolve`, `projection_link` |
| `worker_*` | `worker_dispatch`, `worker_check`, `worker_interrupt`, `worker_steer` |
| `file_*` | `file_read`, `file_write`, `file_list` |

## License

Not yet decided.
