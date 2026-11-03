import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { closeSync, constants, openSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { findPidfdPython } from "./pidfd.js";
import { listDarwinProcesses, runPs, type PsRunner } from "./proc-table-darwin.js";

/** How long a darwin teardown waits after SIGTERM before escalating, and how often it re-reads the table. */
const HOST_TERM_GRACE_MS = 5_000;
const HOST_POLL_MS = 100;

/** Capability and warning state are captured once, before any shutdown work. */
export function createSessionHostStopper(
  platform: NodeJS.Platform = process.platform,
  probe: () => string | undefined = findPidfdPython,
): (created: ReadonlyMap<string, string>) => Promise<void> {
  if (platform === "darwin") return createDarwinHostStopper();
  const python = platform === "linux" ? probe() : undefined;
  let warned = false;
  return async (created) => {
    if (created.size === 0) return;
    if (python === undefined) {
      if (!warned) {
        warned = true;
        console.warn(
          "Private OmO host teardown skipped: requires Linux and python3 with working pidfd support (PATH, /bin/python3 or /usr/bin/python3). Hosts are not tracked; nothing is signalled.",
        );
      }
      return;
    }
    await stopSupportedSessionHosts(created, python);
  };
}

export const stopSessionHosts = createSessionHostStopper();

/** Injected so the darwin path can be tested without running ps, lsof or a signal. */
export interface DarwinHostDependencies {
  readonly run: PsRunner;
  readonly cwdOf: (pid: number) => string | undefined;
  readonly realpath: (path: string) => string;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly delay: (ms: number) => Promise<void>;
  readonly graceMs: number;
  readonly pollMs: number;
}

/** macOS has no `/proc/<pid>/cwd`; lsof prints `p<pid>`, `fcwd`, `n<path>`. */
function cwdOfHost(pid: number): string | undefined {
  try {
    const output = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    });
    for (const line of output.split("\n")) if (line.startsWith("n")) return line.slice(1);
    return undefined;
  } catch {
    // No permission, no process, or no lsof: the directory is unconfirmed and nothing is signalled.
    return undefined;
  }
}

function signalHost(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    // Gone since the last scan, or not ours to signal: either way nothing was sent.
    if (code === "ESRCH" || code === "EPERM") return;
    throw error;
  }
}

function socketName(sessionId: string): string {
  return `p-${createHash("sha256").update(`p:${sessionId}`).digest("hex").slice(0, 16)}.sock`;
}

/**
 * The value of `--socket`, as Linux reads it from argv. `ps` joins argv with spaces, so the value runs
 * to the next ` --` flag (a socket directory may contain spaces). Anything else after it makes the
 * basename miss every shard, which fails closed.
 */
function socketArgument(args: string): string | undefined {
  const match = /(?:^|\s)--socket\s+(.+?)(?=\s--|$)/.exec(args);
  return match?.[1] === undefined ? undefined : basename(match[1].trimEnd());
}

function isSupervisor(args: string): boolean {
  const tokens = args.split(/\s+/);
  return (
    tokens.includes("--internal-rpc-host-supervisor") || tokens.some((token) => token.endsWith("/host-lifecycle.js"))
  );
}

/**
 * macOS teardown without pidfd. Ownership is the Linux rule: a live group leader whose argv names the
 * supervisor entry point and, as its `--socket` value, the shard of a session this connector created,
 * and whose working directory is that session's directory. Every member of an owned group is recorded
 * with its start time in the same scan, and each later signal goes to one PID only after a fresh scan
 * still shows the same group and start time. Members are tracked individually, so a child that outlives
 * its supervisor is still stopped. A PID can be recycled between that scan and the signal; the window
 * is the same one `PiRpcClient.dispose()` accepts.
 */
export function createDarwinHostStopper(
  overrides: Partial<DarwinHostDependencies> = {},
): (created: ReadonlyMap<string, string>) => Promise<void> {
  const deps: DarwinHostDependencies = {
    run: overrides.run ?? runPs,
    cwdOf: overrides.cwdOf ?? cwdOfHost,
    realpath: overrides.realpath ?? realpathSync,
    signal: overrides.signal ?? signalHost,
    delay: overrides.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    graceMs: overrides.graceMs ?? HOST_TERM_GRACE_MS,
    pollMs: overrides.pollMs ?? HOST_POLL_MS,
  };
  return async (created) => {
    if (created.size === 0) return;
    const sockets = new Map([...created].map(([id, directory]) => [socketName(id), directory]));
    const processes = listDarwinProcesses(deps.run);
    const groups = new Set<number>();
    for (const row of processes) {
      if (row.group !== row.pid || !isSupervisor(row.args)) continue;
      const socket = socketArgument(row.args);
      const directory = socket === undefined ? undefined : sockets.get(socket);
      if (directory === undefined) continue;
      const cwd = deps.cwdOf(row.pid);
      if (cwd === undefined) continue;
      let expected: string;
      try {
        expected = deps.realpath(directory);
      } catch {
        continue;
      }
      if (cwd === expected) groups.add(row.group);
    }
    const members = processes.filter((row) => groups.has(row.group));
    if (members.length === 0) return;

    const survivors = (): number[] => {
      const now = new Map(listDarwinProcesses(deps.run).map((row) => [row.pid, row]));
      return members
        .filter((member) => {
          const row = now.get(member.pid);
          return row !== undefined && row.group === member.group && row.start === member.start;
        })
        .map((member) => member.pid);
    };
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      for (const pid of survivors()) deps.signal(pid, signal);
      for (let waited = 0; waited < deps.graceMs; waited += deps.pollMs) {
        await deps.delay(deps.pollMs);
        if (survivors().length === 0) return;
      }
    }
    throw new Error(`private OmO hosts survived shutdown: ${survivors().join(", ")}`);
  };
}

interface HostProcess {
  readonly fd: number;
  readonly pid: number;
  readonly group: number;
  readonly start: string;
  readonly state: string;
  readonly argv: readonly string[];
}

function processInfo(pid: number): HostProcess | undefined {
  let fd: number | undefined;
  try {
    // An open proc directory never redirects to a replacement PID. Keep it
    // through selection and pass it to the helper for post-pidfd-open validation.
    fd = openSync(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY);
    const stat = readFileSync(`/proc/self/fd/${fd}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      fd,
      pid,
      group: Number(fields[2]),
      start: fields[19] ?? "",
      state: fields[0] ?? "",
      argv: readFileSync(`/proc/self/fd/${fd}/cmdline`, "utf8").split("\0").filter(Boolean),
    };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code))) return undefined;
    throw error;
  }
}

// Node 22 has no pidfd API. This bounded, stdlib-only helper holds all pidfds
// across TERM, readiness-based death observation, and KILL. -I ignores Python
// environment customizations. No numeric-PID signal fallback is permitted.
// biome-ignore lint/complexity/noUselessStringRaw: embedded Python must keep any backslashes verbatim.
const stopBoundHosts = String.raw`
import contextlib, json, os, selectors, signal, sys, time

pidfd_open = os.pidfd_open
send_signal = signal.pidfd_send_signal

def matches(member):
    try:
        with open("/proc/self/fd/%s/stat" % member["fd"]) as source:
            stat = source.read()
    except (FileNotFoundError, ProcessLookupError):
        return False
    fields = stat[stat.rfind(")") + 2:].split()
    if fields[19] != member["start"] or fields[0] == "Z":
        return False
    if int(fields[2]) != member["group"]:
        raise RuntimeError("private OmO host member pid=%s changed process group" % member["pid"])
    return True

with contextlib.ExitStack() as resources:
    selector = resources.enter_context(selectors.DefaultSelector())
    pending = {}
    for member in json.loads(sys.argv[1]):
        try:
            fd = pidfd_open(member["pid"])
        except ProcessLookupError:
            continue
        resources.callback(os.close, fd)
        # Open FIRST, then validate against the retained proc directory, not a
        # newly resolved /proc/PID. If the original died/reused, that directory
        # is gone (or zombie), even if both processes started in the same tick.
        if matches(member):
            selector.register(fd, selectors.EVENT_READ)
            pending[fd] = member

    # Finish all acquisition/validation before sending anything. Missing Python,
    # missing pidfd support, and acquisition errors therefore fail closed.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for fd, member in pending.items():
            if matches(member):
                try:
                    send_signal(fd, sig)
                except ProcessLookupError:
                    continue
        deadline = time.monotonic() + 5
        while pending:
            events = selector.select(max(0, deadline - time.monotonic()))
            if not events:
                break
            for key, _ in events:
                del pending[key.fd]
                selector.unregister(key.fd)
        if not pending:
            break
    if pending:
        raise RuntimeError("private OmO hosts survived shutdown: %s" %
                           [member["pid"] for member in pending.values()])
`;

/**
 * OmO's p-<sha256("p:" + parentSessionId)[:16]>.sock shards belong to one
 * parent session tree. Only connector-created IDs (including their persisted
 * ownership after restart) are authorized; discovered sessions and LSP are not.
 */
async function stopSupportedSessionHosts(created: ReadonlyMap<string, string>, python: string): Promise<void> {
  if (created.size === 0) return;
  const sockets = new Map(
    [...created].map(([id, directory]) => [
      `p-${createHash("sha256").update(`p:${id}`).digest("hex").slice(0, 16)}.sock`,
      directory,
    ]),
  );
  const processes: HostProcess[] = [];
  try {
    for (const name of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      const info = processInfo(Number(name));
      if (info) processes.push(info);
    }
    const groups = new Set(
      processes
        .filter((info) => {
          if (info.state === "Z" || info.group !== info.pid) return false;
          if (
            !info.argv.includes("--internal-rpc-host-supervisor") &&
            !info.argv.some((arg) => arg.endsWith("/host-lifecycle.js"))
          )
            return false;
          const socketIndex = info.argv.indexOf("--socket");
          const socket = socketIndex < 0 ? undefined : info.argv[socketIndex + 1];
          if (!socket) return false;
          const directory = sockets.get(basename(socket));
          if (directory === undefined) return false;
          try {
            // The original leader must still exist after the process-table scan:
            // a recycled group number cannot confer its ownership on new members.
            return readlinkSync(`/proc/self/fd/${info.fd}/cwd`) === realpathSync(directory);
          } catch (error) {
            if (error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code)))
              return false;
            throw error;
          }
        })
        .map((info) => info.group),
    );
    const members = processes.filter((info) => groups.has(info.group) && info.state !== "Z");
    if (members.length === 0) return;
    const identities = members.map((info, index) => ({
      fd: index + 3,
      pid: info.pid,
      start: info.start,
      group: info.group,
    }));
    // Ownership is the parent-session shard + cwd + supervisor + private group,
    // never the service cgroup (production hosts share it with the connector).
    const helper = spawn(python, ["-I", "-c", stopBoundHosts, JSON.stringify(identities)], {
      stdio: ["ignore", "ignore", "pipe", ...members.map((info) => info.fd)],
    });
    let stderr = "";
    helper.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    const timeout = setTimeout(() => helper.kill("SIGKILL"), 15_000);
    try {
      const [code, signal] = await once(helper, "close");
      if (code !== 0)
        throw new Error(`private OmO host pidfd teardown failed (code=${code}, signal=${signal}): ${stderr}`);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    for (const info of processes) closeSync(info.fd);
  }
}
