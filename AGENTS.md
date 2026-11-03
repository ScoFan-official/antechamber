# PROJECT KNOWLEDGE BASE

**Generated:** 2026-10-14
**Commit:** 9de373e
**Branch:** main

## OVERVIEW
antechamber is an OpenCode-compatible HTTP/SSE server, so OpenChamber can drive the pi coding agent (default backend: OmO) over JSONL stdio RPC (`<agent> --mode rpc`), with one agent process per session.
Built with TypeScript 7, Node >=22 and ESM/NodeNext. It has zero runtime dependencies; the devDeps are tsc, tsx, Biome, `@opencode-ai/sdk` (types only), and esbuild plus `@openchamber/sdk` (1.24, OmO Graph) and its 2.x alias `@openchamber/sdk-v2` (OmO Work) for the bundled extensions.

```
OpenChamber --HTTP/SSE (OpenCode v1 + v2 /api subset)--> antechamber --JSONL stdio--> omo|pi --mode rpc
```

## STRUCTURE
```
antechamber/
├── src/       # adapter runtime, flat by concern -> src/AGENTS.md
├── test/      # hermetic node:test suite + fake-agent fixtures -> test/AGENTS.md
├── contrib/   # live-agent smokes/probes, cost tokens, not in CI -> contrib/AGENTS.md
├── bin/       # opencode-antechamber: OpenChamber launcher shim (serve, --version, upgrade); opencode-pi = deprecated alias
├── extensions/omo-dag/  # OmO Graph OpenChamber extension: sandboxed panel + read-only service -> its README.md
├── extensions/omo-work/ # OmO Work: OpenChamber 2.x Work Status section + relay service -> its README.md
└── docs/      # architecture, api-surface (route contract), configuration (env), backends/omo.md
```
Published package = `dist/` + `bin/` shims + the built OmO Graph and OmO Work extensions; the `antechamber` bin maps to `dist/cli.js`. There is no library `exports` field.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Which OpenCode routes exist/are called | `docs/api-surface.md` | consumer-driven contract; update with route changes |
| Env vars and defaults | `docs/configuration.md` | update in the same change as any env var |
| Why fork/revert/shutdown work as they do | `docs/architecture.md` | evidence-backed OmO protocol notes |
| OmO deployment, systemd, teardown | `docs/backends/omo.md` | |
| Release flow | `RELEASE.md`, `.github/workflows/release.yml`, `scripts/release.ts`, `scripts/publish-extension-branches.ts` | every push to main ships a patch; never hand-bump patch versions; `extension/*` branches are written by CI only |
| Per-module responsibility table | `docs/development.md` | source and smoke paths |

## CODE MAP
Centrality measured by counting relative imports across src/test/contrib.

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `OC*` types | types | `src/types.ts` | 38 | OpenCode v1 shapes shared everywhere |
| `SessionStore` | class | `src/session-store.ts` | 19 | registry persistence, ID mapping |
| `AdapterServer` | class | `src/server.ts` | 20 | composition root; tests/contrib boot it |
| `SessionManager` | class | `src/sessions.ts` | 20 | session orchestration core |
| `PiRpcClient` | class | `src/pi-rpc.ts` | 13 | agent subprocess + JSONL framing |
| `envSetting` | fn | `src/config.ts` | 12 | `ANTECHAMBER_*` then `OCPI_*` lookup |
| `TodoBridge` | class | `src/todo-bridge.ts` | 10 | todo tool -> OpenCode todo state |
| `V2EventTranslator` | class | `src/v2.ts` | 9 | v1 events -> v2 envelopes |
| `ApprovalBridge` | class | `src/approvals.ts` | 7 | permissions/questions via extension UI |
| `ToolMapper` / `mapTool` | fn | `src/tool-map.ts` | 7 | tool events -> `ToolState` |

## CONVENTIONS
- Biome: 2 spaces, 120 columns, double quotes, semicolons, LF. `npm run lint` runs with `--error-on-warnings`.
- Several Biome rules are off on purpose: `useOptionalChain`, `noUnusedImports`, `noNonNullAssertion`, `useConst`, `noAssignInExpressions`, `noControlCharactersInRegex`, `useIterableCallbackReturn`, `noShadowRestrictedNames`.
  Do not "clean up" code toward those rules.
- tsconfig is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, so build optional props conditionally (`...(x ? {k: x} : {})`).
- Relative imports carry `.js` suffixes (NodeNext). Filenames are kebab-case.
- `tsc` compiles only `src/`; `npm run build` then bundles `extensions/omo-dag` and `extensions/omo-work` with esbuild (own tsconfig, DOM + Node). `npm run typecheck` uses `tsconfig.check.json` and covers `src`, `test` and `contrib`.
- Env vars use the `ANTECHAMBER_` prefix; `OCPI_` is a deprecated fallback. The agent dir is resolved from `OMO_CODING_AGENT_DIR`, then `SENPI_`, then `PI_` (no prefix).
  Auth uses OpenCode's `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`.
- Commits follow Conventional Commits, scoped by area (`fix(session): ...`, `feat(tools): ...`). Add user-visible changes to `[Unreleased]` in `CHANGELOG.md`.

## VERIFYING A FIX
Green hermetic tests are not proof that a user-reported bug is fixed. Fixes for the mobile blank transcript (#15) and compaction shipped green and still failed on real sessions, for three reasons:
the fake agent only does what we coded (`turn-omo.mjs` never cancelled a compaction or connected MCP late), the test data was tiny (3 messages vs. turns longer than 190), and a known-bad real-surface case was written off as acceptable.
A fourth reason: the user's OpenChamber was still running an older adapter.

For every bug report:
1. **Reproduce on the reported session before changing code.** Use its ID, through the real surface (OpenChamber UI, or its HTTP API through the OpenChamber proxy), on a copy of the real data. A fix with no failing "before" has not been shown to fix anything.
2. **Lock it with a hermetic test that fails without the fix.** Disable the fix once and watch the test fail. When the bug depends on OmO behaving differently from the fake agent, first teach the fixture that behavior (cite the OmO bundle file or log line), then test against it.
3. **Show "after" on the same surface.** UI-visible bugs (transcript, cards, layout) need `npm run build && npm run replay -- --session <id>` before the fix and after it, plus a full `npm run replay` with no new FAIL before the PR. Never accept a degraded case (a button to tap, a partial render) as fixed; it is the next bug report.
4. **Put the before/after evidence in the PR**: the command, the session ID (not its content) and PASS/FAIL. Say plainly what was not run live and why (for example, token cost).
5. **After the release, check what is running.** `antechamber doctor` reports the installed, latest and running adapter versions. A WARN on `running` means OpenChamber must relaunch the adapter (`systemctl --user restart openchamber.service` for the user's deployment) before the fix is live. Do not tell the user a merged fix is live until doctor shows it running.

## ANTI-PATTERNS (THIS PROJECT)
- Calling a bug fixed on hermetic tests alone, or on sessions other than the one reported. See VERIFYING A FIX.
- Changing routes without updating `docs/api-surface.md`, or env vars without updating `docs/configuration.md`.
- Fixed sleeps or polling in tests. Subscribe to the real signal first, then await it with a bounded timeout.
- Relying on `contrib/` smokes to catch a regression that a unit test should catch.
- Fabricating success for unsupported OpenCode capabilities (share, MCP, OAuth...). Return 400.
- Killing processes by command-line pattern, or touching OmO's shared LSP daemon or other clients' task hosts.
- Personal paths, hostnames or credentials in code, fixtures or docs (this is a PR checklist item).
- Adding runtime dependencies. There are none today. The published package is `dist/`, the `bin/` shims and the built extensions (`files` in package.json).

## UNIQUE STYLES
- Protocol behavior claims in `docs/architecture.md` cite installed OmO bundle files and dated probes. Keep that evidence style when documenting new RPC semantics.
- Revert is conversation-only and never touches files. This is a product rule, not a limitation.
- Default bind is loopback. A non-loopback bind needs a password, `ANTECHAMBER_ALLOW_INSECURE=1`, or `--insecure-no-auth`.

## COMMANDS
```bash
npm ci
npm run dev -- serve --port 4096         # run from source (tsx)
npm run check                            # typecheck + lint + format:check + test (release gate)
npm run typecheck && npm test && npm run build   # minimum before a PR
npm run format                           # biome format --write
npx tsx --test --import ./test/setup.ts test/fork-revert.test.ts   # one file; keep the setup import
                                         # (npm test -- --test-name-pattern does NOT filter)
ANTECHAMBER_PI_BINARY="$(command -v omo)" npm run omo-smoke   # live, costs tokens
npm run build && npm run replay -- [--session ses_x]   # real sessions in a real OpenChamber; no tokens, local only
antechamber doctor                       # includes installed vs latest vs running adapter versions
```
CI (Node 22.x and 24.x) runs typecheck, lint, format:check, test and build, then asserts `npm pack` ships `dist/cli.js` and the built extensions, and no `test/`, `contrib/` or extension sources/tests. A `macos-latest` job (Node 24) runs typecheck and test so the darwin process paths meet the real `ps`.

## NOTES
- `bin/opencode-antechamber` runs `dist/cli.js`, so a fresh checkout needs `npm run build` before OpenChamber can launch it.
- Teardown of detached OmO task hosts uses pidfd via Python and `/proc` on Linux, and `/bin/ps` plus `/usr/sbin/lsof` with per-PID identity re-checks on macOS. On other platforms it warns and skips.
- `reference/` (gitignored) holds shallow clones of openchamber and pi-mono for protocol lookups. It is not part of the build and Biome ignores it.
- `.omo/` is gitignored and Biome-ignored.
- The route smoke reads the maintained static route table in `docs/api-surface.md`; parameterized routes are documented separately.
- `npm run typecheck` runs `tsc -p tsconfig.check.json`, `tsc -p extensions/omo-dag/tsconfig.json` and `tsc -p extensions/omo-work/tsconfig.json`.
