import { execFileSync } from "node:child_process";
import type { ProcessIdentity, ProcessTable } from "./proc-table.js";

/**
 * macOS process table, backed by `/bin/ps`. Used by disposal to identify owned survivors, so it must
 * report the same three facts Linux reads from `/proc/<pid>/stat`: PID, process group, and a start
 * time that survives PID reuse checks. `ps` exposes the latter as `lstart` (second granularity).
 */

/** Runs `/bin/ps` with the given arguments and returns stdout. Injected so tests never spawn. */
export type PsRunner = (args: readonly string[]) => string;

const PS_TIMEOUT_MS = 2_000;
const PS_MAX_BUFFER = 8 * 1024 * 1024;
const PS_COLUMNS = "pid=,pgid=,stat=,lstart=";

/** `pid pgid stat lstart`, where lstart is "Sun Nov  1 15:55:48 2026" and may end in padding. */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/;

interface PsEntry extends ProcessIdentity {
  readonly state: string;
}

/**
 * `execFileSync` with an absolute binary: no shell, and no PATH lookup that a user-controlled
 * directory could shadow. `-ww` disables width truncation; the column set is fixed so every line
 * has the same shape. LC_ALL is pinned because `lstart` is rendered in the current locale: two
 * calls must agree with each other even if the user changes the system language mid-session.
 */
export function runPs(args: readonly string[]): string {
  return execFileSync("/bin/ps", args, {
    encoding: "utf8",
    timeout: PS_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
}

function parseLine(line: string): PsEntry | undefined {
  const match = PS_LINE.exec(line);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  const group = Number(match[2]);
  const state = match[3];
  const start = match[4];
  if (!Number.isInteger(pid) || !Number.isInteger(group) || state === undefined || start === undefined)
    return undefined;
  if (start === "") return undefined;
  return { pid, group, start, state };
}

/**
 * A zombie has already exited; only its parent is left to reap it. Counting it as a survivor would
 * make disposal wait out the full grace window for a process that can no longer run, so `Z` entries
 * are treated as gone in both methods, as `session-hosts` already does on Linux.
 */
function alive(entry: PsEntry): boolean {
  return !entry.state.startsWith("Z");
}

/** One `ps -A` row with its state and argv, for callers that match processes by command line. */
export interface PsProcess extends ProcessIdentity {
  readonly state: string;
  readonly args: string;
}

// Under LC_ALL=C, lstart is a fixed 24-character field, so argv starts right after it even when it
// contains spaces.
const PS_ARGS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s?(.*)$/;

/** Every live (non-zombie) process with its argv. Throws when `ps` fails, so the caller decides. */
export function listDarwinProcesses(run: PsRunner = runPs): PsProcess[] {
  return run(["-ww", "-o", `${PS_COLUMNS},args=`, "-A"])
    .split("\n")
    .flatMap((line) => {
      const match = PS_ARGS_LINE.exec(line);
      if (match === null) return [];
      const entry = { pid: Number(match[1]), group: Number(match[2]), state: match[3] ?? "", start: match[4] ?? "" };
      return alive(entry) ? [{ ...entry, args: match[5] ?? "" }] : [];
    });
}

function toIdentity(entry: PsEntry): ProcessIdentity {
  return { pid: entry.pid, group: entry.group, start: entry.start };
}

export function createDarwinProcTable(run: PsRunner = runPs): ProcessTable {
  return {
    identity(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      let output: string;
      try {
        output = run(["-ww", "-o", PS_COLUMNS, "-p", String(pid)]);
      } catch {
        // The process is gone, or ps could not read it. An unverifiable identity fails closed.
        return undefined;
      }
      const entry = parseLine(output.trim());
      if (entry === undefined || entry.pid !== pid || !alive(entry)) return undefined;
      return toIdentity(entry);
    },
    groupMembers(group) {
      let output: string;
      try {
        output = run(["-ww", "-o", PS_COLUMNS, "-A"]);
      } catch {
        return [];
      }
      return output.split("\n").flatMap((line) => {
        const entry = parseLine(line);
        return entry !== undefined && entry.group === group && alive(entry) ? [toIdentity(entry)] : [];
      });
    },
  };
}
