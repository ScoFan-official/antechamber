# src - ADAPTER RUNTIME

## OVERVIEW
The only code compiled to `dist/` (`tsconfig.json` rootDir). It is flat by concern, and `commands/` is the only nested directory.
This file exists because `src` scores 14: 37 files and the repo's highest export density and import centrality. It is also a distinct runtime domain.

## REQUEST FLOW
```
cli.ts (parseArgs, lazy import per command; no command framework)
 -> commands/serve.ts (unsafe-bind/auth guard, signals)
 -> server.ts AdapterServer (Http + SSE + SessionManager + catalog cache)
    /event, /global/event -> v1 SSE      /api/event -> v2 SSE
    /api/* -> routes-v2.ts               else -> routes-v1.ts   (both take RouteServices)
 -> sessions.ts SessionManager -> pi-rpc.ts PiRpcClient (spawn `--mode rpc`, JSONL stdio)
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| New/changed route | `routes-v1.ts` + `routes-v2.ts` | v2 shapes/event translator live in `v2.ts` |
| Shared route helpers | `route-services.ts` | model parsing, async prompt admission (204 contract) |
| Prompt/abort/fork/revert orchestration | `sessions.ts` (1262 lines) | owns the conversation-operation queue |
| Live pi events -> OpenCode parts | `pi-event-translation.ts`, `tool-map.ts` | `toolMappers` is per-tool |
| History rebuilt from JSONL | `session-history.ts` | restored messages, pending inputs |
| Fork/revert tree navigation | `session-tree.ts` | `SessionTreeError` -> HTTP 400 |
| Registry on disk | `session-store.ts` | directory map, messageID -> entry id, `connectorOwned` |
| Permissions / questions | `approvals.ts`, `question-forms.ts` | extension-UI sub-protocol |
| Subagent cards, child transcripts | `subagents.ts` | |
| Background monitors as child sessions | `monitor-sessions.ts` | fed by `extension_event` frames; hidden from v2 lists/events |
| OmO Work section data | `work-status.ts` | `/antechamber/work-status`, bearer token from the run record |
| Todos | `todo-bridge.ts` | todo tool calls -> OpenCode todo state |
| Slash commands, shell, compact | `session-commands.ts` | |
| Task-host teardown | `session-hosts.ts`, `pidfd.ts` | Linux pidfd; macOS ps + lsof |
| Auth, origin, CORS, error JSON | `http.ts` | |
| Env settings | `config.ts` | `envSetting(name)` |
| CLI setup/doctor | `commands/` | `context.ts` injects fs/env/exec for tests |

## INVARIANTS
- JSONL frames split on `\n` only. Never use `readline`, which also splits on U+2028/U+2029.
  The frame cap is `MAX_JSONL_FRAME_BYTES` (64 MiB) and the per-command timeout is `RPC_COMMAND_TIMEOUT_MS` (60 s).
  A user `bash` has no deadline until `PiRpcClient.abortBash()`; then it gets the ordinary 60 s.
- Prompt, fork, revert, unrevert, compact, bash and history refresh all share one conversation-operation queue.
  Code that already owns the queue must not enqueue recursively. An abort releases the HTTP waiter but not the ordering barrier.
- Revert only changes conversation context. It never restores files, takes snapshots or computes diffs. Unknown messageIDs are rejected with 400 before any navigation.
- A fork reply does not carry the new identity, so read `get_state.sessionId/sessionFile` afterwards.
- To cancel a user shell, send `abort_bash` first. Plain `abort` does not stop a running `bash` RPC.
- Adapter-authored cards (shell output, notices, error cards) live only in memory.
  They are never matched to JSONL entries, never sent to the model, and do not survive a restart.
  One exception: the agent-stop notice (`msg_agentstop_<time>`) is rebuilt from the registry's `lastStop` until the next prompt.
- Teardown claims task hosts only for `connectorOwned` sessions. Never kill by command line.
  Never signal `openchamber.service` members or the shared OmO LSP daemon.
- Read settings through `envSetting` so the `ANTECHAMBER_` prefix wins and `OCPI_` stays a fallback.
  Exceptions that read `process.env` directly: the OpenCode auth vars in `http.ts` and the RPC capability vars plus child env in `pi-rpc.ts`.

## CONVENTIONS
- `types.ts` holds the OpenCode v1 types (`OC*`). `v2.ts` owns the `V2*` translation shapes; `catalog.ts` has local `OCv2Model` and `OCv2Provider` interfaces. Do not mix these contracts.
- Domain errors (`SessionTreeError`, `SessionPersistenceError`, `ApprovalInputError`) are mapped in `http.ts` to `{name, data: {message}}`. Anything else becomes `UnknownError` 500.
- Debug logging uses `debugLog` (`misc-routes.ts`), gated on `ANTECHAMBER_DEBUG`. The log file is mode 0600, and logging latches off after the first write failure.
- Unsupported capabilities (MCP, OAuth, skills, LSP, formatter) are stubs in `misc-routes.ts`.
  Unsupported called capabilities return 400; never fabricate a successful mutation.
- Env-dependent functions take `env = process.env` and `home = homedir()` parameters so tests can inject them.

## ANTI-PATTERNS
- Adding `index.ts` barrels or a library `exports` field. The package is CLI-only.
- Eager-importing server modules from `cli.ts`. Commands are lazy on purpose.
- Assuming the newest JSONL message is the active branch. Revival reapplies the saved leaf.
