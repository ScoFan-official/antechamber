# Running antechamber against OmO

[OmO](https://github.com/omo-ai) (aka senpi / oh-my-pi) is a pi-compatible
coding-agent distribution. antechamber talks to it the same way it talks to
plain `pi`: by spawning it in RPC mode and speaking JSONL over stdio. This
page covers the parts that are specific to OmO.

## Basic setup

OmO is antechamber's default backend: with `omo` on `PATH` (`bun add -g omo-ai`)
no backend configuration is needed.

```bash
antechamber serve --hostname 127.0.0.1 --port 4096
```

If `omo` is not on the `PATH` of the process that launches OpenChamber (a
systemd user service, for example), set `ANTECHAMBER_PI_BINARY` to its absolute
path.

`ANTECHAMBER_AGENT` controls what agent name antechamber reports to
OpenChamber. If unset, it's detected in this order:

1. `orchestrator.agentName` in `oh-my-pi.jsonc` next to the agent directory
2. `OmO` when `omo.jsonc` sits next to the agent directory (`~/.omo/omo.jsonc`
   for a standard install)
3. `oh-my-pi` if `<agent dir>/settings.json` lists the oh-my-pi package
4. `build` as a last resort

The agent directory follows OmO's own resolution: `OMO_CODING_AGENT_DIR`, then
`SENPI_CODING_AGENT_DIR`, then `PI_CODING_AGENT_DIR`, defaulting to
`~/.omo/agent`.

## Session tree: fork, revert, unrevert

OmO exposes a native session tree (`get_entries`, `fork`, navigation RPCs)
that antechamber maps onto OpenChamber's fork/revert/unrevert actions:

- **Fork** copies the history before the selected message into a new OmO
  session file; the new identity is read back from `get_state` and the RPC
  process switches to it. The original session becomes dormant and resumes
  its own file the next time it's used.
- **Revert** navigates to the selected message's parent and keeps the
  original "redo" branch around so **unrevert** can restore it. Revert only
  changes conversation context for the model; it never touches files on
  disk, and antechamber injects a local-only notice saying so.
- The connector tracks its own OpenChamber message IDs against OmO entry IDs
  across restarts, so fork/revert stay consistent after a restart.

See [docs/architecture.md](../architecture.md) for the full event-translation
and ownership design.

## Child transcripts

OmO runs subagents (tasks) as either separate processes or in-process
children. antechamber resolves both:

- Process-backed children report `host_session.session_path` directly.
- In-process children (for example the `explore` agent) report
  `child_session_id`; their transcript lives under the owning task store at
  `children/<task_id>/sessions/<task_id>/<timestamp>_<child_session_id>.jsonl`.

antechamber tails the transcript while the task runs and archives it under
`$ANTECHAMBER_STATE_DIR/children/<task_id>.jsonl` once the task completes.

## Seeing the sub-agent graph

OmO records every task it launches under
`<agent dir>/projects/*/senpi-task/tasks/`, and antechamber exposes each one as
an OpenChamber sub-agent session. The bundled
[OmO Graph extension](../../extensions/omo-dag/README.md) reads both and draws
the run behind the open session as a live graph. Its local service starts with
OpenChamber's minimal environment and so does not see the agent-directory
variables (`OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`,
`PI_CODING_AGENT_DIR`) or `ANTECHAMBER_STATE_DIR`. If you set any of them,
enter the same paths in the panel's Data paths popover.

## Seeing background work

OmO keeps working between turns: terminal monitors watch commands, detached
eval cells run, background terminal sessions stay up, and the goal
continuation timer waits to wake the session. On OpenChamber 2.x the bundled
[OmO Work section](../../extensions/omo-work/README.md) shows all of it, with
the todo list grouped by phase, in the Work Status panel. OpenChamber 1.x has
no extension sections; it sees monitors as read-only child sessions instead.

The section's service finds antechamber through the run records in
`<state dir>/run/`. Like OmO Graph, it starts with OpenChamber's minimal
environment, so if you set `ANTECHAMBER_STATE_DIR`, enter the same path under
**Data path** in the section header.

What OmO exposes to antechamber decides what the section can do: Stop works
for eval cells and Fire now for the goal timer, but monitors and background
sessions cannot be stopped from OpenChamber, because OmO has no RPC request
for it. See [docs/architecture.md](../architecture.md#omo-work-status-section).

## Git diffs and `diff.external`

antechamber's own `GET /session/:id/diff` endpoint always produces a plain
unified patch (it invokes git with `--no-ext-diff`). OpenChamber's workspace
**Changes** panel is a separate code path: it calls OpenChamber's own git
API, which does honor your `diff.external` setting. If you have
`diff.external` set globally to something like
[difftastic](https://github.com/Wilfred/difftastic) (`difft`), OpenChamber's
Changes panel may show an empty body for a file even though counts are
correct, because it expects a classic unified-diff header.

If you hit this, compare the two raw responses (antechamber's `/session/:id/diff`
vs. OpenChamber's own `/api/git/diff`) and check
`git config --show-origin --get diff.external` in the affected repository.
Keep `difft` available as an explicit terminal command instead of a global
`diff.external` if you also use OpenChamber's native Changes panel.

## Private task-host teardown

OmO can spawn detached, long-lived "task host" supervisor processes shared
across subagent sessions. antechamber owns and tears down the ones it
created (tracked per session as `connectorOwned`); it does not touch task
hosts belonging to sessions it didn't create, or the shared LSP daemon.

This teardown step needs:

- Linux with pidfd support (`os.pidfd_open`, `signal.pidfd_send_signal`;
  Linux 5.3+, Python 3.9+)
- `python3` on `PATH`

On shutdown, antechamber locates its private task-host process group by the
shard key derived from the session ID and working directory it created,
confirms the process identity (PID plus start time, read from `/proc`), then
signals only that verified group: SIGTERM, with an escalation to SIGKILL
after a few seconds. It never does a broad command-line-based kill, and it
never signals a process it can't positively identify as its own.

On macOS there is no pidfd, so the same ownership rule is read from
`/bin/ps` (PID, group, `lstart` start time, argv) and `/usr/sbin/lsof` (working
directory): a live group leader running the supervisor entry point, whose
`--socket` value is the shard of a session antechamber created and whose working
directory is that session's directory. Every member of an owned group is
recorded from that one scan. Each SIGTERM, and each SIGKILL after five seconds,
goes to one PID, and only after a fresh `ps` scan still shows the recorded
group and start time. That leaves a short window between the scan and the
signal in which a PID could be recycled, the same window the agent's own
disposal (`PiRpcClient.dispose()`) accepts on every platform. A member that
outlives its supervisor is still stopped, and members that survive SIGKILL are
reported as a shutdown error. If `ps` or `lsof` cannot confirm a process, it is
not signalled.

If `python3` or pidfd support isn't available (a Linux kernel too old, or a
platform that is neither Linux nor macOS), this teardown step is skipped with a warning instead of crashing
antechamber's shutdown. The agent process itself (the one antechamber spawned
directly) is still reaped normally; only the detached task-host supervisor
cleanup is affected. See the [Platform notes](../../README.md#platform-notes)
in the README.

## Example: running OmO-backed antechamber as a systemd user service

This is a generic template, not a working config for any particular machine.
Replace every placeholder before using it.

`~/.config/systemd/user/antechamber.service`:

```ini
[Unit]
Description=antechamber (OmO backend)
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/antechamber/dist/cli.js serve --hostname 127.0.0.1 --port 4096
Environment=ANTECHAMBER_PI_BINARY=/path/to/omo
Environment=ANTECHAMBER_STATE_DIR=%h/.config/antechamber
Environment=ANTECHAMBER_AGENT=OmO
Environment=ANTECHAMBER_IDLE_TIMEOUT_MS=900000
Environment=ANTECHAMBER_MAX_LIVE=8
Restart=on-failure
KillMode=control-group
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now antechamber
```

Point OpenChamber's `settings.opencodeBinary` at
`/path/to/antechamber/bin/opencode-antechamber` instead if you want
OpenChamber to manage the process lifecycle itself rather than running
antechamber as a standalone service; don't do both at once.
