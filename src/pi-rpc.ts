/**
 * pi RPC subprocess client.
 *
 * Speaks pi's headless JSONL protocol (`pi --mode rpc`): commands go to stdin,
 * responses and events come back on stdout. Framing is strict LF-only JSONL —
 * pi's docs warn that generic line readers (Node `readline`) also split on
 * U+2028/U+2029, which are legal inside JSON strings, so we split on "\n"
 * ourselves and only strip a single trailing "\r".
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { systemClock, type LifecycleClock } from "./lifecycle.js";
import { agentBinary, envSetting } from "./config.js";
import { createProcessTable, type ProcessTable } from "./proc-table.js";

export type { ProcessIdentity, ProcessTable } from "./proc-table.js";

export interface PiRpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export const RPC_COMMAND_TIMEOUT_MS = 60_000;
/**
 * `compact` answers only when the summary is written. OmO bounds one compaction by
 * its SUMMARIZATION_MAX_DURATION_CAP_MS (30 min); the generic 60 s budget gave up
 * long before a large session finished, leaving the run orphaned.
 */
export const COMPACT_RPC_TIMEOUT_MS = 31 * 60_000;
const PROMPT_ADMISSION_TIMEOUT_MS = COMPACT_RPC_TIMEOUT_MS + RPC_COMMAND_TIMEOUT_MS;
const MAX_JSONL_FRAME_BYTES = 64 * 1024 * 1024;
export class UpstreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamProtocolError";
  }
}
const PROCESS_KILL_GRACE_MS = 5_000;
/**
 * How far above antechamber's own `oom_score_adj` each agent is placed. The agent and everything it starts
 * (test runners, compilers, OmO's task host) inherit it, so under memory pressure the kernel OOM killer and
 * earlyoom take a workload before the adapter, whose death stops every session at once.
 */
export const AGENT_OOM_SCORE_ADJ_MARGIN = 300;

/** Linux only: rank the agent above antechamber for the OOM killer. Raising a child's score needs no privilege. */
function rankAboveAdapterForOom(pid: number): void {
  if (process.platform !== "linux") return;
  try {
    const target = Math.min(
      1000,
      Number(readFileSync("/proc/self/oom_score_adj", "utf8")) + AGENT_OOM_SCORE_ADJ_MARGIN,
    );
    if (Number(readFileSync(`/proc/${pid}/oom_score_adj`, "utf8")) < target)
      writeFileSync(`/proc/${pid}/oom_score_adj`, String(target));
  } catch (error) {
    console.error(`[pi-rpc] could not raise the agent's OOM score: ${error instanceof Error ? error.message : error}`);
  }
}

const procTable: ProcessTable = createProcessTable();

/** Why the agent stopped without antechamber disposing it on purpose (eviction, delete, shutdown). */
export type PiStopReason =
  | { readonly kind: "timeout"; readonly command: string; readonly ms: number }
  | { readonly kind: "frame-overflow" }
  | { readonly kind: "spawn"; readonly detail: string }
  | { readonly kind: "transport"; readonly detail: string }
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: string | null };

function duration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms % 1_000 === 0) return `${ms / 1_000} s`;
  return `${ms} ms`;
}

/** The user-facing explanation OpenChamber shows when the agent stops. */
export function describeStop(reason: PiStopReason): string {
  const restart = "Anything in progress did not finish; send a message to start the agent again.";
  switch (reason.kind) {
    case "timeout":
      return `antechamber stopped the agent: its "${reason.command}" command got no reply within ${duration(reason.ms)}. ${restart}`;
    case "frame-overflow":
      return `antechamber stopped the agent: it sent a JSONL frame over the ${MAX_JSONL_FRAME_BYTES}-byte limit. ${restart}`;
    case "spawn":
      return `antechamber could not run the agent (${reason.detail}). ${restart}`;
    case "transport":
      return `antechamber lost its connection to the agent (${reason.detail}) and stopped it. ${restart}`;
    case "exit": {
      const status =
        reason.code !== null
          ? `exit code ${reason.code}`
          : reason.signal !== null
            ? `signal ${reason.signal}`
            : "no status";
      return `The agent exited unexpectedly (${status}). ${restart}`;
    }
  }
}

/** Rejects every command pending when the agent stopped; the exit handler is what shows it to the user. */
export class PiStoppedError extends Error {
  constructor(
    readonly reason: PiStopReason,
    cause?: Error,
  ) {
    super(describeStop(reason), cause === undefined ? undefined : { cause });
    this.name = "AgentStoppedError";
  }
}

export type PiRpcResponse<T = unknown> = {
  readonly id: string;
  readonly type: "response";
  readonly command: string;
} & (
  | { readonly success: true; readonly data?: T; readonly error?: never }
  | {
      readonly success: false;
      readonly error?: string;
      readonly errorCode?: string;
      readonly errorData?: unknown;
      readonly data?: never;
    }
);

interface PiRpcClientOptions {
  cwd: string;
  /** Path/name of the pi binary. Defaults to ANTECHAMBER_PI_BINARY env or "omo" from PATH. */
  piBinary?: string;
  /** Extra CLI flags, e.g. ["--no-session"] or ["--provider", "x"]. */
  args?: string[];
  clock?: LifecycleClock;
  processTable?: ProcessTable;
}

interface PendingRequest {
  command: string;
  resolve: (r: PiRpcResponse) => void;
  reject: (e: Error) => void;
  onWorkState?: () => void;
  onAbortBash?: () => void;
}

export class PiRpcClient extends EventEmitter {
  private proc: ChildProcess;
  private buffer = "";
  private bufferBytes = 0;
  private decoder = new StringDecoder("utf8");
  private pending = new Map<string, PendingRequest>();
  private closed = false;
  private stderrTail = "";
  private disposing: Promise<void> | undefined;
  private disposeRequested = false;
  private stopped: PiStopReason | undefined;
  private outputClosed = false;
  private sentSignals = new Set<NodeJS.Signals>();
  private agentActive = false;
  private compacting = false;
  private sessionPath: string | undefined;
  /** Wall-clock spawn time; work OmO records before it belongs to an earlier agent process. */
  readonly startedAtMs = Date.now();

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get isBusy(): boolean {
    return this.pending.size > 0;
  }

  get sessionFile(): string | undefined {
    return this.sessionPath;
  }

  /** Set once the agent stopped for a reason other than a requested dispose; read it from exit listeners. */
  get stopReason(): PiStopReason | undefined {
    return this.stopped;
  }

  onEvent(listener: (payload: Record<string, unknown>) => void): this {
    return super.on("event", listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): this {
    return super.on("exit", listener);
  }

  onExtensionUI(listener: (request: Record<string, unknown>) => void): this {
    return super.on("extension_ui_request", listener);
  }

  constructor(private options: PiRpcClientOptions) {
    super();
    const extraArgs = envSetting("PI_ARGS")?.trim().split(/\s+/).filter(Boolean) ?? [];
    const args = ["--mode", "rpc", ...(options.args ?? []), ...extraArgs];
    const capabilities = [
      ...new Set(
        [
          ...(process.env.OMO_RPC_CLIENT_CAPABILITIES ?? "").split(","),
          ...(process.env.SENPI_RPC_CLIENT_CAPABILITIES ?? "").split(","),
          "auto_title_sessions",
          "question",
          // Extension `pi.rpc.emit` frames, e.g. the terminal extension's monitor state.
          "extension_events",
        ]
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ].join(",");
    this.proc = spawn(options.piBinary ?? agentBinary(), args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OMO_RPC_CLIENT_CAPABILITIES: capabilities,
        SENPI_RPC_CLIENT_CAPABILITIES: capabilities,
      },
      detached: true,
    });
    if (this.proc.pid !== undefined) rankAboveAdapterForOom(this.proc.pid);

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8192);
    });

    this.proc.stdin?.on("error", (error) => {
      this.closeForTransportFailure({ kind: "transport", detail: error.message }, error);
    });
    this.proc.stdout!.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      this.buffer += text;
      this.bufferBytes += Buffer.byteLength(text);
      this.drain();
    });
    this.proc.stdout!.on("end", () => {
      const text = this.decoder.end();
      this.buffer += text;
      this.bufferBytes += Buffer.byteLength(text);
      this.drain();
      this.outputClosed = true;
      this.closeForTransportFailure({ kind: "transport", detail: "the agent closed its output" });
    });
    // ChildProcess "error": the binary could not be spawned, or signalling it failed.
    this.proc.on("error", (err) => {
      this.closeForTransportFailure({ kind: "spawn", detail: err.message }, err);
    });
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      if (this.stopped === undefined && !this.disposeRequested) this.stopped = { kind: "exit", code, signal };
      // A crashing agent closes stdout just before it exits. Name the crash, not the closed pipe, unless the
      // status comes from a signal antechamber sent while closing: OmO traps SIGTERM and exits 128 + 15.
      else if (this.stopped?.kind === "transport" && this.outputClosed && !this.ownSignal(code, signal))
        this.stopped = { kind: "exit", code, signal };
      console.error(
        `[pi-rpc] process exited code=${code} signal=${signal}` +
          (envSetting("DEBUG") && this.stderrTail ? `\n[pi-rpc] stderr tail:\n${this.stderrTail}` : ""),
      );
      this.failAll(
        this.stopped !== undefined
          ? new PiStoppedError(this.stopped)
          : new Error(`pi exited (code=${code} signal=${signal})`),
      );
      this.emit("exit", code, signal);
    });
  }

  private drain(): void {
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) {
        if (this.bufferBytes > MAX_JSONL_FRAME_BYTES) this.frameOverflow();
        return;
      }
      let line = this.buffer.slice(0, idx);
      const frameBytes = Buffer.byteLength(line);
      if (frameBytes > MAX_JSONL_FRAME_BYTES) {
        this.frameOverflow();
        return;
      }
      this.buffer = this.buffer.slice(idx + 1);
      this.bufferBytes -= frameBytes + 1;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private frameOverflow(): void {
    this.stopped ??= { kind: "frame-overflow" };
    this.closed = true;
    this.buffer = "";
    this.bufferBytes = 0;
    this.failAll(new PiStoppedError(this.stopped));
    this.proc.stdout?.destroy();
    if (this.proc.pid === undefined) this.proc.kill("SIGKILL");
    else if (!this.reaped()) process.kill(-this.proc.pid, "SIGKILL");
  }

  private ownSignal(code: number | null, signal: string | null): boolean {
    if (signal !== null) return [...this.sentSignals].includes(signal as NodeJS.Signals);
    if (code === null) return true;
    return [...this.sentSignals].some((sent) => code === 128 + osConstants.signals[sent]);
  }

  /** Node has reaped the leader, so its PID (and group ID) may already belong to another process. */
  private reaped(): boolean {
    return this.proc.exitCode !== null || this.proc.signalCode !== null;
  }

  private closeForTransportFailure(reason: PiStopReason, cause?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.stopped ??= reason;
    this.failAll(new PiStoppedError(reason, cause));
    void this.dispose().catch((disposeError: unknown) => {
      const message = disposeError instanceof Error ? disposeError.message : String(disposeError);
      console.error(`[pi-rpc] failed to dispose after transport failure: ${message}`);
    });
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // Non-JSON noise on stdout; ignore but keep going.
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const msg = value as Record<string, unknown>;

    if (msg.type === "response") {
      const pending = typeof msg.id === "string" ? this.pending.get(msg.id) : undefined;
      if (
        typeof msg.id !== "string" ||
        typeof msg.success !== "boolean" ||
        typeof msg.command !== "string" ||
        (msg.error !== undefined && typeof msg.error !== "string")
      ) {
        const error = new Error("pi returned a malformed RPC response");
        console.error(`[pi-rpc] ${error.message}`);
        pending?.reject(error);
        return;
      }
      if (pending !== undefined && pending.command !== msg.command) {
        const error = new Error(
          `pi returned mismatched RPC response command "${msg.command}" for pending command "${pending.command}"`,
        );
        console.error(`[pi-rpc] ${error.message}`);
        pending.reject(error);
        return;
      }
      const response: PiRpcResponse = msg.success
        ? { type: "response", id: msg.id, command: msg.command, success: true, data: msg.data }
        : {
            type: "response",
            id: msg.id,
            command: msg.command,
            success: false,
            ...(msg.error !== undefined ? { error: msg.error } : {}),
            ...(typeof msg.errorCode === "string" ? { errorCode: msg.errorCode } : {}),
            ...(msg.errorData !== undefined ? { errorData: msg.errorData } : {}),
          };
      if (pending && response.success && msg.command === "get_state") {
        const data = response.data;
        this.sessionPath =
          typeof data === "object" && data !== null && "sessionFile" in data && typeof data.sessionFile === "string"
            ? data.sessionFile
            : undefined;
      }
      pending?.resolve(response);
      return;
    }

    if (msg.type === "extension_ui_request") {
      this.handleExtensionUI(msg);
      return;
    }

    const wasWorking = this.agentActive || this.compacting;
    switch (msg.type) {
      case "agent_start":
      case "auto_retry_start":
        this.agentActive = true;
        break;
      case "agent_end":
        if (msg.willRetry !== true) this.agentActive = false;
        break;
      case "agent_idle":
        this.agentActive = false;
        break;
      case "compaction_start":
        this.compacting = true;
        break;
      case "compaction_end":
        this.compacting = false;
        break;
    }
    if (wasWorking !== (this.agentActive || this.compacting))
      for (const request of this.pending.values()) request.onWorkState?.();
    this.emit("event", msg);
  }

  private handleExtensionUI(msg: Record<string, unknown>): void {
    const method = msg.method as string | undefined;
    const id = msg.id as string | undefined;
    if (!id || !method) return;
    const blocking = new Set(["select", "confirm", "input", "editor"]);
    if (!blocking.has(method) && method !== "notify" && method !== "question") return;
    this.emit("extension_ui_request", msg);
  }

  respondExtensionUI(response: Record<string, unknown>): void {
    this.write(response);
  }

  private write(obj: Record<string, unknown>): void {
    if (this.closed) return;
    this.proc.stdin!.write(`${JSON.stringify(obj)}\n`);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /**
   * A read whose late answer changes nothing (status polls, listings): its timeout rejects only itself and
   * the agent keeps running. OmO handles RPC lines concurrently, so anything that orders the conversation
   * must use `command`, whose timeout stops the agent rather than let a late reply overlap the next operation.
   */
  probe<T = unknown>(
    cmd: Omit<PiRpcCommand, "id">,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<PiRpcResponse<T>> {
    return this.command<T>(cmd, timeoutMs, signal, undefined, false);
  }

  /** Send a command and wait for its correlated response. A timeout stops the agent unless `stopOnTimeout` is false. */
  command<T = unknown>(
    cmd: Omit<PiRpcCommand, "id">,
    timeoutMs?: number,
    signal?: AbortSignal,
    onDispatch?: () => void,
    stopOnTimeout = true,
  ): Promise<PiRpcResponse<T>> {
    if (this.closed) return Promise.reject(new Error("pi process is not running"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = randomUUID();
    const expectedCommand = String(cmd.type);
    const deadlineMs = timeoutMs ?? RPC_COMMAND_TIMEOUT_MS;
    const waitsForWork = expectedCommand === "prompt" && timeoutMs === undefined;
    // A user `bash` answers when its command exits: OmO awaits `executeBash` with no time limit (senpi
    // 2026.10.25-2, dist/modes/rpc/connection-handler.js `case "bash"`), and an interactive command such as a
    // login waits on the user. Without a caller deadline it gets one only once `abortBash` asks OmO to stop it.
    const waitsForShell = expectedCommand === "bash" && timeoutMs === undefined;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let admissionTimer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        clearTimeout(admissionTimer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const rejectCommand = (reason: unknown): void => {
        cleanup();
        reject(reason);
      };
      const onAbort = (): void => {
        rejectCommand(signal?.reason);
      };
      // A probe's late response finds no pending entry and is dropped.
      const expire = (ms: number): void => {
        if (stopOnTimeout) this.closeForTransportFailure({ kind: "timeout", command: expectedCommand, ms });
        else rejectCommand(new Error(`pi command "${expectedCommand}" timed out after ${ms}ms`));
      };
      const armDeadline = (): void => {
        clearTimeout(timer);
        if (!waitsForWork || !(this.agentActive || this.compacting))
          timer = setTimeout(() => expire(deadlineMs), deadlineMs);
      };
      if (!waitsForShell) armDeadline();
      if (waitsForWork)
        admissionTimer = setTimeout(() => expire(PROMPT_ADMISSION_TIMEOUT_MS), PROMPT_ADMISSION_TIMEOUT_MS);
      this.pending.set(id, {
        command: expectedCommand,
        resolve: (r) => {
          cleanup();
          // The envelope is checked at the transport boundary; callers own data schemas.
          resolve(r.success ? { ...r, data: r.data as T } : r);
        },
        reject: rejectCommand,
        ...(waitsForWork ? { onWorkState: armDeadline } : {}),
        ...(waitsForShell ? { onAbortBash: () => timer === undefined && armDeadline() } : {}),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.write({ ...cmd, id });
      onDispatch?.();
    });
  }

  /** Asks OmO to stop the user shell; a pending `bash` still unanswered after the ordinary deadline means a hung agent. */
  abortBash(): void {
    this.write({ type: "abort_bash" });
    for (const request of this.pending.values()) request.onAbortBash?.();
  }

  /** Fire-and-forget command (no response correlation). */
  notify(cmd: Omit<PiRpcCommand, "id">): void {
    this.write(cmd);
  }

  async dispose(): Promise<void> {
    if (this.disposing !== undefined) return this.disposing;
    this.disposeRequested = true;
    this.closed = true;
    this.failAll(new Error("pi process disposed"));
    const pid = this.proc.pid;
    if (pid === undefined || this.reaped()) return;
    const clock = this.options.clock ?? systemClock;
    const table = this.options.processTable ?? procTable;
    const signal = (target: number, sig: NodeJS.Signals): void => {
      try {
        process.kill(target, sig);
        this.sentSignals.add(sig);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "ESRCH") return;
        // macOS returns EPERM, not ESRCH, when the group's only member is our unreaped leader;
        // the pending "exit" event completes disposal.
        if (code === "EPERM" && target < 0) return;
        throw error;
      }
    };
    // Until Node reaps the leader its PID, and therefore the group ID, cannot be reused, so group
    // signals are safe only before "exit". Record the members now; after the leader exits, a
    // grandchild is killed only when its PID still has the same group and start time.
    const owned = table.groupMembers(pid).filter((member) => member.pid !== pid);
    const survivors = (): number[] =>
      owned
        .filter((member) => {
          const now = table.identity(member.pid);
          return now !== undefined && now.group === member.group && now.start === member.start;
        })
        .map((member) => member.pid);
    this.disposing = new Promise<void>((resolve) => {
      const finish = (): void => {
        clock.clearTimeout(timer);
        this.proc.off("exit", onExit);
        resolve();
      };
      const onExit = (): void => {
        if (survivors().length === 0) finish();
      };
      this.proc.once("exit", onExit);
      const timer = clock.setTimeout(() => {
        if (!this.reaped()) {
          signal(-pid, "SIGKILL");
          this.proc.off("exit", onExit);
          this.proc.once("exit", finish);
          return;
        }
        for (const member of survivors()) signal(member, "SIGKILL");
        finish();
      }, PROCESS_KILL_GRACE_MS);
      signal(-pid, "SIGTERM");
      this.proc.stdin?.end();
    });
    return this.disposing;
  }
}
