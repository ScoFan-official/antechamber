# Architecture

## Goal

OpenChamber talks to an OpenCode server over HTTP + SSE via
`@opencode-ai/sdk/v2`. The pi coding agent (and OmO, a pi-compatible
distribution) exposes headless operation via RPC mode (`pi --mode rpc`, JSONL
over stdin/stdout) and an in-process SDK (`AgentSession` from
`@earendil-works/pi-coding-agent`).

`antechamber` bridges the two:

```
OpenChamber ──HTTP/SSE (OpenCode API subset)──▶ antechamber ──JSONL stdio──▶ pi/omo --mode rpc
```

OpenChamber is configured to use an **external OpenCode server** pointing at
this adapter. No OpenChamber fork, no pi fork.

## Two backend strategies

| Strategy | Mechanism | Pros | Cons |
|---|---|---|---|
| SDK embed | `AgentSession` in-process | No subprocess overhead, typed API | Ties adapter lifecycle to pi internals |
| RPC subprocess | spawn `pi --mode rpc` per session | Process isolation, version-tolerant, language-stable protocol | One process per session, JSONL framing rules (LF-only) |

Default: **RPC subprocess** (pi documents strict JSONL framing; Node `readline`
is not compliant because it splits on U+2028/U+2029, so we split on `\n` only).
SDK embed stays an option behind the same internal interface.

RPC transport errors and stdout EOF close the client, reject pending requests,
and dispose the owned child process. A response correlated to the wrong command
is an upstream protocol error. A command timeout also closes the transport, so
the process cannot accept another operation whose native completion is unknown:
OmO handles RPC lines concurrently (`dist/modes/rpc/rpc-mode.js`,
`void handleInputLine(line)`), so the adapter's conversation-operation queue is
the only ordering, and a timed-out prompt, fork, navigation or bash that kept
running could land after the next queued operation. Closing is also what
recovers a hung agent mid-turn, which idle eviction cannot (it requires idle).

Requests outside the conversation whose late answer changes nothing go through
`PiRpcClient.probe()`, whose timeout rejects only that request; the late response
finds no pending entry and is dropped. These are OmO Work's
`eval_cells.list/peek/stop` and the MCP listing reads (whose own 5-second abort
usually fires first). Before this split, OmO Work's 10-second `eval_cells.list` lost the race
with a cold start of a large session and killed it, rejecting the user's prompt.

These boundaries are implemented in `src/pi-rpc.ts`.

An agent that stops without antechamber disposing it records a `PiStopReason`
(timeout with command and deadline, frame overflow, spawn failure, broken pipe,
or exit code and signal). A closed stdout followed by an exit status is reported
as the exit, unless that status comes from antechamber's own close signal: OmO
traps SIGTERM and exits 143, so 128 + a sent signal counts as ours. Pending
commands reject with `PiStoppedError`. The session's exit handler shows it: a
notice card in the transcript (`msg_agentstop_<time>`), the same error on the
reply it interrupted, and a `session.error`. A revival unwires its client before
that exit arrives, so a stop that ends a revival is reported from the revival's
failure path instead, once per client. Prompt admission never adds a second
card for that error.
The stop is saved as `lastStop` in the registry and replayed at its original
position after a history re-parse or an adapter restart, until the next prompt.
Idle eviction, delete and shutdown unwire the session before disposing, so they
show nothing.

Default `prompt` timeouts are suspended during active turns, retries, or compaction,
then reset to 60 seconds when work settles, with a 32-minute overall cap.
Explicit deadlines and other RPC commands keep fixed limits, except a user `bash`.
OmO answers it only when the command exits and sets no limit of its own
(senpi 2026.10.25-2 `dist/modes/rpc/connection-handler.js`, `case "bash"`), and an
interactive command such as a login waits on the user. It therefore has no deadline
until Stop sends `abort_bash`; a reply still missing 60 seconds later stops the agent.

While it runs, OmO streams its output as `bash_execution_update {id, delta}` frames,
where `id` is the `executionId` the request carried (`agent-session.js` `executeBash`;
RPC probe 2026-10-28). The adapter sends the card's call id as `executionId` and keeps
the newest 64 KiB on the running card's `metadata.output`, sent at most every 100 ms.
A stopped card keeps that output; a finished card gets OmO's full output.

## Mapping concerns

### Session model

- OpenCode: one server, many sessions, sessions belong to a directory/project.
- pi: one process per session; session persistence as JSONL files
  (`--session-dir`, `switch_session`, `fork`).
- Adapter owns a process pool keyed by session id, and a directory registry
  mapping OpenCode "project/directory" to pi working directory + session dir.

### OmO session tree

Fork/revert/unrevert use `get_entries` (`entries`, `leafId`) and OmO's
session-tree RPCs. Explicit-message `fork {entryId}` copies the history before
the selected user message. OpenChamber restores that prompt into its composer,
matching OmO's default `"before"` position; including an unanswered user tail
would make the UI report a failed reply. An assistant boundary is kept instead
(`position: "at"` on the reply, or on the last result of its own tool calls):
OpenChamber 2.x names an assistant message only from `/btw`, which passes the
last completed reply (`finish: "stop"`, installed 2.5.0 bundle) so the side
thread starts from a settled conversation; OpenChamber 1.24's `/btw` can name any
completed step, whose tool results stay with it. OpenCode's strictly exclusive
`before` would drop that reply (dated 2026-10-25, reported fork
`ses_a7f8...`). With no messageID, `position: "at"`
includes the complete active leaf. Fork returns `{cancelled}` (and sometimes `text`), not
the new identity: the connector reads `get_state.sessionId/sessionFile`.
The RPC process switches to that new file. It is transferred to the forked
OpenChamber session; the original becomes dormant and resumes its original
file in its own process when next used.

The connector records OpenChamber messageID -> OmO entry id in its registry,
preserving client-generated live IDs across restarts. Restored messages
without a recorded mapping use the existing `msg_r<JSONL offset>` scheme.
Revert navigates to the selected user's parent with `intent: "resume"`:
without that intent OmO's tree selection would skip user/custom-message
parents. The registry saves the previous leaf, current leaf, and cutoff
messageID. Repeated revert retains the original redo leaf. Unrevert restores
it; a new prompt clears the cutoff and starts a branch at the earlier leaf.
Revival reapplies the saved leaf rather than assuming the newest JSONL
message is the active branch. The reverted transcript is retained for redo.

Native progress is checkpointed at `agent_end`, successful `compaction_end`, and
process exit. Checkpoints advance only to descendants of the saved leaf.

Dormant history reads check the native file size against the parsed cache.
When another client appends, the next read rebuilds native messages and tool
results while retaining adapter-local notices. Branch advancement still requires
a descendant of the saved selection; a staged revert remains pinned.
Live RPC-owned history continues to use its event-driven cache.

Restoring a task child loads its retained transcript and computes its own cost
and token totals before the session is returned or listed. Child costs remain
separate from the parent's own spend: OpenChamber sums sessions by `parentID`.

Synthetic compaction markers and summaries never bind to ordinary native
messages. History reconstruction removes legacy bindings for these reserved IDs
before assigning native message and part identities. Otherwise a summary and a
cost-bearing reply can share one ID and a later refresh drops the reply.
Evidence: copied-session revival through the HTTP message endpoint on
2026-10-19 lost nine tool-bearing replies before this repair and retained them
after it.

Compaction is displayed as a user-role compaction marker and its assistant
summary. Subsequent replies use that marker as their display parent until a new
user prompt, both live and in restored history. The native `clientMessageId` and
active input identity still refer to the real prompt. Otherwise OpenChamber
groups the continuation under the earlier prompt and moves older compaction
markers below newer output. Evidence: the installed OpenChamber 1.24.2
`useAppFontEffects-DcdrFv2Z.js` parent-based turn projector and copied-session
desktop/phone replay on 2026-10-18.

OmO cancels a running compaction whenever its active tool set changes
(`setActiveTools` -> `abortCompaction`, senpi `chunks/chunk-NNQ7DPUD.js`), and a
freshly started agent registers its MCP servers' tools about a second after
`get_state` answers. A `/compact` that revives a dormant session therefore waits
(at most 10 s) until `get_loaded_surfaces` reports no server `connecting`,
re-reading it on each `loaded_surfaces_changed` event. Cancellations nobody asked
for are still retried up to four times, and a retried cancellation is not
published, so OpenChamber 2.5 (which draws `session.compaction.failed` as a
transcript row) shows one compaction. Evidence: OmO `logs/session.log` on
2026-10-27 (two `aborted` decisions within a second of startup, then
`committed`), and a real-OmO probe on 2026-10-28: three servers `connecting`
after `get_state`, all `connected` 871 ms later.

The registry also stores the published part IDs in message order under each
stable message ID. On history reconstruction, those IDs are restored onto the
parsed parts so clients keep their live identities after a restart. History
with no saved mapping keeps the deterministic IDs derived from native entries.
Adapter-authored local cards are excluded from this mapping.

Fork admission holds the lifecycle slot across native tree navigation, client
transfer, and publication of the child owner. A concurrent create or revival
therefore cannot observe the in-flight transfer as an available process slot.

Revert only changes conversation context. It never invokes a filesystem
restore, snapshot, or diff operation. The adapter publishes the cutoff as
`session.revert` and adds no transcript card: OpenChamber renders its own
reverted-message dock from that field. Unknown messageIDs are rejected with
HTTP 400 before navigation.

History refreshes and compact/bash RPCs share the conversation-operation queue
with prompt, fork, revert and unrevert. A refresh cannot read an intermediate
navigation state or overwrite the cursor before its operation completes.
Cancellation releases only the caller's HTTP waiter; it does not release the
native operation's queue lease. If a queued shell is cancelled, it rejects
after its predecessor completes and before dispatching a bash RPC. A dispatched
operation retains the ordering barrier until its native reply or timeout. A
dispatched shell continues to use `abort_bash`.

Adapter-authored shell cards and notices are retained in canonical in-memory
history, not appended to the revert-notice projection. While reverted, new
cards are inserted before the hidden redo branch and belong to the last visible
user turn, so completed shell output remains rendered. Refresh, unrevert and a
replacement prompt retain these cards; they are never matched to OmO JSONL
entries or sent to the model. This retention lasts for the connector process,
not across connector restarts: adapter-only cards are not persisted transcripts.

### Event translation

| OpenCode (SSE `event`) | pi (stdout JSONL) |
|---|---|
| `message.updated` / `message.part.updated` | `message_update` (`assistantMessageEvent`: `text_delta` etc.) |
| `message.part.updated` (tool part) | `message_update` (`toolcall_start`/`toolcall_delta`/`toolcall_end`) + `turn_end` (`toolResults[]` by `toolCallId`) |
| `session.status` / `session.idle` | turn lifecycle events (`agent_start`/`agent_end`-family) |
| `permission.asked` | pi extension-UI sub-protocol (`extension_ui_request`/`extension_ui_response`); semantics differ, map conservatively |
| `session.error` | `extension_error`, RPC error responses |

V1 prompt bodies retain supported text, file, and agent parts. Inline image
data becomes native image input, inline text files become prompt text, and
agent mentions become `@name` text. Other inline attachments (PDF, archives...)
are saved under `<state dir>/attachments/<sha256>/<filename>` (mode `0600`)
and reach the agent as a `{filename, mime, url}` file reference, like a
workspace file, so its own tools can read them. The path is content-addressed,
so re-deriving the prompt when history binds it yields the same text. Slash-command file parts use the same adaptation. V1 `delivery`
defaults to `steer` and can select `queue`, which maps to native
`streamingBehavior: followUp`.

For text and reasoning, the adapter emits the v1 `message.part.delta` before
the authoritative `message.part.updated` snapshot; the snapshot does not
repeat the append delta. This preserves a single append in clients that also
replace their cached part from snapshots.

V2 failed steps publish usage and error data on `session.step.failed` with
`rawFinish: "error"`, followed by `session.execution.failed`. User
interruptions publish `session.execution.interrupted` with `reason: "user"`.
Successful executions use `session.execution.succeeded`; failed or interrupted
executions do not later publish a success terminal. These transitions are
translated in `src/v2.ts`.

When the RPC process exits during a turn, the adapter finalizes streaming text,
reasoning, and tool parts before publishing the session error and idle status.
This prevents cards from remaining in a running state after process exit
(`src/sessions.ts`, `src/pi-event-translation.ts`).

The v1 asynchronous prompt route keeps its HTTP 204 contract. If prompt submission
rejects, including a registry write before RPC dispatch, it emits `session.error`
and appends an assistant error message to canonical session history. The error
name and message are available through both SSE and the message GET route; a
failed disk write does not depend on another successful disk write to report
the failure. These adapter-authored error cards have the in-memory retention
described above, not restart durability.

### Shutdown ownership

The connector owns its per-session RPC process groups. It also owns detached
task-host shards for parent sessions it **created**, including forks. It does
not claim task hosts for sessions discovered/restored from another OmO client.
The registry saves `connectorOwned: true` for new sessions and forks so this
ownership survives connector restart. Unmarked legacy/discovered sessions are
not retroactively claimed.
Created session IDs remain tracked after removal or idle reaping, so their
private hosts are still covered by final connector shutdown.

This is a split ownership decision based on the installed OmO implementation
inspected on October 13, 2026:

- `omo-ai/plugin/extensions/omo-task.js`, bundled functions `P2`, `A2`, `nI`
  and `bq`: a root task shard is `p-<key>.sock`, where `key` is the first
  16 hex characters of SHA-256 of `"p:" + parentSessionId`. Nested children
  inherit `shard_key` and attach to that same parent tree. Independent parent
  sessions get different shards, even within one project. The sidecar records
  `owner_session_id`, `owner_session_file` and participating task stores.
- `@code-yeongyu/senpi/dist/modes/rpc/host-ensure-start.js:51-64` detaches
  the supervisor. `host-lifecycle.js:362-393` spawns its engine without
  detaching it again; both therefore belong to the supervisor's process group.
  `host-lifecycle-policy.js:1-7` defines the default 15-minute idle window.
  The general host mechanism can serve multiple clients; that alone does not
  make a connector-created parent shard shared with unrelated parent sessions.
- `omo-ai/plugin/runtime/lsp-daemon/dist/paths.js:43-66` keys the LSP
  endpoint by HOME (or its explicit daemon-directory override) and package
  version, not by a session or project. `request-routing.js:12-29,70-81`
  supplies per-request context to the same daemon.
  `ensure-daemon.js:22-36,100-122` probes/reuses it and detaches only on
  startup. Killing it would interrupt other OmO sessions/projects.
  `daemon-server.js:11-15,74-89` actually specifies **30 idle minutes**,
  with connections and LSP clients preventing expiry. It is not the task
  supervisor's 15-minute policy. `index.js:565-582` also detaches the daemon's
  language servers; their observed parent ancestry, not just one process group,
  establishes that they belong to the same shared LSP infrastructure.

After its RPC groups stop, the connector finds private supervisors by the
exact shard basename derived from a newly created session ID plus that
session's working directory. It requires a detached group leader and records
its process start time before signalling that group: kernel start time from
`/proc` on Linux, `ps lstart` on macOS. Shutdown subscribes to
member death, sends SIGTERM, and escalates after five seconds with a ten-second
deadline. It refuses to signal any observed member of `openchamber.service`.
No broad command-line kill is used. The real-process regression proves that a
different session's supervisor and engine in the same directory stay alive.
The regression harness itself needs Linux `/proc` and GNU `tail --pid`; the
teardown path it exercises also runs on macOS through `ps` and `lsof`.

The smoke assertion runs **before any harness termination**. Surviving RPC
groups, private task hosts and unknown processes fail immediately. Only the
shared LSP daemon and its observed descendants, outside recorded RPC groups, are reported as
`NON-CONNECTOR OmO-owned, outside connector scope`, with PID and command line.
That report is not evidence of connector teardown. The harness later cleans
its private HOME's helpers in its separate `finally` cleanup; cleanup can
never turn a failed shutdown assertion into a PASS.

The adapter is the one process whose death stops every session: OmO
exits when its RPC pipes close, and a DAG lives in the parent session's
agent. On Linux each spawned agent's `oom_score_adj` is therefore raised to
the adapter's own plus 300 (capped at 1000). Agents, their tools and the task
hosts they start inherit it, so the kernel OOM killer and earlyoom take a
workload first. On 2026-10-27, eight parallel exec/verify lanes running vitest
and tsc pushed a 16 GB WSL host under earlyoom's limits; every process in
`openchamber.service` shared `oom_score_adj=200`, earlyoom avoids `bun` (the
agents) but not `node`, and it SIGTERMed then SIGKILLed the adapter at 589 MiB,
taking the DAG's driving agent and its unfinished children with it.

### User shell cancellation and extension commands

The installed OmO RPC exposes two different abort commands. `abort` acknowledges
an agent-turn interruption but does not stop a user `bash` RPC. `abort_bash`
aborts the active user-shell execution. Probes on 2026-10-13 with
`omo --mode rpc --no-session --model anthropic/claude-haiku-4-5` observed:

- `abort` returned `{success: true}` while the same OS `sleep 600` process
  remained alive and the bash request remained unanswered.
- In a separate probe, `abort_bash` returned `{success: true}` and the pending
  bash returned `{output: "", cancelled: true, truncated: false}` within
  10 milliseconds. Both observed sleep PIDs were gone after `abort_bash`.
  A cancelled result can omit `exitCode`; the adapter normalizes it to `null`.

The connector dispatches `abort_bash` for an active shell before ordinary
`abort`, releases its correlated bash waiter immediately, and emits an error
tool state with `metadata.cancelled: true` and `Command cancelled`. The composer
returns to idle without waiting for the 60-second transport deadline. Removing
the correlation and its timeout prevents a late response from completing or
duplicating the cancelled card, reloading history, or changing a resumed turn.
The same abort signal covers the follow-up history and navigation RPCs, so
Stop also releases a shell whose bash result arrived but whose history refresh
is still pending. Aborted refresh replies are discarded before history mutation.
The adapter dispatch is not itself proof that an arbitrary remote shell has
stopped; the real local OmO probe and manual QA check the OS process as well.

Print-only extension commands do not necessarily emit `agent_start` or
`agent_end`. The real `get_commands` catalog includes `/ttsr`, which reports
its status through `extension_ui_request {method: "notify"}` and returns
`prompt {success: true, data: {disposition: "handled"}}`. The connector renders
notifications received during a slash invocation as assistant text and treats
that handled response as completion, returning the session to idle. Prompts
that start an agent turn still use the agent lifecycle events for completion.

This is a connector-only mapping of the installed OmO protocol, not a change
to OmO or its settings.

### Background monitors

OpenChamber 1.24 has no surface for an agent's background watches, but it
already lists child sessions under Subagents and gives each sidebar row a live
dot. For v1 clients the connector therefore shows each OmO terminal monitor as
a read-only child session of the session that started it: `busy` while the watch is live, `idle`
once it ends. Its transcript is one `bash` tool card holding the watched
command, the filter, the event count and how the watch ended. The parent
session's own status is untouched, so the composer, queued messages, fork and
revert keep working while a watch waits. A live watch does keep the parent's
agent process out of idle eviction (`ANTECHAMBER_IDLE_TIMEOUT_MS`), because
evicting it would stop the watch.

Detached eval cells get the same protection: evicting the agent process kills
every cell still running in its kernels. senpi-codemode publishes them as a
`wake_source_state` extension event with `source: "senpi-codemode"` and
`activeCount`, and the connector keeps the session out of idle eviction while
any wake source it has seen over RPC reports a non-zero count. The snapshot
that drops the count to zero is itself an agent event, so the idle window
restarts when the last cell settles. The agent process exiting clears every
wake source, so a dead agent cannot pin a revived session.

Background terminal sessions (`bash` with `run_in_background`, or a command
that auto-detached) are protected too. They are owned by the agent process (its
PTY closes when it exits), so eviction kills them, and their exit
notification, which would have woken the session, never arrives. Their wake
source is bus-only, so the connector reads the terminal manifest (see the OmO
Work section below) instead, and it keeps the session out of idle eviction
while an entry's recorded `runtime.pid` is alive and its `startedAtMs` is not
before the current agent process was spawned. An entry without `runtime` does
not count, matching OmO's own restore check. Entries from an earlier process
do not count either: a crashed or evicted agent never records their exit, and
the pid may since belong to an unrelated process (OmO's own check also
compares process start time and argv). After a fork, the shell moves to the
child's manifest only on OmO's next background change, so until then the
child is not protected. Observed on October 24, 2026: a CI poller started as
`bash_1` was reaped 15 minutes after the turn ended, and the next prompt found
`No terminal session found with id: bash_1`.

Evidence, from the installed `@code-yeongyu/senpi` runtime bundle
(`dist/bundle/chunks/chunk-NNQ7DPUD.js`) inspected on October 24, 2026:
`recordBackgroundStart(id, command, startedAtMs, runtime)` and
`recordBackgroundExit(id)` rewrite the manifest, and `defaultBackgroundAlive`
treats `runtime === undefined` as not alive.

Evidence, from the installed `@code-yeongyu/senpi-codemode` 2026.10.19-2
package inspected on October 23, 2026:

- `src/index.ts` (`emitWakeSourceState`) sends
  `pi.rpc.emit("wake_source_state", state)` alongside the in-process bus.
- `src/extension/wake-source-state.ts` documents the contract: a full
  per-source snapshot on every liveness transition and once on
  `session_start`, so a revived session reports its cells again.
- Other wake sources (background tasks, omo-dag runs, team members, and the
  terminal extension's own `terminal-monitors` source) publish on the
  in-process bus only and never reach the connector; terminal monitors are
  covered by `terminal_monitor_state` above.

Evidence, from the installed `@code-yeongyu/senpi` bundle inspected on
October 15, 2026:

- `core/extensions/builtin/terminal/extension-state.js` (`bundleSinks`) sends
  `pi.rpc.emit("terminal_monitor_state", {activeCount, monitors})` on every
  monitor change and fire, and `pi.rpc.emit("terminal_monitor_ended", event)`
  when one ends. `session-bundle.js` (`bind`) re-publishes the snapshot when
  the terminal bundle binds, so a revived session reports its restored
  persistent watches again.
- `modes/rpc/connection-handler.js` forwards those as
  `{type: "extension_event", name, data}` only to clients that advertise the
  `extension_events` capability, which the connector now does.
- `core/extensions/builtin/monitor-state-event.js` defines the ended reasons
  `exit`, `timeout`, `killed` and `disposed`.
- Background bash sessions (`terminal-background-sessions`) are published
  only on OmO's in-process event bus, not over RPC, so they are not shown yet.

Monitor child sessions live only in memory, like adapter-authored cards. A
watch the user deletes is not recreated by a later snapshot. When the agent
process exits, its watches are marked ended.

OpenChamber 2.x clients do not see these children: `/api/session`,
`/api/session/active` and the `/api/event` stream leave them out, and the
watches are reported as OpenCode shells instead (next section). The
`/api/global/event/ws` socket keeps them, because it carries v1-shaped events
for OpenChamber 1.24.

### OmO background work as OpenCode shells

OmO's main agent ends its turn while monitors, detached eval cells and
background terminal sessions keep running, and each of them wakes it again.
OpenChamber 2.x already models that pause for OpenCode's own background
commands: an idle session with a running shell keeps its turn open, reads as
"Background command" in the sidebar, tabs and switcher, holds its turn timer,
and lists the commands above the composer with their output and a Stop button.
Running shells do not hold queued messages (only running subagents do), so a
user message still reaches OmO at once. `omo-shells.ts` reports OmO's work
through that contract, from the same sources idle eviction and OmO Work use.

Evidence, from OpenChamber 2.5.2 (`packages/ui`) read on October 27, 2026, and
replayed against its own sync code with antechamber-shaped envelopes:

- `sync/global-session-status.ts` (`useSessionTurnActivity`) resolves a
  session's activity to `running`, `workflow`, `subagent` or `shell`; `shell`
  comes from `sync/background-shells.ts`.
- That index is filled by `GET /api/shell` (directory bootstrap and stream
  reconnects) and the `shell.created` / `shell.exited` / `shell.deleted`
  events; `lib/opencode/background-shell.ts` (`runningShellFromWire`) ignores a
  shell without `metadata.sessionID`.
- A shell first seen on the event stream counts as background (and appears in
  the list above the composer) only once a tool call settles with
  `metadata: {status: "running", shellID}`; one first seen in a list read always
  counts, but a list read keeps what the stream said about a shell it already
  holds (`replaceDirectoryShells`). A `shell` card with that metadata is drawn from the shell: live
  output from `GET /api/shell/{id}/output`, a Stop button, then its result.
- Stop posts a synthetic note carrying `openchamberShellCancellation` and only
  then calls `DELETE /api/shell/{id}`; nothing is removed when the note fails.
- `@opencode/client` 2.1.4 returns each response body as is, and
  `readShellOutput` reads `.data`: single-shell and output answers are
  `{location, data}` like the list.
- `@opencode/schema` 2.1.4 `shell.js`: ids start with `sh_`; `Info` is
  `{id, status, command, cwd, shell, file, pid?, exit?, signal?, metadata,
  time: {started, completed?}}`; `Output` is `{output, cursor, size,
  truncated}` over an append-only byte stream.

Identity and sources:

- Monitors (`terminal_monitor_state`) and background terminal sessions (the
  terminal manifest) share OmO's `bash_N` numbering, which restarts with each
  agent process, so both are `sh_t<agent start, base 36>_<bash_N>`. Manifest
  entries follow the idle-eviction rule: a live `runtime.pid` and a start no
  earlier than the current agent process.
- Detached eval cells (the codemode wake source) are `sh_e_<cellId>`; a cell id
  is the id of the eval call that started it.
- The bridge reconciles a session after monitor and wake-source snapshots, tool
  results, turn and run ends, and custom messages (OmO's background-finished
  notifications), and before answering `GET /api/shell`. The manifest has no
  RPC event, so a background session started by a detached cell after its own
  result appears at the next of those. When the agent process exits, when
  antechamber disposes it (`lifecycle.dormant`: idle eviction, a failed tree
  refresh, which unwires the exit handler first), or when the session is
  removed, every shell it ran ends as `killed`.
- End status: a watch's ended reason and exit code; a stopped eval cell is
  `killed`; OmO's finished notification gives a background session's status
  and exit code ("bash_3 finished: killed (exit code 137)") and a cell's
  outcome (a failed cell reads as exit 1) when it arrives before the work
  disappears, else the shell ends `exited`.

Cards: a card that leaves work running (`background-results.ts`) records the
shell it stands for, `backgroundShellID`: the detached cell itself, else the
first background session it launched. A `monitor` call records its watch from
`details.bash_id` (`terminal/tools/monitor.js`, `textResult("Monitor started
with ID: ...", {details: {monitor_id, bash_id, monitor: true}})`), and a
monitor started inside eval records it on its nested card. On v2 such a card
settles at once, as OpenCode settles a call it moved to the background, with
`{status: "running", shellID}` in its metadata; v1 keeps the card running
until the work reports finishing. When it does, v2 re-announces the card as a
plain completed one. Work with no card (a watch a revived agent restored, or a
second background session from the same cell) still keeps the turn open, but
reaches the list above the composer only once OpenChamber is reloaded and reads
it from `GET /api/shell` first. A history rebuilt from the session file
(revert, fork, compaction, revival) settles every waiting card, so its cards
lose the link the same way.

Output: each shell keeps an append-only log. A watch's log is its command and
filter, then each matched line once: lines are counted as OmO sends them, so
the 200 the watch keeps never repeat. An eval cell's log follows
`eval_cells.peek`, which returns at most a 64 KiB tail, continuing where the
new tail's start matches the known end. Pages end on a character boundary. Background
terminal sessions have no output OmO exposes over RPC; their output is a
one-line notice.

Stop: only eval cells (`eval_cells.stop`). The terminal extension registers no
RPC request to stop a monitor or a background session, so `DELETE` answers 400
and the stop note naming one is refused before it reaches the agent.

### OmO Work status section

`extensions/omo-work` is an OpenChamber 2.x Work Status section
(`contributes.statusSection`) for the session's work OpenChamber has no surface
for: the todo list, the goal continuation timer and other wake sources.
Monitors, eval cells and background terminal sessions are OpenChamber's own
background commands (previous section), so the section no longer lists them;
the snapshot still carries them for extension versions installed before. Its local
service reads `<state dir>/run/<pid>.json`, which `serve` writes with a random
`token` (file 0600, directory 0700), and calls
`/antechamber/work-status/<session>` with that bearer token. The token opens
only `/antechamber/work-status` routes, so the service never needs the OpenCode server
password, which OpenChamber does not pass to extension services.

`work-status.ts` builds the snapshot from these sources, read in the installed
`omo-ai` 5.1.33 / `@code-yeongyu/senpi` 2026.10.13 bundles on October 20,
2026:

- Todo phases: the `senpi.todo-state` entries the todo bridge already follows,
  kept with their phase grouping.
- Monitors: the `terminal_monitor_state` / `terminal_monitor_ended` events
  above, with the latest matched lines.
- Detached eval cells: senpi-codemode publishes
  `wake_source_state {source: "senpi-codemode", activeCount, items}` over RPC
  (`senpi-codemode/src/index.ts`, `emitWakeSourceState`) and answers
  `eval_cells.list`, `eval_cells.peek` and `eval_cells.stop`
  (`src/extension/eval-cells-rpc.ts`). The list is cached for one second per
  session; without it (no codemode, or a dormant agent) the wake-source items
  are shown as running cells.
- Background terminal sessions: their wake source is bus-only
  (`terminal/extension-state.js`, `onBackgroundState`), but the terminal
  manifest `<session dir>/extensions/terminal/<encoded session id>.json` is
  rewritten on every start and exit (`terminal/terminal-manifest.js`). Entries
  whose recorded `runtime.pid` is gone are dropped, since a crashed agent
  leaves them behind.
- Goal continuation: `goal_continuation_timer_state {armed, kind, dueAtMs}`
  and `goal_continuation_scheduled {wakeSources}` events
  (`goal/monitor-continuation.js`), and the `goal_continuation_fire_now`
  extension request (`goal/rpc-wait-surface.js`).

Not available over RPC, so not shown or not actionable: continuation holds
(loop guard publishes `continuation_hold_state` on the in-process bus only),
and stopping a monitor or a background session (the terminal extension
registers no RPC request for it).

### Subagent lifecycle

OmO owns every task's lifecycle; the connector only shows it. A child session
is `busy` while OmO reports its task running and `idle` once OmO reports an
end. The connector never decides a task ended on its own: aborting the parent's
turn or losing the parent's agent process ends the parent's task cards that
have no running child, and leaves the children to OmO.

Evidence, from the installed `omo-ai` 5.1.33 plugin
(`plugin/extensions/omo-task.js`, minified, cited by bundled function name)
inspected on October 19, 2026:

- `W6` sends `pi.rpc.emit("omo.task.updated", {parent_session_id, tasks,
  truncated_tasks?})`: a replacement snapshot of the parent's tasks (status,
  residency, `updated_at`, final response or error), on attach after
  `session_start` reconciles detached workers and on every task store change.
  It reaches clients that advertise `extension_events`. The snapshot is capped
  at 256 tasks, so a task missing from it is unknown, not ended.
- A `run_in_background` spawn returns before the foreground wait whose abort
  handler calls `cancelTask(..., "parent turn aborted")` (`UZ` and the batch
  waits), so a parent abort cancels only tasks the turn was still waiting on.
- On parent shutdown, shared-host workers detach (`rpc_detached`) and keep
  running (`DK`, `jK`); a revived parent reattaches them before publishing.
- On parent shutdown, in-process workers are stopped and their record stays
  `running` with residency `persisted_only` until the revived parent
  reconciles it; the connector shows such a child idle.
- Task records bump `updated_at` only on record mutations (spawn, steer,
  residency changes, end), so it is no heartbeat: a long task keeps its spawn
  time. Snapshots repeat every row about 150 ms after any task's progress
  event, so the connector applies a row only when its lifecycle fields change,
  ignores `live_progress`, and keeps a full `final_response`/`error_message`
  over a copy OmO cut to 32,000 characters (`*_truncated`).

The connector merges task state from records, snapshots, wake messages and
tool results. It drops an update older than the one it holds, and a running
state no newer than a terminal one OmO already reported. Versions up to 0.2.33
synthesized `cancelled` on abort and compared records against the archive's
modification time, which hid long tasks for good; such a persisted state has
no terminal time and is replaced by the next running record or snapshot.

Because stopping the parent's turn no longer ends its background subagents,
fork and revert stay refused while one runs, with an error that says so;
wait for the subagent, or cancel it from the parent session.

### MCP status and authorization

OpenChamber scopes MCP calls by directory, while OmO owns MCP per session
process. The connector answers them from the most recently used session in the
directory that has a running agent, else from a live session elsewhere, else
from a short-lived `--no-session` agent started for the read and stopped again
(its answer is shared for 30 seconds). A new chat, a project whose sessions are
all dormant and a just-started adapter therefore still list the servers. It
never revives a dormant session for MCP, and a status read does not itself
refresh the idle timer (only agent events do).

Answers change as agents come and go, because a running agent is preferred over
the inventory read. Whenever an agent starts, stops or announces
`loaded_surfaces_changed`, the connector drops the cached inventory and sends
`mcp.status.changed` (with no server name) to every directory whose MCP status a
client has read; OpenChamber holds its status per directory and re-reads only
those it already holds. One announcement covers a startup burst.
A sign-in in a directory without a running agent runs in an agent started with
`--no-session` for that flow alone. That agent holds OmO's pending state, so it
lives until the flow completes, fails, is cancelled or expires (10 minutes), and
stops with the server. Evidence below is from the
installed `@code-yeongyu/senpi` 2026.10.13 bundle (omo-ai 5.1.33); it is covered
by the hermetic fixture `test/fixtures/mcp-omo.mjs`, not by a dated live probe.

- `get_loaded_surfaces` returns `mcpServers: [{name, toolCount, status,
  authStatus}]` (`dist/modes/rpc/rpc-types.d.ts`, `connection-handler.js`). The
  status is the connection state or the config state (`idle`, `connected`,
  `needs_auth`, `disabled`, `untrusted`, ...). Lazy `idle` servers are usable and
  map to OpenCode `connected`. An OAuth server with `authStatus: "notLoggedIn"`
  that is not connected maps to `needs_auth`.
- No MCP RPC exists for authorization. The `/mcp` extension command
  (`core/extensions/builtin/mcp/commands.js`, `auth/commands-auth.js`) runs the
  interactive flow when the runner has a UI context, which RPC mode does. It
  binds a `127.0.0.1` loopback listener, launches the browser with `xdg-open`
  (or `open`), and records the URL as `appendEntry("mcp-auth", "Open this URL to
  authorize <name>:\n<url>")`. That append is published as an `entry_appended`
  event. OmO then exchanges the code itself, reconnects the server and
  reattaches MCP tools to the session. The listener gives up after 5 minutes.
- An extension command dispatched by `prompt` runs before the turn gate
  (`core/agent-session.js` `_prompt`). It does not create a user message or
  an LLM turn, and without a `clientMessageId` it writes no admission entry
  (`modes/rpc/client-admissions.js`). The `prompt` response arrives only after
  the handler returns, so the connector gives it a 10-minute transport budget.
  It sends the command outside the conversation queue and holds the session
  active so the reaper cannot stop the listener. Before sending, it looks the
  command up in `get_commands`, so a missing command can never reach the model as
  prompt text. An extension that registers its own `mcp` (such as
  `pi-mcp-adapter`) makes OmO list the builtin under a suffixed name (`mcp:1`)
  and reject a bare `/mcp`, so the connector picks the extension command whose
  `sourceInfo.path` is `<builtin:mcp>`, falling back to `mcp` for builds without
  `sourceInfo`. Handler failures arrive as `notify` errors.
- The `mcp-auth` entries persist in the session JSONL as custom entries. They
  are not LLM context, and history rebuilding does not render them.
- The headless pair documented in `docs/mcp.md` ("Auth") is `/mcp auth-start
  <name>` followed by `/mcp auth-complete <name> <redirect-url>`. `auth-start`
  opens no listener and no browser. Its authorization request carries
  `redirect_uri` (the `mcp.oauthCallbackUrl` setting, else
  `http://127.0.0.1:0/callback`) and a single-use `state` that only the same
  process can consume (`auth/oauth.js` `completeAuthorization`, `consumeState`).
  `/mcp auth` parks the same pending state, instead of listening, when
  `mcp.oauthCallbackUrl` is set (`auth/callback.js` `openCallbackChannel`).
  OpenChamber sends only the bare `code`, so the connector rebuilds
  `redirect_uri?code=…&state=…` from the authorization URL it saw. It runs
  `auth-complete` in the session that started the flow, and drops the attempt
  if that session's agent changed or 10 minutes have passed.
- A code that arrives while `/mcp auth` is still waiting on its loopback
  listener is delivered to that listener as the browser's redirect would be.
  The connector always runs on the same host as its agent. This covers a
  browser that cannot reach the loopback port: the user pastes the failed
  redirect URL or its code instead. OmO validates the state, and a rejected
  redirect is reported without waiting for the listener to time out.
- OpenChamber 2.x has no MCP auth routes. It signs in through `mcp_*`
  integrations (`IntegrationInfo` with `metadata.source: "mcp"`) and the attempt
  protocol `connect/oauth`, `connect/oauth/{attemptID}`, `.../complete`. The
  connector serves these with `auth-start` (`mode: "code"`, so the UI shows its
  paste box) and `auth-complete`. Providers settings already hide `mcp_*`
  integrations. A completed sign-in emits `mcp.status.changed`, which makes
  OpenChamber re-read `/api/mcp`.

Limitations: one-click `/mcp auth` needs a browser that can reach OmO's
loopback port; otherwise the user pastes the code. Point `mcp.oauthCallbackUrl`
at OpenChamber's `/mcp/oauth/callback` to complete remote sign-ins without
pasting. When OpenChamber opens the URL itself and OmO's `xdg-open` also
works, two tabs may open. OpenChamber 2.3.2 shows the sign-in only on the MCP
settings page, and that page lists servers from OpenCode config files, so
servers defined only in OmO get status there but no sign-in button. Tokens are
stored globally, so after a sign-in the connector sends `/mcp reconnect {name}`
to every other live session; their status updates once that reconnect finishes.

### Capability gaps to decide explicitly

- **Permissions/questions**: OpenCode has permission prompts and elicitation;
  pi handles interactive prompts through its extension-UI protocol. The
  adapter must map or auto-resolve these deterministically.
- **Todos / file diffs**: OpenCode exposes todo and file-diff state that
  OpenChamber renders. pi emits tool-call events; the adapter reconstructs
  file-change state from edit/write tool calls.
- **Models/providers**: OpenCode `/provider` and `/config` endpoints vs pi's
  `get_available_models` / `set_model`. Adapter translates at the boundary.
- **Compaction**: pi `compact` / `set_auto_compaction` ↔ OpenCode
  `session.summarize`.

## Reference sources

Upstream repos are shallow-cloned into `reference/` (gitignored) for local
inspection:

- `reference/openchamber`: https://github.com/openchamber/openchamber
- `reference/pi-mono`: https://github.com/badlogic/pi-mono
