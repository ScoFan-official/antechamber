# antechamber

A local OpenCode-compatible HTTP/SSE server that lets [OpenChamber](https://github.com/openchamber/openchamber) drive [OmO](https://github.com/code-yeongyu/oh-my-openagent) instead of OpenCode. Plain [pi](https://github.com/badlogic/pi-mono) also works as an opt-in backend.

[![CI](https://github.com/eliottness/antechamber/actions/workflows/ci.yml/badge.svg)](https://github.com/eliottness/antechamber/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/eliottness/antechamber?style=flat&labelColor=100F0F&color=205EA6)](./LICENSE)

## What it is

OpenChamber only speaks the OpenCode HTTP/SSE API. OmO (and pi, which it
builds on) are headless agents with their own RPC protocol (JSONL over stdio). antechamber sits
between them: it implements the subset of the OpenCode API that OpenChamber
actually uses, and translates every call into an OmO RPC session.

```
OpenChamber (UI)  --OpenCode API (HTTP/SSE)-->  antechamber  --JSONL/stdio-->  omo --mode rpc
                                                                                (one process per session)
```

No fork of OpenChamber or pi is required. Point OpenChamber at antechamber as
an **external OpenCode server** and sessions run on OmO.

## Features

- Session create/list/rename/archive/delete, prompt streaming (text and
  reasoning deltas), and abort, mapped onto pi/OmO RPC sessions.
- Tool calls rendered as native OpenChamber tool parts (bash, write, edit,
  and so on), including subagent/task cards.
- Approvals and questions bridged through pi's extension-UI protocol.
- Todo list bridging from pi/OmO's todo tool to OpenChamber's task panel
  (OpenChamber 1.x; on 2.x, the OmO Work section shows it by phase).
- Fork, revert, and unrevert backed by the agent's session tree, not a
  filesystem snapshot. Reverting changes conversation context only; it never
  touches files on disk.
- Session diff endpoint (unified patch) independent of OpenChamber's own git
  integration.
- Session persistence and revival across connector restarts, with explicit
  ownership tracking for detached task-host processes it spawned.
- Idle reaping and a live-process cap (`ANTECHAMBER_MAX_LIVE`) so long-running
  deployments don't accumulate agent processes.
- Optional [OpenChamber extensions](#openchamber-extensions): **OmO Graph**
  draws the OmO sub-agents behind the open session as a live, clickable graph,
  and **OmO Work** (OpenChamber 2.x) shows the session's todo phases,
  monitors, eval cells and other background work in the Work Status panel.

## Supported backends

| Backend | Status |
|---|---|
| [OmO](https://github.com/code-yeongyu/oh-my-openagent) (`omo`, package `omo-ai`) | **default and supported**: titles, steering, subagent cards, structured questions, and private task-host teardown are built and tested against it |
| [pi](https://github.com/badlogic/pi-mono) (`@earendil-works/pi-coding-agent`) | opt-in, best effort: set `ANTECHAMBER_PI_BINARY=pi`; OmO-specific features are unavailable |

antechamber spawns `omo` from `PATH` unless `ANTECHAMBER_PI_BINARY` names
another executable (see [docs/configuration.md](docs/configuration.md)).

## Compatibility

| OpenChamber | API | Status |
|---|---|---|
| >= 2.0.4 | v2 (`@opencode-ai/sdk/v2`) | primary target; antechamber advertises `opencode v2.1.0` on `--version` (OpenChamber 2.5.2 requires 2.1.0) |
| 1.24.x | v1 | supported |
| other versions | - | not tested |

OpenChamber changes which OpenCode API calls it makes between releases. If a
feature breaks on a newer OpenChamber, run `npm run smoke` to see which check
failed, then open an issue with the output. See
[docs/api-surface.md](docs/api-surface.md) for the maintained route, response,
and event-stream inventory.

## Quick start

Needs Node.js 22+ and OmO's `omo` command on PATH (`bun add -g omo-ai`).

```bash
npm i -g antechamber
# or: bun add -g antechamber
antechamber doctor
antechamber setup --auto-update
```

`setup` updates OpenChamber's `opencodeBinary`, preserves all other settings,
and backs up an existing settings file before changing it. Restart OpenChamber
after setup. Preview changes with `antechamber setup --dry-run`.

`--auto-update` keeps antechamber current without any action from you. It
writes a small launcher, `~/.config/antechamber/opencode-antechamber`, and points
OpenChamber at it. Each time OpenChamber starts antechamber, the launcher
checks npm for a newer release once the server is up and installs it with the
package manager that owns the global install. The new version runs from the
next start; startup never waits on the network, and an offline start just
skips the check. It needs a global npm or bun install, so it is refused for
source checkouts and `npx`. Drop the flag (plain `antechamber setup`) to point
OpenChamber back at the `antechamber` bin and stop auto-updates.

Optionally, add the bundled [OpenChamber extensions](#openchamber-extensions):
`setup` ends by printing their folders (under
`$(npm root -g)/antechamber/extensions/`). In OpenChamber, open
**Settings → Extensions → Add → Folder**, paste a path, and approve the
permissions it asks for. On OpenChamber 2.x, add OmO Work to see monitors,
eval cells and the todo list in the Work Status panel. The folders are updated
in place by `npm update -g`.

For an isolated OpenChamber instance, leaving your main settings untouched:

```bash
antechamber setup --profile ~/.config/antechamber-openchamber
# setup prints the command for this profile:
OPENCHAMBER_DATA_DIR=~/.config/antechamber-openchamber openchamber serve --port 57124
```

For a systemd-managed OpenChamber, also capture the shell's PATH and the
absolute OmO executable in a user service drop-in:

```bash
antechamber setup --systemd
# default unit: openchamber.service; another unit: --systemd my-openchamber.service
systemctl --user daemon-reload && systemctl --user restart openchamber.service
# or explicitly let setup run those commands:
antechamber setup --systemd --restart
```

`--pi-binary /absolute/path/to/omo` overrides backend discovery for the drop-in.
Other drop-ins setting `ANTECHAMBER_*` or `OCPI_*` produce a warning: later
files can override the generated configuration. `setup` never runs systemctl
unless `--restart` is passed.

OpenChamber spawns whatever `settings.opencodeBinary` points at as
`serve --hostname H --port P`, waits for the stdout line
`opencode server listening on <url>`, then health-checks `/global/health`.
The installed `antechamber` bin implements this contract itself, including the
`--version` compatibility probe. `bin/opencode-antechamber` is only needed for
source checkouts; `bin/opencode-pi` remains a deprecated compatibility shim.

You can also run antechamber directly, outside of OpenChamber's managed
lifecycle:

```bash
antechamber --port 4096 --host 127.0.0.1 --directory /path/to/project
# or, OpenCode-compatible:
antechamber serve --hostname 127.0.0.1 --port 4096
```

## Commands

| Command | Purpose / options |
|---|---|
| `antechamber serve` | OpenCode-compatible server; `--hostname`/`--host`, `--port`, `--directory`. Bare `antechamber` also starts the server. |
| `antechamber setup` | Configure OpenChamber; `--settings <file>`, `--profile <dir>`, `--binary <path>`, `--dry-run`, `--systemd [unit]`, `--pi-binary <path>`, `--restart`, `--auto-update`. |
| `antechamber doctor` | Read-only Node, backend, agent/state directories, teardown, OpenChamber and auth checks, plus the installed, latest released and running adapter versions (a running server older than the install needs an OpenChamber restart); `--json`, `--settings <file>`, `--profile <dir>`. Exits 1 on any FAIL; warnings do not fail. |
| `antechamber upgrade` | Install the latest release over a global npm or bun install, with the package manager that owns it. Refused for source checkouts and `npx`. |
| `antechamber version` | Package version plus OpenCode API contract version. `--version`/`-v` deliberately print exactly `opencode v2.1.0` for OpenChamber. |
| `antechamber help` | Usage and options; also `--help`/`-h`. |

## Upgrade, uninstall and rollback

With `setup --auto-update` there is nothing to do: each start installs the
latest release for the next one. Otherwise:

```bash
antechamber upgrade
# equivalent: npm update -g antechamber (or: bun add -g antechamber)
```

Restart OpenChamber, or `systemctl --user restart openchamber.service` for a
managed service. Run `antechamber doctor` again. If the executable moved,
rerun `antechamber setup`.

OpenChamber 2.3.2 and later can show an "OpenCode update" notice because antechamber
reports OpenCode API 2.1.0, the minimum OpenChamber 2.5.2 accepts. The notice names
an OpenCode version, but its **Update** button runs `<opencodeBinary> upgrade`,
which upgrades antechamber itself (a no-op when it is already current). Click
**Reload OpenCode** afterwards to restart onto the new version. OpenChamber
1.x shows no notice; its `POST /global/upgrade` call upgrades antechamber the
same way.

To roll back wiring, copy the backup printed by setup over the settings file:

```bash
cp /path/settings.json.bak-antechamber-YYYYMMDDHHMMSS /path/settings.json
```

If you used `--systemd`, restore the printed `antechamber.conf` backup, or
remove only that generated drop-in if there was no previous file. Then run
`systemctl --user daemon-reload` and restart OpenChamber/the service. Restore
the old `opencodeBinary` before uninstalling:

```bash
npm uninstall -g antechamber
# or: bun remove -g antechamber
```

## From source

```bash
git clone https://github.com/eliottness/antechamber.git
cd antechamber
npm ci
npm run build
node dist/cli.js doctor
node dist/cli.js setup --binary "$PWD/bin/opencode-antechamber"
# isolated alternative:
node dist/cli.js setup --profile ~/.config/antechamber-openchamber \
  --binary "$PWD/bin/opencode-antechamber"
```

The source launcher requires the built `dist/cli.js`. Pull updates, run
`npm ci && npm run build`, and restart OpenChamber.

`npm run build` also builds the OmO Graph and OmO Work extensions; `setup`
prints their folders (`$PWD/extensions/omo-dag`, `$PWD/extensions/omo-work`) to
add in **Settings → Extensions → Add → Folder**.

## OpenChamber extensions

antechamber ships three optional OpenChamber extensions, in the npm package and
attached to every GitHub release. None is required to run sessions.

| Extension | Adds | OpenChamber | Asks for |
|---|---|---|---|
| [OmO Graph](#omo-graph) (`extensions/omo-dag`) | a rail panel drawing the session's OmO sub-agents as a live graph | 1.22 or newer | sessions, local service |
| [OmO Work](#omo-work) (`extensions/omo-work`) | a Work Status section with the session's todo phases, monitors, eval cells, background sessions and goal timer | 2.3.2 or newer | local service |
| [OmO Compatibility](#omo-compatibility) (`extensions/omo-compat`) | headers for OmO tool cards, such as `JS Eval` on eval cells | 1.24 or newer | nothing |

All three run on OpenChamber web and desktop; VS Code and mobile load no
extensions.

### Installing an extension

In OpenChamber, open **Settings → Extensions → Add** and pick the source that
fits where OpenChamber runs:

| OpenChamber runs | Add | OmO Graph | OmO Work | OmO Compatibility |
|---|---|---|---|---|
| anywhere (recommended) | **URL** (Git) | `https://github.com/eliottness/antechamber#extension/omo-graph` | `…#extension/omo-work` | `…#extension/omo-compat` |
| on the machine where antechamber is installed | **Folder** | `extensions/omo-dag` | `extensions/omo-work` | `extensions/omo-compat` |
| anywhere, offline | **ZIP file** | `antechamber-omo-graph.zip` | `antechamber-omo-work.zip` | `antechamber-omo-compat.zip` |

- **URL**: a Git install from the branch every release publishes. OpenChamber
  offers to update it after each release. Keep the `#extension/...` part: the
  bare repository URL makes OpenChamber clone antechamber itself, whose
  `package.json` is not an extension, and OpenChamber words that rejection as
  "panel.id must be kebab-case".
- **Folder**: the paths `antechamber setup` prints, under
  `$(npm root -g)/antechamber/` for npm installs or the checkout after
  `npm run build`.
- **ZIP file**: attached to every GitHub release, or built with
  `npm run build && npm run pack:extension -- antechamber-omo-graph.zip` (OmO
  Graph) or `npm run pack:work-extension -- antechamber-omo-work.zip` (OmO
  Work). OpenChamber never updates ZIP installs.

Then approve the permissions it asks for. See
[Upgrading the OpenChamber extensions](#upgrading-the-openchamber-extensions)
for how each source moves to a new release.

### OmO Graph

With the default OmO backend, OmO Graph adds a rail panel showing the open
session's orchestrator and every sub-agent OmO launched, grouped in waves:

- each card shows the sub-agent's live state, duration, agent and model;
- hovering a card highlights its input and output edges;
- clicking a card opens that sub-agent's session.

Its local service reads OmO's task store and antechamber's session registry
read-only. Details: [extensions/omo-dag/README.md](extensions/omo-dag/README.md).

### OmO Work

OmO Work adds an **OmO Work** section to OpenChamber 2.x's Work Status panel,
for the background work of the open session:

- the OmO todo list grouped by phase, with progress per phase;
- terminal monitors, with their command, filter and latest matched lines (on
  2.x, monitors appear here instead of as subagent sessions);
- detached eval cells, with their output and a **Stop** button;
- background terminal sessions that are still running;
- the goal continuation timer, what it waits on, and a **Fire now** button.

Its local service talks to the running antechamber through the
`/antechamber/work-status` routes, authenticated by a token antechamber writes
into its private run record, so it never needs the server password. It needs
antechamber running on the same machine as OpenChamber. Details:
[extensions/omo-work/README.md](extensions/omo-work/README.md).

### OmO Compatibility

OmO Compatibility is a manifest with no code. It tells OpenChamber how to
display OmO tool calls that antechamber maps onto OpenChamber's cards; today
it heads eval cells with `JS Eval` or `Python Eval` and the cell's summary. It
needs no build. Details:
[extensions/omo-compat/README.md](extensions/omo-compat/README.md).

## Upgrading the OpenChamber extensions

Every antechamber release ships the three extensions at its own version. How
an installed extension moves to a new release depends on how it was added:

- **Git URL** (`https://github.com/eliottness/antechamber#extension/...`):
  Settings → Extensions shows **Update available** once a release is out
  (OpenChamber checks at most hourly; **Check for updates** checks now).
  **Update** replaces it in place and keeps its approvals and settings.
- **Folder**: the folder belongs to the antechamber installation, so it
  changes with `antechamber upgrade` (or `git pull && npm ci && npm run build`
  in a checkout). Toggle the extension off and on to restart its service.
- **ZIP** (file or release URL): OpenChamber never checks these. Add the new
  archive and choose **Reinstall**, or switch to the Git URL once: remove the
  extension, then add it by URL.

Each extension is built against the antechamber of the same release, so
upgrade antechamber too and restart OpenChamber to run it; `antechamber
doctor` shows the running version.

## Configuration

Connector settings use the `ANTECHAMBER_` prefix; the deprecated `OCPI_`
prefix is still accepted as a fallback. RPC capability passthrough also reads
`OMO_RPC_CLIENT_CAPABILITIES` and `SENPI_RPC_CLIENT_CAPABILITIES` directly.
Full reference, defaults, and units:
[docs/configuration.md](docs/configuration.md).

| Variable | Purpose |
|---|---|
| `ANTECHAMBER_PI_BINARY` | agent executable to spawn (default `omo`; set to `pi` for plain pi) |
| `ANTECHAMBER_PI_ARGS` | extra whitespace-split args passed to that binary |
| `ANTECHAMBER_STATE_DIR` | session registry directory |
| `ANTECHAMBER_AGENT` | agent name override advertised to OpenChamber |
| `ANTECHAMBER_IDLE_TIMEOUT_MS` | idle session reap timeout |
| `ANTECHAMBER_MAX_LIVE` | cap on concurrent live agent processes |
| `ANTECHAMBER_DEBUG` / `ANTECHAMBER_DEBUG_LOG` | request/event debug logging |
| `OMO_RPC_CLIENT_CAPABILITIES` / `SENPI_RPC_CLIENT_CAPABILITIES` | inherited RPC capabilities merged for the agent process |

## Security

antechamber is a local development tool: by default it binds to loopback
with no authentication, and it can run arbitrary shell commands on behalf of
the agent. Treat it the same way you'd treat a local dev server with shell
access, not a service to expose on a network.

Hardening controls (full reference in [docs/configuration.md](docs/configuration.md#security)):

- Optional HTTP Basic auth, matching OpenCode's own contract:
  `OPENCODE_SERVER_PASSWORD` (plus `OPENCODE_SERVER_USERNAME`, default
  `opencode`).
- Without a password, browser origins are limited to the adapter's own origin,
  HTTP(S) loopback origins (including a different loopback port), and origins
  listed in `ANTECHAMBER_ALLOWED_ORIGINS`; other origins get `403`. With a
  password, other origins may make authenticated requests but receive no CORS
  headers unless explicitly allowed.
- Binding to a non-loopback host requires a password, `ANTECHAMBER_ALLOW_INSECURE=1`,
  or the `--insecure-no-auth` flag.
- Request bodies are capped by `ANTECHAMBER_MAX_BODY_BYTES` (default 10 MiB);
  SSE subscribers, file search and agent RPC frames have fixed bounds.

## Platform notes

Linux is the primary supported platform. OmO's private task-host teardown
(killing detached supervisor processes antechamber spawned) uses Linux
pidfds (`os.pidfd_open`, Linux 5.3+) and `python3` on PATH, because Node has no pidfd
API; on Linux it never signals a numeric PID. macOS has no pidfd, so there it
reads `/bin/ps` and `/usr/sbin/lsof` and signals each owned process by PID after
re-checking its process group and start time (see
[the OmO backend notes](docs/backends/omo.md#private-task-host-teardown)). CI runs the suite on
macOS. On other platforms that teardown step is skipped with one warning instead of crashing.

## Limitations / non-goals

- Not a reimplementation of OpenChamber's own platform features (scheduler,
  relay, goals). Those stay in OpenChamber.
- Not a way to use pi/OmO as an LLM provider inside OpenCode. pi/OmO are full
  agents with their own loop; antechamber adapts at the session-protocol
  level, not the model level.
- Some OpenCode routes have no pi/OmO equivalent and are stubbed or return
  `400`/`501` (OAuth-based provider auth, MCP connect/disconnect, session
  share). See [docs/api-surface.md](docs/api-surface.md) for the maintained
  route and unsupported-response inventory.

## Development

```bash
npm run typecheck
npm test
npm run build
```

The smoke scripts (`npm run smoke`, `npm run omo-smoke`, `npm run probe`,
`npm run model-smoke`, `npm run v2-smoke`) drive a real `omo` (or `pi`)
process end to end and cost model tokens; they are not part of `npm test`
and are not run in CI. See [docs/development.md](docs/development.md).

Every commit on `main` is released as a new patch version: CI runs the checks,
bumps the package and extension versions, tags, publishes to npm with
provenance and creates the GitHub release from the CHANGELOG. See
[RELEASE.md](RELEASE.md).

## Docs

- [docs/architecture.md](docs/architecture.md) - design and session-model mapping
- [docs/api-surface.md](docs/api-surface.md) - OpenCode endpoints implemented, stubbed, or unsupported
- [docs/configuration.md](docs/configuration.md) - full environment variable reference
- [docs/development.md](docs/development.md) - source layout, testing, smoke scripts
- [docs/backends/omo.md](docs/backends/omo.md) - OmO backend details (agent name, task hosts, transcripts)
- [RELEASE.md](RELEASE.md) - automatic patch releases to npm and GitHub on every push to `main`

- [extensions/omo-dag/README.md](extensions/omo-dag/README.md) - the OmO Graph OpenChamber extension ([design](extensions/omo-dag/docs/DESIGN.md))
- [extensions/omo-work/README.md](extensions/omo-work/README.md) - the OmO Work status section for OpenChamber 2.x ([design](extensions/omo-work/docs/DESIGN.md))
- [extensions/omo-compat/README.md](extensions/omo-compat/README.md) - the OmO Compatibility display rules

## Credits

antechamber began as a fork of
[openchamber-pi-connector](https://github.com/qingzhu521/openchamber-pi-connector)
by qingzhu521 (xiuli.qz), released under the MIT license, and was substantially
extended from there (OpenCode v2 API support, OmO support, session fork/revert,
subagent and task cards, approvals, todos, thinking levels, shell runs, diffs,
session persistence, lifecycle caps, and more).

Also relies on [OpenChamber](https://github.com/openchamber/openchamber),
[OmO](https://github.com/code-yeongyu/oh-my-openagent) by code-yeongyu, and
[pi](https://github.com/badlogic/pi-mono) by badlogic / earendil.

## License

MIT. See [LICENSE](./LICENSE), which retains the original
openchamber-pi-connector copyright notice alongside the antechamber one.
