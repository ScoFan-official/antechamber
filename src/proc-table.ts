import { readdirSync, readFileSync } from "node:fs";
import { createDarwinProcTable } from "./proc-table-darwin.js";

/** A process's group and kernel start time: with the PID, the identity that survives PID reuse checks. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly group: number;
  readonly start: string;
}

/** Reads process identities so disposal can tell owned survivors from a reused PID. */
export interface ProcessTable {
  identity(pid: number): ProcessIdentity | undefined;
  groupMembers(group: number): ProcessIdentity[];
}

// Linux /proc. Any read failure (gone, no permission, no /proc) means the identity cannot be
// verified, and an unverifiable process is never signalled: fail closed.
const linuxProcTable: ProcessTable = {
  identity(pid) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return undefined;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, group: Number(fields[2]), start: fields[19] ?? "" };
  },
  groupMembers(group) {
    let names: string[];
    try {
      names = readdirSync("/proc");
    } catch {
      return [];
    }
    return names
      .filter((name) => /^\d+$/.test(name))
      .flatMap((name) => linuxProcTable.identity(Number(name)) ?? [])
      .filter((member) => member.group === group);
  },
};

/**
 * The process table for this platform. Linux reads `/proc`; macOS reads `/bin/ps`, because Node has no
 * `/proc` and no pidfd there. Every other platform keeps the Linux table so a missing `/proc` fails
 * closed (an identity is never reported that cannot be verified).
 */
export function createProcessTable(platform: NodeJS.Platform = process.platform): ProcessTable {
  return platform === "darwin" ? createDarwinProcTable() : linuxProcTable;
}
