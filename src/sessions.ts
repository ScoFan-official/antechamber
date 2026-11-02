/**
 * Session registry: one OpenCode session maps to one `pi --mode rpc` process.
 * Composes the live event bridge and restored-session history reconstruction.
 */

import { id, PiEventTranslator, syncSessionCost } from "./pi-event-translation.js";
import { parsePiSessionFile, parsePiSessionText } from "./session-history.js";
import { CONTEXT_MESSAGE_TYPE, nativePromptInput, v2PromptAttachments } from "./prompt-parts.js";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  COMPACT_RPC_TIMEOUT_MS,
  describeStop,
  PiRpcClient,
  PiStoppedError,
  RPC_COMMAND_TIMEOUT_MS,
  type PiRpcCommand,
  type PiRpcResponse,
} from "./pi-rpc.js";
import { stopSessionHosts } from "./session-hosts.js";
import { setThinkingLevel, userMessageModel, type ModelSelection, type ThinkingState } from "./thinking-levels.js";
import { SessionLifecycle, type LifecycleOptions } from "./lifecycle.js";
import { ApprovalBridge, extensionUiRequestFrom, type PendingPermission, type PendingQuestion } from "./approvals.js";
import { getAgentName, getExposedAgentNames } from "./agent-name.js";
import { RequestBodyError } from "./http.js";
import type { TodoBridge, Todo, TodoUpdated } from "./todo-bridge.js";
import {
  bindMessageEntries,
  branchEntries,
  durableShellTree,
  followExternalAppends,
  forkConversation,
  getEntries,
  navigate,
  recordTurn,
  readSessionTree,
  restoredLeaf,
  revertConversation,
  SessionTreeError,
  unrevertConversation,
  type SessionTreeState,
} from "./session-tree.js";
import { SubagentBridge } from "./subagents.js";
import { MonitorSessions } from "./monitor-sessions.js";
import { WorkStatusBridge } from "./work-status.js";
import { OmoShells } from "./omo-shells.js";
import { sessionDiff } from "./session-diff.js";
import { waitForMcpServers } from "./mcp.js";
import { announceSessionNotice, noticeMessage, skillCommandText, slashTitlePrompt } from "./session-commands.js";
import {
  ocIdFor,
  piSessionDir,
  piSessionsRootMtime,
  scanAllPiSessions,
  scanPiSessions,
  SessionStore,
  type ScannedSession,
  readSessionFileMeta,
  type SessionSelection,
  type TitleSource,
} from "./session-store.js";
import type {
  OCAssistantMessage,
  OCEvent,
  OCMessageWithParts,
  OCModelRef,
  OCPart,
  OCPromptPart,
  OCSession,
  OCSessionStatus,
  OCToolPart,
  OCUserMessage,
} from "./types.js";

import { ADAPTER_VERSION } from "./version.js";
export { ADAPTER_VERSION } from "./version.js";
const SESSION_SCAN_CACHE_TTL_MS = 5_000;
const PI_FILE_RESOLVE_ATTEMPTS = 10;
const PI_FILE_RESOLVE_RETRY_MS = 200;
const SESSION_TITLE_MAX_CHARS = 60;
/** OmO's reply when a compaction is aborted (`CompactionCancelledError`). */
const OMO_COMPACTION_CANCELLED = "Compaction cancelled";
// Real revivals took two cancels before the third attempt committed (OmO compaction.log, 2026-10-27),
// so two retries left no margin for one more MCP server connecting late.
const COMPACT_CANCEL_RETRIES = 4;
/** Longest a compaction waits for connecting MCP servers; a stuck server falls back to the retries. */
const MCP_SETTLE_WAIT_MS = 10_000;

interface StreamingState {
  message: OCAssistantMessage;
  /** contentIndex → part; pi addresses streaming content by index. */
  parts: Map<number, OCPart>;
}

export interface ManagedSession extends ThinkingState {
  interruptRequested?: boolean;
  /** Counts abort requests, so a compaction cancelled by the user is not retried. */
  abortRequests?: number;
  titleSource?: TitleSource;
  activeUserMessageID?: string;
  deliveredInputCompactions?: Map<string, string>;
  inputs?: Map<string, { text: string; delivery: "steer" | "queue"; accepted: boolean; delivered: boolean }>;
  tree: SessionTreeState;
  info: OCSession;
  /** undefined while dormant (restored from disk, no pi process spawned yet). */
  pi: PiRpcClient | undefined;
  /** Remove only this session's subscriptions when its client is transferred. */
  unwirePi?: () => void;
  /** undefined for dormant sessions until history is parsed from the JSONL. */
  messages: OCMessageWithParts[] | undefined;
  historyFileSize?: number;
  /** Adapter-authored notices/errors remain local; persisted shell cards can be bound. */
  localMessageIds?: Set<string>;
  status: OCSessionStatus;
  /** undefined while dormant; resolved via get_state on create/revive. */
  model: OCModelRef | undefined;
  streaming: StreamingState | undefined;
  /** A manual compaction started while idle; its end returns the session to idle. */
  compactingFromIdle?: boolean;
  compactionID?: string;
  /** Retries sessionRpc still owes a `compact` command that OmO cancels on its own. */
  compactRetry?: { left: number; aborts: number };
  /** A cancelled compaction_end held back while its retry may continue the same compaction. */
  heldCompactionEnd?: Record<string, unknown>;
  /** Cancels the adapter-owned user bash waiter and its OmO execution. */
  cancelShell?: (interrupted?: boolean) => void;
  /**
   * toolCallId → tool part for the current agent run. pi streams tool calls
   * (toolcall_start/delta/end) inside one assistant message but delivers the
   * *result* later, in turn_end.toolResults — matched by toolCallId.
   */
  toolByCallId: Map<string, OCToolPart>;
  approvals?: ApprovalBridge;
  todoBridge?: TodoBridge;
  /** pi's own session id + file — the bridge to persistence/restore. */
  piSessionId?: string;
  piPath?: string;
  /** Set while dormant: revive() spawns pi with `--session <piPath>`. */
  restored?: { piSessionId: string; piPath: string };
  /** Hooks wired by the approvals and child-task bridges. */
  hasPendingInteraction: () => boolean;
  hasRunningChildren: () => boolean;
  /** Live OmO background work (monitors) that keeps the agent process from idle eviction. */
  hasBackgroundWork?: () => boolean;
  /** Live wake sources OmO publishes over RPC (detached eval cells), which also block idle eviction. */
  hasWakeSources?: () => boolean;
  /** antechamber stopped the agent process itself (lifecycle `dormant`): its in-process work died with it. */
  onDormant?: () => void;
  /** Why the agent last stopped on its own; persisted and replayed as a notice until the next prompt. */
  lastStop?: { message: string; at: number };
}

type EventSink = (directory: string, event: OCEvent | TodoUpdated) => void;

interface PiModel {
  id: string;
  provider: string;
  name?: string;
}

interface PiState {
  /** pi reports `null` before a model is resolved. */
  model: PiModel | null;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  thinkingLevel?: string;
  pendingQuestions?: unknown;
}

/**
 * A dormant session's record as OmO will resume it. OpenChamber 2.x restores a reopened session's effort
 * from this record and resends it, so the model and level come together from the file; the registry only
 * fills in when the file records no model.
 */
function dormantModel(
  file: SessionSelection,
  registry: { providerID: string; modelID: string; variant?: string } | undefined,
): { model: OCModelRef; variant: string } | undefined {
  if (file.model !== undefined) return { model: file.model, variant: file.thinkingLevel ?? "default" };
  if (registry === undefined) return undefined;
  return {
    model: { providerID: registry.providerID, modelID: registry.modelID },
    variant: registry.variant ?? "default",
  };
}

export class SessionManager {
  private events: PiEventTranslator;
  private disposed = false;
  private operations = new Map<string, Promise<unknown>>();
  /** Connector-created session trees, including persisted ownership after restart. */
  private createdSessions = new Map<string, string>();
  /** Clients whose stop onExit already showed, so a failing revival does not show it again. */
  private stopShown = new WeakSet<PiRpcClient>();
  private hostShutdown: Promise<void> | undefined;
  private sessions = new Map<string, ManagedSession>();
  private dirtyDiffs = new Set<string>();
  private diffEmissions = new Map<string, Promise<void>>();
  private readonly store: SessionStore;
  readonly lifecycle: SessionLifecycle;
  readonly subagents: SubagentBridge;
  readonly monitors: MonitorSessions;
  readonly workStatus: WorkStatusBridge;
  readonly shells: OmoShells;
  /** directory → last scan freshness (pi dir mtime + wall clock). */
  private scanCache = new Map<string, { mtimeMs: number; at: number }>();
  /** freshness of the all-directories scan (see listAll). */
  private scanAllCache: { mtimeMs: number; at: number } | undefined;

  /** Called when an agent starts, stops or reports a change to its MCP servers. */
  onMcpSurfacesChanged: (() => void) | undefined;

  constructor(
    private emit: EventSink,
    store?: SessionStore,
    private defaultDirectory?: string,
    lifecycleOptions: LifecycleOptions = {},
  ) {
    this.store = store ?? new SessionStore();
    this.lifecycle = new SessionLifecycle(() => this.sessions.values(), lifecycleOptions);
    this.subagents = new SubagentBridge(this.store, this.sessions, this.emit, (session, raw) =>
      parsePiSessionText(session, getAgentName(), raw),
    );
    this.monitors = new MonitorSessions(this.sessions, this.emit);
    this.workStatus = new WorkStatusBridge(this.monitors);
    this.shells = new OmoShells(this.sessions, this.monitors, this.workStatus, this.emit);
    this.events = new PiEventTranslator({
      emit: this.emit,
      subagents: this.subagents,
      monitors: this.monitors,
      workStatus: this.workStatus,
      shells: this.shells,
      store: this.store,
      dirtyDiffs: this.dirtyDiffs,
      ensureMessages: (s) => this.ensureMessages(s),
      applyNativeTitle: (s, value) => this.applyNativeTitle(s, value),
      applyPiModel: (s, provider, modelId) => this.applyPiModel(s, provider, modelId),
      emitDiff: (s) => this.emitDiff(s),
      persistMeta: (s) => this.persistMeta(s),
    });
  }

  async create(
    directory: string,
    title?: string,
    parentID?: string,
    options: { id?: string; agent?: string; model?: ModelSelection; metadata?: Record<string, unknown> } = {},
  ): Promise<OCSession> {
    if (options.agent !== undefined && !getExposedAgentNames().includes(options.agent))
      throw new RequestBodyError(400, `unknown agent: ${options.agent}`);
    return this.lifecycle.run(() => this.createLive(directory, title, parentID, options));
  }

  private async createLive(
    directory: string,
    title?: string,
    parentID?: string,
    options: { id?: string; agent?: string; model?: ModelSelection; metadata?: Record<string, unknown> } = {},
  ): Promise<OCSession> {
    if (options.id !== undefined && (options.id === "" || this.get(options.id) !== undefined))
      throw new RequestBodyError(400, "session id must be nonempty and unused");
    await this.lifecycle.makeRoom();
    const pi = new PiRpcClient({ cwd: directory, clock: this.lifecycle.clock });
    const state = await pi.command<PiState>({ type: "get_state" }).catch(async (error: unknown) => {
      await pi.dispose();
      throw error;
    });
    if (!state.success || !state.data) {
      await pi.dispose();
      throw new Error(`pi get_state failed: ${state.error ?? "no data"}`);
    }

    const now = Date.now();
    // Deterministic id derived from pi's session id, so a session keeps the
    // same OpenChamber id across adapter restarts (create once, restore later).
    const piSessionId =
      typeof state.data.sessionId === "string" && state.data.sessionId !== "" ? state.data.sessionId : undefined;
    if (piSessionId !== undefined) this.createdSessions.set(piSessionId, directory);
    const info: OCSession = {
      id: options.id ?? (piSessionId !== undefined ? ocIdFor(piSessionId) : id("ses")),
      projectID: directory,
      directory,
      title: title?.trim() || "New session",
      version: ADAPTER_VERSION,
      time: { created: now, updated: now },
      agent: options.agent ?? getAgentName(),
      slug: piSessionId ?? id("session"),
      path: "",
      summary: { additions: 0, deletions: 0, files: 0 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      ...(parentID !== undefined ? { parentID } : {}),
    };

    const managed: ManagedSession = {
      tree: { messageEntries: {} },
      titleSource: title?.trim() ? "user" : "fallback",
      info,
      pi,
      messages: [],
      status: { type: "idle" },
      model: undefined,
      streaming: undefined,
      toolByCallId: new Map(),
      hasPendingInteraction: () => false,
      hasRunningChildren: () => false,
      ...(piSessionId !== undefined ? { piSessionId } : {}),
      ...(state.data.thinkingLevel !== undefined ? { thinkingLevel: state.data.thinkingLevel } : {}),
    };
    let published = false;
    try {
      managed.approvals = this.approvalsFor(managed);
      this.sessions.set(info.id, managed);
      published = true;
      this.subagents.wire(managed);
      this.monitors.wire(managed);
      this.workStatus.wire(managed);
      this.wireDormant(managed);
      this.lifecycle.touch(managed);
      this.wirePi(managed, pi);

      if (options.model !== undefined) await this.setModel(info.id, options.model);
      this.emit(directory, { type: "session.created", properties: { info } });
      // Announce pi's real model *after* session.created, so the client already
      // knows the session when the switch marker lands in its transcript.
      if (options.model === undefined) this.applyPiModel(managed, state.data.model?.provider, state.data.model?.id);

      // Bind pi's session file so the session survives adapter restarts. pi
      // reports the path directly; fall back to a background scan for older pi
      // versions, and re-bind after the first prompt (pi persists lazily).
      if (typeof state.data.sessionFile === "string" && state.data.sessionFile !== "") {
        managed.piPath = state.data.sessionFile;
        this.persistMeta(managed);
      } else if (piSessionId !== undefined) {
        void this.resolvePiFile(directory, piSessionId)
          .then((piPath) => {
            if (this.sessions.get(info.id) !== managed || piPath === undefined || managed.piPath !== undefined) return;
            managed.piPath = piPath;
            this.persistMeta(managed);
          })
          .catch((error: unknown) => {
            if (this.sessions.get(info.id) === managed) this.reportPersistenceError(managed, error);
          });
      }

      if (managed.titleSource === "user") {
        const renamed = await pi.command({ type: "set_session_name", name: info.title });
        if (!renamed.success) throw new Error(renamed.error ?? "session rename rejected");
      } else {
        this.applyNativeTitle(managed, state.data.sessionName);
      }
      const reconciled = await pi.command<PiState>({ type: "get_state" });
      if (reconciled.success) this.applyNativeTitle(managed, reconciled.data?.sessionName);
      return info;
    } catch (error) {
      if (published) await this.rollbackCreate(managed, piSessionId);
      else await pi.dispose();
      throw error;
    }
  }

  private async rollbackCreate(managed: ManagedSession, piSessionId: string | undefined): Promise<void> {
    this.sessions.delete(managed.info.id);
    if (piSessionId !== undefined) this.createdSessions.delete(piSessionId);
    managed.unwirePi?.();
    const pi = managed.pi;
    managed.pi = undefined;
    if (pi !== undefined) await pi.dispose();
    this.store.remove(managed.info.id);
    this.emit(managed.info.directory, { type: "session.deleted", properties: { info: managed.info } });
  }

  private applyNativeTitle(s: ManagedSession, value: unknown): void {
    if (s.titleSource === "user" || typeof value !== "string") return;
    const title = value.trim().replace(/\s+/g, " ");
    if (title === "" || title === s.info.title) return;
    s.info.title = title;
    s.titleSource = "native";
    s.info.time.updated = Date.now();
    this.persistMeta(s);
    this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
  }

  private refreshNativeTitles(): void {
    for (const s of this.sessions.values()) this.refreshNativeTitle(s);
  }

  private refreshNativeTitle(s: ManagedSession): void {
    if (s.pi !== undefined || s.restored === undefined || !existsSync(s.restored.piPath)) return;
    const metadata = readSessionFileMeta(s.restored.piPath, s.restored.piSessionId);
    if (metadata.titleSource === "native") this.applyNativeTitle(s, metadata.title);
    // Not revived here yet, so nothing cached overrides what OmO will resume with, which another client may change.
    const resumed = s.thinkingLevel === undefined ? dormantModel(metadata, undefined) : undefined;
    if (resumed !== undefined) {
      s.model = resumed.model;
      s.info.model = { id: resumed.model.modelID, providerID: resumed.model.providerID, variant: resumed.variant };
    }
  }

  private wirePi(s: ManagedSession, pi: PiRpcClient): void {
    s.unwirePi?.();
    const onEvent = (payload: Record<string, unknown>): void => {
      if (s.pi !== pi) return;
      if (payload.type === "loaded_surfaces_changed") this.onMcpSurfacesChanged?.();
      this.lifecycle.touch(s);
      s.approvals?.observeQuestion(payload);
      try {
        this.onPiEvent(s, payload);
      } catch (error) {
        this.reportPersistenceError(s, error);
      }
    };
    const onExtensionUI = (request: Record<string, unknown>): void => {
      if (s.pi !== pi) return;
      this.lifecycle.touch(s);
      const extensionRequest = extensionUiRequestFrom(request);
      if (extensionRequest !== undefined) s.approvals?.handle(extensionRequest);
    };
    const onExit = (code: number | null, signal: string | null): void => {
      if (s.pi !== pi) return;
      this.onMcpSurfacesChanged?.();
      // An agent that stopped on its own (timeout, broken pipe, crash) must say why: a notice card in the
      // transcript, the same error on the reply it interrupted, and a replay after an adapter restart.
      // Pending commands reject with the same PiStoppedError; prompt admission leaves it to this handler.
      // Without a stop reason antechamber disposed the process itself and keeps the plain notice.
      const reason = pi.stopReason;
      const message = reason === undefined ? `pi process exited (code=${code} signal=${signal})` : describeStop(reason);
      const error = { name: reason === undefined ? "UnknownError" : "AgentStoppedError", data: { message } };
      this.events.finishInterruptedRun(s, error);
      if (reason !== undefined) s.lastStop = { message, at: Date.now() };
      try {
        recordTurn(s);
        this.persistMeta(s);
      } catch (error) {
        this.reportPersistenceError(s, error);
      }
      delete s.interruptRequested;
      this.events.settleBackground(s);
      // Its task cards end with the run; the tasks themselves may still run in OmO's shared host.
      this.subagents.finishCalls(s.info.id, true);
      this.monitors.stopParent(s.info.id);
      this.workStatus.stopParent(s.info.id);
      this.shells.stopParent(s.info.id);
      void this.lifecycle
        .dormant(s)
        .catch((error: unknown) => console.error("[lifecycle] exit cleanup failed:", error));
      if (s.lastStop !== undefined && reason !== undefined) {
        this.stopShown.add(pi);
        this.showStop(s, s.lastStop);
      }
      this.emit(s.info.directory, { type: "session.error", properties: { sessionID: s.info.id, error } });
      this.events.setStatus(s, { type: "idle" });
    };
    pi.onEvent(onEvent);
    pi.onExtensionUI(onExtensionUI);
    pi.onExit(onExit);
    this.onMcpSurfacesChanged?.();
    s.unwirePi = () => {
      pi.off("event", onEvent);
      pi.off("extension_ui_request", onExtensionUI);
      pi.off("exit", onExit);
      delete s.unwirePi;
    };
  }

  /** pi writes `<ts>_<sessionId>.jsonl` at startup — poll briefly for it. */
  private async resolvePiFile(directory: string, piSessionId: string): Promise<string | undefined> {
    const dir = piSessionDir(directory);
    const suffix = `_${piSessionId}.jsonl`;
    for (let attempt = 0; attempt < PI_FILE_RESOLVE_ATTEMPTS; attempt++) {
      try {
        for (const name of readdirSync(dir)) {
          if (name.endsWith(suffix)) return join(dir, name);
        }
      } catch {
        /* session dir may not exist until pi writes the first entry */
      }
      await new Promise((resolve) => setTimeout(resolve, PI_FILE_RESOLVE_RETRY_MS));
    }
    return undefined;
  }

  /** Sessions with a running agent (in `directory`, if given), most recently used first; never revives a dormant one. */
  liveSessions(directory?: string): ManagedSession[] {
    if (this.disposed) return [];
    return [...this.sessions.values()]
      .filter((s) => s.pi !== undefined && (directory === undefined || s.info.directory === directory))
      .sort((a, b) => this.lifecycle.lastUsed(b) - this.lifecycle.lastUsed(a));
  }

  list(directory?: string): OCSession[] {
    return this.store.batch(() => {
      this.refreshNativeTitles();
      this.subagents.restoreAll();
      if (directory !== undefined) {
        this.ensureScanned(directory);
        return [...this.sessions.values()]
          .filter((s) => s.info.directory === directory)
          .map((s) => this.sessionInfo(s));
      }
      // Unfiltered: keep the old semantics — live sessions only.
      return [...this.sessions.values()].filter((s) => s.restored === undefined).map((s) => this.sessionInfo(s));
    });
  }

  /**
   * Every restorable session on disk (all directories) plus live ones. Backs the
   * directory-less `/experimental/session` list OpenChamber reads for its
   * global/recent view; `list(directory)` stays the per-project source of truth.
   */
  listAll(): OCSession[] {
    return this.store.batch(() => {
      this.refreshNativeTitles();
      this.ensureAllScanned();
      this.subagents.restoreAll();
      return [...this.sessions.values()].map((s) => this.sessionInfo(s));
    });
  }

  private sessionInfo(s: ManagedSession): OCSession {
    if (s.restored !== undefined) this.ensureMessages(s);
    return s.info;
  }

  get(sessionId: string): ManagedSession | undefined {
    return this.store.batch(() => {
      if (this.disposed) return undefined;
      const live = this.sessions.get(sessionId);
      if (live !== undefined) {
        this.refreshNativeTitle(live);
        this.sessionInfo(live);
        return live;
      }
      const restored = this.subagents.restore(sessionId) ?? this.resolveRestored(sessionId);
      if (restored !== undefined) this.sessionInfo(restored);
      return restored;
    });
  }

  async remove(sessionId: string): Promise<boolean> {
    return this.lifecycle.run(() => this.removeLive(sessionId));
  }

  private async removeLive(sessionId: string): Promise<boolean> {
    const s = this.get(sessionId);
    if (!s) return false;
    s.approvals?.cancelAll();
    this.subagents.stopParent(sessionId);
    this.sessions.delete(sessionId);
    this.emit(s.info.directory, { type: "session.deleted", properties: { info: s.info } });
    await this.lifecycle.dormant(s);
    const piPath =
      this.subagents.owns(sessionId) || this.monitors.owns(sessionId) ? undefined : (s.piPath ?? s.restored?.piPath);
    const child = this.subagents.remove(sessionId);
    this.monitors.remove(sessionId);
    this.workStatus.stopParent(sessionId);
    this.shells.stopParent(sessionId);
    if (piPath !== undefined) {
      try {
        unlinkSync(piPath);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    // A deleted child keeps its tombstone; OmO still holds the task record that would list it again.
    if (!child) this.store.remove(sessionId);
    return true;
  }

  /**
   * PATCH /session/{id} — rename and/or archive. OpenChamber archives with
   * `{ time: { archived: Date.now() } }` and unarchives with `archived: 0`
   * (SDK v2 session.update); `title` is only touched when actually sent,
   * otherwise an archive-only PATCH would blank the title.
   */
  async update(
    sessionId: string,
    patch: {
      title?: string | undefined;
      archived?: number | undefined;
      metadata?: Record<string, unknown> | undefined;
      agent?: string | undefined;
    },
  ): Promise<OCSession | undefined> {
    const s = this.get(sessionId);
    if (!s) return undefined;
    if (patch.agent !== undefined && !getExposedAgentNames().includes(patch.agent))
      throw new RequestBodyError(400, `unknown agent: ${patch.agent}`);
    if (typeof patch.title === "string" && patch.title.trim() !== "") {
      const title = patch.title.trim().replace(/\s+/g, " ");
      if (s.pi !== undefined) {
        const renamed = await s.pi.command({ type: "set_session_name", name: title });
        if (!renamed.success) throw new Error(renamed.error ?? "session rename rejected");
      }
      s.info.title = title;
      s.titleSource = "user";
    }
    if (patch.metadata !== undefined) s.info.metadata = patch.metadata;
    if (patch.agent !== undefined) s.info.agent = patch.agent;
    if (patch.archived !== undefined) {
      if (patch.archived > 0) s.info.time.archived = patch.archived;
      else delete s.info.time.archived; // 0 = unarchive
    }
    s.info.time.updated = Date.now();
    // Child sessions have no pi path of their own, so persistMeta would skip them.
    if (!this.subagents.save(s.info.id)) this.persistMeta(s);
    this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
    return s.info;
  }

  messages(sessionId: string): OCMessageWithParts[] | undefined {
    const s = this.get(sessionId);
    if (!s) return undefined;
    const messages = s.tree.localShellTurns?.length ? this.refreshMessageCache(s) : this.ensureMessages(s);
    // OpenChamber also hydrates the panel through SSE when reopening history.
    if (s.todoBridge !== undefined) {
      this.emit(s.info.directory, {
        type: "todo.updated",
        properties: { sessionID: s.info.id, todos: s.todoBridge.todos },
      });
    }
    return messages;
  }

  /** Append to canonical history, before the hidden redo branch while reverted. */
  appendMessage(sessionId: string, message: OCMessageWithParts): void {
    const s = this.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);
    const messages = this.ensureMessages(s);
    (s.localMessageIds ??= new Set()).add(message.info.id);
    const boundary = messages.findIndex((item) => item.info.id === s.tree.revert?.messageID);
    messages.splice(boundary < 0 ? messages.length : boundary, 0, message);
  }

  private async operation<T>(s: ManagedSession, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(s.info.id);
    const next = previous ? previous.then(() => this.lifecycle.use(s, action)) : this.lifecycle.use(s, action);
    const settled = next.catch(() => undefined);
    this.operations.set(s.info.id, settled);
    try {
      return await next;
    } finally {
      if (this.operations.get(s.info.id) === settled) this.operations.delete(s.info.id);
    }
  }

  /** Cancellation releases only the caller; the native action keeps its queue lease. */
  private async waitForOperation<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return pending;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private async syncTree(s: ManagedSession, treeOperation = false) {
    const pi = s.pi;
    if (!pi) throw new SessionTreeError("Session has no OmO process");
    if (treeOperation) this.refreshMessageCache(s);
    else this.ensureMessages(s);
    const admissions = s.tree.localShellTurns?.length;
    let tree = await getEntries(pi);
    if (treeOperation && s.piPath !== undefined) {
      const disk = readSessionTree(s.piPath);
      const known = new Set(tree.entries.map((entry) => entry.id));
      if (tree.unverifiedPrefix || disk.leafId !== tree.leafId || disk.entries.some((entry) => !known.has(entry.id))) {
        // Only idle user tree operations can replace a stale native runtime.
        const saved = s.tree.leafId;
        const response = await pi.command<{ cancelled?: boolean }>(
          { type: "switch_session", sessionPath: s.piPath },
          RPC_COMMAND_TIMEOUT_MS,
        );
        if (!response.success || response.data?.cancelled)
          throw new SessionTreeError(response.error ?? "Native tree refresh was cancelled");
        try {
          const leaf = saved === undefined ? undefined : await navigate(pi, saved);
          tree = await getEntries(pi);
          if (leaf !== undefined && !restoredLeaf(tree, leaf))
            throw new SessionTreeError("Native tree refresh did not restore the saved navigation");
          if (leaf !== undefined) s.tree.leafId = leaf;
        } catch (error) {
          await this.lifecycle.dormant(s);
          throw error;
        }
      }
    }
    bindMessageEntries(s, tree);
    if (admissions) this.refreshMessageCache(s);
    this.persistMeta(s);
    return tree;
  }

  private async treeSession(
    sessionId: string,
    action: (s: ManagedSession, pi: PiRpcClient) => Promise<OCSession>,
  ): Promise<OCSession> {
    const s = this.get(sessionId);
    if (!s) throw new SessionTreeError(`unknown session: ${sessionId}`);
    return this.operation(s, async () => {
      if (s.status.type !== "idle" || s.hasPendingInteraction()) {
        throw new SessionTreeError("Session is busy; stop the turn before changing the conversation");
      }
      // Stopping the turn does not stop a background subagent; it ends on its own or when cancelled.
      if (s.hasRunningChildren()) {
        throw new SessionTreeError(
          "A subagent of this session is still running; wait for it to finish before changing the conversation",
        );
      }
      if (!s.pi) await this.revive(s);
      const pi = s.pi;
      if (!pi) throw new SessionTreeError("Session cannot be resumed");
      return action(s, pi);
    });
  }

  async fork(sessionId: string, messageID?: string): Promise<OCSession> {
    // Admission must see either the parent or child owner throughout the transfer.
    return this.treeSession(sessionId, (s, pi) =>
      this.lifecycle.run(async () => {
        const tree = await this.syncTree(s, true);
        const state = await forkConversation(s, pi, tree, messageID);
        this.createdSessions.set(state.sessionId, s.info.directory);
        const now = Date.now();
        const child = this.adopt({
          piSessionId: state.sessionId,
          piPath: state.sessionFile,
          directory: s.info.directory,
          title: `${s.info.title} (fork)`,
          created: now,
          updated: now,
        });
        child.pi = pi;
        child.piPath = state.sessionFile;
        child.piSessionId = state.sessionId;
        delete child.restored;
        child.model = s.model;
        child.info.parentID = s.info.id;
        if (messageID !== undefined) child.info.parentMessageID = messageID;
        child.info.agent = s.info.agent ?? getAgentName();
        if (s.info.metadata !== undefined) child.info.metadata = structuredClone(s.info.metadata);
        const childTree = await getEntries(pi);
        child.tree.leafId = childTree.leafId;
        this.ensureMessages(child);
        this.wirePi(child, pi);
        this.lifecycle.touch(child);
        this.persistMeta(child);
        this.emit(child.info.directory, { type: "session.created", properties: { info: child.info } });
        return child.info;
      }),
    );
  }

  async revert(sessionId: string, messageID: string): Promise<OCSession> {
    return this.treeSession(sessionId, async (s, pi) => {
      const tree = await this.syncTree(s, true);
      // OpenChamber renders its own reverted-message dock from session.revert.
      if (!(await revertConversation(s, pi, tree, messageID))) return s.info;
      this.persistMeta(s);
      this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
      this.emit(s.info.directory, {
        type: "session.revert.staged",
        properties: { sessionID: s.info.id, revert: { messageID } },
      });
      return s.info;
    });
  }

  async unrevert(sessionId: string): Promise<OCSession> {
    return this.treeSession(sessionId, async (s, pi) => {
      await this.syncTree(s, true);
      if (!(await unrevertConversation(s, pi))) return s.info;
      this.persistMeta(s);
      this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
      this.emit(s.info.directory, { type: "session.revert.cleared", properties: { sessionID: s.info.id } });
      return s.info;
    });
  }

  async reloadMessages(sessionId: string, signal?: AbortSignal): Promise<OCMessageWithParts[] | undefined> {
    const s = this.get(sessionId);
    if (!s) return undefined;
    return this.waitForOperation(
      this.operation(s, () => this.reloadMessagesLive(s, signal)),
      signal,
    );
  }

  /** Called only within the conversation operation queue, including RPC refreshes. */
  private async reloadMessagesLive(s: ManagedSession, signal?: AbortSignal): Promise<OCMessageWithParts[]> {
    const sessionId = s.info.id;
    signal?.throwIfAborted();
    if (!s.pi) await this.revive(s);
    const pi = s.pi;
    if (!pi) throw new SessionTreeError("Session cannot be resumed");
    const tree = await getEntries(pi);
    signal?.throwIfAborted();
    bindMessageEntries(s, tree);
    // Compact/bash and extension slash commands can append without agent_end.
    // Binding follows new descendants, never a stale ancestor of the selection.
    if (s.tree.revert && s.tree.leafId !== undefined && tree.leafId !== s.tree.leafId)
      await navigate(pi, s.tree.leafId);
    signal?.throwIfAborted();
    const previous = s.messages ?? [];
    const messages = this.refreshMessageCache(s);
    const ids = new Set(messages.map((message) => message.info.id));
    for (const message of previous) {
      if (!ids.has(message.info.id)) {
        this.emit(s.info.directory, {
          type: "message.removed",
          properties: { sessionID: sessionId, messageID: message.info.id },
        });
      }
    }
    for (const message of messages) {
      this.emit(s.info.directory, { type: "message.updated", properties: { info: message.info } });
      for (const part of message.parts) this.events.emitPart(s, part);
    }
    await this.update(sessionId, {});
    return messages;
  }

  statuses(): Record<string, OCSessionStatus> {
    const out: Record<string, OCSessionStatus> = {};
    for (const s of this.sessions.values()) out[s.info.id] = s.status; // dormant sessions are idle
    return out;
  }

  todos(sessionId: string): Todo[] | undefined {
    const s = this.get(sessionId);
    if (!s) return undefined;
    this.ensureMessages(s);
    return s.todoBridge?.todos ?? [];
  }

  async commitRevert(sessionId: string): Promise<void> {
    await this.treeSession(sessionId, async (s, pi) => {
      await this.commitRevertLive(s, pi);
      return s.info;
    });
  }

  private async commitRevertLive(s: ManagedSession, pi: PiRpcClient): Promise<void> {
    const revert = s.tree.revert;
    if (revert === undefined) return;
    const boundary = s.messages?.findIndex((message) => message.info.id === revert.messageID) ?? -1;
    if (boundary >= 0) {
      for (const message of s.messages?.splice(boundary) ?? []) {
        this.emit(s.info.directory, {
          type: "message.removed",
          properties: { sessionID: s.info.id, messageID: message.info.id },
        });
      }
    }
    delete s.tree.revert;
    delete s.info.revert;
    bindMessageEntries(s, await getEntries(pi));
    this.persistMeta(s);
    this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
    this.emit(s.info.directory, {
      type: "session.revert.committed",
      properties: { sessionID: s.info.id, to: revert.messageID },
    });
  }

  async diff(
    sessionId: string,
    options: { from?: string | undefined; to?: string | undefined; context?: number | undefined } = {},
  ) {
    const s = this.get(sessionId);
    if (s === undefined) throw new Error(`unknown session: ${sessionId}`);
    const messages = this.ensureMessages(s);
    const start = options.from === undefined ? 0 : messages.findIndex((message) => message.info.id === options.from);
    const end =
      options.to === undefined ? messages.length : messages.findIndex((message) => message.info.id === options.to);
    if (start < 0 || end < 0 || start > end) throw new RequestBodyError(400, "invalid diff message range");
    return sessionDiff(s.info.directory, messages.slice(start, end), options.context);
  }

  private emitDiff(s: ManagedSession): void {
    if (!this.dirtyDiffs.delete(s.info.id)) return;
    const previous = this.diffEmissions.get(s.info.id) ?? Promise.resolve();
    const pending = previous
      .then(async () => {
        const diff = await this.diff(s.info.id);
        this.emit(s.info.directory, { type: "session.diff", properties: { sessionID: s.info.id, diff } });
      })
      .catch((error: unknown) => {
        this.emit(s.info.directory, {
          type: "session.error",
          properties: {
            sessionID: s.info.id,
            error: { name: "UnknownError", data: { message: error instanceof Error ? error.message : String(error) } },
          },
        });
      })
      .finally(() => {
        if (this.diffEmissions.get(s.info.id) === pending) this.diffEmissions.delete(s.info.id);
      });
    this.diffEmissions.set(s.info.id, pending);
  }

  async abort(sessionId: string): Promise<boolean> {
    const s = this.get(sessionId);
    if (!s) return false;
    s.abortRequests = (s.abortRequests ?? 0) + 1;
    if (s.pi !== undefined) {
      if (s.status.type !== "idle") s.interruptRequested = true;
      try {
        const response = await s.pi.command({ type: "abort" });
        if (!response.success) throw new Error(response.error ?? "pi abort failed");
      } catch (error) {
        delete s.interruptRequested;
        throw error;
      }
    }
    s.cancelShell?.();
    s.approvals?.cancelAll();
    // Background tasks outlive an abort; OmO itself cancels the ones the turn was waiting on.
    this.subagents.finishCalls(sessionId, true);
    return true;
  }

  permissions(sessionId?: string): PendingPermission[] {
    return [...this.sessions.values()].flatMap((session) =>
      sessionId === undefined || session.info.id === sessionId ? (session.approvals?.permissions() ?? []) : [],
    );
  }

  questions(sessionId?: string): PendingQuestion[] {
    return [...this.sessions.values()].flatMap((session) =>
      sessionId === undefined || session.info.id === sessionId ? (session.approvals?.questions() ?? []) : [],
    );
  }

  replyPermission(
    sessionID: string,
    requestID: string,
    reply: "once" | "always" | "reject",
    message?: string,
  ): boolean {
    return this.get(sessionID)?.approvals?.replyPermission(requestID, reply, message) ?? false;
  }

  async replyQuestion(
    sessionID: string,
    requestID: string,
    answers: Array<string[]>,
    comment?: string,
  ): Promise<boolean> {
    const s = this.get(sessionID);
    if (!s) return false;
    if (!s.pi) await this.revive(s);
    return s.approvals?.replyQuestion(requestID, answers, undefined, comment) ?? false;
  }

  async rejectQuestion(sessionID: string, requestID: string): Promise<boolean> {
    const s = this.get(sessionID);
    if (!s) return false;
    if (!s.pi) await this.revive(s);
    return s.approvals?.rejectQuestion(requestID) ?? false;
  }

  private approvalsFor(s: ManagedSession): ApprovalBridge {
    s.hasPendingInteraction = () => s.approvals?.hasPending(s.info.id) ?? false;
    return new ApprovalBridge(
      s.info.id,
      (event) => this.emit(s.info.directory, event as OCEvent),
      (response) => s.pi?.respondExtensionUI(response),
      () => s.streaming?.message.id ?? s.messages?.findLast((m) => m.info.role === "assistant")?.info.id,
      async (response) => {
        if (!s.pi) return false;
        const reply = await s.pi.command({ ...response, type: "extension_ui_response" });
        return reply.success;
      },
    );
  }

  async sessionRpc<T = unknown>(
    sessionId: string,
    command: Omit<PiRpcCommand, "id">,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<PiRpcResponse<T>> {
    const s = this.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);
    signal?.throwIfAborted();
    const pending = this.operation(s, async () => {
      signal?.throwIfAborted();
      if (s.pi === undefined) await this.revive(s);
      const pi = s.pi;
      if (pi === undefined) throw new Error(`session cannot be resumed: ${sessionId}`);
      this.lifecycle.touch(s);
      // A user shell runs until its command exits or the user stops it (`PiRpcClient.abortBash`).
      const timeout =
        command.type === "compact"
          ? COMPACT_RPC_TIMEOUT_MS
          : command.type === "bash"
            ? undefined
            : RPC_COMMAND_TIMEOUT_MS;
      // OmO cancels a compaction whenever an MCP server's tools register, which a freshly revived agent
      // does for about a second; start it once they have. The retries below remain the backstop.
      if (command.type === "compact") await waitForMcpServers(pi, MCP_SETTLE_WAIT_MS, signal);
      signal?.throwIfAborted();
      const abortsBefore = s.abortRequests ?? 0;
      // The translator holds back a cancellation this loop may retry, so the UI shows one compaction.
      if (command.type === "compact") s.compactRetry = { left: COMPACT_CANCEL_RETRIES, aborts: abortsBefore };
      let response: PiRpcResponse<T>;
      try {
        response = await pi.command<T>(command, timeout, undefined, onDispatch);
        // OmO cancels a running compaction whenever its active tool set changes. On a session
        // just revived for this request, MCP servers finish connecting a moment after startup
        // and cancel it although nobody asked. Retry unless the user sent an abort meanwhile.
        for (
          let retry = 0;
          retry < COMPACT_CANCEL_RETRIES &&
          command.type === "compact" &&
          !response.success &&
          response.error === OMO_COMPACTION_CANCELLED &&
          (s.abortRequests ?? 0) === abortsBefore &&
          !signal?.aborted &&
          s.pi === pi;
          retry++
        ) {
          if (s.compactRetry) s.compactRetry.left--;
          response = await pi.command<T>(command, timeout);
        }
      } finally {
        if (command.type === "compact") {
          delete s.compactRetry;
          this.events.releaseCompactionEnd(s);
        }
      }
      if (!signal?.aborted && response.success && (command.type === "compact" || command.type === "bash"))
        await this.reloadMessagesLive(s, signal);
      return response;
    });
    return this.waitForOperation(pending, signal);
  }

  /**
   * POST /api/session/{id}/model — OpenChamber awaits this before every prompt
   * (its `applySendSelection` calls switchModel first), so it is the only path
   * from the bottom-right picker to pi. Errors are deliberately not swallowed:
   * a silent no-op is exactly what let the UI and pi disagree about the model.
   */
  async setModel(sessionId: string, ref: ModelSelection): Promise<OCModelRef> {
    const s = this.get(sessionId);
    if (s === undefined) throw new Error(`unknown session: ${sessionId}`);
    return this.operation(s, () => this.setModelLive(s, ref));
  }

  private async setModelLive(s: ManagedSession, ref: ModelSelection): Promise<OCModelRef> {
    const sessionId = s.info.id;
    if (s.pi === undefined) await this.revive(s);
    const pi = s.pi;
    if (pi === undefined) throw new Error(`session cannot be resumed: ${sessionId}`);
    // The client re-sends its selection on every send; an unchanged model must
    // not cost a round-trip nor emit a phantom "model switched" marker.
    if (s.model !== undefined && s.model.providerID === ref.providerID && s.model.modelID === ref.modelID) {
      await setThinkingLevel(s, pi, ref.variant);
      this.syncRecordVariant(s);
      return s.model;
    }
    const res = await pi.command<{ provider?: string; id?: string; responseModel?: string }>({
      type: "set_model",
      provider: ref.providerID,
      modelId: ref.modelID,
    });
    if (!res.success) throw new Error(res.error ?? `pi refused model ${ref.providerID}/${ref.modelID}`);
    // set_model may clamp thinking to the new model's supported range.
    delete s.thinkingLevel;
    if (ref.variant !== undefined) {
      const state = await pi.command<PiState>({ type: "get_state" });
      if (!state.success || !state.data) throw new Error(state.error ?? "pi returned no state after model switch");
      if (state.data.thinkingLevel !== undefined) s.thinkingLevel = state.data.thinkingLevel;
    }
    // pi's response is the authority, not the request: it echoes the resolved
    // Model, including `responseModel` when the provider named a concrete one.
    const data = res.data;
    const resolved: OCModelRef = {
      providerID: typeof data?.provider === "string" && data.provider !== "" ? data.provider : ref.providerID,
      modelID:
        typeof data?.responseModel === "string" && data.responseModel !== ""
          ? data.responseModel
          : typeof data?.id === "string" && data.id !== ""
            ? data.id
            : ref.modelID,
    };
    this.applyPiModel(s, resolved.providerID, resolved.modelID);
    await setThinkingLevel(s, pi, ref.variant);
    this.syncRecordVariant(s);
    return resolved;
  }

  /**
   * On a device with no saved pick, OpenChamber 2.x restores a reopened session's effort from this
   * record and resends it with the next prompt, so a stale level silently resets the user's choice.
   */
  private syncRecordVariant(s: ManagedSession): void {
    if (s.info.model !== undefined) s.info.model = { ...s.info.model, variant: s.thinkingLevel ?? "default" };
  }

  /**
   * Single funnel for "pi is now running this model": adopt it, persist it for
   * the next cold start, and tell the UI. Returns whether anything changed.
   */
  private applyPiModel(s: ManagedSession, provider: unknown, modelId: unknown): boolean {
    if (typeof provider !== "string" || provider === "") return false;
    if (typeof modelId !== "string" || modelId === "") return false;
    const previous = s.model;
    if (previous !== undefined && previous.providerID === provider && previous.modelID === modelId) return false;
    const model: OCModelRef = { providerID: provider, modelID: modelId };
    s.model = model;
    s.info.model = { id: modelId, providerID: provider, variant: s.thinkingLevel ?? "default" };
    this.persistMeta(s);
    this.emit(s.info.directory, {
      type: "model.changed",
      properties: { sessionID: s.info.id, model, ...(previous !== undefined ? { previous } : {}) },
    });
    return true;
  }

  async prompt(
    sessionId: string,
    text: string,
    model?: ModelSelection,
    noReply = false,
    messageID?: string,
    delivery: "steer" | "queue" = "steer",
    parts?: readonly OCPromptPart[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const s = this.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);
    return this.operation(s, () => this.promptLive(s, text, model, noReply, messageID, delivery, parts, metadata));
  }

  private async preparePrompt(s: ManagedSession, model: ModelSelection | undefined): Promise<PiRpcClient> {
    const sessionId = s.info.id;
    if (s.pi === undefined) await this.revive(s);
    const pi = s.pi;
    if (pi === undefined) throw new Error(`session cannot be resumed: ${sessionId}`);
    this.lifecycle.touch(s);
    this.ensureMessages(s);

    await this.commitRevertLive(s, pi);

    if (model !== undefined) {
      try {
        // This prompt already owns the operation queue; do not enqueue recursively.
        await this.setModelLive(s, model);
      } catch (error) {
        this.emit(s.info.directory, {
          type: "session.error",
          properties: {
            sessionID: s.info.id,
            error: {
              name: "UnknownError",
              data: { message: error instanceof Error ? error.message : String(error) },
            },
          },
        });
        throw error;
      }
    }
    return pi;
  }

  private publishPrompt(
    s: ManagedSession,
    text: string,
    model: ModelSelection | undefined,
    messageID: string | undefined,
    inputParts?: readonly OCPromptPart[],
    metadata?: Record<string, unknown>,
    context = false,
  ): OCUserMessage {
    // OpenChamber sends a client-generated messageID with its optimistic
    // insert; the server MUST reuse it so the echoed message.part.updated /
    // message.updated events reconcile the optimistic entry in place instead
    // of rendering the user's message twice (event-reducer matches by id).
    const userMsg: OCUserMessage = {
      id: typeof messageID === "string" && messageID !== "" ? messageID : id("msg"),
      sessionID: s.info.id,
      role: "user",
      time: { created: Date.now() },
      agent: getAgentName(),
      model: userMessageModel(s.model ?? model ?? { providerID: "unknown", modelID: "unknown" }, s.thinkingLevel),
      ...(context ? { synthetic: true } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
    if (metadata !== undefined) (s.tree.promptMetadata ??= {})[userMsg.id] = metadata;
    // The user moved on: the stop notice stays in this adapter's memory but is not replayed after a restart.
    if (!context) delete s.lastStop;
    const parts: OCPart[] = (inputParts ?? [{ type: "text", text }]).map((part) => ({
      ...part,
      id: part.id ?? id("prt"),
      sessionID: s.info.id,
      messageID: userMsg.id,
    }));
    if (inputParts?.some((part) => part.type !== "text")) (s.tree.promptParts ??= {})[userMsg.id] = [...inputParts];
    s.messages?.push({ info: userMsg, parts });
    s.info.time.updated = Date.now();
    if (!context && s.info.title === "New session" && s.titleSource !== "user" && s.titleSource !== "native") {
      s.info.title = text.trim().replace(/\s+/g, " ").slice(0, SESSION_TITLE_MAX_CHARS) || "New session";
      s.titleSource = "fallback";
    }
    this.persistMeta(s);
    this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
    this.emit(s.info.directory, { type: "message.updated", properties: { info: userMsg } });
    // Echo the user text part: the reducer replaces the client's sessionID-less
    // optimistic part (same type, new id) in place — without this echo a page
    // fetch merges the optimistic part back in and the text shows twice.
    for (const part of parts) this.events.emitPart(s, part);
    return userMsg;
  }

  private async promptLive(
    s: ManagedSession,
    text: string,
    model?: ModelSelection,
    noReply = false,
    messageID?: string,
    delivery: "steer" | "queue" = "steer",
    parts?: readonly OCPromptPart[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const pi = await this.preparePrompt(s, model);
    const native = nativePromptInput(text, parts ?? []);
    const userMsg = this.publishPrompt(s, text, model, messageID, parts, metadata, noReply);

    if (noReply) {
      await this.admitContext(s, pi, userMsg, native.message);
      return;
    }

    if (!(await this.dispatchPrompt(s, pi, userMsg, text, delivery, native, parts ?? []))) return;
    await this.bindPromptState(s);
  }

  /**
   * No-reply context (v2 synthetic, v1 noReply) joins the native conversation without a turn:
   * OmO appends it now when idle, or after the running turn, so the next prompt carries it.
   */
  private async admitContext(s: ManagedSession, pi: PiRpcClient, userMsg: OCUserMessage, text: string): Promise<void> {
    const res = await pi.command({
      type: "send_custom_message",
      customType: CONTEXT_MESSAGE_TYPE,
      content: [{ type: "text", text }],
      display: true,
      details: { messageID: userMsg.id },
      triggerTurn: false,
    });
    if (!res.success) {
      if (s.tree.promptParts) delete s.tree.promptParts[userMsg.id];
      if (s.tree.promptMetadata) delete s.tree.promptMetadata[userMsg.id];
      s.messages = s.messages?.filter((message) => message.info.id !== userMsg.id);
      this.emit(s.info.directory, {
        type: "message.removed",
        properties: { sessionID: s.info.id, messageID: userMsg.id },
      });
      throw new Error(res.error ?? "context admission rejected");
    }
    // Bind the appended entry and persist the new leaf before announcing delivery, or a restart
    // restores the old branch without the context.
    await this.bindPromptState(s);
    this.emit(s.info.directory, {
      type: "session.inbox.enqueued",
      properties: {
        sessionID: s.info.id,
        inboxID: userMsg.id,
        item: { type: "synthetic", payload: { text, ...(userMsg.metadata ? { metadata: userMsg.metadata } : {}) } },
      },
    });
    this.events.deliverInput(s, userMsg.id);
  }

  private async dispatchPrompt(
    s: ManagedSession,
    pi: PiRpcClient,
    userMsg: OCUserMessage,
    text: string,
    delivery: "steer" | "queue",
    native: ReturnType<typeof nativePromptInput>,
    parts: readonly OCPromptPart[],
  ): Promise<boolean> {
    const wasIdle = s.status.type === "idle";
    if (wasIdle) {
      s.toolByCallId = new Map();
      this.events.setStatus(s, { type: "busy" });
    }
    const input = { text: native.message, delivery, accepted: false, delivered: false };
    (s.inputs ??= new Map()).set(userMsg.id, input);
    const rejectInput = (): void => {
      s.inputs?.delete(userMsg.id);
      if (s.tree.promptParts) delete s.tree.promptParts[userMsg.id];
      if (s.tree.promptMetadata) delete s.tree.promptMetadata[userMsg.id];
      s.messages = s.messages?.filter((message) => message.info.id !== userMsg.id);
      this.emit(s.info.directory, {
        type: "message.removed",
        properties: { sessionID: s.info.id, messageID: userMsg.id },
      });
      if (wasIdle) this.events.setStatus(s, { type: "idle" });
    };
    const onNotification = (request: Record<string, unknown>): void => {
      if (request.method === "notify" && typeof request.message === "string") {
        announceSessionNotice({ sessions: this, session: s, emit: this.emit }, request.message);
      }
    };
    if (text.startsWith("/")) pi.onExtensionUI(onNotification);
    const send = (message: string) =>
      pi.command({
        type: "prompt",
        ...native,
        message,
        streamingBehavior: delivery === "queue" ? "followUp" : "steer",
        clientMessageId: userMsg.id,
        ...slashTitlePrompt(text),
      });
    const res = await (async () => {
      const first = await send(native.message);
      // OmO rejects unknown commands before admission, so the same clientMessageId can be resent.
      const skill = first.success ? undefined : skillCommandText(native.message, first);
      if (skill === undefined) return first;
      input.text = skill;
      return send(skill);
    })()
      .catch((error: unknown) => {
        rejectInput();
        throw error;
      })
      .finally(() => {
        pi.off("extension_ui_request", onNotification);
      });
    if (!res.success) {
      rejectInput();
      this.emit(s.info.directory, {
        type: "session.error",
        properties: {
          sessionID: s.info.id,
          error: { name: "UnknownError", data: { message: res.error ?? "prompt rejected" } },
        },
      });
      return false;
    }
    input.accepted = true;
    this.emit(s.info.directory, {
      type: "session.inbox.enqueued",
      properties: {
        sessionID: s.info.id,
        inboxID: userMsg.id,
        item: {
          type: "user",
          delivery,
          payload: {
            text,
            ...v2PromptAttachments(parts),
            ...(userMsg.metadata ? { metadata: userMsg.metadata } : {}),
          },
        },
      },
    });
    if (input.delivered) this.events.deliverInput(s, userMsg.id);
    // Extension commands can finish without starting an agent turn.
    if (
      res.data !== null &&
      typeof res.data === "object" &&
      "disposition" in res.data &&
      res.data.disposition === "handled"
    ) {
      if (!input.delivered) this.events.deliverInput(s, userMsg.id);
      if (wasIdle) this.events.setStatus(s, { type: "idle" });
    }
    return true;
  }

  private async bindPromptState(s: ManagedSession): Promise<void> {
    // First message makes pi write the session file — bind it now so the
    // session (and its current title) survives an adapter restart.
    if (s.piPath === undefined && s.piSessionId !== undefined) {
      const piPath = await this.resolvePiFile(s.info.directory, s.piSessionId);
      if (piPath !== undefined) {
        s.piPath = piPath;
        this.persistMeta(s);
      }
    }
    await this.syncTree(s);
  }

  async disposeAll(): Promise<void> {
    for (const s of this.sessions.values()) {
      s.approvals?.cancelAll();
      s.cancelShell?.(true);
    }
    try {
      await this.lifecycle.stop();
      await (this.hostShutdown ??= stopSessionHosts(this.createdSessions));
    } finally {
      // A failed private-host teardown is reported to the caller, but local
      // state is released regardless; the hosts themselves are left alone.
      this.disposed = true;
      this.subagents.dispose();
      await Promise.all(this.diffEmissions.values());
      this.sessions.clear();
    }
  }

  // ------------------------------------------------------------------
  // restore: dormant sessions backed by pi's JSONL files
  // ------------------------------------------------------------------

  /** Spawn pi against the session's JSONL file and adopt it as live. */
  private async revive(s: ManagedSession): Promise<void> {
    return this.lifecycle.run(() => this.reviveLive(s));
  }

  private async reviveLive(s: ManagedSession): Promise<void> {
    if (this.sessions.get(s.info.id) !== s) throw new Error(`session was deleted: ${s.info.id}`);
    if (s.pi !== undefined) return; // Concurrent prompts share one revival.
    const restored = s.restored;
    if (restored === undefined) throw new Error(`session is not restorable: ${s.info.id}`);
    if (!existsSync(restored.piPath)) throw new Error(`pi session file is gone: ${restored.piPath}`);
    this.refreshMessageCache(s);
    await this.lifecycle.makeRoom();
    const resumedLeaf = readSessionTree(restored.piPath).leafId;
    const pi = new PiRpcClient({
      cwd: s.info.directory,
      args: ["--session", restored.piPath],
      clock: this.lifecycle.clock,
    });
    s.pi = pi;
    s.approvals = this.approvalsFor(s);
    this.wirePi(s, pi);
    try {
      const state = await pi.command<PiState>({ type: "get_state" });
      if (!state.success || !state.data) throw new Error(`pi get_state failed on resume: ${state.error ?? "no data"}`);
      s.approvals.hydrate(state.data.pendingQuestions);
      if (s.titleSource === "user") {
        const renamed = await pi.command({ type: "set_session_name", name: s.info.title });
        if (!renamed.success) throw new Error(renamed.error ?? "session rename rejected");
      } else {
        this.applyNativeTitle(s, state.data.sessionName);
      }
      // Restore selection before publishing a runtime that prompts can use.
      const thinking: ThinkingState =
        state.data.thinkingLevel === undefined ? {} : { thinkingLevel: state.data.thinkingLevel };
      await setThinkingLevel(thinking, pi, s.thinkingLevel);
      let tree = await getEntries(pi);
      const saved = s.tree.leafId;
      // Resume hooks can already be streaming on this branch. Navigating back would
      // discard their progress, and OmO rejects even a no-op navigation while streaming.
      if (
        saved !== undefined &&
        saved !== tree.leafId &&
        (s.tree.revert || resumedLeaf !== saved || !branchEntries(tree).some((entry) => entry.id === saved))
      ) {
        const leaf = await navigate(pi, saved);
        tree = await getEntries(pi);
        if (!restoredLeaf(tree, leaf)) throw new SessionTreeError("Revival did not restore the saved navigation");
        s.tree.leafId = leaf;
      }
      bindMessageEntries(s, tree);
      if (thinking.thinkingLevel !== undefined) s.thinkingLevel = thinking.thinkingLevel;
      s.piPath = restored.piPath;
      s.piSessionId = restored.piSessionId;
      this.applyPiModel(s, state.data.model?.provider, state.data.model?.id);
      this.syncRecordVariant(s);
      this.refreshMessageCache(s);
      this.persistMeta(s);
      delete s.restored;
      this.lifecycle.touch(s);
    } catch (error) {
      s.unwirePi?.();
      s.pi = undefined;
      delete s.approvals;
      await pi.dispose();
      // Unwired above, so onExit cannot report a stop that ended the revival (crash, cold-start timeout).
      // Read the reason after dispose: a closed stdout is corrected to the exit status once the exit arrives.
      if (error instanceof PiStoppedError && !this.stopShown.has(pi))
        this.reportStop(s, describeStop(pi.stopReason ?? error.reason));
      throw error;
    }
  }

  /** Record, persist and show a stop that no exit handler will report. */
  private reportStop(s: ManagedSession, message: string): void {
    s.lastStop = { message, at: Date.now() };
    try {
      this.persistMeta(s);
    } catch (error) {
      this.reportPersistenceError(s, error);
    }
    this.showStop(s, s.lastStop);
    this.emit(s.info.directory, {
      type: "session.error",
      properties: { sessionID: s.info.id, error: { name: "AgentStoppedError", data: { message } } },
    });
  }

  /** `reparse` rebuilds from the JSONL while `s.messages` stays visible, so the binder can reuse live ids. */
  private ensureMessages(s: ManagedSession, reparse = false): OCMessageWithParts[] {
    if (this.subagents.owns(s.info.id)) return this.subagents.messages(s.info.id);
    if (this.monitors.owns(s.info.id)) return this.monitors.messages(s.info.id);
    if (s.pi !== undefined) delete s.historyFileSize;
    const dormantPath = s.pi === undefined ? s.restored?.piPath : undefined;
    const fileSize = dormantPath === undefined ? undefined : statSync(dormantPath, { throwIfNoEntry: false })?.size;
    const cachedFileSize = s.historyFileSize ?? s.tree.fileSize;
    if (!reparse && s.messages !== undefined && fileSize !== undefined && fileSize !== cachedFileSize)
      return this.refreshMessageCache(s, true);
    if (s.messages === undefined || reparse) {
      // A dormant session may have been continued by another OmO client since the last save.
      if (s.pi === undefined && s.restored !== undefined) followExternalAppends(s, s.restored.piPath);
      const admissions = s.tree.localShellTurns?.length;
      s.messages = parsePiSessionFile(s, getAgentName());
      if (s.lastStop !== undefined) this.replayStop(s, s.messages, s.lastStop);
      if (fileSize !== undefined) s.historyFileSize = fileSize;
      this.subagents.discover(s, s.messages);
      if (admissions) this.persistMeta(s);
      if (syncSessionCost(s)) this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
    }
    return s.messages;
  }

  /**
   * The stop notice card. Its id derives from the stop time, so the live card and every replay after a
   * history re-parse are one message, never duplicates.
   */
  private stopNotice(s: ManagedSession, stop: { message: string; at: number }): ReturnType<typeof noticeMessage> {
    const notice = noticeMessage(
      s,
      stop.message,
      { name: "AgentStoppedError", data: { message: stop.message } },
      stop.at,
    );
    notice.info.id = `msg_agentstop_${stop.at}`;
    for (const part of notice.parts) {
      part.id = `prt_agentstop_${stop.at}`;
      part.messageID = notice.info.id;
    }
    return notice;
  }

  private showStop(s: ManagedSession, stop: { message: string; at: number }): void {
    const messages = this.ensureMessages(s);
    let notice = messages.find((message) => message.info.id === `msg_agentstop_${stop.at}`);
    if (notice === undefined) {
      notice = this.stopNotice(s, stop);
      this.appendMessage(s.info.id, notice);
    }
    this.emit(s.info.directory, { type: "message.updated", properties: { info: notice.info } });
    for (const part of notice.parts) this.events.emitPart(s, part);
  }

  /** Show the last unexplained stop again after a history re-parse or adapter restart, where it happened. */
  private replayStop(s: ManagedSession, messages: OCMessageWithParts[], stop: { message: string; at: number }): void {
    if (messages.some((message) => message.info.id === `msg_agentstop_${stop.at}`)) return;
    // Like appendMessage: never inside the hidden redo branch while reverted.
    const boundary = messages.findIndex((message) => message.info.id === s.tree.revert?.messageID);
    const later = messages.findIndex((message) => message.info.time.created > stop.at);
    const at = Math.min(later < 0 ? messages.length : later, boundary < 0 ? messages.length : boundary);
    const notice = this.stopNotice(s, stop);
    notice.info.parentID = messages.slice(0, at).findLast((message) => message.info.role === "user")?.info.id ?? "";
    (s.localMessageIds ??= new Set()).add(notice.info.id);
    messages.splice(at, 0, notice);
  }

  private refreshMessageCache(s: ManagedSession, replaceNative = false): OCMessageWithParts[] {
    const previous = s.messages ?? [];
    // Keep the live list during the re-parse: with a pending shell turn the parse binds entries to visible
    // messages, and an empty list would give every unbound live reply a second, restored `_r` copy.
    const native = this.ensureMessages(s, true);
    if (replaceNative) {
      // Legacy compaction IDs can collide; retain every parsed native row.
      let index = 0;
      for (const message of previous) {
        let next = index;
        while (next < native.length && native[next]?.info.id !== message.info.id) next++;
        if (next < native.length) index = next + 1;
        else if (s.tree.messageEntries[message.info.id] === undefined) native.splice(index++, 0, message);
      }
      return native;
    }
    const parsed = new Map(native.map((message) => [message.info.id, message]));
    s.messages = previous.flatMap((message) => {
      const restored = parsed.get(message.info.id);
      parsed.delete(message.info.id);
      if (!restored) return s.tree.messageEntries[message.info.id] === undefined ? [message] : [];
      return [message];
    });
    s.messages.push(...parsed.values());
    return s.messages;
  }

  /** pi paths/ids already represented in memory — shared by both scans. */
  private knownSessionKeys(): { paths: Set<string>; piIds: Set<string> } {
    const paths = new Set<string>();
    const piIds = new Set<string>();
    for (const s of this.sessions.values()) {
      const p = s.piPath ?? s.restored?.piPath;
      if (p !== undefined) paths.add(p);
      if (s.piSessionId !== undefined) piIds.add(s.piSessionId);
      if (s.restored !== undefined) piIds.add(s.restored.piSessionId);
    }
    return { paths, piIds };
  }

  /** Adopt dormant sessions for pi files in `directory` not tracked yet. */
  private ensureScanned(directory: string): void {
    const dirPath = piSessionDir(directory);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(dirPath).mtimeMs;
    } catch {
      return; // no sessions recorded for this directory yet
    }
    const cached = this.scanCache.get(directory);
    if (cached !== undefined && cached.mtimeMs === mtimeMs && Date.now() - cached.at < SESSION_SCAN_CACHE_TTL_MS)
      return;
    this.scanCache.set(directory, { mtimeMs, at: Date.now() });

    const { paths, piIds } = this.knownSessionKeys();
    for (const sc of scanPiSessions(directory)) {
      if (paths.has(sc.piPath) || piIds.has(sc.piSessionId)) continue;
      this.adopt(sc);
    }
  }

  /** Adopt every restorable pi session on disk, regardless of directory. */
  private ensureAllScanned(): void {
    const mtimeMs = piSessionsRootMtime();
    if (mtimeMs === undefined) return; // no sessions recorded yet
    const cached = this.scanAllCache;
    if (cached !== undefined && cached.mtimeMs === mtimeMs && Date.now() - cached.at < SESSION_SCAN_CACHE_TTL_MS)
      return;
    this.scanAllCache = { mtimeMs, at: Date.now() };

    const { paths, piIds } = this.knownSessionKeys();
    for (const sc of scanAllPiSessions()) {
      if (paths.has(sc.piPath) || piIds.has(sc.piSessionId)) continue;
      this.adopt(sc);
    }
  }

  private adopt(sc: ScannedSession): ManagedSession {
    const ocId = this.store.idFor(sc.piSessionId) ?? ocIdFor(sc.piSessionId);
    const reg = this.store.get(ocId);
    const titleSource =
      reg?.titleSource ??
      (reg?.title && reg.title !== "New session" && reg.title !== sc.fallbackTitle ? "user" : "fallback");
    const useRegistry = titleSource === "user" || (sc.titleSource !== "native" && titleSource === "generated");
    const resumed = dormantModel(sc, reg?.model);
    const info: OCSession = {
      id: ocId,
      projectID: sc.directory,
      directory: sc.directory,
      title: useRegistry ? (reg?.title ?? sc.title) : sc.title,
      agent: reg?.agent ?? getAgentName(),
      slug: sc.piSessionId,
      path: "",
      summary: { additions: 0, deletions: 0, files: 0 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(reg?.metadata !== undefined ? { metadata: reg.metadata } : {}),
      ...(reg?.parentID !== undefined ? { parentID: reg.parentID } : {}),
      ...(reg?.parentMessageID !== undefined ? { parentMessageID: reg.parentMessageID } : {}),
      ...(resumed !== undefined
        ? {
            model: { id: resumed.model.modelID, providerID: resumed.model.providerID, variant: resumed.variant },
          }
        : {}),
      ...(reg?.tree?.revert ? { revert: { messageID: reg.tree.revert.messageID } } : {}),
      version: ADAPTER_VERSION,
      time: {
        created: sc.created,
        updated: Math.max(sc.updated, reg?.updated ?? 0),
        ...(reg?.archived ? { archived: reg.archived } : {}),
      },
    };
    const managed: ManagedSession = {
      tree: durableShellTree(reg?.tree ?? { messageEntries: {} }),
      titleSource: useRegistry ? titleSource : (sc.titleSource ?? "fallback"),
      info,
      pi: undefined,
      messages: undefined,
      status: { type: "idle" },
      model: resumed?.model,
      streaming: undefined,
      toolByCallId: new Map(),
      restored: { piSessionId: sc.piSessionId, piPath: sc.piPath },
      hasPendingInteraction: () => false,
      hasRunningChildren: () => false,
      ...(reg?.lastStop !== undefined ? { lastStop: reg.lastStop } : {}),
    };
    this.sessions.set(ocId, managed);
    if (reg?.connectorOwned === true) this.createdSessions.set(sc.piSessionId, sc.directory);
    this.subagents.wire(managed);
    this.monitors.wire(managed);
    this.workStatus.wire(managed);
    this.wireDormant(managed);
    return managed;
  }

  /** The same cleanup as an agent exit, for a process antechamber disposed after unwiring its exit handler. */
  private wireDormant(s: ManagedSession): void {
    s.onDormant = () => {
      this.monitors.stopParent(s.info.id);
      this.workStatus.stopParent(s.info.id);
      this.shells.stopParent(s.info.id);
    };
  }

  /** Resolve a bare session id (e.g. deep link after restart) via known directories. */
  private resolveRestored(sessionId: string): ManagedSession | undefined {
    const reg = this.store.get(sessionId);
    if (reg?.deleted) return undefined;
    if (reg && existsSync(reg.piPath)) {
      return this.adopt({
        piSessionId: reg.piSessionId,
        piPath: reg.piPath,
        directory: reg.directory,
        ...readSessionFileMeta(reg.piPath, reg.piSessionId),
        created: reg.created,
        updated: reg.updated,
      });
    }
    const dirs = new Set<string>([
      ...this.store.directories(),
      ...[...this.sessions.values()].map((s) => s.info.directory),
    ]);
    if (this.defaultDirectory !== undefined) dirs.add(this.defaultDirectory);
    for (const dir of dirs) {
      this.ensureScanned(dir);
      const hit = this.sessions.get(sessionId);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /** Registry write for adapter-owned metadata (title override, pi path). */
  private persistMeta(s: ManagedSession): void {
    for (const message of s.messages ?? []) {
      if (s.localMessageIds?.has(message.info.id)) continue;
      (s.tree.messageParts ??= {})[message.info.id] = message.parts.map((part) => part.id);
    }
    const piPath = s.piPath ?? s.restored?.piPath;
    const piSessionId = s.piSessionId ?? s.restored?.piSessionId;
    if (piPath === undefined || piSessionId === undefined) return;
    // Only a live runtime vouches for the file contents; dormant saves keep the previous marker.
    if (s.pi !== undefined) {
      const size = statSync(piPath, { throwIfNoEntry: false })?.size;
      if (size !== undefined) s.tree.fileSize = size;
    }
    this.store.set(s.info.id, {
      ...(this.createdSessions.has(piSessionId) ? { connectorOwned: true } : {}),
      tree: durableShellTree(s.tree),
      piSessionId,
      piPath,
      directory: s.info.directory,
      // "New session" is a placeholder — let the scan-derived title win.
      ...(s.info.title !== "New session" ? { title: s.info.title } : {}),
      ...(s.titleSource !== undefined ? { titleSource: s.titleSource } : {}),
      ...(s.info.time.archived !== undefined ? { archived: s.info.time.archived } : {}),
      ...(s.info.metadata !== undefined ? { metadata: s.info.metadata } : {}),
      ...(s.info.agent !== undefined ? { agent: s.info.agent } : {}),
      ...(s.info.parentID !== undefined ? { parentID: s.info.parentID } : {}),
      ...(s.info.parentMessageID !== undefined ? { parentMessageID: s.info.parentMessageID } : {}),
      ...(s.model !== undefined ? { model: { providerID: s.model.providerID, modelID: s.model.modelID } } : {}),
      ...(s.lastStop !== undefined ? { lastStop: s.lastStop } : {}),
      created: s.info.time.created,
      updated: s.info.time.updated,
    });
  }

  /** Async event callbacks cannot reject an HTTP operation; report save failures through SSE. */
  private reportPersistenceError(s: ManagedSession, error: unknown): void {
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : String(error);
    this.emit(s.info.directory, {
      type: "session.error",
      properties: { sessionID: s.info.id, error: { name, data: { message } } },
    });
  }

  /** Keep the existing event entry point for RPC wiring and test harnesses. */
  private onPiEvent(s: ManagedSession, ev: Record<string, unknown>): void {
    this.events.onPiEvent(s, ev);
  }
}
