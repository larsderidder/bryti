# Bryti

Bryti is a personal AI agent that lives in Telegram and WhatsApp. It remembers everything, tracks what's coming, runs background research, and writes its own tools when it needs new ones.

Named after the Old Norse *bryti*: the estate steward who handled the day-to-day so you could focus on the important stuff.

Built on the [pi SDK](https://github.com/mariozechner/pi). Self-hosted, single machine.

## What makes it different

* Not just reminders, it understands complicated futures (e.g. remind of me of writing an article unless you see it posted already)
* It won't forget you after a compaction
* Security built in through worker isolation and LLM guardrail instead of complicated and fragile allowlists
* Self-extending capabilities that go further than roleplay
* Background workers as isolated sessions to prevent context rot
* Implements Letta-style tiered memory system; simple to understand, powerful in use
* Automatic model fallbacks, so you can pull in a list of open source models and it will keep working
* Built-in collaborative document management with HedgeDoc integration
* No heartbeat and other wasteful processes; you pay for your tokens so Bryti is efficient

## Getting started

### What you need

- Node.js 22+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather)) or phone number with a WhatsApp account for Bryti
- Docker and docker-compose (if you want to use HedgeDoc integration for documentation management)

If you want to use Anthropic models through your Claude subscription:
- Install [pi](https://github.com/mariozechner/pi): `npm i -g @mariozechner/pi-coding-agent`
- Run `pi login anthropic` once (opens browser, stores OAuth token locally)

If you use a free / open source model / anything with an API key:

- Nothing extra. Add the provider to `data/config.yml` (see `config.example.yml` for examples with OpenRouter, Google
  Gemini, Ollama, Together AI, and others). Set the API key in `.env` if needed.

### Setup

```bash
git clone git@github.com:larsderidder/bryti.git bryti
cd bryti
npm install

# Configure
cp .env.example .env                       # add your Telegram bot token
cp config.example.yml data/config.yml      # edit to taste

# Run
./run.sh
```

The embedding model downloads on first run (~300MB). After that, startups are fast.

### No Claude subscription?

Use free models only:

```yaml
agent:
  model: "opencode/minimax-m2.5-free"
  fallback_models:
    - "opencode/kimi-k2.5-free"
```

Remove the `anthropic` provider from `models.providers`. No API keys needed.

### Docker

```bash
docker compose up -d
```

Mount `data/` as a volume. Config, memory, sessions, and logs all live there. Backup = copy the directory.

## How it works

### Memory

Three tiers, managed automatically:

1. **Core memory** (`data/core-memory.md`): a small markdown file (4KB cap) that's always included in the model's
   context. Contains your preferences, ongoing projects, and key facts about you. The agent updates it as it learns.

2. **Archival memory** (per-user SQLite): long-term storage with hybrid search that combines FTS5 keyword matching and
   vector similarity (local embeddings via node-llama-cpp), fused with reciprocal rank fusion. No external API calls;
   all embedding runs locally. The agent inserts facts when it learns something and searches when it needs context.

3. **Conversation search**: full JSONL audit logs of every conversation, searchable by keyword. Useful when the agent
   needs to look up what you discussed last week, or when you want to find something specific from a past exchange.

### Projections

The forward-looking memory system. Instead of just remembering the past, Bryti tracks what's coming:

- **Exact-time**: "remind me at 3pm" fires at 3pm
- **Day/week/month**: "follow up next week" resolves within that window
- **Someday**: "when the dentist confirms" waits for a trigger
- **Recurring**: "every Monday morning" repeats on a cron schedule
- **Dependencies**: "after X is done, do Y"
- **Fact triggers**: archiving a fact (from a worker or the CLI) can activate a waiting projection

A reflection pass runs every 30 minutes, scanning recent conversation history for commitments the agent missed during
live chat. It writes projections directly to SQLite without going through the agent loop.

### Workers

Stateless background sessions for long-running tasks. The main agent dispatches a worker with a goal; the worker runs
independently (web search, URL fetching, analysis) and writes results to a file. When it finishes, a completion fact is
archived, which triggers any matching projection so the main agent reads the summary and notifies you immediately rather
than waiting for the next scheduler tick.

Workers are also the first security boundary. The main agent has no web search or URL fetch tools at all; external
content is processed in isolation, and only the worker's cleaned-up result file enters the main conversation. This keeps
prompt injection in web content from reaching the agent's context.

Workers default to the cheapest model in the fallback chain so they don't burn your primary model's tokens on research
tasks. You can steer a running worker mid-task.

### Guardrail

Elevated tools (shell commands, HTTP requests, extension-loaded tools) go through two checks:

1. **Tool-level approval**: is this tool allowed at all? First use requires your permission via inline buttons or text.
2. **Call-level evaluation**: an LLM call evaluates the specific arguments against what you asked for, and determines
   whether it should escalate to you. Like a call-based sudo. The prompt is small (~300 tokens in, ~20 out), so it uses
   the primary model for reliability without meaningful cost impact.

Pre-approve tools in config to skip the first-use prompt:

```yaml
trust:
  approved_tools:
    - shell_exec
    - http_request
```

### Self-extending

The agent writes TypeScript extension files to give itself new tools, within the pi SDK philosophy. Each extension
registers tools with the pi SDK; after writing one the agent restarts, and the new tools are available immediately.

Extensions live in `data/files/extensions/`. An extension guide is included so the agent knows the template, parameter
types, and conventions. An empty file acts as a tombstone, signaling the agent intentionally deleted an extension so it
won't get reseeded on restart.

## Architecture

Bryti is intentionally simple, straightforward, and organized. You should be able to understand the code, and any
component is supposed to be simple enough so you can go through it in a single sitting. If that's not the case, create
an issue and I'll fix it with prio.

### Source layout

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

### Key design decisions

**Persistent sessions.** Each user gets a single pi session file that survives across messages. The model sees its
actual prior tool calls and results in context, not a reconstructed summary. Auto-compaction triggers when the context
window fills, and proactive compaction runs during idle periods and nightly so the context stays lean without adding
latency mid-conversation.

**Transcript repair.** Session files can end up with tool-call/result mismatches from partial writes or crashes. A
repair pass runs before every prompt, reordering displaced results, inserting synthetic error results for missing ones,
and dropping duplicates so the API never rejects the request.

**Worker isolation.** The main agent intentionally has no web search or URL fetch tools. All external content goes
through workers, which run in separate sessions with scoped file access. The main agent only reads the worker's result
file. This keeps prompt injection in web content contained; even if a malicious page tries to instruct the model, it
only reaches the isolated worker, not the main conversation.

**Model fallback.** When the primary model fails (rate limit, downtime, error), the agent switches to the next candidate
in the fallback chain and retries with the same session. OAuth tokens from `~/.pi/agent/auth.json` are shared with the
pi CLI, so signing in once covers both.

**Crash recovery.** A checkpoint file is written before each model call and deleted after the response is sent. If the
process dies mid-call, the next startup finds the checkpoint and notifies the user to resend. Intentional restarts (exit
code 42) are handled separately by `run.sh` so the restart loop distinguishes crashes from the agent restarting itself
after writing an extension.

## Configuration

`data/config.yml` controls everything. Copy `config.example.yml` to get started.

Environment variables are supported via `${VAR}` syntax. The `.env` file loads automatically.

## CLI

Operator tools for managing Bryti without going through chat:

```bash
npm run cli -- help                              # all commands
npm run cli -- memory                            # inspect all memory tiers
npm run cli -- memory projections --all          # all projections (including resolved)
npm run cli -- memory archival --query "energy"  # search archival memory
npm run cli -- reflect                           # run reflection pass now
npm run cli -- timeskip "dentist" --minutes 2    # make a projection fire in 2 min
npm run cli -- archive-fact "dentist confirmed"  # insert fact, trigger matching projections
npm run cli -- fill-context --turns 20           # inject synthetic conversation for testing
npm run cli -- import-openclaw                   # import memory from an OpenClaw instance
```

## License

[AGPL-3.0](LICENSE)
