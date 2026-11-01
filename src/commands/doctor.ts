import { dirname, resolve } from "node:path";
import { piAgentDir } from "../agent-dir.js";
import { detectAgentName } from "../agent-name.js";
import { agentBinary, defaultStateDir, envSetting, isPlainPi } from "../config.js";
import { findPidfdPython } from "../pidfd.js";
import { readRunningServers } from "../running-servers.js";
import { isNewerVersion } from "../self-update.js";
import { ADAPTER_VERSION } from "../version.js";
import {
  autoUpdateLauncherPath,
  autoUpdateLauncherTarget,
  type CommandContext,
  createContext,
  isPackageBinary,
  readSettings,
  resolveBinary,
  type SettingsOptions,
  settingsPath,
} from "./context.js";

interface DoctorCheck {
  readonly name: string;
  readonly status: "PASS" | "WARN" | "FAIL" | "INFO";
  readonly message: string;
}

interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: 0 | 1;
}

/** EPERM means the process exists under another user. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * Which mechanism this platform uses to stop private OmO task hosts. Linux opens pidfds through
 * python3; macOS reads /bin/ps and /usr/sbin/lsof. Anything else has no teardown at all, and the
 * check says so instead of warning about Linux support that was never applicable.
 */
function privateHostTeardown(ctx: CommandContext): { status: DoctorCheck["status"]; message: string } {
  if (ctx.platform === "linux") {
    const python = findPidfdPython(ctx.env, (candidate, args) => {
      try {
        ctx.exec(candidate, args);
        return true;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return false;
      }
    });
    return python === undefined
      ? {
          status: "WARN",
          message: "requires python3 with working pidfd support (PATH, /bin/python3 or /usr/bin/python3)",
        }
      : { status: "PASS", message: `Linux pidfd support via ${python}` };
  }
  if (ctx.platform === "darwin") {
    const missing = ["/bin/ps", "/usr/sbin/lsof"].filter((binary) => {
      try {
        ctx.fs.accessSync(binary, ctx.fs.constants.X_OK);
        return false;
      } catch {
        return true;
      }
    });
    return missing.length === 0
      ? { status: "PASS", message: "ps + lsof (/bin/ps, /usr/sbin/lsof)" }
      : { status: "WARN", message: `ps + lsof teardown unavailable: ${missing.join(", ")}` };
  }
  return { status: "WARN", message: `not supported on ${ctx.platform}; nothing is signalled` };
}

/** Checks capabilities with access/stat only, never creating state or config files. */
export function doctor(
  options: SettingsOptions = {},
  ctx: CommandContext = createContext(),
  latestVersion?: string | Error,
): DoctorReport {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck["status"], message: string): void => {
    checks.push({ name, status, message });
  };
  add("node", Number(ctx.nodeVersion.split(".")[0]) >= 22 ? "PASS" : "FAIL", `Node ${ctx.nodeVersion}; requires >=22`);
  const backend = agentBinary(ctx.env);
  const binary = resolveBinary(backend, ctx);
  if (binary === undefined) add("backend", "FAIL", `${backend} is not an executable on PATH`);
  else {
    try {
      add("backend", "PASS", `${binary}: ${ctx.exec(binary, ["--version"]) || "version command succeeded"}`);
    } catch (error) {
      add("backend", "FAIL", `${binary}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  add(
    "backend-kind",
    isPlainPi(ctx.env) ? "WARN" : "PASS",
    isPlainPi(ctx.env)
      ? "plain pi backend: best effort; OmO features unavailable"
      : `OmO-compatible backend (${backend})`,
  );
  const agentDir = resolve(ctx.cwd, piAgentDir(ctx.env, ctx.home));
  add("agent-dir", ctx.fs.existsSync(agentDir) && ctx.fs.statSync(agentDir).isDirectory() ? "PASS" : "FAIL", agentDir);
  add("agent-name", "PASS", detectAgentName(ctx.env, ctx.home, ctx.fs));
  const stateDir = resolve(ctx.cwd, envSetting("STATE_DIR", ctx.env) ?? defaultStateDir(ctx.home, ctx.fs.existsSync));
  try {
    let ancestor = stateDir;
    while (!ctx.fs.existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    if (!ctx.fs.statSync(ancestor).isDirectory()) throw new Error(`${ancestor} is not a directory`);
    ctx.fs.accessSync(ancestor, ctx.fs.constants.W_OK | ctx.fs.constants.X_OK);
    add(
      "state-dir",
      "PASS",
      `${stateDir}${ancestor === stateDir ? " is writable" : ` can be created under writable ${ancestor}`}`,
    );
  } catch (error) {
    add("state-dir", "FAIL", `${stateDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const latest = typeof latestVersion === "string" ? latestVersion : undefined;
  if (latestVersion instanceof Error)
    add("version", "INFO", `${ADAPTER_VERSION}; latest unknown (${latestVersion.message})`);
  else if (latest !== undefined && isNewerVersion(latest, ADAPTER_VERSION))
    add("version", "WARN", `${ADAPTER_VERSION} installed; ${latest} is released: run antechamber upgrade`);
  else add("version", "PASS", ADAPTER_VERSION);
  // A released fix is live only once OpenChamber relaunches the adapter.
  const running = readRunningServers(stateDir, ctx.fs, processAlive);
  if (running.length === 0) add("running", "INFO", `no running antechamber server recorded in ${stateDir}`);
  for (const server of running) {
    const target = latest !== undefined && isNewerVersion(latest, ADAPTER_VERSION) ? latest : ADAPTER_VERSION;
    const stale = isNewerVersion(target, server.version);
    add(
      "running",
      stale ? "WARN" : "PASS",
      `pid ${server.pid} at ${server.url} runs ${server.version}${stale ? `; restart OpenChamber to run ${target}` : ""}`,
    );
  }
  const teardown = privateHostTeardown(ctx);
  add("private-host-teardown", teardown.status, teardown.message);
  const openchamber = resolveBinary("openchamber", ctx);
  if (openchamber === undefined) add("openchamber", "WARN", "openchamber is not on PATH");
  else {
    try {
      add("openchamber", "PASS", `${openchamber}: ${ctx.exec(openchamber, ["--version"]) || "version not reported"}`);
    } catch (error) {
      add(
        "openchamber",
        "WARN",
        `${openchamber}: version not determinable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  const settings = settingsPath(options, ctx);
  if (!ctx.fs.existsSync(settings))
    add("openchamber-settings", "WARN", `${settings} does not exist; run antechamber setup`);
  else {
    try {
      const configured = readSettings(settings, ctx).opencodeBinary;
      const launcher = autoUpdateLauncherPath(ctx);
      const launcherTarget =
        configured === launcher && ctx.fs.existsSync(launcher)
          ? autoUpdateLauncherTarget(ctx.fs.readFileSync(launcher, "utf8"))
          : undefined;
      const viaLauncher = launcherTarget !== undefined && isPackageBinary(launcherTarget, ctx);
      const matches = viaLauncher || (typeof configured === "string" && isPackageBinary(configured, ctx));
      add(
        "openchamber-settings",
        matches ? "PASS" : "WARN",
        `${settings}: opencodeBinary=${JSON.stringify(configured ?? null)}${viaLauncher ? ` (auto-update launcher for ${launcherTarget})` : matches ? "" : "; does not point at this antechamber installation"}`,
      );
    } catch (error) {
      add("openchamber-settings", "WARN", error instanceof Error ? error.message : String(error));
    }
  }
  add("auth", "INFO", `OPENCODE_SERVER_PASSWORD is ${ctx.env.OPENCODE_SERVER_PASSWORD ? "set" : "not set"}`);
  return { checks, exitCode: checks.some((check) => check.status === "FAIL") ? 1 : 0 };
}

export function formatDoctor(report: DoctorReport, json: boolean): string {
  return json
    ? JSON.stringify(report, null, 2)
    : report.checks.map((check) => `${check.status} ${check.name}: ${check.message}`).join("\n");
}
