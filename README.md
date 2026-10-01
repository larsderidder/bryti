<p align="center">
  <img src="assets/icon.svg" alt="" width="32" height="40">
</p>

<h1 align="center">Bryti</h1>

<p align="center">
  <strong>Your AI colleague, in the apps you already use.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-22.19%2B-brightgreen.svg" alt="Node.js 22.19+"></a>
  <a href="https://github.com/mariozechner/pi"><img src="https://img.shields.io/badge/built%20on-pi%20SDK-purple.svg" alt="Built on pi"></a>
  <a href="#getting-started"><img src="https://img.shields.io/badge/self--hosted-yes-orange.svg" alt="Self-hosted"></a>
</p>

<p align="center">
  <img src="assets/chat-example.svg" alt="Bryti conversation showing research, memory recall, and proactive follow-up" width="540">
</p>

---

Bryti is a personal AI agent that lives in the chat apps you already use, or in its own self-hosted web client. It remembers what you tell it, tracks what's coming up, researches things in the background, and writes its own tools when it needs new capabilities. All running on your machine, with your data staying yours.

> *Named after the Old Norse **bryti**: the estate steward who handled the day-to-day so you could focus on what matters.*

## What makes it different

**It actually remembers you.** Three-tier memory: a small always-visible file for key facts, long-term searchable storage with local embeddings, and full conversation logs. When the context window fills up, compaction preserves what matters instead of throwing it away.

**It understands the future, not just the past.** Projections go beyond simple reminders. "Remind me to write that article unless you see it posted already." "When the dentist confirms, remind me to book time off." "Every Monday morning, check the sprint board." Time-based, event-triggered, recurring, with dependencies.

**Research runs in scoped workers.** Workers use separate sessions and limited file access, without loading extensions or MCP. Their results can still contain malicious instructions, so the main agent treats external content as untrusted and tool execution remains subject to Bryti's approval policy.

**It extends itself.** The agent writes TypeScript extensions to give itself new tools: API integrations, custom commands, whatever it needs. Write the file, restart, done.

**It works without a subscription.** Configure free models via OpenCode, use your own Ollama instance, or bring any OpenAI-compatible API. Automatic fallback across providers means it keeps working when one goes down.

## Channel support

Bryti can run on multiple chat channels, but they are not all at the same maturity level. The practical difference is how much real-world use the channel has had, how much setup is involved, and how likely it is to need sharp-edge fixes.

| Channel | Status | Built in | Notes |
| --- | --- | --- | --- |
| Telegram | Stable | Yes | The most exercised channel. Good default choice for daily use, approvals, markdown replies, images, and voice when voice support is enabled. |
| WhatsApp | Beta | Yes | Useful because it is where many people already are, but the Web/Baileys integration can be brittle and may need re-authentication. |
| Threema | Alpha | Yes | Privacy-focused and promising, especially with Gateway E2E, but setup is heavier and the channel is newer. Expect some operator rough edges. |
| Web E2EE | Alpha | Yes | Self-hosted PWA with encrypted text, and voice when enabled. Strategically interesting because it gives Bryti its own private chat surface, but pairing, browser audio, and crypto handling need more review before calling it stable. |
| Discord | Stable | Planned | Expected to be a good fit for server-style usage and developer workflows, but it is not wired into this branch yet. |
| Slack | Beta | Planned | Useful for text-oriented team workflows, but also not wired into this branch yet. |

Status labels are intentionally conservative. Alpha means the channel is worth trying if you are comfortable debugging it; beta means it should work for normal use, but still has integration-specific sharp edges.

## Getting started

### Requirements

- Node.js 22.19+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather)) or a WhatsApp phone number for Bryti
- Docker and docker-compose (optional, for HedgeDoc integration)

### Quick start

```bash
git clone git@github.com:larsderidder/bryti.git
cd bryti
npm install

# Configure
cp .env.example .env                       # add your Telegram bot token
cp config.example.yml data/config.yml      # edit to taste

# Run
bryti                  # or: npm start, or: ./run.sh (auto-restart on crash)
```

The embedding model downloads on first run (~300 MB). After that, startups take a few seconds.

### Using Anthropic models through your Claude subscription

No API key needed. Install the [pi CLI](https://github.com/mariozechner/pi) and log in once:

```bash
npm i -g @mariozechner/pi-coding-agent
pi login anthropic    # opens browser, stores OAuth token locally
```

### Using free or open-source models only

No subscription, no API keys:

```yaml
agent:
  model: "opencode/mimo-v2.6-flash-free"
  fallback_models:
    - "opencode/nemotron-3-ultra-free"
```

Remove the `anthropic` provider from `models.providers` in your config. See `config.example.yml` for more provider examples (OpenRouter, Google Gemini, Ollama, Together AI).

### Docker

```bash
cp .env.example .env                       # add your Telegram bot token
cp config.example.yml data/config.yml      # edit to taste
docker compose up -d
```

The `data/` directory is mounted as a volume. Config, memory, sessions, and logs all live there. Backup = copy the directory. Logs are available via `docker compose logs -f`.

### Why self-hosted?

Your conversations, memories, and personal data never leave your machine. No third-party servers, no vendor lock-in on the agent itself. You control which models to use, which providers to trust, and when to upgrade.

## How it works

### Memory

Three tiers, managed automatically:

1. **Core memory** (`data/core-memory.md`): a small markdown file (4 KB cap) that's always in the model's context. Contains your preferences, ongoing projects, and key facts about you. The agent updates it as it learns.

2. **Archival memory** (per-user SQLite): long-term storage with hybrid search combining FTS5 keyword matching and vector similarity (local embeddings via node-llama-cpp), fused with reciprocal rank fusion. No external API calls; all embedding runs on your machine. The agent inserts facts when it learns something and searches when it needs context.

3. **Conversation search**: full JSONL audit logs of every conversation, searchable by keyword. Useful when the agent needs to look up what you discussed last week.

### Projections

The forward-looking memory system. Instead of just remembering the past, Bryti tracks what's coming:

- **Exact-time**: "remind me at 3pm" fires at 3pm
- **Day/week/month**: "follow up next week" resolves within that window
- **Someday**: "when the dentist confirms" waits for a trigger
- **Recurring**: "every Monday morning" repeats on a cron schedule
- **Dependencies**: "after X is done, do Y"
- **Fact triggers**: archiving a fact (from a worker or the CLI) can activate a waiting projection

A reflection pass runs every 30 minutes, scanning recent conversation history for commitments the agent missed during live chat. It writes projections directly to SQLite without going through the agent loop.

### Workers

Background sessions for long-running tasks. The main agent dispatches a worker with a goal; the worker runs independently (web search, URL fetching, analysis) and writes results to a file. When it finishes, a completion fact is archived, which can trigger projections so the main agent reads the summary and notifies you right away.

Workers are the default path for web research, with scoped file access and no extensions or MCP. The main agent can still receive untrusted content through worker results or opted-in direct web tools. Worker isolation restricts capabilities, and the main agent's tool calls retain Bryti's approvals.

Direct main-agent web access is available as an explicit opt-in tool group. Add `web` to `agent.yml` `tools.groups` to expose `web_search` and `fetch_url` directly. The same `fetch_url` tool is always available to background workers. It uses npm-native Readability by default, is HTTPS-only by default, and is protected against private-network fetches before extraction. Worker isolation is still the safer choice for broad or adversarial research.

If you prefer Argus extraction, set `tools.fetch_url.backend: argus` and install Argus separately. You can point Bryti at it with `ARGUS_BIN` or `tools.fetch_url.argus_bin`.

Local Argus CLI extraction uses explicit development standalone mode and stores its state in `$XDG_DATA_HOME/argus-cli`, defaulting to `~/.local/share/argus-cli`. `ARGUS_DATA_ROOT` can override that directory, but it must not point at a long-lived Argus service's state because standalone calls persist provider registrations. Explicit `ARGUS_MCP_STANDALONE` settings are preserved; `ARGUS_AUTHORITY_URL` and `ARGUS_ENV=production` prevent automatic standalone configuration.

Set `tools.web_search.parallel_enabled: true` to add anonymous Parallel search and focused extraction alongside the existing tools. Research workers that request `web_search` also receive `parallel_search` and `parallel_fetch`; an explicit empty research tool set does not receive them. Main sessions need the `web` group and use Bryti's elevated-tool approvals. Parallel receives only the supplied public objective, queries or URLs, and an opaque session ID, not conversation history or model identity. Free-tier limits are server-controlled, so existing search and extraction remain available. Requests have a total deadline, response and output limits, and public HTTPS validation for extraction. Results are untrusted evidence, not instructions. This does not enable generic MCP servers for workers.

You can configure named worker types in `config.yml` with preset models, tools, and timeouts:

```yaml
workers:
  types:
    research:
      description: "Web research and content gathering"
      model: "anthropic/claude-sonnet-4-20250514"
      tools: [web_search, fetch_url]
      timeout_seconds: 3600
    analysis:
      description: "Deep analysis using a stronger model"
      model: "anthropic/claude-sonnet-4-6"
      tools: [fetch_url]
      timeout_seconds: 1800
```

The agent selects a type when dispatching. Explicit parameters on the dispatch call still override type defaults. The agent can also define new types by editing `config.yml` and restarting.

You can steer a running worker mid-task to narrow its focus or redirect its research.

### Guardrail

Elevated tools (shell commands, HTTP requests, extension-loaded tools) go through two checks:

1. **Tool-level approval**: is this tool allowed at all? First use requires your permission via inline buttons or text.
2. **Call-level evaluation**: an LLM call evaluates the specific arguments against what you asked for, and decides whether to escalate. Like a call-based sudo. The prompt is small (~300 tokens in, ~20 out), so it uses the primary model for reliability without meaningful cost impact.

Pre-approve tools in config to skip the first-use prompt:

```yaml
trust:
  approved_tools:
    - shell_exec
    - http_request
```

### Self-extending

The agent writes TypeScript extension files to give itself new tools, using the pi SDK extension format. Each extension registers tools with the SDK; after writing one the agent restarts, and the new tools are available immediately.

Extensions live in `data/files/extensions/`. An extension guide is included so the agent knows the template, parameter types, and conventions. An empty file acts as a tombstone, signaling the agent intentionally deleted an extension so it won't get reseeded on restart.

### MCP servers

Configure MCP for each user in an operator-owned `data/users/<userId>/mcp.json`, using pi's `mcpServers` format. Bryti starts without MCP servers and ignores your global pi and project MCP configuration.

```json
{
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp" }
  }
}
```

Both stdio and streamable HTTP use pi's native MCP transport. Tools can be loaded through `tool_search` or composed in `codemode` scripts. Bryti forces server and tool exposure to `deferred`, preserving explicit `hidden` settings. MCP tools use Bryti's approvals; unsupported input schemas are quarantined before discovery, and workers never load MCP or other extensions.

Sign in to OAuth servers through the operator's pi 0.99.1 CLI, pointing it at the user's directory:

```bash
PI_CODING_AGENT_DIR=/path/to/data/users/USER_ID pi mcp login docs
```

Credentials and refresh locks stay in that user's directory, while headers and environment values can reference `${VARIABLE}`. Keep credentials out of URLs and source control, and reload the session after configuration changes.

### Codemode

The main session can use pi's native `codemode` to batch tool calls and filter, join, or aggregate results before they enter model context. Direct tool calls remain available. Scripts run in a QuickJS sandbox without direct filesystem or network access; nested calls retain the tools' existing approvals and audit events. Classifier calls are disabled, and workers do not receive codemode. Only script output reaches the model. Failed scripts do not undo completed tool operations.

### Google accounts

Native Google tools use private accounts selected by the operator for each Bryti user. Enable them explicitly in `config.yml`:

```yaml
google:
  users:
    "USER_ID":
      default_account: personal
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, or the matching `integrations.google.client_id` and `client_secret` values. Enable Calendar, Gmail, and Search Console APIs for the OAuth application. The client must accept the loopback redirect printed by the CLI; web clients need that exact URI registered.

```bash
bryti google login --user-id USER_ID --account personal --email owner@example.com
bryti google accounts --user-id USER_ID
```

Authentication happens in the operator terminal and browser, with PKCE and a one-use callback protected by random state. On a headless host, forward the callback port printed by the CLI to the same local port before opening the authorization URL. Keep authorization codes and callback URLs out of chat.

Accounts live in `data/users/<userId>/google/<alias>.json`, with private directory and file permissions and serialized refreshes. Signing in never replaces an existing alias; use a new alias to reconnect. Tools accept an optional account alias and otherwise use the configured default. Calendar and Gmail remain read-only; Search Console retains performance queries and sitemap submissions under Bryti's approval policy.

Opted-in users cannot access the overlapping legacy Google tools, including chat-based OAuth setup. Existing extensions and shared credentials remain unchanged for users without this opt-in. There is no automatic migration.

### Email previews

Optional Gmail and IMAP triggers forward bounded, plain-text previews to an allowlisted Telegram or WhatsApp destination. Polling needs no public webhooks or Gmail Pub/Sub infrastructure; configuration examples are commented in `config.example.yml`.

Gmail uses an account connected through the operator CLI and reads headers with provider snippets, without fetching full MIME bodies or attachments. IMAP requires verified TLS and opens the mailbox read-only. Sender checks require an exact allowlisted address and an aligned DMARC pass in the receiver's first `Authentication-Results` header. Gmail trusts `mx.google.com`; IMAP requires explicit `trusted_authserv_ids` and a receiving server that strips forged authentication headers. DMARC authenticates the domain, so mailbox-level identity still depends on that domain's sending policy.

The first poll establishes a baseline without replaying existing mail. Expired Gmail history or changed IMAP UIDVALIDITY produces a gap notice and a new baseline. Cursors advance after durable notification acceptance, and accepted messages deduplicate across restarts. Provider failures retain the cursor with backoff; queue backpressure leaves it available for another poll.

Email notices bypass slash commands, approvals, memory updates, and the model entirely. Their contents cannot start an agent turn or invoke tools; any follow-up requires a separate user request in chat.

### PDF attachments

Telegram accepts PDF documents up to 10 MiB each, with an optional caption describing the request. Up to three PDFs share a 40,000-character text budget per processed message. Attachment bytes remain in durable work receipts, so queued uploads survive restarts and are included in data backups.

PDFium extracts text locally through `clawpdf` in terminable workers; each document has a 60-second deadline and a 20-page extraction limit. At most two parser workers run concurrently. Each worker caps WASM linear memory at 128 MiB and its old-generation V8 heap at 128 MiB; session state and attachment buffers also contribute to application memory.

Low-text pages can be rendered as PNGs for an image-capable model, with at most three images forwarded per message. Rendering is bounded by pixel count, dimensions, and encoded size. Disable it with `documents.render_images: false` for text-only extraction. Extracted text and selected page images enter the configured model's context as untrusted document data; local parsing does not make subsequent cloud-model processing local.

## Architecture

Bryti is intentionally simple, straightforward, and organized. You should be able to understand the code, and any component should be simple enough to read in a single sitting. If that's not the case, open an issue and I'll fix it.

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
    core-memory.ts    always-in-context markdown file (4 KB cap)
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
  integrations/       private Google accounts, native API tools, inert email polling
  documents/          bounded local PDF parsing and page rendering
  markdown/           IR-based markdown-to-Telegram-HTML renderer
  scheduler.ts        projection-driven cron (daily review, exact-time checks)
  message-queue.ts    per-channel FIFO with merge window
  model-infra.ts      shared model registry, auth, and resolution
```

### Key design decisions

**Persistent sessions.** Each user gets a single pi session file that survives across messages. The model sees its actual prior tool calls and results in context, not a reconstructed summary. Auto-compaction triggers when the context window fills, and proactive compaction runs during idle periods and nightly so the context stays lean without adding latency mid-conversation.

**Transcript repair.** Session files can end up with tool-call/result mismatches from partial writes or crashes. A repair pass runs before every prompt, reordering displaced results, inserting synthetic error results for missing ones, and dropping duplicates so the API never rejects the request.

**Worker isolation.** Web research uses separate sessions with scoped file access by default; the main agent can receive direct web tools only through an explicit opt-in. Workers do not load extensions or MCP. Their results remain untrusted external content when read by the main agent, and tool execution still uses Bryti's approval policy.

**Model fallback.** When the primary model fails (rate limit, downtime, error), the agent switches to the next candidate in the fallback chain and retries with the same session. OAuth tokens from `~/.pi/agent/auth.json` are shared with the pi CLI, so signing in once covers both.

**Crash recovery.** A checkpoint file is written before each model call and deleted after the response is sent. If the process dies mid-call, the next startup finds the checkpoint and notifies the user to resend. Intentional restarts (exit code 42) are handled separately by `run.sh` so the restart loop distinguishes crashes from the agent restarting itself after writing an extension.

## Configuration

`data/config.yml` controls everything. Copy `config.example.yml` to get started. The example file is heavily commented with all available options, provider examples, and integration patterns.

Environment variables are supported via `${VAR}` syntax. The `.env` file loads automatically.

## CLI

Operator tools for managing Bryti without going through chat. Safe to run while the server is running.

```bash
bryti help                              # all commands
bryti memory                            # inspect all memory tiers
bryti memory projections --all          # all projections (including resolved)
bryti memory archival --query "energy"  # search archival memory
bryti reflect                           # run reflection pass now
bryti archive-fact "dentist confirmed"  # insert fact, trigger matching projections
bryti version                           # show version
bryti google accounts --user-id USER_ID # connected private Google aliases
bryti google login --user-id USER_ID --account personal --email owner@example.com
```

## Contributing

Run `npm run check` to run the tests, build the application, and verify the compiled PDF worker against local text and image fixtures.

Found a bug or have an idea? [Open an issue](https://github.com/larsderidder/bryti/issues). Pull requests welcome.

## License

[AGPL-3.0](LICENSE)
