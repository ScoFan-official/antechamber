# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.35] - 2026-11-03

- test: resolve fixture paths with fileURLToPath (#86)

## [1.0.34] - 2026-11-02

### Fixed

- Show a session's subagents under that session. A session list that OpenChamber sent while a new session's agent
  was still starting could adopt the agent's file as a second copy of the session, and subagents started
  later were filed under that copy, so the session showed none of them.

## [1.0.33] - 2026-11-02

### Fixed

- Stop showing replies twice, and keep new messages and `!` shell commands at the end of the conversation, in a
  session that has a shell command OmO never reported back (for example one stopped by the old one-minute deadline).
  Every read of the conversation re-parsed the session file without the live replies, so each reply read mid-turn
  gained a second, restored copy, and those copies piled up after newer messages. Restart OpenChamber's adapter to
  clear copies already in memory.

## [1.0.32] - 2026-10-29

### Fixed

- Stop killing the agent when a shell command run from the composer takes longer than a minute, such as an
  interactive login. A user shell now runs until its command exits or you press Stop; only a shell that OmO still
  has not answered a minute after Stop stops the agent.
- Show a shell command's output live in its card while it runs, so a link or code a command prints before it waits
  (such as a login URL) can be copied. Before, the card stayed empty until the command ended. A command you stop
  keeps the output it printed.

## [1.0.31] - 2026-10-29

### Fixed

- Show the MCP servers and their count before a session runs. A directory with no running agent used to report no servers,
  so the sidebar's "MCP servers" count sat at 0 in a new chat, on a dormant project and after the idle reaper stopped the
  last agent. The servers are now read by a short-lived agent started for that read alone.
- Keep that list current: antechamber announces `mcp.status.changed` when an agent starts, stops or reports new MCP state,
  so OpenChamber re-reads instead of keeping a stale count (it treats an answer as fresh for a minute).
- Stop a sign-in from failing with "pi process disposed" when OmO answers `auth-start` only while `auth-complete` is
  already running. The agent started for the sign-in was stopped mid-command; the completion now owns it until it ends.

## [1.0.30] - 2026-10-28

- update
- update
- update

## [1.0.29] - 2026-10-28

### Fixed

- Stop OmO from cancelling a `/compact` that revives a session. OmO cancels a running compaction whenever an MCP
  server's tools register, which a freshly started agent does for about a second, so the chat showed
  "Compaction failed" twice (OpenChamber 2.5 draws these events as transcript rows) above a compaction that then
  succeeded. A compaction now waits, at most 10 s, until OmO reports no MCP server still connecting. Cancellations
  nobody asked for are retried up to four times instead of two, and a retried attempt is no longer reported as a
  failure; a compaction the user stops still is.

## [1.0.28] - 2026-10-28

- fix(mcp): sign in to MCP servers without a running OmO session (#79)

## [1.0.27] - 2026-10-28

### Fixed

- Sign in to an MCP server from OpenChamber without a running OmO session in that directory. The sign-in now runs in
  an agent started for it alone, which stops once the sign-in completes, is cancelled or expires, and every running
  session reconnects the server afterwards so it picks up the new token.
- Find OmO's builtin `/mcp` command when an extension such as `pi-mcp-adapter` also registers `mcp` and OmO renames
  the builtin to `mcp:1`. MCP sign-in used to fail there with "Unknown command /mcp".

## [1.0.26] - 2026-10-28

### Fixed

- Stop showing "Opencode failed to send message" for a provider error that OmO retries on its own, such as
  Anthropic's 400 for a `web_search` tool use with no `web_search_tool_result`, which OmO retries without web search
  replay data. The errored reply now waits for OmO's retry decision: a retried step completes without the error and
  v2 no longer reports `session.step.failed`. An error that is not retried still fails the message, step and run.

## [1.0.25] - 2026-10-27

### Added

- Show OmO's background work as background commands in OpenChamber 2.x. While a terminal monitor, a detached eval
  cell or a background terminal session runs, the session reads as working ("Background command") after its turn
  ends, the turn timer keeps running, and the commands are listed above the composer with their output (work no card
  started, such as a watch a revived agent restored, is listed after a reload). Stop works
  for eval cells; OmO offers no way to stop a monitor or a background terminal session, so their Stop fails without
  telling the agent anything. A card that left such work running now settles at once and follows the command, as
  OpenCode's own background calls do.

### Changed

- The OmO Work section no longer lists monitors, eval cells or background terminal sessions, which OpenChamber now
  shows itself. It keeps the todo list, the goal timer and other activity.

## [1.0.24] - 2026-10-27

### Fixed

- Keep each reply in its own turn in OpenChamber 2.x after history is reloaded. A reply's request can start a few
  milliseconds before OmO writes its prompt, so a restored reply sorted ahead of its prompt: the first turn's replies
  vanished and each later turn's first reply was drawn in the turn before.

## [1.0.23] - 2026-10-27

### Fixed

- Draw shell and eval cards in OpenChamber 2.x as shell cards: the command as code, then its live output. OpenCode
  2.x renamed `bash` to `shell`, and OpenChamber 2.x drew `bash` cards with its generic body, listing `Command:` and
  `Description:`. The v2 API now reports these cards as `shell`, and the OmO Compatibility extension heads `shell`
  cards too.

## [1.0.22] - 2026-10-26

### Fixed

- Show terminal turns appended to a session that the adapter last saved while empty, instead of keeping its
  transcript blank. Empty forks and active reverts keep their hidden history.

## [1.0.21] - 2026-10-26

### Fixed

- Show live eval cells as `JS Eval` / `Python Eval` cards with their code and streaming output in OpenChamber 2.x.
  The v2 stream announced the card as `eval` and never renamed it to the `bash` card it becomes, and it dropped
  running metadata, so the OmO Compatibility header rule never matched and live output never arrived. The card is
  now announced again under its mapped name, and running metadata is sent as `session.tool.progress`.

## [1.0.20] - 2026-10-26

### Fixed

- Work with OpenChamber 2.5.2, which refuses OpenCode older than 2.1.0 and showed an "Update OpenCode" screen
  that never cleared. antechamber now reports OpenCode API 2.1.0, and `PATCH /api/session/{id}` accepts 2.1's
  `archived: true|false`, so archiving and unarchiving from OpenChamber 2.5.2 take effect instead of answering 204
  and changing nothing.

## [1.0.19] - 2026-10-25

### Fixed

- Keep the parent's last reply in a `/btw` side thread. OpenChamber forks `/btw` at the last completed assistant
  reply, and the adapter cut strictly before it, so the fork ended mid-turn on the reply's tool calls and the side
  agent never saw the answer the main thread had just given. An assistant boundary now keeps that reply and the
  results of its own tool calls.

## [1.0.18] - 2026-10-25

- fix(session): accept late OmO extension entries after a fork refresh (#68)

## [1.0.17] - 2026-10-24

### Fixed

- Keep a session's agent out of idle eviction while a background terminal session (`bash` run in the background)
  is still running. The reaper killed it with the agent 15 minutes after the turn ended, so a CI poller or long
  build died silently and the session never woke up with its result.
- Fork (and `/btw`) on large sessions no longer fails with "Native tree refresh did not restore the saved
  navigation". OmO's session-start hooks append extension entries (rules scan, session bindings) on top of the
  restored branch right after the adapter reloads the session, and the check treated those as a lost navigation.

## [1.0.16] - 2026-10-23

### Fixed

- Stop OmO Work's status poll from killing the agent. Its 10-second `eval_cells.list` lost the race with a large
  session's cold start, the timeout stopped the agent, and the user's prompt failed with
  `pi command "eval_cells.list" timed out` while the resend could not start a reply. OmO Work's eval cell requests
  now fail alone on timeout; conversation operations still stop the agent, which keeps their order.
- Say why the agent stopped whenever it stops on its own: a command timeout (which command, which deadline), a
  broken pipe, an oversized frame, or a crash (exit code or signal). The transcript gets a notice card and the
  interrupted reply carries the same error, instead of a bare `pi process exited (code=null)` toast or
  "OpenCode did not start a reply". The notice survives an adapter restart until the next prompt.

## [1.0.15] - 2026-10-23

### Fixed

- Stop reaping a session while detached eval cells are still running: idle eviction killed the agent process and
  every cell in its kernels once the session had been quiet for `ANTECHAMBER_IDLE_TIMEOUT_MS`. A session now stays
  live while senpi-codemode reports detached cells, and its idle window restarts when the last one settles.

## [1.0.14] - 2026-10-22

### Fixed

- Preselect OmO's real effort in OpenChamber 2.x instead of "Default": `/api/agent` now nests the agent's
  default model and level as `model: {id, providerID, variant}`, and a reopened session reports the model and
  level OmO will resume it with, read from its session file, instead of `variant: "default"`.

## [1.0.13] - 2026-10-22

### Fixed

- Show the effort (thinking level) picker again in OpenChamber 2.x: `/api/model` and `/api/model/default`
  now list each model's thinking levels in `variants` instead of an empty array.
- Keep a session's effort when OpenChamber 2.x reopens it on another device: the v2 session record now reports
  the thinking level actually applied, instead of a stale one that the next prompt sent back.

## [1.0.12] - 2026-10-21

### Fixed

- Stop saving child-task spawn specs in the session registry; OmO's task records already hold them.
  This shrinks the registry by about a third in sessions with hundreds of child tasks.

## [1.0.11] - 2026-10-21

### Fixed

- Cut the event-loop stall of each session registry write by reusing the in-memory registry while
  the file is unchanged, cloning only the entries a batch reads, and writing compact JSON.

## [1.0.10] - 2026-10-21

### Fixed

- Keep sessions with many child tasks responsive by ignoring unchanged task snapshots and saving
  each snapshot's changes in one registry write.

## [1.0.9] - 2026-10-21

### Fixed

- Reduce repeated native-title scans and task-record lookups while restoring and listing sessions,
  preserving first-list costs, child-session identities and later native updates.

## [1.0.8] - 2026-10-20

### Fixed

- Allow messages in restored sessions whose active goal has already resumed a response, without
  rejecting the send as a session-tree navigation.

## [1.0.7] - 2026-10-20

- fix(session): defer registry snapshots for cached lookups (#54)

## [1.0.6] - 2026-10-20

- docs: integrate the OmO Work extension across the docs (#55)

## [1.0.5] - 2026-10-20

### Fixed

- Avoid copying the entire session registry for cached session lookups, preventing session lists
  from blocking transcript loading after startup.
- Reduce startup CPU usage and boot delays for large session histories by committing restoration metadata
  in one registry write, while preserving restored costs, child sessions and independent registry writers.

## [1.0.4] - 2026-10-20

### Fixed

- Keep subagents with colliding task IDs in different sessions separate, and recover a foreign child
  archive from its own retained transcript.

## [1.0.3] - 2026-10-20

### Added

- The OpenChamber extensions install by Git URL, and OpenChamber offers each release under
  **Update** in Settings → Extensions: every release commits them to the `extension/omo-graph`,
  `extension/omo-work` and `extension/omo-compat` branches, so add
  `https://github.com/eliottness/antechamber#extension/omo-graph` (or `#extension/omo-work`,
  `#extension/omo-compat`). The bare repository URL keeps failing with OpenChamber's "panel.id must
  be kebab-case" toast, because it points at antechamber itself. ZIP installs still work but are
  never updated.

## [1.0.2] - 2026-10-20

### Fixed

- Restore main-session costs before listing sessions after a restart, and keep live usage totals cumulative
  across assistant steps.

## [1.0.1] - 2026-10-20

### Added

- OmO Work, an OpenChamber 2.x Work Status section (`extensions/omo-work`). For the open session it
  shows OmO's todo list by phase, terminal monitors with their matched lines, detached eval cells
  (output peek and Stop), background terminal sessions and the goal continuation timer (Fire now).
  Its service reaches antechamber through new `/antechamber/work-status` routes, authenticated by a
  token `serve` writes into its run record.

### Changed

- On OpenChamber 2.x, OmO monitors are no longer listed as subagent sessions; the OmO Work section
  shows them. OpenChamber 1.24 still sees them as child sessions.

## [1.0.0] - 2026-10-20

- First stable release. No functional changes since 0.2.37.

## [0.2.37] - 2026-10-20

- fix(questions): drop optional comment field that OpenChamber 2.4 makes mandatory (#45)

## [0.2.36] - 2026-10-20

### Fixed

- Keep large sessions usable after their persisted history exceeds the 64 MiB RPC frame limit.
  History synchronization now reads the persisted prefix locally and requests only the native tail,
  preserving the selected branch when sending messages or reopening a session.

## [0.2.35] - 2026-10-19

### Fixed

- Keep OmO background subagents running in OpenChamber after the parent turn is stopped or its agent
  process exits. Child status now follows OmO's `omo.task.updated` snapshots and task records, and a
  child an older version wrongly marked cancelled recovers from its running record. Stopping the turn
  no longer unblocks fork and revert while a background subagent runs; the error now names the
  running subagent instead of asking to stop the turn.
- Let OmO questions be submitted in OpenChamber 2.4 without typing a comment. The question form no
  longer adds an optional `Comment` field, which OpenChamber 2.4's question dock treated as a required
  final step.

## [0.2.34] - 2026-10-19

### Fixed

- Accept uploaded attachments other than images and text, such as PDFs, instead of failing the prompt with
  `Unsupported inline attachment MIME type`. The file is saved under the state directory's `attachments/`
  folder and passed to the agent as a file reference it can read with its own tools.

## [0.2.33] - 2026-10-19

### Fixed

- Restore subagent costs and token totals before listing sessions, so OpenChamber includes
  retained child spend without requiring each child transcript to be opened.

## [0.2.32] - 2026-10-19

### Fixed

- Preserve native replies and their recorded usage when reopening sessions with legacy compaction ID collisions.

## [0.2.31] - 2026-10-19

- fix(session): refresh dormant history after external appends (#39)

## [0.2.30] - 2026-10-19

### Fixed

- Preserve archived and nested task children in replay sandboxes, with transcript and task session paths
  remapped locally, so child history and costs are not lost when replaying selected roots.
- Refresh dormant conversation history when another client appends messages or tool results after it was opened.

## [0.2.29] - 2026-10-19

### Fixed

- Keep compaction markers before the replies that follow them, both live and after reopening a conversation.

## [0.2.28] - 2026-10-18

- fix(session): keep replies visible after compaction (#37)

## [0.2.27] - 2026-10-18

### Fixed

- Keep new replies and tool activity visible after compaction in long conversations by retaining their original
  prompt in paged history.
- Keep a subagent and its parent session shown as running when OmO resumes the subagent on its own after its turn
  ended while its background work ran, and keep the subagent's transcript up to its final reply.

## [0.2.26] - 2026-10-17

### Changed

- Name a subagent card for an `agent()` call made inside eval after its agent type (for example "Explore Agent"),
  and describe it with the call's label, the task's summary, or the first line of its prompt, instead of a bare "agent".
- Show subagents an eval cell starts with `tool.task(...)` as subagent cards that open their session, live and after
  reloading history, including ones started in the background.
- Show an `agent()` call that OmO refused (for example one with no agent type) as a failed subagent card. OmO
  records it as a success but starts no task.

## [0.2.25] - 2026-10-17

- feat(tools): show subagents and monitors started inside eval (#30)

## [0.2.24] - 2026-10-17

### Fixed

- Show completed background bash output and detached eval results in OpenChamber, including after reloading history.
  A card that started background work keeps running until that work finishes.

### Added

- Show subagents and monitors started inside an eval cell as subagent cards that open their session, live and after
  reloading history. A failed `agent()` call keeps its error.

## [0.2.23] - 2026-10-17

- feat(monitors): show matched lines in monitor sessions (#32)

## [0.2.22] - 2026-10-17

- fix(tools): stream live bash and eval output into OpenChamber cards (#29)

## [0.2.21] - 2026-10-17

### Fixed

- Keep a session's thinking level when it is reopened. User messages now carry the level as `model.variant`, both
  live and in history rebuilt from OmO's session file. Without it OpenChamber fell back to the agent's default effort
  and sent that with the next prompt, which reset the level and broke the prompt cache.

## [0.2.20] - 2026-10-17

### Fixed

- Show a session as running in OpenChamber while a subagent it started from `eval` (such as an OmO Graph run) is
  still working. The adapter marked such a child busy without announcing it, so the parent's running dot stayed off.

## [0.2.19] - 2026-10-17

### Fixed

- Report the real agent startup failure on macOS instead of `kill EPERM`. When OmO exited while a session was being
  created, cleanup signalled its not yet reaped process group, macOS answered EPERM, and OpenChamber showed "Failed
  to create session" with the original error hidden.
- Show live bash and eval output in OpenChamber 1.24, and display eval and terminal controls as shell cards with
  their final results retained after history reload. A failed cell shows as a failed card.

### Added

- OmO Compatibility, a second bundled OpenChamber extension (1.24 or newer) with no code or permissions. It heads
  eval cards with `JS Eval` or `Python Eval` and the cell's summary.

### Added

- Show the lines an OmO monitor matched in its monitor session, as they fire.

## [0.2.18] - 2026-10-17

- test(endpoints): await the abort_bash dispatch instead of reading a flag (#27)

## [0.2.17] - 2026-10-17

### Fixed

- Keep files in the session diff when the agent reports their absolute path through a symlinked workspace, such as
  a macOS temporary directory under `/var`.
- Make `antechamber doctor` skip running-server records whose process has exited on macOS, not only on Linux.
- Stop a fast subagent task from staying busy on macOS when its task record changes before the file watcher is
  live.

## [0.2.16] - 2026-10-17

### Fixed

- Keep deleted subagent sessions deleted. They came back when their parent's history was read again or when the
  adapter restarted, because OmO still holds their task record.
- Keep subagent sessions archived after an adapter restart. Archiving a parent with its subagents left the
  subagents active as orphans once the adapter restarted.

## [0.2.15] - 2026-10-17

### Fixed

- Show saved child-task errors when no transcript is available, and label missing runtime, token and cost statistics
  as unknown instead of zero.

## [0.2.14] - 2026-10-16

### Fixed

- Retry a manual compaction that OmO cancelled without a user abort. Compacting a dormant session failed with
  "Compaction cancelled" when its MCP servers finished connecting right after the agent started.
- List MCP servers for a directory whose sessions are all dormant, from the most recently used live session
  elsewhere, instead of showing none.
- Keep OpenChamber 1.24's mobile transcript from opening blank after a long agent turn: a v1 message page with no
  user message now reaches back to the prompt that opened its turn.

### Added

- `antechamber doctor` reports the installed, latest released and running adapter versions, and warns when the running
  server is older, since a released fix only goes live after OpenChamber relaunches the adapter.

## [0.2.13] - 2026-10-16

### Fixed

- Show and resume turns that another OmO client, such as the terminal, appended to a session while the connector
  was detached. Previously the connector stayed pinned to its last saved message. A committed revert's abandoned
  branch stays hidden.

## [0.2.12] - 2026-10-16

### Fixed

- Preserve recorded conversation progress when the agent process exits before
  `agent_end`, and retain successful background compaction across revival.
  Checkpoints respect reverted selections and do not switch to sibling branches.

## [0.2.11] - 2026-10-16

### Fixed

- Keep pending prompts alive while the agent is running or compacting instead of terminating useful work at the
  ordinary RPC deadline. Silent requests still time out, and prompt admission has a bounded overall wait.

## [0.2.10] - 2026-10-16

### Fixed

- `/btw` on an idle session no longer fails with "Invalid entry ID for
  forking". Forking before an assistant message (the fork point `/btw` sends)
  now keeps everything before that reply, matching OpenCode's exclusive fork
  boundary. Forks are still refused while the session is busy.
- Running tool cards no longer flash a red "Interrupted" error until they
  finish. An assistant message is now marked completed only once its tools
  (including subagent task cards) have settled, as OpenCode does.

## [0.2.9] - 2026-10-16

### Fixed

- Mobile: sessions whose newest 30 messages contain no user prompt no longer
  open blank on OpenChamber's mobile surface. v1 `GET /session/{id}/message`
  now returns `x-next-cursor` and honors `before`, so the client pages back
  until it finds the start of a turn.

## [0.2.8] - 2026-10-15

- fix(session): resend bare /<skill> commands as /skill:<name>

## [0.2.7] - 2026-10-15

### Fixed

- OmO Graph: panning no longer selects the wave labels, so pressing near the
  graph can no longer start a native text drag. That drag cancelled the pan
  after a few pixels, and before 0.2.3 it left the graph following the mouse
  with the button released.

## [0.2.6] - 2026-10-15

- fix(omo-graph): stop ending the pan on blur and lost capture

## [0.2.5] - 2026-10-15

### Added

- OmO terminal monitors now appear in OpenChamber as read-only child sessions of
  the session that started them. They are listed under Subagents and keep a live
  sidebar dot while the watch runs, and their transcript shows the watched
  command, filter, event count and how the watch ended. A session with a live
  watch is no longer evicted as idle, which used to stop the watch.
- MCP servers configured in OmO now appear in OpenChamber's MCP status, and the
  Authorize button for a server that needs sign-in runs OmO's native
  `/mcp auth` flow in the running session. Status and authorization use the
  most recently used live session in the directory. The flow never adds a
  message to the conversation, and it never revives a dormant session.
- Completing an MCP sign-in with a pasted code or redirect URL (OpenChamber's
  callback page or paste box) now works through `/mcp/{name}/auth/callback`.
  The code goes to OmO's waiting loopback listener, or to
  `/mcp auth-complete` when OmO parked the flow.
- OpenChamber 2.x now lists OmO MCP servers (`GET /api/mcp`) and can sign in
  through `mcp_*` integrations. These run OmO's headless `/mcp auth-start` and
  `/mcp auth-complete` with a paste-the-code step. A completed sign-in emits
  `mcp.status.changed`.

### Fixed

- OmO Graph: dragging the graph no longer stops after a fraction of a second.
  The previous stuck-pan fix also ended the drag when the panel lost focus or
  pointer capture, which can happen while the button is still held; the drag
  now ends only on release, cancel, or a move without the button held.

### Fixed

- Invoking a skill as `/<name>` (as OpenChamber offers it) no longer fails with
  `Unknown command /<name>. Did you mean /skill:<name>?`. When OmO suggests the
  matching skill, antechamber resends the prompt as `/skill:<name>`.

## [0.2.4] - 2026-10-15

### Added

- feat(cli): `antechamber setup --auto-update` points OpenChamber at a launcher that installs the latest release in the background on every start; it is now the recommended install path
- feat(cli): `antechamber upgrade` installs the latest release with the package manager that owns the global install, so OpenChamber 2.3.2's Update button now upgrades antechamber
- feat(api): `POST /global/upgrade` upgrades antechamber itself instead of returning `UnsupportedError`
- feat(config): `ANTECHAMBER_AUTO_UPDATE=1` enables the post-start background update

## [0.2.3] - 2026-10-15

### Fixed

- OmO Graph: panning no longer gets stuck following the mouse after the button
  is released outside the panel (or the pointer is cancelled, capture is lost
  or the window loses focus); a move without the primary button held now ends
  the drag.

## [0.2.2] - 2026-10-15

### Fixed

- Sub-agent sessions spawned without a `task` tool call (for example `agent()`
  inside an `eval` cell) now open from their OmO task record instead of
  returning `session not found`, and appear in the session list as soon as
  they exist or complete, so their OmO Graph cards are clickable.

### Changed

- ci(release): every push to `main` now ships a patch release automatically; CI bumps the package and OmO Graph extension versions (now kept equal), rolls the CHANGELOG, tags, publishes to npm and attaches the extension zip to the GitHub release. The release guide moved to `RELEASE.md`

## [0.2.1] - 2026-10-15

### Fixed

- fix(extension): save OmO Graph data paths without form submission, which OpenChamber's iframe sandbox blocks
- fix(session): accept OmO messages stored as plain-string content when titling, binding and restoring sessions instead of crashing
- fix(api): answer OpenChamber's location eviction (`DELETE /api/debug/location`) with OpenCode's empty 204
- fix(api): answer the v2 routes OpenChamber 2.3.2 calls instead of a generic 404/501. Plugin list and check return an empty inventory, `/api/experimental/generate` returns OpenCode's typed 503, and plugin update, credential update/activate, integration connections and session generate/background/move return `UnsupportedError`
- fix(api): stop faking mutations. `POST /api/credential` and `PATCH /api/project/{projectID}` return `UnsupportedError` instead of keeping an in-memory credential or echoing an unsaved project
- fix(api): reject missing or empty prompt and synthetic-context input with a typed 400 before anything reaches OmO
- fix(vcs): back `/api/vcs/status`, `/api/vcs/diff`, `/api/vcs/branch` and `/api/vcs/base` with read-only git instead of fixed empty data
- fix(cli): refuse `opencode-antechamber upgrade` with the antechamber upgrade command, and document OpenChamber 2.3.2's OpenCode update notice

### Changed

- refactor: use `findLast` for last-match scans
- docs(api): unknown routes return 404 on both APIs; only unknown subpaths of an existing v2 session return 501

## [0.2.0] - 2026-10-14

### Added

- feat(api): add v2 credential, integration, file-search, VCS, and synthetic-context routes
- feat(events): replay retained SSE events and expose v2 shell, compaction, and execution terminals

### Fixed

- fix(session): preserve rich prompt parts, metadata, ancestry, and part identities across reloads
- fix(runtime): retain operation ordering after caller cancellation and finalize interrupted tool cards
- fix(rpc): close failed transports and reject responses correlated to the wrong command
- fix(http): allow passwordless loopback origins across ports while retaining explicit origin checks
- fix(security): validate registry records and write registry state with private permissions
- fix(cli): advertise OpenCode API compatibility as 2.0.20
- fix(api): return OpenCode 2.x bootstrap shapes for `/api/config`, `/api/shell`, `/api/websearch/provider` and `GET /api/mcp` so OpenChamber 2.3.2 can initialize workspaces
- fix(api): answer v2 synthetic context admission with the admitted record and return the bare interrupt flag, so OpenChamber 2.3.2 can send prompts and stop turns
- fix(extension): bound graph responses and display omitted-node counts
- fix(api): carry v2 prompt attachments, agent mentions and metadata into OmO's input, admission events and message history, and answer skill references with OpenCode's tagged not-found error
- fix(session): admit synthetic context and v1 `noReply` messages into OmO's conversation without a turn, keep them after restarts even when no prompt follows, and stop context from titling sessions
- fix(events): keep an unscoped v2 `/api/event` stream global, as OpenChamber 2.3.2 subscribes
- fix(rpc): after the agent exits during shutdown, kill only re-identified members of its process group

### Changed

- docs(api): document route statuses, response envelopes, stream framing, and unsupported capabilities
- docs(maintainers): correct smoke paths, typecheck commands, and release guidance

## [0.1.1] - 2026-10-14

### Added

- Sessions now report `cost` (USD) from OmO's per-message usage, live and from
  history, on v1 session payloads and v2 session reads. Subagent sessions carry
  their own cost, so OpenChamber's work-status panel shows the session total
  with its session/subagents breakdown.

### Fixed

- `/compact` now shows progress and its result. The session turns busy while
  OmO compacts, and the summary appears as a `/compact` turn with a summary
  reply, live and after reload. The compact RPC now waits up to OmO's own
  30-minute compaction budget instead of giving up after 60 seconds, which left
  the compaction running unseen until a later abort reported it cancelled.
- Reverting no longer adds a "Conversation reverted. Files were not changed."
  card to the transcript; OpenChamber's own reverted-message dock (driven by
  `session.revert`) already shows the state.
- Sessions opened with a slash command (for example `/skill:plan Build the
  importer`) now get a generated title. OmO skips titling slash-led prompts, so
  the adapter passes the command's arguments as the native `sessionTitlePrompt`.

## [0.1.0] - 2026-10-14

First standalone release under the `antechamber` name.

### Renamed

This project was previously published as `openchamber-pi-connector`. The
rename affects:

- Package and CLI binary: `openchamber-pi-connector` / `opencode-pi` to
  `antechamber` (`dist/cli.js`, bin name `antechamber`).
- Launcher script: `bin/opencode-antechamber` is the new OpenChamber launcher;
  `bin/opencode-pi` is kept as a deprecated shim that forwards to it, so
  existing `settings.opencodeBinary` values keep working.
- Environment variables: all settings now read the `ANTECHAMBER_` prefix
  first (for example `ANTECHAMBER_PI_BINARY`, `ANTECHAMBER_STATE_DIR`,
  `ANTECHAMBER_AGENT`, `ANTECHAMBER_IDLE_TIMEOUT_MS`, `ANTECHAMBER_MAX_LIVE`,
  `ANTECHAMBER_DEBUG`). The previous `OCPI_` prefix is still accepted as a
  deprecated fallback; migrate at your own pace.
- State directory: defaults to `~/.config/antechamber`. If that directory
  doesn't exist yet but the legacy `~/.config/openchamber-pi-connector`
  does, the legacy directory is used automatically so existing session
  registries keep working across the upgrade. Move the directory manually
  once you're ready to drop the fallback.
- No action needed for most users: both the binary and environment variable
  fallbacks mean an existing OpenChamber `settings.json` pointing at
  `opencode-pi` keeps working unchanged.

### Changed

- OmO is now the default backend: antechamber spawns `omo` unless
  `ANTECHAMBER_PI_BINARY` says otherwise, and the agent directory follows
  OmO's resolution (`OMO_CODING_AGENT_DIR` > `SENPI_CODING_AGENT_DIR` >
  `PI_CODING_AGENT_DIR`, default `~/.omo/agent`; `~/.pi/agent` when the backend
  is `pi`). A standard OmO install is advertised as the `OmO` agent without
  setting `ANTECHAMBER_AGENT`. Plain pi remains available as an opt-in,
  best-effort backend (`ANTECHAMBER_PI_BINARY=pi`).

### Added

- OmO Graph, an OpenChamber extension in `extensions/omo-dag`. It draws the
  OmO sub-agents behind the open session as a live graph:
  - cards are grouped in waves and show each sub-agent's state, duration,
    agent and model;
  - hovering a card highlights its input and output edges;
  - clicking a card opens the sub-agent's session.

  The extension is built by `npm run build`, is covered by `npm test`,
  typecheck and lint, and ships in the npm package. It reads OmO's task store
  and the session registry read-only, through an OpenChamber-managed local
  service.
- `antechamber setup` ends by printing the bundled OmO Graph extension folder
  to add in OpenChamber (Settings → Extensions → Add → Folder), and every
  GitHub release attaches `antechamber-omo-graph.zip`, installable from
  OpenChamber by URL
  (`https://github.com/eliottness/antechamber/releases/latest/download/antechamber-omo-graph.zip`).
- npm-first installation with `antechamber setup`: settings discovery,
  isolated profiles, executable selection, timestamped backups, idempotency,
  dry-run plans, and optional systemd user drop-ins with explicit restart.
- Read-only `antechamber doctor` diagnostics with text/JSON output, backend
  checks, agent/state directory checks, OpenChamber wiring and pidfd capability.
- Explicit `serve`, `setup`, `doctor`, `version`, and `help` commands. Package
  versions now come from `package.json`; the OpenChamber `--version` probe
  keeps advertising `opencode v2.0.18`.
- Public npm publication configuration with provenance and an executable
  built CLI, plus installation, upgrade and rollback documentation.
- Tag-driven release workflow: a `vX.Y.Z` tag runs the checks, publishes to
  npm with provenance (trusted publishing or `NPM_TOKEN`) and creates the
  GitHub release from this file. See [docs/releasing.md](docs/releasing.md).
- Security hardening: optional HTTP Basic auth (`OPENCODE_SERVER_PASSWORD`),
  `Origin` checks for unauthenticated servers, a non-loopback-bind guard, and
  request/SSE/search limits. See [docs/configuration.md](docs/configuration.md#security).
- OpenCode v2 API support (`@opencode-ai/sdk/v2`), alongside the original v1
  surface, covering the endpoints OpenChamber >= 2.0.4 depends on.
- [OmO](https://github.com/omo-ai) backend support (a pi-compatible
  coding-agent distribution, aka senpi / oh-my-pi), including OmO-specific
  session-tree fork/revert/unrevert, subagent and task cards, todo bridging,
  and thinking-level mapping.
- Session fork, revert, and unrevert backed by the agent's native session
  tree rather than a filesystem snapshot.
- Subagent and task cards rendered as native OpenChamber tool parts.
- Approval and question bridging through the agent's extension-UI protocol.
- Thinking-level selection surfaced through OpenChamber's model picker.
- Shell run cards (user-invoked `!command` execution) with cancellation.
- Session diff endpoint returning a unified patch independent of
  OpenChamber's own git integration.
- Session persistence and revival across connector restarts.
- Idle session reaping and a configurable cap on concurrent live agent
  processes (lifecycle caps).

### Fixed

- Slash commands sent through `POST /session/:id/command` (for example
  `/skill:<name> ...`) now reuse OpenChamber's client `messageID`, so the user
  message no longer appears twice in the chat.
- With a server password configured, requests carrying a non-loopback
  `Origin` (forwarded by OpenChamber's proxy for LAN browsers and the desktop
  app) are no longer rejected with 403; the password is the boundary.
- Turn statistics now use the native assistant stop reason independently of
  usage, normalize tool-call finishes, and preserve tokens, cost, errors, and
  response-model attribution in v1 and v2 history. Restored messages retain
  their provider-to-append duration when valid timestamps are available.
- Native session titles replace provisional first-message titles and persist
  through reload and revival. Explicit user titles win over delayed native
  generation; scans read the latest native name even beyond the transcript
  head limit. Both OmO and Senpi client capability variables now advertise
  `auto_title_sessions` and `question` while preserving inherited capabilities.
  Historical title generation for old unnamed sessions is deferred to a
  follow-up; existing native names are restored without adding a conversation
  turn.
- Busy prompts now carry native steer/follow-up admission behavior and stable
  client message IDs instead of waiting behind a running turn until the RPC
  timeout. v1 defaults to steering; v2 validates and honors steer/queue delivery,
  publishes inbox acceptance and consumption, and restores durable pending
  input without duplicating consumed user cards or changing assistant parents.
- Structured `ask_user_question` requests now remain visible after a
  nonblocking tool finishes. OpenChamber 1.24.2 receives v1 question
  events and lists; OpenChamber 2.x receives native forms, including
  multiselect, custom text, partial answers, comments, and cancellation.
  Replies use correlated native acknowledgments rather than sending a
  duplicate prompt.
- Pending native questions hydrate on session revival with stable public
  IDs and refreshed connection IDs. Dormant-session dangling-question
  scanning without revival is deliberately omitted: those questions enter
  lists only after revival. Native repeated-crash recovery limitations
  remain; no native recovery code is changed.

### History

Everything before this release lived under the `openchamber-pi-connector`
name, originally authored by qingzhu521 (xiuli.qz) as a minimal pi-backed
OpenCode-API adapter for OpenChamber, and MIT-licensed. This fork retained
that license and extended the project substantially; see the README's
Credits section.
