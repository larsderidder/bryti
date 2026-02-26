# Tools

Built-in tools + extension system.

## Built-in tools

`src/tools/index.ts` → createTools()

- Memory: core_memory_append, core_memory_replace, archival_insert, archival_search, conversation_search
- Projections: projection_create, projection_resolve, projection_list, projection_link
- Workers: worker_dispatch, worker_check, worker_interrupt, worker_steer
- Pi sessions: pi_session_list, pi_session_read, pi_session_search, pi_session_inject
- Files: file_read, file_write, file_list (only in workers, scoped to worker dir)
- Web: web_search, fetch_url (only in workers)
- Skills: skill_install (agent writes skills to `data/skills/`)

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

All tools declared in system prompt via `src/system-prompt.ts` → buildToolSection()

- Capability level shown per tool
- Grouped by: always-on, workers-only, optional (based on config)
