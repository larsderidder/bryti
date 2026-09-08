# Tools

Built-in tools + extension system.

## Built-in tools

`src/tools/index.ts` → createTools()

- Memory: core_memory_append, core_memory_replace, archival_insert, archival_search, conversation_search
- Projections: projection_create, projection_resolve, projection_list, projection_link
- Workers: worker_dispatch, worker_check, worker_interrupt, worker_steer
- Pi sessions: pi_session_list, pi_session_read, pi_session_search, pi_session_inject
- Files: file_read (unsandboxed, any path), file_write + file_list (sandboxed to data/files/)
- Web: web_search, fetch_url. Workers always get fetch_url and get web_search when configured/requested; main agent gets web tools only when `agent.yml` includes the opt-in `web` tool group. `fetch_url` uses npm-native Readability by default, can use Argus when configured, is HTTPS-only by default, and uses SSRF protections before extraction.
- Skills: skill_install (agent writes skills to `data/skills/`)
- Tool discovery: search_tools searches the inactive extension-tool catalog and activates matching tools additively

## Extensions

`defaults/extensions/EXTENSIONS.md` → guide for writing extensions

- TypeScript files in `data/files/extensions/`
- Loaded at startup via pi SDK ResourceLoader
- `pi.registerTool()` only (no TUI, no commands, headless)
- Env vars via config.yml `integrations.<name>.<key>` → `process.env.NAME_KEY`

Default extensions: `defaults/extensions/documents-hedgedoc.ts`, `defaults/extensions/bryti-bridge.ts`

## Skills

Agent-written Python/Bash scripts, not TypeScript extensions.

- Lives in `data/skills/<name>/`
- Installed via `skill_install` tool
- One-shot execution, no persistent session

## Tool registration

`src/agent.ts` registers all tools with pi, then `src/tools/tool-search.ts` keeps Bryti-owned core tools active and defers extension tools until `search_tools` loads them.

- The system prompt lists only active tools through `src/system-prompt.ts` → buildToolSection()
- Tool activation is additive so supported providers can preserve their prompt-cache prefix
- Quarantined extension tools are excluded from both the initial active set and the searchable catalog
- Grouped by: standard groups, workers, and opt-in direct web access (based on config)

## Execution and delivery receipts

- `src/work/store.ts` stores accepted input and separate execution/delivery outcomes in `data/work/receipts.db`. Only queued work is replayed; interrupted execution is not repeated. `/work [id]` exposes receipts only to their owner.
- Startup rebuilds the paused queue from durable acceptance order before draining newly received messages.
- `src/channels/outbound-queue.ts` persists the final response before acknowledging completed execution. Startup reconciles staged responses before generating interruption notices. Only definitely-unsent text is retried; ambiguous sends remain `unknown`. Optional voice is forwarded without replaying caller-owned media.
- Projections persist their originating user, platform, channel, Bryti thread, and channel topic. Scheduler occurrences settle from confirmed receipts, not enqueue success. Failed or uncertain occurrences generate a durable notice and remain paused for explicit review rather than repeating possible side effects.
- `src/projection/occurrence.ts` validates scheduled work against the live projection before execution. Cancelled or rescheduled work skips the model; resolved projections still reconcile delivery without rearming.
- `src/workers/recovery.ts` stores immutable owner routing under `data/work/worker-owners/`, outside worker-writable output directories. Completion notifications are automatic; abandoned workers are interrupted. Owner records retire after durable notification acceptance; result files remain available.
- `src/trust/wrapper.ts` checks first-use arguments. Exact-argument grants include conversation/automation scope and expiry; `/trust` lists grants and `/trust revoke <id>` revokes one.
- Telegram approval callbacks require the requester, chat, topic, and approval message to match. Malformed decisions and callbacks from other allowlisted users cannot resolve the request.
- Optional embeddings degrade to keyword recall during outages. Set `memory.embeddings.required: true` to fail instead.
- `src/durable-file.ts` atomically replaces worker and outbound JSON records, flushing both contents and the directory entry before acknowledgement.
