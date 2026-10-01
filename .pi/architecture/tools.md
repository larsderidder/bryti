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
- Parallel: `src/tools/parallel-search.ts` supplies `parallel_search` and `parallel_fetch` when `tools.web_search.parallel_enabled` is true (default false). Research workers inherit them from the `web_search` permission; main sessions additionally require the `web` group and elevated-tool approvals. Only fixed anonymous Parallel calls are allowed, using the native MCP client internally without loading configurable servers or extensions. Calls send public hints and opaque session IDs, enforce deadlines and size bounds, validate extraction URLs, and label returned evidence untrusted. Existing web tools are unchanged.
- Skills: skill_install (agent writes skills to `data/skills/`)
- Tool discovery: native `tool_search` ranks deferred extension and MCP tools using names, schemas, descriptions, and namespaces, then activates matches additively.
- Codemode: the main session registers native `createCodemodeExtension({ mode: "on", models: false })` and activates it additively. Direct calls remain available; workers do not receive codemode. Scripts can compose active direct and deferred tools while only their output enters model context. Nested calls retain approval wrappers, audit events, and topic-delivery tracking. Script state persists through native `codemode-store` entries.
- Google: `src/integrations/google-tools.ts` registers account aliases, Calendar, Gmail, and Search Console tools only for users selected by `google.users`. Calls remain approval-wrapped. `src/agent.ts` removes overlapping legacy Google extension definitions for those users before discovery.
- SearXNG: `src/tools/searxng.ts` validates operator endpoints, bounds response bytes, rejects redirects, verifies HTTPS certificates, propagates cancellation, and filters malformed result entries. `src/tools/web-search.ts` owns a bounded per-tool TTL cache and returns cloned, untrusted search data.

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

`src/agent.ts` loads native codemode, MCP, and discovery factories. Only codemode definitions captured by identity from the trusted SDK factory bypass the agent-written extension policy. `src/tools/extension-policy.ts` wraps extension execution with Bryti approvals and marks unsupported schemas as hidden before registration. `src/tools/tool-search.ts` refreshes prompt metadata and reconciles persisted tool declarations after asynchronous MCP startup. The custom prompt summarizes codemode without duplicating its generated tool catalog.

- The system prompt lists only active tools through `src/system-prompt.ts` → buildToolSection()
- Tool activation is additive so supported providers can preserve their prompt-cache prefix
- Quarantined extension tools are excluded from both the initial active set and the searchable catalog
- Grouped by: standard groups, workers, and opt-in direct web access (based on config)

## MCP

`src/tools/mcp.ts` reads only `data/users/<userId>/mcp.json`. There are no default servers and no implicit global/project MCP configuration. Native transports provide stdio and streamable HTTP. Server and tool exposure are deferred, with explicit hidden tools preserved. MCP-triggered codemode activation is disabled; the main session enables codemode independently.

OAuth credentials use `data/users/<userId>/mcp-auth.json`, atomic private writes, and cross-process refresh locks compatible with pi. Operator sign-in uses `PI_CODING_AGENT_DIR=<user-directory> pi mcp login <server>`; there is no chat OAuth flow. Native metadata and structured results are preserved through the approval wrapper. Session disposal awaits native shutdown hooks before disposing the SDK. Workers do not load extensions or MCP.

## Google accounts and email previews

`src/integrations/google-auth.ts` owns private per-user/account tokens, refresh locks, bounded Google API requests, and operator-only loopback OAuth with PKCE and random state. `src/cli.ts` exposes `google login` and `google accounts`; login cannot overwrite an existing alias. Legacy credentials remain untouched, with no shared-token fallback for native tools.

`src/integrations/email-config.ts` validates opt-in Gmail/IMAP triggers and destinations. `email-readers.ts` uses read-only Gmail history or verified-TLS IMAP polling with bounded batches and source-bound cursors. `email-watcher.ts` requires an allowlisted From plus aligned DMARC evidence in the receiver's first authentication header. IMAP needs explicitly trusted authserv IDs and an MTA that removes forged headers; DMARC establishes domain authentication, not independent mailbox identity.

The watcher advances cursors only after durable notice acceptance and deduplicates accepted mail across restarts. Initial connection baselines old mail; history gaps emit a notice and rebaseline. `email_notice` bypasses commands, approvals, memory, sessions, and models in `src/process-message.ts`, using plain-text durable delivery. Application shutdown aborts and awaits polling.

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
