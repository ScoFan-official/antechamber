# Development

## Source layout

One line per module in `src/`:

| File | Responsibility |
|---|---|
| `cli.ts` | CLI entry point: argument parsing and lazy dispatch to serve, setup, doctor, upgrade, version and help |
| `version.ts` | Runtime package.json version and the separate OpenCode 2.x compatibility constant |
| `commands/serve.ts` | Default/OpenCode-compatible server startup, bind guard and shutdown signals |
| `commands/setup.ts` | OpenChamber settings, optional auto-update launcher and systemd drop-in plans, backups and configuration |
| `commands/upgrade.ts` | `antechamber upgrade` output around `selfUpdate` |
| `self-update.ts` | Global npm/bun install detection, npm registry lookup, and the single-flight installer run behind `upgrade`, `POST /global/upgrade` and `ANTECHAMBER_AUTO_UPDATE` |
| `commands/doctor.ts` | Read-only installation diagnostics and text/JSON reporting |
| `running-servers.ts` | `serve` records its PID, version and URL under `<state>/run/` so doctor can report what is actually running |
| `commands/context.ts` | Injectable filesystem/environment/exec dependencies, executable and settings resolution |
| `commands/help.ts` | Command and option reference printed by help |
| `pidfd.ts` | Shared bounded Python/Linux pidfd capability probe for doctor and session-host teardown |
| `server.ts` | `AdapterServer` composition root: service wiring, request dispatch, start/stop/url |
| `http.ts` | Shared HTTP body reader, JSON/error responses, authentication, origin checks, and CORS |
| `sse.ts` | SSE subscriber registry, v1/v2 framing, bounded replay, heartbeat, backpressure, and teardown |
| `route-services.ts` | Shared route service contract, model parsing, async prompt admission, and compatibility version |
| `routes-v1.ts` | OpenCode v1 HTTP routes, receiving session, catalog, body-reader, and event services |
| `routes-v2.ts` | OpenCode v2 `/api/*` HTTP routes and route-specific response adapters |
| `v2.ts` | OpenCode v2 API translation layer (session/message shapes, v2 event translator) |
| `sessions.ts` | `SessionManager`: registry, persistence, lifecycle, prompt/abort/fork/revert orchestration |
| `session-history.ts` | Reconstructs OpenCode messages, stable parts, and pending inputs from pi JSONL history |
| `pi-event-translation.ts` | Shared pi message/part helpers and live event translation with explicit manager services |
| `session-store.ts` | Session registry persistence (directory, ancestry, metadata, model, tree, and part-ID mappings) |
| `session-tree.ts` | Agent session-tree parsing (JSONL entries, fork/revert navigation) |
| `session-hosts.ts` | Teardown of detached OmO task-host processes antechamber owns: Linux pidfd, macOS `ps` + `lsof` |
| `session-commands.ts` | Slash commands, shell execution, compaction, share (unsupported) |
| `session-diff.ts` | `GET /session/:id/diff` unified-patch computation |
| `pi-rpc.ts` | Low-level pi/OmO RPC subprocess management: spawn, JSONL framing, capability passthrough, request correlation |
| `approvals.ts` | Permission/question bridging through the agent's extension-UI protocol |
| `question-forms.ts` | Converts pending native questions into v2 forms and parses form replies |
| `subagents.ts` | Subagent/task card tracking and child-transcript resolution |
| `monitor-sessions.ts` | OmO terminal monitors as read-only child sessions (v1 clients) |
| `work-status.ts` | Background-work snapshot and actions behind `/antechamber/work-status` for the OmO Work section |
| `todo-bridge.ts` | Translates the agent's todo tool calls into OpenCode todo state |
| `thinking-levels.ts` | Maps OmO thinking levels onto OpenChamber's model/variant picker |
| `tool-map.ts` | Maps pi/OmO tool-call events onto OpenCode v2 `ToolState` |
| `catalog.ts` | Model/agent catalog construction from the running agent |
| `agent-name.ts` | Agent name detection (env override, `oh-my-pi.jsonc`, package detection, fallback) |
| `agent-dir.ts` | Resolves the pi/OmO agent directory (`PI_CODING_AGENT_DIR` / `OMO_CODING_AGENT_DIR`) |
| `lifecycle.ts` | Idle session reaping and the live-process cap |
| `misc-routes.ts` | Filesystem/search routes and unsupported-capability stubs (MCP, OAuth, skills, LSP, formatter) |
| `config.ts` | Environment variable reading (`ANTECHAMBER_`/`OCPI_` prefix fallback), state directory resolution |
| `types.ts` | Shared OpenCode v1 type definitions |

`extensions/omo-dag/` holds the OmO Graph OpenChamber extension: a sandboxed
panel (`src/panel.ts`, `panel/index.html`) and a read-only local service
(`src/service.ts`) that builds the sub-agent graph from OmO's task store and
the session registry. It has its own `tsconfig.json` (DOM and Node), because
the panel runs in a browser iframe. It shares the root toolchain:
`npm run build` bundles it with esbuild (`npm run build:extension` alone), and
`npm run typecheck`, `npm run lint` and `npm test` cover it. The bundles
(`panel/main.js`, `service/main.js`) are gitignored but listed in the
package's `files`. See [extensions/omo-dag/README.md](../extensions/omo-dag/README.md).

`extensions/omo-work/` holds the OmO Work extension for OpenChamber 2.x: a
Work Status section (`src/status.ts`, `status/index.html`) and a local service
(`src/service.ts`, `src/discovery.ts`) that finds the running antechamber
through its run record and relays `/antechamber/work-status`. It imports the
adapter's snapshot types, uses the 2.x SDK through the `@openchamber/sdk-v2`
alias, and builds, typechecks and tests with the same root commands. See
[extensions/omo-work/README.md](../extensions/omo-work/README.md).

`extensions/omo-compat/` holds the OmO Compatibility extension: a manifest with
no code. It declares OpenChamber display rules (`contributes.tools`) for tool
calls antechamber maps from OmO, such as the eval card header read from
`metadata.evalTitle`/`evalSubtitle`. Display behavior that only an extension can
add goes there, not in OmO Graph. See
[extensions/omo-compat/README.md](../extensions/omo-compat/README.md).

## Testing

```bash
npm run typecheck
npm test
npm run build
```

`npm test` runs `test/*.test.ts` and `extensions/*/test/*.test.ts` under
Node's built-in test runner (`tsx --test`). The extension's
`connector-parity.test.ts` imports `ocIdFor` and `SessionRegistryEntry` from
`src/session-store.ts`. Changing session ids or registry fields therefore
means updating the extension in the same change. OmO Work's `src/model.ts`
imports its snapshot types from `src/work-status.ts`, so a snapshot change
fails `npm run typecheck` until the section follows; `manifest.test.ts` runs
the OpenChamber 2.x manifest parser on its `package.json`. These tests are hermetic: they don't require a real `pi` or
`omo` binary on PATH, and use fixtures under `test/fixtures/` (fake RPC
processes, fake OmO endpoints, recorded tool-call payloads) to exercise the
adapter logic in isolation.

Keep new tests hermetic and free of fixed sleeps. If a test needs to wait on
an async state change (an RPC event, a process exit), subscribe to that
signal with a bounded timeout rather than polling or sleeping a fixed
duration.

## Smoke scripts

The scripts under `contrib/` drive a real agent process end to end and make
real model calls, so they cost tokens and are not run in CI:

| Script | Command | What it checks |
|---|---|---|
| `contrib/smoke.ts` | `npm run smoke` | End-to-end smoke against a real `pi` process: bootstrap probes, a full tool round, abort, rename, delete |
| `contrib/omo/omo-smoke.ts` | `npm run omo-smoke` | End-to-end smoke against a real `omo` process, including OmO-specific features (fork/revert/unrevert, subagents, approvals, shell, compaction). Runs in an isolated HOME and private state directory; see `contrib/omo/smoke/README.md`. |
| `contrib/probe.ts` | `npm run probe` | Dumps raw pi/OmO RPC events to a JSONL file for protocol inspection |
| `contrib/model-consistency.ts` | `npm run model-smoke` | Checks that model selection/resolution stays consistent across requests |
| `contrib/v2-smoke.ts` | `npm run v2-smoke` | Checks the OpenCode v2 API surface specifically |
| `contrib/replay/transcripts.ts` | `npm run replay` | Opens copies of real sessions in an isolated OpenChamber with headless Chrome, at phone and desktop sizes, and fails when a transcript renders no turn. No agent and no tokens; the data stays local. See `contrib/AGENTS.md`. |

Replay keeps the selected sessions' descendant registry closure in its sandbox,
including archived task children whose only transcript is under `state/children/`.
Transcript references and persisted task session paths are remapped into the
sandbox; project directories remain the original read-only context. This copied
closure is hydrated through the read-only message API before opening the UI,
so restored child costs are available to its rollup. It does not add UI test jobs:
`--children`, `--archived`, and `--limit` still
control only the selected sessions to open. The copy helper is covered by
`test/replay-sandbox.test.ts` without launching an agent, CLI, or browser.

`contrib/omo/smoke/` holds the shared smoke-test harness (`core.ts`,
`context.ts`, and the `checks/` modules loaded by
`contrib/omo/omo-smoke.ts`); see `contrib/omo/smoke/README.md` for how checks
are structured, the `--only` selector, and how to add a new check module.

OmO-specific maintainer tooling (deployment scripts, version-pin tracking,
and similar operational material that isn't part of the general smoke suite)
is expected to live under `contrib/omo/` going forward rather than at the
repository root or in `docs/`.

## Adding a feature that touches the OpenCode API

1. Check `docs/api-surface.md` for the route/event you're implementing and
   whether OpenChamber actually calls it.
2. Implement the v1 route in `routes-v1.ts` and the v2 route in
   `routes-v2.ts`; shared v2 message/session/event translation lives in `v2.ts`.
3. Add a unit test under `test/` using the existing RPC/HTTP fixtures rather
   than a real agent process.
4. If you're adding or renaming behavior tied to an environment variable,
   update `docs/configuration.md` in the same change.
5. If you changed what a route returns or which routes exist, update
   `docs/api-surface.md`.
