import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { bindMessageEntries, branchEntries, getEntries, recordTurn } from "../src/session-tree.js";
import { SessionManager, type ManagedSession } from "../src/sessions.js";
import { SessionStore } from "../src/session-store.js";
import { AdapterServer } from "../src/server.js";
import {
  announceSessionNotice,
  completeShellMessage,
  createShellMessage,
  failShellMessage,
  runShellCommand,
  shellUserMessage,
} from "../src/session-commands.js";
import type { PiRpcClient } from "../src/pi-rpc.js";
import { compactionMessages } from "../src/pi-event-translation.js";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "antechamber-t10-"));
  const previous = process.env.ANTECHAMBER_PI_BINARY;
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/fake-omo.mjs");
  const state = join(dir, "state");
  const manager = new SessionManager(() => undefined, new SessionStore(state), dir);
  t.after(async () => {
    await manager.disposeAll();
    if (previous === undefined) delete process.env.ANTECHAMBER_PI_BINARY;
    else process.env.ANTECHAMBER_PI_BINARY = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, state, manager };
}

async function turns(manager: SessionManager, dir: string) {
  const session = await manager.create(dir);
  for (let i = 1; i <= 3; i++) await manager.prompt(session.id, `turn-${i}`, undefined, false, `msg_live_${i}`);
  const s = manager.get(session.id);
  assert.ok(s?.pi);
  return { s, id: session.id, tree: await getEntries(s.pi) };
}

function firstText(content: string | Array<{ type: string; text?: string }> | undefined): string | undefined {
  return typeof content === "string" ? content : content?.[0]?.text;
}

test("repeated forks transfer listeners without retaining previous sessions", { timeout: 30_000 }, async (t) => {
  const { manager, dir } = setup(t);
  const { s } = await turns(manager, dir);
  assert.ok(s.pi);
  const pi = s.pi;
  const events = ["event", "extension_ui_request", "exit"];
  const counts = events.map((event) => pi.listenerCount(event));
  assert.ok(counts[0] !== undefined);
  const observer = () => {};
  pi.onEvent(observer);
  let current = s;
  for (let index = 0; index < 4; index++) {
    const forked = await manager.fork(current.info.id);
    assert.equal(current.pi, undefined);
    const child = manager.get(forked.id);
    assert.ok(child?.pi);
    assert.equal(child.pi, pi);
    assert.deepEqual(
      events.map((event) => pi.listenerCount(event)),
      [counts[0] + 1, counts[1], counts[2]],
    );
    assert.ok(pi.listeners("event").includes(observer), "external observers remain subscribed");
    current = child;
  }
});

async function cancelQueuedShell(t: TestContext, manager: SessionManager, session: ManagedSession, command: string) {
  const pi = session.pi;
  assert.ok(pi);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const original = pi.command.bind(pi);
  let hold = true;
  t.mock.method(pi, "command", async <T>(...args: Parameters<PiRpcClient["command"]>) => {
    const response = await original<T>(...args);
    if (args[0].type === "get_entries" && hold) {
      hold = false;
      held.resolve();
      await release.promise;
    }
    return response;
  });
  const refresh = manager.reloadMessages(session.info.id);
  await held.promise;
  try {
    const pending = runShellCommand({ sessions: manager, session, command, emit: () => {} });
    await manager.abort(session.info.id);
    const cancelled = await pending;
    assert.equal(cancelled.kind, "completed");
    return cancelled.message;
  } finally {
    release.resolve();
    await refresh;
    await manager.reloadMessages(session.info.id);
  }
}

test("shell identity is durable while a persisted native response is held", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.pi);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = s.pi.command.bind(s.pi);
  t.mock.method(s.pi, "command", async <T>(...args: Parameters<PiRpcClient["command"]>) => {
    const response = await original<T>(...args);
    if (args[0].type === "bash") {
      held.resolve();
      await release.promise;
    }
    return response;
  });
  const pending = runShellCommand({ sessions: manager, session: s, command: "echo restarted", emit: () => {} });
  try {
    await held.promise;
    const live = s.messages?.at(-1);
    assert.ok(live?.info.role === "assistant");
    const disk = new SessionStore(state).get(id);
    assert.equal(disk?.tree?.shellDispatch?.[live.info.id], true, "dispatch must be on disk before refresh");
    assert.ok(disk.tree.localShellTurns?.some((turn) => turn.messages[1].info.id === live.info.id));
    const cold = new SessionManager(() => {}, new SessionStore(state), dir);
    t.after(() => cold.disposeAll());
    const restored = cold.messages(id)?.find((message) => message.info.id === live.info.id);
    assert.ok(restored?.parts[0]?.type === "tool" && restored.parts[0].state.status === "completed");
    assert.equal(restored.parts[0].state.output, "restarted\n");
    assert.equal(restored.info.role === "assistant" && restored.info.parentID, live.info.parentID);
    assert.ok(cold.get(id)?.tree.messageEntries[live.info.id]);
  } finally {
    release.resolve();
    await pending;
  }
});

test("a cold restore keeps only the identity admission when no native shell result exists", {
  timeout: 30_000,
}, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.pi);
  execFileSync("mkfifo", [join(dir, "restart-gate")]);
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  s.pi.onEvent((event) => {
    if (event.type === "fake_bash_started") started.resolve();
    if (event.type === "fake_bash_finished") finished.resolve();
  });
  const pending = runShellCommand({
    sessions: manager,
    session: s,
    command: "IFS= read -r gate < restart-gate; echo restarted",
    emit: () => {},
  });
  try {
    await started.promise;
    const live = s.messages?.at(-1);
    assert.ok(live?.info.role === "assistant");
    assert.equal(new SessionStore(state).get(id)?.tree?.shellDispatch?.[live.info.id], true);
    const cold = new SessionManager(() => {}, new SessionStore(state), dir);
    t.after(() => cold.disposeAll());
    const restored = cold.messages(id)?.find((message) => message.info.id === live.info.id);
    assert.equal(restored, undefined);
    const parentID = live.info.parentID;
    assert.equal(
      cold.messages(id)?.some((message) => message.info.id === parentID),
      false,
    );
    assert.equal(cold.get(id)?.tree.messageEntries[live.info.id], undefined);
    assert.ok(
      new SessionStore(state).get(id)?.tree?.localShellTurns?.some((turn) => turn.messages[1].info.id === live.info.id),
    );
  } finally {
    await manager.abort(id);
    await pending;
    await finished.promise;
  }
});

async function crashDispatchedShell(t: TestContext) {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.pi);
  execFileSync("mkfifo", [join(dir, "lost-gate")]);
  const started = Promise.withResolvers<void>();
  s.pi.onEvent((event) => {
    if (event.type === "fake_bash_started") started.resolve();
  });
  const pending = runShellCommand({
    sessions: manager,
    session: s,
    command: "IFS= read -r x < lost-gate; echo unavailable-outcome",
    emit: () => {},
  }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await started.promise;
  const shell = s.messages?.at(-1)?.info;
  assert.ok(shell?.role === "assistant");
  const saved = new SessionStore(state).get(id);
  assert.ok(saved);
  const snapshot = new SessionStore(join(dir, "cold-state"));
  snapshot.set(id, saved);
  const rpcPID = s.pi.pid;
  assert.ok(rpcPID);
  const bashPID = Number(execFileSync("pgrep", ["-P", String(rpcPID), "-x", "bash"], { encoding: "utf8" }).trim());
  assert.ok(bashPID > 0);
  const exited = once(s.pi, "exit", { signal: AbortSignal.timeout(10_000) });
  process.kill(-rpcPID, "SIGKILL");
  process.kill(-bashPID, "SIGKILL");
  await exited;
  await pending;
  await manager.disposeAll();
  const cold = new SessionManager(() => {}, snapshot, dir);
  t.after(() => cold.disposeAll());
  return { cold, dir, id, shell, snapshot };
}

test("an unresolved dispatched admission cannot abort the next admitted prompt", { timeout: 30_000 }, async (t) => {
  const { cold, id } = await crashDispatchedShell(t);
  cold.messages(id);
  await cold.reloadMessages(id);
  const session = cold.get(id);
  assert.ok(session?.pi);
  const pi = session.pi;
  const original = pi.command.bind(pi);
  t.mock.method(pi, "command", async <T>(...args: Parameters<PiRpcClient["command"]>) => {
    if (args[0].type === "switch_session") await original({ type: "abort" });
    return original<T>(...args);
  });
  await cold.prompt(id, "pending-turn", undefined, false, "msg_followup");
  assert.equal(session.status.type, "busy", "a read/sync must not abort an admitted native turn");
  const finished = Promise.withResolvers<void>();
  pi.onEvent((event) => {
    if (event.type === "agent_idle") finished.resolve();
  });
  await pi.command({ type: "finish_pending_turn" });
  await finished.promise;
  const reply = cold
    .messages(id)
    ?.find((message) => message.info.role === "assistant" && message.info.parentID === "msg_followup");
  assert.ok(reply?.parts.some((part) => part.type === "text" && part.text === "completed followup"));
  assert.equal(session.status.type, "idle");
});

test("an unresolved dispatched admission does not duplicate replies read mid-turn", { timeout: 30_000 }, async (t) => {
  const { cold, id } = await crashDispatchedShell(t);
  cold.messages(id);
  await cold.reloadMessages(id);
  const session = cold.get(id);
  assert.ok(session?.pi);
  const pi = session.pi;
  await cold.prompt(id, "pending-turn", undefined, false, "msg_followup");
  const finished = Promise.withResolvers<void>();
  // OpenChamber re-reads the list while a reply streams; the reply's entry is on disk before agent_end binds it.
  pi.onEvent((event) => {
    if (event.type === "message_end") cold.messages(id);
    if (event.type === "agent_idle") finished.resolve();
  });
  await pi.command({ type: "finish_pending_turn" });
  await finished.promise;
  const messages = cold.messages(id) ?? [];
  const replies = messages.filter((message) =>
    message.parts.some((part) => part.type === "text" && part.text === "completed followup"),
  );
  assert.equal(replies.length, 1, "the reply must not also appear under a restored id");
  assert.doesNotMatch(replies[0]?.info.id ?? "", /_r\d+$/, "the live reply keeps its live id");
  assert.deepEqual(
    messages.slice(-2).map((message) => message.info.id),
    ["msg_followup", replies[0]?.info.id],
  );
});

test("an abandoned dispatched admission never returns after replacement refresh or restart", {
  timeout: 30_000,
}, async (t) => {
  const { cold, dir, id, shell, snapshot } = await crashDispatchedShell(t);
  cold.messages(id);
  await cold.revert(id, "msg_live_2");
  await cold.prompt(id, "replacement", undefined, false, "msg_replacement");
  assert.equal(
    cold.messages(id)?.some((message) => message.info.id === shell.id || message.info.id === shell.parentID),
    false,
  );
  await cold.reloadMessages(id);
  assert.equal(
    cold.messages(id)?.some((message) => message.info.id === shell.id || message.info.id === shell.parentID),
    false,
  );
  assert.equal(
    new SessionStore(snapshot.stateDir)
      .get(id)
      ?.tree?.localShellTurns?.some((turn) => turn.messages[1].info.id === shell.id),
    false,
  );
  await cold.disposeAll();
  const restarted = new SessionManager(() => {}, new SessionStore(snapshot.stateDir), dir);
  t.after(() => restarted.disposeAll());
  assert.equal(
    restarted.messages(id)?.some((message) => message.info.id === shell.id || message.info.id === shell.parentID),
    false,
  );
  assert.ok(restarted.messages(id)?.some((message) => message.info.id === "msg_replacement"));
});

test("never dispatched shell attempts stay live but are absent from the registry and restart", async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  const cancelled = await cancelQueuedShell(t, manager, s, "echo ephemeral");
  assert.ok(manager.messages(id)?.some((message) => message.info.id === cancelled.info.id));
  assert.equal(manager.messages(id)?.length, 8);
  const disk = new SessionStore(state).get(id);
  assert.ok(disk?.tree);
  assert.equal(disk.tree.shellDispatch?.[cancelled.info.id], undefined);
  assert.equal(
    disk.tree.localShellTurns?.some((turn) =>
      turn.messages.some(
        (message) => message.info.id === cancelled.info.id || message.info.id === cancelled.info.parentID,
      ),
    ) ?? false,
    false,
  );
  await manager.disposeAll();
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  const history = cold.messages(id);
  assert.equal(history?.[0]?.info.id, "msg_live_1");
  assert.equal(history?.length, 6);
  assert.equal(
    history?.some((message) => message.info.id === cancelled.info.id || message.info.id === cancelled.info.parentID),
    false,
  );
});

test("old registry local attempts are not restored under the ephemeral contract", async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  const cancelled = await cancelQueuedShell(t, manager, s, "echo legacy-local");
  const saved = new SessionStore(state).get(id);
  assert.ok(saved?.tree);
  saved.tree.localShellTurns = [
    { afterEntryId: s.tree.leafId ?? null, messages: [shellUserMessage(cancelled), cancelled] },
  ];
  (saved.tree.shellDispatch ??= {})[cancelled.info.id] = false;
  const legacy = new SessionStore(join(dir, "legacy-state"));
  legacy.set(id, saved);
  const cold = new SessionManager(() => {}, legacy, dir);
  t.after(() => cold.disposeAll());
  assert.equal(cold.messages(id)?.length, 6);
  assert.equal(
    cold.messages(id)?.some((message) => message.info.id === cancelled.info.id),
    false,
  );
});

test("shutdown marks an active shell interrupted rather than rejected", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.pi);
  execFileSync("mkfifo", [join(dir, "shutdown-gate")]);
  const started = Promise.withResolvers<void>();
  s.pi.onEvent((event) => {
    if (event.type === "fake_bash_started") started.resolve();
  });
  const pending = runShellCommand({
    sessions: manager,
    session: s,
    command: "IFS= read -r gate < shutdown-gate; echo done",
    emit: () => {},
  }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await started.promise;
  const shellID = s.messages?.at(-1)?.info.id;
  await manager.disposeAll();
  const outcome = await pending;
  assert.ok("result" in outcome && outcome.result.kind === "completed");
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  const restored = cold.messages(id)?.find((message) => message.info.id === shellID);
  const saved = new SessionStore(state).get(id);
  assert.ok(saved);
  const native = readFileSync(saved.piPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((entry) => entry.message?.role === "bashExecution");
  if (native) {
    assert.ok(restored?.parts[0]?.type === "tool" && restored.parts[0].state.status === "error");
    assert.equal(restored.parts[0].state.metadata?.cancelled, true);
  } else assert.equal(restored, undefined);
});

test("a replacement prompt cannot resurrect ephemeral shell attempts through reload and restart", async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  const cancelled = await cancelQueuedShell(t, manager, s, "echo discarded");
  await manager.revert(id, "msg_live_2");
  assert.ok(
    manager.messages(id)?.some((message) => message.info.id === cancelled.info.id),
    "revert alone retains the live cache",
  );
  await manager.prompt(id, "replacement", undefined, false, "msg_replacement");
  const retained = () => manager.messages(id)?.some((message) => message.info.id === cancelled.info.id);
  assert.equal(retained(), false);
  await manager.reloadMessages(id);
  assert.equal(retained(), false, "reload must not resurrect the abandoned pair");
  assert.equal(new SessionStore(state).get(id)?.tree?.localShellTurns?.length ?? 0, 0);
  assert.equal(new SessionStore(state).get(id)?.tree?.shellDispatch?.[cancelled.info.id], undefined);
  await manager.disposeAll();
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  assert.equal(
    cold.messages(id)?.some((message) => message.info.id === cancelled.info.id),
    false,
  );
  assert.equal(cold.messages(id)?.[0]?.info.id, "msg_live_1");
});

test("forks never copy ephemeral shell attempts even before a normal user boundary", async (t) => {
  const { manager, dir, state } = setup(t);
  const info = await manager.create(dir);
  const s = manager.get(info.id);
  assert.ok(s);
  await manager.prompt(info.id, "one", undefined, false, "msg_one");
  const first = await cancelQueuedShell(t, manager, s, "echo local-one");
  await manager.prompt(info.id, "two", undefined, false, "msg_two");
  await cancelQueuedShell(t, manager, s, "echo local-two");
  assert.ok(manager.messages(info.id)?.some((message) => message.info.id === first.info.id));
  const children = [];
  for (const boundary of ["msg_two", undefined]) {
    const child = await manager.fork(info.id, boundary);
    children.push(child.id);
    assert.equal(
      manager
        .messages(child.id)
        ?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash")).length,
      0,
    );
  }
  await manager.disposeAll();
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  for (const childID of children)
    assert.equal(
      cold
        .messages(childID)
        ?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash")).length,
      0,
    );
  assert.equal(
    cold
      .messages(info.id)
      ?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash")).length,
    0,
  );
});

for (const boundary of ["complete", "assistant", "user"] as const) {
  test(`a dispatched cancellation forks once at its ${boundary} boundary through restart`, {
    timeout: 30_000,
  }, async (t) => {
    const { manager, dir, state } = setup(t);
    const info = await manager.create(dir);
    await manager.prompt(info.id, "before", undefined, false, "msg_before");
    const session = manager.get(info.id);
    assert.ok(session?.pi);
    execFileSync("mkfifo", [join(dir, "boundary-gate")]);
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    session.pi.onEvent((event) => {
      if (event.type === "fake_bash_started") started.resolve();
      if (event.type === "fake_bash_finished") finished.resolve();
    });
    const command = "IFS= read -r x < boundary-gate; echo done";
    const pending = runShellCommand({ sessions: manager, session, command, emit: () => {} });
    await started.promise;
    await manager.abort(info.id);
    const result = await pending;
    await finished.promise;
    assert.equal(result.kind, "completed");
    const child = await manager.fork(
      info.id,
      boundary === "complete"
        ? undefined
        : boundary === "assistant"
          ? result.message.info.id
          : result.message.info.parentID,
    );
    const expected = boundary === "user" ? 0 : 1;
    const count = (owner: SessionManager) =>
      owner
        .messages(child.id)
        ?.filter((message) =>
          message.parts.some(
            (part) => part.type === "tool" && part.tool === "bash" && part.state.input.command === command,
          ),
        ).length;
    const pi = manager.get(child.id)?.pi;
    assert.ok(pi);
    assert.equal(
      branchEntries(await getEntries(pi)).filter((entry) => entry.message?.role === "bashExecution").length,
      expected,
    );
    assert.equal(count(manager), expected);
    await manager.disposeAll();
    const cold = new SessionManager(() => {}, new SessionStore(state), dir);
    t.after(() => cold.disposeAll());
    assert.equal(count(cold), expected);
  });
}

test("a fork at a native shell excludes local attempts after that boundary", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const info = await manager.create(dir);
  await manager.prompt(info.id, "before", undefined, false, "msg_before");
  const session = manager.get(info.id);
  assert.ok(session);
  const executed = await runShellCommand({ sessions: manager, session, command: "echo included", emit: () => {} });
  assert.equal(executed.kind, "completed");
  await manager.reloadMessages(info.id);
  const queued = await cancelQueuedShell(t, manager, session, "echo excluded-local");
  const child = await manager.fork(info.id, executed.message.info.id);
  const commands = (owner: SessionManager) =>
    owner
      .messages(child.id)
      ?.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool" && part.tool === "bash" ? [part.state.input.command] : [],
        ),
      );
  assert.deepEqual(commands(manager), ["echo included"]);
  await manager.disposeAll();
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  assert.deepEqual(commands(cold), ["echo included"]);
  assert.equal(
    cold.messages(info.id)?.some((message) => message.info.id === queued.info.id),
    false,
  );
});

test("an older cached ancestor cannot carry a later queued attempt across either shell fork cutoff", {
  timeout: 30_000,
}, async (t) => {
  const { manager, dir, state } = setup(t);
  const info = await manager.create(dir);
  await manager.prompt(info.id, "before", undefined, false, "msg_before");
  const session = manager.get(info.id);
  assert.ok(session?.pi);
  const ancestor = session.tree.leafId;
  execFileSync("mkfifo", [join(dir, "gate"), join(dir, "exit-gate")]);
  const ready = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const watcher = watch(dir, (_event, name) => {
    if (name === "ready") ready.resolve();
  });
  t.after(() => watcher.close());
  session.pi.onEvent((event) => {
    if (event.type === "fake_bash_finished") finished.resolve();
  });
  const command = 'trap "IFS= read -r x < exit-gate; exit 0" TERM; : > ready; IFS= read -r x < gate; echo earlier';
  const pending = runShellCommand({ sessions: manager, session, command, emit: () => {} });
  await ready.promise;
  await manager.abort(info.id);
  const earlier = await pending;
  assert.equal(earlier.kind, "completed");
  assert.equal(session.tree.leafId, ancestor);
  execFileSync("/bin/sh", ["-c", "printf 'release\\n' > exit-gate"], { cwd: dir });
  await finished.promise;
  assert.equal(session.tree.leafId, ancestor, "no preliminary source refresh before admitting the later attempt");
  const queued = await cancelQueuedShell(t, manager, session, "echo later-local");
  const children = [];
  for (const [boundary, expected] of [
    [earlier.message.info.id, [command]],
    [earlier.message.info.parentID, []],
  ] as const) {
    const child = await manager.fork(info.id, boundary);
    children.push({ id: child.id, expected });
    const commands = manager
      .messages(child.id)
      ?.flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool" && part.tool === "bash" ? [part.state.input.command] : [],
        ),
      );
    assert.deepEqual(commands, expected);
  }
  assert.ok(manager.messages(info.id)?.some((message) => message.info.id === queued.info.id));
  await manager.disposeAll();
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  for (const child of children)
    assert.deepEqual(
      cold
        .messages(child.id)
        ?.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.type === "tool" && part.tool === "bash" ? [part.state.input.command] : [],
          ),
        ),
      child.expected,
    );
  assert.equal(
    cold.messages(info.id)?.some((message) => message.info.id === queued.info.id),
    false,
  );
});

for (const snapshot of ["descendant", "ancestor", "sibling", "missing-selection", "revert", "torn-tail"] as const)
  test(`native checkpoint respects the selected branch with a ${snapshot} disk snapshot`, async (t) => {
    const { manager, dir } = setup(t);
    const { s, id, tree } = await turns(manager, dir);
    assert.ok(s.piPath);
    if (snapshot === "revert") await manager.revert(id, "msg_live_3");
    const before = structuredClone(s.tree);
    const raw = readFileSync(s.piPath, "utf8");
    const header = raw.split("\n")[0];
    const appended = {
      type: "compaction",
      id: "checkpoint-compaction",
      parentId: snapshot === "sibling" ? tree.entries[1]?.id : tree.leafId,
      summary: "checkpoint",
    };
    if (snapshot === "ancestor")
      writeFileSync(
        s.piPath,
        `${[header, ...tree.entries.slice(0, -1).map((entry) => JSON.stringify(entry))].join("\n")}\n`,
      );
    else if (snapshot === "missing-selection") writeFileSync(s.piPath, `${header}\n`);
    else writeFileSync(s.piPath, `${raw}${JSON.stringify(appended)}\n${snapshot === "torn-tail" ? '{"type":' : ""}`);

    recordTurn(s);

    if (snapshot === "descendant" || snapshot === "torn-tail") assert.equal(s.tree.leafId, appended.id);
    else assert.deepEqual(s.tree, before);
  });

for (const failure of ["missing", "corrupt"] as const)
  test(`native checkpoint rejects a ${failure} session file without changing selection`, async (t) => {
    const { manager, dir } = setup(t);
    const { s } = await turns(manager, dir);
    assert.ok(s.piPath);
    const before = structuredClone(s.tree);
    if (failure === "missing") rmSync(s.piPath);
    else writeFileSync(s.piPath, `${readFileSync(s.piPath, "utf8")}not-json\n{}\n`);

    assert.throws(() => recordTurn(s), failure === "missing" ? { code: "ENOENT" } : /Malformed session line/);

    assert.deepEqual(s.tree, before);
  });

test("revival preserves an unreverted native branch instead of adopting its latest sibling", {
  timeout: 30_000,
}, async (t) => {
  const { manager, dir, state } = setup(t);
  const { id } = await turns(manager, dir);
  await manager.revert(id, "msg_live_3");
  const session = manager.get(id);
  assert.ok(session);
  const shell = await runShellCommand({ sessions: manager, session, command: "echo sibling", emit: () => {} });
  assert.equal(shell.kind, "completed");
  await manager.unrevert(id);
  const selected = session.tree.leafId;
  assert.ok(manager.messages(id)?.some((message) => message.info.id === "msg_live_3"));
  await manager.disposeAll();
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  assert.ok(cold.messages(id)?.some((message) => message.info.id === "msg_live_3"));
  await cold.reloadMessages(id);
  const revived = cold.get(id);
  assert.ok(revived?.pi);
  assert.equal(revived.tree.leafId, selected);
  assert.equal((await getEntries(revived.pi)).leafId, selected);
  assert.ok(cold.messages(id)?.some((message) => message.info.id === "msg_live_3"));
  await cold.revert(id, "msg_live_2");
  const pin = revived.tree.leafId;
  await cold.disposeAll();
  const pinned = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => pinned.disposeAll());
  await pinned.reloadMessages(id);
  const restoredPin = pinned.get(id);
  assert.ok(restoredPin?.pi);
  assert.equal(restoredPin.tree.leafId, pin);
  assert.equal((await getEntries(restoredPin.pi)).leafId, pin);
  assert.equal(restoredPin.tree.revert?.messageID, "msg_live_2");
});

/** Simulate the terminal client resuming the file at its tail and completing one turn. */
function appendExternalTurn(piPath: string, text: string): void {
  const entries = readFileSync(piPath, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const user = structuredClone(entries.findLast((entry) => entry.message?.role === "user"));
  const assistant = structuredClone(entries.findLast((entry) => entry.message?.role === "assistant"));
  assert.ok(user && assistant);
  Object.assign(user, { id: "external-user", parentId: entries.at(-1).id });
  user.message.content = [{ type: "text", text }];
  delete user.message.clientMessageId;
  Object.assign(assistant, { id: "external-assistant", parentId: "external-user" });
  assistant.message.content = [{ type: "text", text: `${text} reply` }];
  writeFileSync(
    piPath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`,
  );
}

function texts(manager: SessionManager, id: string): string[] {
  return (manager.messages(id) ?? []).flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );
}

for (const cached of [false, true])
  test(`empty dormant history follows terminal turns with cached history ${cached}`, async (t) => {
    const { manager, dir, state } = setup(t);
    const session = await manager.create(dir);
    await manager.reloadMessages(session.id);
    const empty = manager.get(session.id);
    assert.ok(empty?.piPath);
    assert.equal(empty.tree.leafId, null);
    await manager.disposeAll();

    const cold = new SessionManager(() => {}, new SessionStore(state), dir);
    t.after(() => cold.disposeAll());
    if (cached) assert.deepEqual(cold.messages(session.id), []);
    const entries = [
      {
        type: "message",
        id: "external-user",
        parentId: null,
        timestamp: "2026-10-26T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "from-terminal" }] },
      },
      {
        type: "message",
        id: "external-assistant",
        parentId: "external-user",
        timestamp: "2026-10-26T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "from-terminal reply" }] },
      },
    ];
    writeFileSync(
      empty.piPath,
      `${readFileSync(empty.piPath, "utf8")}${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    assert.deepEqual(texts(cold, session.id), ["from-terminal", "from-terminal reply"]);
    assert.equal(cold.get(session.id)?.pi, undefined);
  });

for (const legacy of [false, true])
  test(`empty dormant forks keep abandoned history hidden with legacy size marker ${legacy}`, async (t) => {
    const { manager, dir, state } = setup(t);
    const { id } = await turns(manager, dir);
    const child = await manager.fork(id, "msg_live_1");
    await manager.disposeAll();
    if (legacy) {
      const store = new SessionStore(state);
      const entry = store.get(child.id);
      assert.ok(entry?.tree);
      delete entry.tree.fileSize;
      store.set(child.id, entry);
    }

    const cold = new SessionManager(() => {}, new SessionStore(state), dir);
    t.after(() => cold.disposeAll());

    assert.deepEqual(cold.messages(child.id), []);
    assert.equal(cold.get(child.id)?.tree.leafId, null);
  });

test("empty saved selections ignore metadata-only terminal appends", async (t) => {
  const { manager, dir, state } = setup(t);
  const { id, s } = await turns(manager, dir);
  assert.ok(s.piPath);
  await manager.disposeAll();
  const store = new SessionStore(state);
  const entry = store.get(id);
  assert.ok(entry?.tree?.fileSize);
  store.set(id, { ...entry, tree: { messageEntries: {}, leafId: null, fileSize: entry.tree.fileSize } });
  const raw = readFileSync(s.piPath, "utf8");
  const lastLine = raw.trimEnd().split("\n").at(-1);
  assert.ok(lastLine);
  const last = JSON.parse(lastLine);
  writeFileSync(
    s.piPath,
    `${raw}${JSON.stringify({ type: "custom", id: "external-metadata", parentId: last.id, customType: "startup" })}\n`,
  );
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());

  assert.deepEqual(cold.messages(id), []);
});

test("dormant history and revival follow turns another client appended to the session file", {
  timeout: 30_000,
}, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.piPath);
  await manager.disposeAll();
  appendExternalTurn(s.piPath, "from-terminal");

  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  assert.ok(texts(cold, id).includes("from-terminal reply"));
  await cold.reloadMessages(id);
  const revived = cold.get(id);
  assert.ok(revived?.pi);
  assert.equal(revived.tree.leafId, "external-assistant");
  assert.equal((await getEntries(revived.pi)).leafId, "external-assistant");
  assert.ok(texts(cold, id).includes("from-terminal reply"));
});

test("dormant history follows external turns appended after the first history read", {
  timeout: 30_000,
}, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.piPath);
  await manager.disposeAll();

  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  assert.ok(cold.messages(id)?.some((message) => message.info.id === "msg_live_3"));
  const session = cold.get(id);
  assert.ok(session);
  announceSessionNotice({ sessions: cold, session, emit: () => {} }, "adapter notice");
  const noticeID = cold.messages(id)?.at(-1)?.info.id;
  assert.ok(noticeID);
  appendExternalTurn(s.piPath, "from-terminal");

  assert.ok(texts(cold, id).includes("from-terminal reply"));
  const refreshed = cold.messages(id);
  assert.ok(refreshed?.some((message) => message.info.id === noticeID));
  assert.equal(cold.messages(id), refreshed);
  assert.equal(cold.get(id)?.pi, undefined);
});

test("dormant history refreshes a cached tool when its native result arrives", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.piPath);
  await manager.disposeAll();
  const raw = readFileSync(s.piPath, "utf8");
  const lastLine = raw.trimEnd().split("\n").at(-1);
  assert.ok(lastLine);
  const last = JSON.parse(lastLine);
  const call = {
    type: "message",
    id: "external-call",
    parentId: last.id,
    timestamp: "2026-10-19T00:00:00.000Z",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "external-tool", name: "bash", arguments: { command: "echo done" } }],
    },
  };
  writeFileSync(s.piPath, `${raw}${JSON.stringify(call)}\n`);
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  const tool = () =>
    cold
      .messages(id)
      ?.flatMap((message) => message.parts)
      .find((part) => part.type === "tool");
  const pending = tool();
  assert.ok(pending?.type === "tool");
  assert.equal(pending.state.status, "running");

  const result = {
    type: "message",
    id: "external-result",
    parentId: call.id,
    timestamp: "2026-10-19T00:00:01.000Z",
    message: { role: "toolResult", toolCallId: "external-tool", content: [{ type: "text", text: "done\n" }] },
  };
  writeFileSync(s.piPath, `${readFileSync(s.piPath, "utf8")}${JSON.stringify(result)}\n`);

  const completed = tool();
  assert.ok(completed?.type === "tool" && completed.state.status === "completed");
  assert.equal(completed.state.output, "done\n");
  assert.equal(cold.get(id)?.pi, undefined);
});

test("dormant refresh preserves native rows with legacy compaction ID collisions", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.piPath);
  await manager.disposeAll();
  const raw = readFileSync(s.piPath, "utf8");
  const lastLine = raw.trimEnd().split("\n").at(-1);
  assert.ok(lastLine);
  const compaction = {
    type: "compaction",
    id: "external-compaction",
    parentId: JSON.parse(lastLine).id,
    firstKeptEntryId: JSON.parse(lastLine).id,
    timestamp: "2026-10-19T00:00:00.000Z",
    summary: "compaction-summary",
  };
  const reply = {
    type: "message",
    id: "external-reply",
    parentId: compaction.id,
    timestamp: "2026-10-19T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "native-reply" }] },
  };
  writeFileSync(s.piPath, `${raw}${JSON.stringify(compaction)}\n${JSON.stringify(reply)}\n`);
  const summaryID = `msg_compaction_${compaction.id}_summary`;
  new SessionStore(state).update(id, {
    tree: { ...s.tree, messageEntries: { ...s.tree.messageEntries, [summaryID]: reply.id } },
  });
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  const rows = () => cold.messages(id)?.filter((message) => message.info.id === summaryID);
  const before = rows();
  assert.equal(before?.length, 1);

  appendExternalTurn(s.piPath, "from-terminal");

  assert.deepEqual(rows(), before);
  assert.ok(texts(cold, id).includes("from-terminal reply"));
});

test("dormant cached history keeps a staged revert pinned after external appends", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.piPath);
  await manager.revert(id, "msg_live_3");
  await manager.disposeAll();
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  const before = cold.messages(id)?.map((message) => message.info.id);
  const pin = structuredClone(cold.get(id)?.tree.revert);
  assert.ok(before && pin);

  appendExternalTurn(s.piPath, "from-terminal");

  assert.deepEqual(
    cold.messages(id)?.map((message) => message.info.id),
    before,
  );
  assert.deepEqual(cold.get(id)?.tree.revert, pin);
  assert.equal(cold.get(id)?.pi, undefined);
});

test("native binding skips synthetic compaction messages", { timeout: 30_000 }, async (t) => {
  const { manager, dir } = setup(t);
  const { s } = await turns(manager, dir);
  const reply = s.messages?.at(-1);
  assert.ok(reply?.info.role === "assistant");
  s.messages = [...compactionMessages(s, "unbound", "context", 1, s.model, undefined), reply];
  s.tree.messageEntries = {};
  s.tree.leafId = "native-reply";

  bindMessageEntries(s, {
    entries: [{ type: "message", id: "native-reply", parentId: null, message: { role: "assistant" } }],
    leafId: "native-reply",
  });

  assert.equal(s.tree.messageEntries.msg_compaction_unbound_summary, undefined);
  assert.equal(s.tree.messageEntries[reply.info.id], "native-reply");
});

for (const cached of [false, true]) {
  test(`revival retains colliding native usage with cached history ${cached}`, { timeout: 30_000 }, async (t) => {
    const { manager, dir, state } = setup(t);
    const { s, id } = await turns(manager, dir);
    assert.ok(s.piPath);
    await manager.disposeAll();
    const raw = readFileSync(s.piPath, "utf8");
    const lastLine = raw.trimEnd().split("\n").at(-1);
    assert.ok(lastLine);
    const last = JSON.parse(lastLine);
    const compaction = {
      type: "compaction",
      id: "legacy-compaction",
      parentId: last.id,
      firstKeptEntryId: last.id,
      timestamp: "2026-10-19T00:00:00.000Z",
      summary: "retained-context",
    };
    const reply = {
      type: "message",
      id: "legacy-reply",
      parentId: compaction.id,
      timestamp: "2026-10-19T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "legacy-tool", name: "bash", arguments: { command: "true" } }],
        usage: { input: 31, output: 7, cost: { total: 0.25 } },
      },
    };
    writeFileSync(s.piPath, `${raw}${JSON.stringify(compaction)}\n${JSON.stringify(reply)}\n`);
    const summaryID = `msg_compaction_${compaction.id}_summary`;
    new SessionStore(state).update(id, {
      tree: { ...s.tree, messageEntries: { ...s.tree.messageEntries, [summaryID]: reply.id } },
    });
    const cold = new SessionManager(() => {}, new SessionStore(state), dir);
    t.after(() => cold.disposeAll());
    const previous = cached ? cold.messages(id) : undefined;

    await cold.reloadMessages(id);

    const messages = cold.messages(id);
    assert.ok(messages);
    assert.equal(new Set(messages.map((message) => message.info.id)).size, messages.length);
    assert.equal(messages.filter((message) => message.info.id === summaryID).length, 1);
    const native = messages.find((message) =>
      message.parts.some((part) => part.type === "tool" && part.callID === "legacy-tool"),
    );
    assert.ok(native);
    assert.notEqual(native.info.id, summaryID);
    assert.equal(
      messages.reduce((cost, message) => cost + (message.info.role === "assistant" ? message.info.cost : 0), 0),
      0.25,
    );
    assert.equal(cold.get(id)?.info.cost, 0.25);
    assert.equal(cold.get(id)?.info.tokens?.input, 31);
    assert.equal(cold.get(id)?.tree.messageEntries[summaryID], undefined);
    assert.equal(cold.get(id)?.tree.messageEntries[native.info.id], reply.id);
    if (previous) for (let index = 0; index < previous.length; index++) assert.equal(messages[index], previous[index]);
  });
}

test("a committed revert keeps its abandoned branch hidden after restart", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { id } = await turns(manager, dir);
  await manager.revert(id, "msg_live_3");
  await manager.commitRevert(id);
  const pin = manager.get(id)?.tree.leafId;
  await manager.disposeAll();

  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  assert.equal(
    cold.messages(id)?.some((message) => message.info.id === "msg_live_3"),
    false,
  );
  await cold.reloadMessages(id);
  const revived = cold.get(id);
  assert.ok(revived?.pi);
  assert.equal(revived.tree.leafId, pin);
  assert.equal((await getEntries(revived.pi)).leafId, pin);
});

for (const action of ["read", "refresh", "fork", "notice", "prewarmed-fork", "prewarmed-revert"] as const) {
  test(`an invisible admission binds a later native result on normal ${action}`, { timeout: 30_000 }, async (t) => {
    const { manager, dir, state } = setup(t);
    const info = await manager.create(dir);
    await manager.prompt(info.id, "before", undefined, false, "msg_before");
    const session = manager.get(info.id);
    assert.ok(session?.pi);
    execFileSync("mkfifo", [join(dir, "late-gate")]);
    const started = Promise.withResolvers<void>();
    session.pi.onEvent((event) => {
      if (event.type === "fake_bash_started") started.resolve();
    });
    const pending = runShellCommand({
      sessions: manager,
      session,
      command: "IFS= read -r x < late-gate; echo late-native",
      emit: () => {},
    });
    await started.promise;
    const live = session.messages?.at(-1);
    assert.ok(live?.info.role === "assistant");
    const saved = new SessionStore(state).get(info.id);
    assert.ok(saved);
    const snapshot = new SessionStore(join(dir, "late-state"));
    snapshot.set(info.id, saved);
    const cold = new SessionManager(() => {}, snapshot, dir);
    t.after(() => cold.disposeAll());
    const initial = cold.messages(info.id)?.find((message) => message.info.id === live.info.id);
    assert.equal(initial, undefined);
    const switches: string[] = [];
    if (action.startsWith("prewarmed")) {
      await cold.reloadMessages(info.id);
      const recovered = cold.get(info.id);
      assert.ok(recovered?.pi, "RPC must be revived before the original writer produces its outcome");
      const original = recovered.pi.command.bind(recovered.pi);
      t.mock.method(recovered.pi, "command", async <T>(...args: Parameters<PiRpcClient["command"]>) => {
        if (args[0].type === "switch_session") {
          switches.push(recovered.status.type);
          if (recovered.status.type === "busy") await original({ type: "abort" });
        }
        return original<T>(...args);
      });
    }
    let noticeID: string | undefined;
    if (action === "notice") {
      const recovered = cold.get(info.id);
      assert.ok(recovered);
      announceSessionNotice({ sessions: cold, session: recovered, emit: () => {} }, "Local recovery notice");
      noticeID = cold.messages(info.id)?.at(-1)?.info.id;
      assert.ok(noticeID);
    }
    execFileSync("/bin/sh", ["-c", "printf 'release\\n' > late-gate"], { cwd: dir });
    const completed = await pending;
    assert.equal(completed.kind, "completed");
    if (action.startsWith("prewarmed")) {
      assert.ok(cold.messages(info.id)?.some((message) => message.info.id === live.info.id));
      if (action === "prewarmed-fork") await cold.fork(info.id, live.info.id);
      else {
        await cold.revert(info.id, live.info.parentID);
        await cold.unrevert(info.id);
      }
      await cold.prompt(info.id, "pending-turn", undefined, false, "msg_after_recovery");
      const recovered = cold.get(info.id);
      assert.ok(recovered?.pi);
      assert.equal(recovered.status.type, "busy", "prompt admission must not reopen native after recovery");
      const finished = Promise.withResolvers<void>();
      recovered.pi.onEvent((event) => {
        if (event.type === "agent_idle") finished.resolve();
      });
      await recovered.pi.command({ type: "finish_pending_turn" });
      await finished.promise;
      assert.ok(switches.every((status) => status === "idle"));
      assert.ok(
        cold
          .messages(info.id)
          ?.some((message) => message.info.role === "assistant" && message.info.parentID === "msg_after_recovery"),
      );
    } else if (action === "fork") await cold.fork(info.id, live.info.id);
    else if (action !== "read") await cold.reloadMessages(info.id);
    const restored = cold.messages(info.id)?.find((message) => message.info.id === live.info.id);
    assert.ok(restored?.parts[0]?.type === "tool" && restored.parts[0].state.status === "completed");
    assert.equal(restored.parts[0].state.output, "late-native\n");
    assert.equal(restored.info.role === "assistant" && restored.info.parentID, live.info.parentID);
    assert.equal(
      cold
        .messages(info.id)
        ?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash")).length,
      1,
    );
    if (noticeID) assert.ok(cold.messages(info.id)?.some((message) => message.info.id === noticeID));
    assert.equal(new SessionStore(snapshot.stateDir).get(info.id)?.tree?.localShellTurns?.length, 0);
    await cold.disposeAll();
    const nextCold = new SessionManager(() => {}, new SessionStore(snapshot.stateDir), dir);
    t.after(() => nextCold.disposeAll());
    const next = nextCold.messages(info.id)?.find((message) => message.info.id === live.info.id);
    assert.ok(next?.parts[0]?.type === "tool" && next.parts[0].state.status === "completed");
    assert.equal(next.parts[0].state.output, "late-native\n");
    await nextCold.fork(info.id, live.info.id);
  });
}

async function lateNativeReader(t: TestContext) {
  const { manager, dir, state } = setup(t);
  const { s, id } = await turns(manager, dir);
  assert.ok(s.pi);
  execFileSync("mkfifo", [join(dir, "late-gate")]);
  const started = Promise.withResolvers<void>();
  s.pi.onEvent((event) => {
    if (event.type === "fake_bash_started") started.resolve();
  });
  const pending = runShellCommand({
    sessions: manager,
    session: s,
    command: "IFS= read -r x < late-gate; echo late-native",
    emit: () => {},
  });
  await started.promise;
  const saved = new SessionStore(state).get(id);
  assert.ok(saved?.tree?.localShellTurns?.[0]);
  const live = saved.tree.localShellTurns[0].messages[1].info;
  const snapshot = new SessionStore(join(dir, "reader-state"));
  snapshot.set(id, saved);
  const reader = new SessionManager(() => {}, snapshot, dir);
  t.after(() => reader.disposeAll());
  reader.messages(id);
  await reader.reloadMessages(id);
  const recovered = reader.get(id);
  assert.ok(recovered?.pi);
  execFileSync("/bin/sh", ["-c", "printf release > late-gate"], { cwd: dir });
  assert.equal((await pending).kind, "completed");
  return { manager, dir, s, id, live, reader, recovered, snapshot };
}

for (const action of ["older-fork", "older-revert", "direct-late-fork"] as const) {
  test(`idle ${action} compares the complete disk tree before preserving the selected shell`, {
    timeout: 30_000,
  }, async (t) => {
    const { id, live, reader, recovered, snapshot, dir } = await lateNativeReader(t);
    assert.ok(recovered.pi);
    if (action !== "direct-late-fork") {
      assert.ok(reader.messages(id)?.some((message) => message.info.id === live.id));
      assert.equal(
        (await getEntries(recovered.pi)).entries.some((entry) => entry.id === recovered.tree.leafId),
        false,
      );
    }
    if (action === "older-revert") {
      const selected = recovered.tree.leafId;
      await reader.revert(id, "msg_live_3");
      assert.equal(recovered.tree.revert?.previousLeafId, selected);
      await reader.unrevert(id);
    } else await reader.fork(id, action === "older-fork" ? "msg_live_2" : live.id);
    await reader.disposeAll();
    const cold = new SessionManager(() => {}, new SessionStore(snapshot.stateDir), dir);
    t.after(() => cold.disposeAll());
    assert.ok(cold.messages(id)?.some((message) => message.info.id === live.id));
    assert.equal(cold.get(id)?.tree.messageEntries[live.id], cold.get(id)?.tree.leafId);
  });
}

test("plain binding and refresh cannot move a selected leaf back to its ancestor", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id, tree: ancestor } = await turns(manager, dir);
  const shell = await runShellCommand({ sessions: manager, session: s, command: "echo selected", emit: () => {} });
  assert.equal(shell.kind, "completed");
  const selected = s.tree.leafId;
  bindMessageEntries(s, ancestor);
  assert.equal(s.tree.leafId, selected);
  assert.ok(s.pi);
  const original = s.pi.command.bind(s.pi);
  t.mock.method(s.pi, "command", async (...args: Parameters<PiRpcClient["command"]>) =>
    args[0].type === "get_entries"
      ? { type: "response", command: "get_entries", success: true, data: ancestor }
      : original(...args),
  );
  await manager.reloadMessages(id);
  assert.equal(s.tree.leafId, selected);
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  assert.ok(cold.messages(id)?.some((message) => message.info.id === shell.message.info.id));
});

for (const outcome of ["cancel", "fail"] as const) {
  test(`a reopened RPC is discarded when saved navigation reports ${outcome}`, { timeout: 30_000 }, async (t) => {
    const { manager, s, id, live, reader, recovered } = await lateNativeReader(t);
    assert.ok(reader.messages(id)?.some((message) => message.info.id === live.id));
    const selected = recovered.tree.leafId;
    await manager.revert(id, "msg_live_3");
    assert.equal(
      (await runShellCommand({ sessions: manager, session: s, command: "echo sibling", emit: () => {} })).kind,
      "completed",
    );
    const pi = recovered.pi;
    assert.ok(pi);
    const original = pi.command.bind(pi);
    let switched = false;
    t.mock.method(pi, "command", async (...args: Parameters<PiRpcClient["command"]>) => {
      if (args[0].type === "navigate_tree" && switched) {
        return outcome === "cancel"
          ? {
              type: "response",
              command: "navigate_tree",
              success: true,
              data: { cancelled: true, leafId: (await getEntries(pi)).leafId },
            }
          : { type: "response", command: "navigate_tree", success: false, error: "Injected navigation refusal" };
      }
      const response = await original(...args);
      if (args[0].type === "switch_session") switched = true;
      return response;
    });
    await assert.rejects(reader.fork(id, live.id), outcome === "cancel" ? /cancelled/ : /Injected navigation refusal/);
    assert.ok(switched);
    assert.equal(recovered.pi, undefined);
    assert.ok(recovered.restored);
    assert.equal(recovered.tree.leafId, selected);
    await reader.prompt(id, "after restoration", undefined, false, "msg_after_refusal");
    assert.ok(recovered.pi);
    const tree = await getEntries(recovered.pi);
    assert.equal(
      tree.entries.find((entry) => entry.id === recovered.tree.messageEntries.msg_after_refusal)?.parentId,
      selected,
    );
    assert.equal(recovered.status.type, "idle");
    assert.ok(
      reader
        .messages(id)
        ?.some((message) => message.info.role === "assistant" && message.info.parentID === "msg_after_refusal"),
    );
  });
}

test("fork accepts extension entries OmO appends on the restored leaf after a native refresh", {
  timeout: 30_000,
}, async (t) => {
  const { id, live, reader, recovered } = await lateNativeReader(t);
  const pi = recovered.pi;
  assert.ok(pi);
  const original = pi.command.bind(pi);
  let switched = false;
  let appended = 0;
  t.mock.method(pi, "command", async (...args: Parameters<PiRpcClient["command"]>) => {
    const response = await original(...args);
    if (args[0].type === "switch_session") switched = true;
    // Late session_start hooks land after the navigation reply (seen in a real 47 MB session JSONL).
    if (args[0].type === "navigate_tree" && switched) {
      for (const customType of ["pi-rules.scan", "senpi-memory.session-binding"]) {
        await original({ type: "append_custom", customType });
        appended++;
      }
    }
    return response;
  });
  const child = await reader.fork(id, live.id);
  assert.ok(switched);
  assert.equal(appended, 2);
  assert.notEqual(child.id, id);
  assert.ok(reader.get(child.id)?.pi);
});

test("unrevert refreshes entries appended after its saved navigation pin", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { id } = await turns(manager, dir);
  await manager.disposeAll();
  const reader = new SessionManager(() => {}, new SessionStore(state), dir);
  const writer = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => reader.disposeAll());
  t.after(() => writer.disposeAll());
  await reader.revert(id, "msg_live_3");
  await writer.reloadMessages(id);
  const source = writer.get(id);
  assert.ok(source?.pi);
  assert.equal(
    (await runShellCommand({ sessions: writer, session: source, command: "echo external", emit: () => {} })).kind,
    "completed",
  );
  const appended = (await getEntries(source.pi)).entries.find(
    (entry) => entry.message?.role === "bashExecution" && entry.message.command === "echo external",
  )?.id;
  assert.ok(appended);
  const recovered = reader.get(id);
  assert.ok(recovered?.pi);
  assert.equal(
    (await getEntries(recovered.pi)).entries.some((entry) => entry.id === appended),
    false,
  );
  await reader.unrevert(id);
  assert.ok((await getEntries(recovered.pi)).entries.some((entry) => entry.id === appended));
  assert.equal(recovered.info.revert, undefined);
});

test("missing saved leaf revival fails dormant before admitting an unwired prompt", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const { id } = await turns(manager, dir);
  await manager.disposeAll();
  const store = new SessionStore(state);
  const saved = store.get(id);
  assert.ok(saved?.tree);
  saved.tree.leafId = "entry-no-longer-present";
  store.set(id, saved);
  const cold = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => cold.disposeAll());
  await assert.rejects(cold.reloadMessages(id), /entry-no-longer-present/);
  const recovered = cold.get(id);
  assert.ok(recovered);
  assert.equal(recovered.pi, undefined);
  assert.ok(recovered.restored);
  await assert.rejects(
    cold.prompt(id, "must not dispatch", undefined, false, "msg_after_bad_revival"),
    /entry-no-longer-present/,
  );
  assert.equal(recovered.pi, undefined);
  assert.equal(recovered.status.type, "idle");
  assert.equal(
    cold.messages(id)?.some((message) => message.info.id === "msg_after_bad_revival"),
    false,
  );
});

test("a never-dispatched cancelled shell cannot claim an identical successful run", { timeout: 30_000 }, async (t) => {
  const { manager, dir, state } = setup(t);
  const info = await manager.create(dir);
  await manager.prompt(info.id, "before", undefined, false, "msg_before");
  const session = manager.get(info.id);
  assert.ok(session?.pi);
  const cancelled = await cancelQueuedShell(t, manager, session, "echo repeated");
  const completed = await runShellCommand({ sessions: manager, session, command: "echo repeated", emit: () => {} });
  assert.equal(completed.kind, "completed");
  const entries = (await getEntries(session.pi)).entries.filter((entry) => entry.message?.role === "bashExecution");
  assert.equal(entries.length, 1);
  assert.equal(
    session.tree.messageEntries[cancelled.info.id],
    undefined,
    "the never-dispatched cancellation must remain unbound",
  );
  assert.equal(session.tree.messageEntries[cancelled.info.parentID], undefined);
  assert.equal(session.tree.messageEntries[completed.message.info.id], entries[0]?.id);
  assert.equal(session.tree.messageEntries[completed.message.info.parentID], entries[0]?.id);
  await manager.reloadMessages(info.id);
  const cards = manager
    .messages(info.id)
    ?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash"));
  assert.deepEqual(
    cards?.map((message) => message.info.id),
    [cancelled.info.id, completed.message.info.id],
  );
  assert.equal(cards?.[0]?.parts[0]?.type === "tool" && cards[0].parts[0].state.status, "error");
  assert.equal(cards?.[1]?.parts[0]?.type === "tool" && cards[1].parts[0].state.status, "completed");
  await manager.fork(info.id, completed.message.info.id);
  await manager.disposeAll();
  const restored = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => restored.disposeAll());
  const restarted = restored
    .messages(info.id)
    ?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash"));
  assert.deepEqual(
    restarted?.map((message) => message.info.id),
    [completed.message.info.id],
  );
  assert.equal(restarted?.[0]?.parts[0]?.type === "tool" && restarted[0].parts[0].state.status, "completed");
  await restored.revert(info.id, completed.message.info.parentID);
  await restored.unrevert(info.id);
  await restored.fork(info.id, completed.message.info.id);
});

test("identical shell commands retain mixed cancellation outcomes and distinct tree boundaries", {
  timeout: 30_000,
}, async (t) => {
  const { manager, dir, state } = setup(t);
  const info = await manager.create(dir);
  await manager.prompt(info.id, "before", undefined, false, "msg_before");
  const session = manager.get(info.id);
  assert.ok(session?.pi);
  const command = "if [ ! -f allow-shell ]; then IFS= read -r gate < shell-gate; fi; echo repeated";
  execFileSync("mkfifo", [join(dir, "shell-gate")]);
  const queued = await cancelQueuedShell(t, manager, session, command);
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const onEvent = (event: Record<string, unknown>) => {
    if (event.type === "fake_bash_started") started.resolve();
    if (event.type === "fake_bash_finished") finished.resolve();
  };
  session.pi.onEvent(onEvent);
  const pending = runShellCommand({ sessions: manager, session, command, emit: () => {} });
  await started.promise;
  await manager.abort(info.id);
  const cancelled = await pending;
  assert.equal(cancelled.kind, "completed");
  await finished.promise;
  session.pi.off("event", onEvent);
  await manager.reloadMessages(info.id);
  writeFileSync(join(dir, "allow-shell"), "");
  const successful = [];
  for (let i = 0; i < 2; i++) {
    const result = await runShellCommand({ sessions: manager, session, command, emit: () => {} });
    assert.equal(result.kind, "completed");
    successful.push(result.message);
  }
  const dispatched = [cancelled.message, ...successful];
  const identities = [queued, ...dispatched].map((message) => message.info.id);
  const tree = await getEntries(session.pi);
  const native = tree.entries.filter((entry) => entry.message?.role === "bashExecution");
  assert.equal(native.length, 3);
  assert.equal(session.tree.messageEntries[queued.info.id], undefined);
  for (const [index, message] of dispatched.entries()) {
    assert.equal(session.tree.messageEntries[message.info.id], native[index]?.id);
    assert.equal(session.tree.messageEntries[message.info.parentID], native[index]?.id);
  }
  await manager.reloadMessages(info.id);
  const cards = manager
    .messages(info.id)
    ?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash"));
  assert.deepEqual(
    cards?.map((message) => message.info.id),
    identities,
  );
  assert.deepEqual(
    cards?.map((message) => message.parts[0]?.type === "tool" && message.parts[0].state.status),
    ["error", "error", "completed", "completed"],
  );
  for (const message of dispatched) {
    await manager.revert(info.id, message.info.parentID);
    assert.equal(
      session.tree.leafId,
      native.find((entry) => entry.id === session.tree.messageEntries[message.info.id])?.parentId,
    );
    await manager.unrevert(info.id);
    await manager.fork(info.id, message.info.id);
  }
  await manager.disposeAll();
  const restored = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => restored.disposeAll());
  const restarted = restored
    .messages(info.id)
    ?.filter((message) => message.parts.some((part) => part.type === "tool" && part.tool === "bash"));
  assert.deepEqual(
    restarted?.map((message) => message.info.id),
    dispatched.map((message) => message.info.id),
  );
  assert.deepEqual(
    restarted?.map((message) => message.parts[0]?.type === "tool" && message.parts[0].state.status),
    ["error", "completed", "completed"],
  );
  for (const message of dispatched) {
    await restored.revert(info.id, message.info.parentID);
    await restored.unrevert(info.id);
    await restored.fork(info.id, message.info.id);
  }
});

test("shell binding rejects conflicting outcomes, undispatched cards and reused entry bindings", async (t) => {
  const { manager, dir } = setup(t);
  const info = await manager.create(dir);
  const session = manager.get(info.id);
  assert.ok(session);
  for (const conflict of ["output", "exitCode", "cancelled", "undispatched", "bound"]) {
    const wrong = createShellMessage(session, "echo repeated");
    const correct = createShellMessage(session, "echo repeated");
    const result = { output: "repeated\n", exitCode: 0, cancelled: false, truncated: false };
    completeShellMessage(wrong, "echo repeated", {
      ...result,
      ...(conflict === "output" ? { output: "other\n" } : {}),
      ...(conflict === "exitCode" ? { exitCode: 7 } : {}),
    });
    if (conflict === "cancelled") failShellMessage(wrong, "echo repeated", "Command cancelled", { cancelled: true });
    completeShellMessage(correct, "echo repeated", result);
    session.messages = [shellUserMessage(wrong), wrong, shellUserMessage(correct), correct];
    Object.assign(session.tree, {
      messageEntries: {},
      shellDispatch: { [wrong.info.id]: conflict !== "undispatched", [correct.info.id]: true },
    });
    if (conflict === "bound") session.tree.messageEntries[wrong.info.id] = "another_entry";
    bindMessageEntries(session, {
      entries: [
        {
          type: "message",
          id: "expected_entry",
          parentId: null,
          message: { role: "bashExecution", command: "echo repeated", ...result },
        },
      ],
      leafId: "expected_entry",
    });
    assert.equal(
      session.tree.messageEntries[wrong.info.id],
      conflict === "bound" ? "another_entry" : undefined,
      conflict,
    );
    assert.equal(session.tree.messageEntries[correct.info.id], "expected_entry", conflict);
  }
});

test("an established shell binding takes precedence over an earlier identical candidate", async (t) => {
  const { manager, dir } = setup(t);
  const info = await manager.create(dir);
  const session = manager.get(info.id);
  assert.ok(session);
  const earlier = createShellMessage(session, "echo repeated");
  const known = createShellMessage(session, "echo repeated");
  const result = { output: "repeated\n", exitCode: 0, cancelled: false, truncated: false };
  for (const message of [earlier, known]) completeShellMessage(message, "echo repeated", result);
  session.messages = [shellUserMessage(earlier), earlier, shellUserMessage(known), known];
  Object.assign(session.tree, { shellDispatch: { [earlier.info.id]: true, [known.info.id]: true } });
  session.tree.messageEntries[known.info.id] = "known_entry";
  session.tree.messageEntries[known.info.parentID] = "known_entry";
  bindMessageEntries(session, {
    entries: [
      {
        type: "message",
        id: "known_entry",
        parentId: null,
        message: { role: "bashExecution", command: "echo repeated", ...result },
      },
    ],
    leafId: "known_entry",
  });
  assert.equal(session.tree.messageEntries[earlier.info.id], undefined);
  assert.equal(session.tree.messageEntries[earlier.info.parentID], undefined);
  assert.equal(session.tree.messageEntries[known.info.id], "known_entry");
  assert.equal(session.tree.messageEntries[known.info.parentID], "known_entry");
});

test("fork stops before the selected live user and transfers the process away from the source", async (t) => {
  const { manager, dir } = setup(t);
  const { s, id } = await turns(manager, dir);
  const sourcePath = s.piPath;
  const child = await manager.fork(id, "msg_live_2");
  assert.notEqual(child.id, id);
  assert.equal(s.pi, undefined);
  assert.equal(s.piPath, sourcePath);
  assert.deepEqual(
    manager
      .messages(child.id)
      ?.filter((m) => m.info.role === "user")
      .map((m) => (m.parts[0]?.type === "text" ? m.parts[0].text : "")),
    ["turn-1"],
  );
  assert.equal(manager.messages(child.id)?.at(-1)?.info.role, "assistant");
  await manager.prompt(id, "source-only");
  assert.ok(s.pi);
  const source = branchEntries(await getEntries(s.pi));
  assert.equal(source.filter((entry) => entry.message?.role === "user").length, 4);
  const fork = manager.get(child.id);
  assert.ok(fork?.pi);
  assert.equal(branchEntries(await getEntries(fork.pi)).filter((entry) => entry.message?.role === "user").length, 1);
});

test("fork at an assistant message keeps that reply, as /btw requests", async (t) => {
  const { manager, dir } = setup(t);
  const { id } = await turns(manager, dir);
  const replies = manager.messages(id)?.filter((m) => m.info.role === "assistant") ?? [];
  const second = replies[1];
  assert.ok(second);
  const child = await manager.fork(id, second.info.id);
  const copied = manager.messages(child.id) ?? [];
  assert.deepEqual(
    copied.filter((m) => m.info.role === "user").map((m) => (m.parts[0]?.type === "text" ? m.parts[0].text : "")),
    ["turn-1", "turn-2"],
  );
  assert.equal(copied.filter((m) => m.info.role === "assistant").length, 2);
  const last = copied.at(-1);
  assert.equal(last?.info.role, "assistant");
  const text = (message: typeof second | undefined) =>
    message?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  assert.equal(text(last), text(second));
});

test("fork without messageID copies the complete leaf including the final reply", async (t) => {
  const { manager, dir } = setup(t);
  const { id } = await turns(manager, dir);
  const before = manager.messages(id)?.length;
  const child = await manager.fork(id);
  assert.equal(manager.messages(child.id)?.length, before);
  assert.equal(manager.messages(child.id)?.at(-1)?.info.role, "assistant");
});

test("persisted shell cards retain live ids through reload, fork and revert boundaries", async (t) => {
  const { manager, dir, state } = setup(t);
  const { id } = await turns(manager, dir);
  const session = { id };
  const s = manager.get(id);
  assert.ok(s?.pi);
  const result = await runShellCommand({
    sessions: manager,
    session: s,
    command: "echo bash-boundary",
    emit: () => {},
  });
  assert.equal(result.kind, "completed");
  const shellID = result.message.info.id;
  const shellUserID = result.message.info.parentID;
  assert.ok(shellUserID < shellID, "live shell IDs must preserve user-before-assistant order");
  assert.equal(manager.messages(session.id)?.length, 8, "refresh must not duplicate the live shell pair");
  const entryID = s.tree.messageEntries[shellID];
  assert.ok(entryID);
  assert.equal(s.tree.messageEntries[shellUserID], entryID);
  await manager.prompt(session.id, "after-shell", undefined, false, "msg_after_shell");
  await manager.revert(session.id, "msg_after_shell");
  assert.equal(s.tree.leafId, entryID, "revert must navigate to the preceding shell entry");
  await manager.unrevert(session.id);
  const beforeShell = (await getEntries(s.pi)).entries.find((entry) => entry.id === entryID)?.parentId;
  await manager.revert(session.id, shellUserID);
  assert.equal(s.tree.leafId, beforeShell);
  await manager.unrevert(session.id);
  await manager.reloadMessages(session.id);
  assert.equal(manager.messages(session.id)?.filter((m) => m.info.id === shellID).length, 1);
  await manager.disposeAll();
  const restored = new SessionManager(() => {}, new SessionStore(state), dir);
  t.after(() => restored.disposeAll());
  const shell = restored.messages(session.id)?.find((m) => m.info.id === shellID);
  assert.ok(shell?.parts[0]?.type === "tool" && shell.parts[0].state.status === "completed");
  const fork = await restored.fork(session.id, shellID);
  const forked = restored.messages(fork.id);
  assert.equal(forked?.length, 8);
  assert.ok(forked?.at(-1)?.parts[0]?.type === "tool");
  const before = await restored.fork(session.id, shellUserID);
  assert.equal(restored.messages(before.id)?.length, 6, "forking a shell user boundary must exclude the shell turn");
});

test("revert navigates before the user without changing a working file and unrevert restores the exact leaf", async (t) => {
  const { manager, dir } = setup(t);
  const { s, id, tree } = await turns(manager, dir);
  const file = join(dir, "f.txt");
  writeFileSync(file, "not reverted");
  const original = readFileSync(file);
  const parent = tree.entries.find((entry) => entry.id === s.tree.messageEntries.msg_live_3)?.parentId;
  await manager.revert(id, "msg_live_3");
  assert.deepEqual(s.info.revert, { messageID: "msg_live_3" });
  assert.ok(s.pi);
  assert.equal((await getEntries(s.pi)).leafId, parent);
  assert.deepEqual(readFileSync(file), original);
  // OpenChamber shows its own reverted dock from session.revert; no adapter card is injected.
  assert.equal(manager.messages(id)?.length, 6);
  await manager.revert(id, "msg_live_3");
  await manager.revert(id, "msg_live_2");
  await manager.unrevert(id);
  assert.equal((await getEntries(s.pi)).leafId, tree.leafId);
  assert.equal(s.info.revert, undefined);
  assert.equal(manager.messages(id)?.length, 6);
  await manager.unrevert(id);
  assert.equal((await getEntries(s.pi)).leafId, tree.leafId);
});

test("restart retains live ids and reverted transcript then a prompt branches from the saved parent", async (t) => {
  const { manager, dir, state } = setup(t);
  const { id } = await turns(manager, dir);
  await manager.revert(id, "msg_live_3");
  const saved = manager.get(id)?.tree.revert;
  await manager.disposeAll();
  const restarted = new SessionManager(() => undefined, new SessionStore(state), dir);
  t.after(() => restarted.disposeAll());
  assert.deepEqual(restarted.get(id)?.info.revert, { messageID: "msg_live_3" });
  assert.ok(restarted.messages(id)?.some((m) => m.info.id === "msg_live_3"));
  await restarted.prompt(id, "replacement", undefined, false, "msg_replacement");
  const s = restarted.get(id);
  assert.ok(s?.pi);
  const tree = await getEntries(s.pi);
  const active = branchEntries(tree);
  assert.equal(active.filter((e) => e.message?.role === "user").length, 3);
  assert.equal(
    active.some((e) => firstText(e.message?.content) === "turn-3"),
    false,
  );
  assert.ok(tree.entries.some((e) => firstText(e.message?.content) === "turn-3"));
  assert.equal(tree.entries.find((e) => e.id === s.tree.messageEntries.msg_replacement)?.parentId, saved?.targetId);
  assert.equal(s.info.revert, undefined);
});

test("compaction preserves the active revert leaf and original history across refresh and restart", async (t) => {
  const { manager, dir, state } = setup(t);
  const { s, id, tree } = await turns(manager, dir);
  await manager.revert(id, "msg_live_3");
  const pinnedLeaf = s.tree.leafId;
  const revert = { ...s.tree.revert };
  const response = await manager.sessionRpc(id, { type: "compact" });
  assert.equal(response.success, true);
  assert.equal(s.tree.leafId, pinnedLeaf);
  assert.deepEqual(s.tree.revert, revert);
  assert.ok(s.pi);
  assert.equal((await getEntries(s.pi)).leafId, pinnedLeaf);
  assert.doesNotMatch(JSON.stringify(manager.messages(id)), /Compacted summary/);
  await manager.disposeAll();

  const restarted = new SessionManager(() => undefined, new SessionStore(state), dir);
  t.after(() => restarted.disposeAll());
  assert.equal(restarted.get(id)?.tree.leafId, pinnedLeaf);
  assert.deepEqual(restarted.get(id)?.tree.revert, revert);
  assert.ok(restarted.messages(id)?.some((message) => message.info.id === "msg_live_3"));
  await restarted.unrevert(id);
  const restored = restarted.get(id);
  assert.ok(restored?.pi);
  assert.equal((await getEntries(restored.pi)).leafId, tree.leafId);
  assert.doesNotMatch(JSON.stringify(restarted.messages(id)), /Compacted summary/);
});

test("F2 B1 history refresh waits for an in-flight unrevert and agrees with the backend", {
  timeout: 10_000,
}, async (t) => {
  const { manager, dir } = setup(t);
  const { s, id, tree } = await turns(manager, dir);
  await manager.revert(id, "msg_live_3");
  assert.ok(s.pi);
  const pi = s.pi;
  const command = pi.command.bind(pi);
  const dispatched = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  pi.command = async <T>(...args: Parameters<PiRpcClient["command"]>) => {
    if (args[0].type === "get_entries") reads++;
    const response = await command<T>(...args);
    if (args[0].type === "navigate_tree" && args[0].targetId === tree.leafId) {
      dispatched.resolve();
      await release.promise;
    }
    return response;
  };
  const redo = manager.unrevert(id);
  await dispatched.promise;
  const readsBeforeRefresh = reads;
  const refresh = manager.reloadMessages(id);
  try {
    assert.equal(
      reads,
      readsBeforeRefresh,
      "refresh must not dispatch get_entries while unrevert navigation is pending",
    );
  } finally {
    release.resolve();
    await Promise.all([redo, refresh]);
    pi.command = command;
  }
  const reported = await redo;
  assert.equal(reported.revert, undefined);
  assert.equal(s.tree.revert, undefined);
  assert.equal(s.tree.leafId, tree.leafId);
  assert.equal((await getEntries(pi)).leafId, s.tree.leafId);
});

test("F2 B2 shell cards and notices created after revert remain in rendered history", {
  timeout: 10_000,
}, async (t) => {
  const { manager, dir } = setup(t);
  const { s, id } = await turns(manager, dir);
  await manager.revert(id, "msg_live_3");
  const result = await runShellCommand({
    sessions: manager,
    session: s,
    command: "echo F2_SHELL_OK",
    emit: () => undefined,
  });
  assert.equal(result.kind, "completed");
  announceSessionNotice({ sessions: manager, session: s, emit: () => undefined }, "F2_NOTICE");
  const shellId = result.message.info.id;
  assert.equal(result.message.info.parentID, `${result.message.info.id.slice(0, -1)}u`);
  const noticeId = s.messages?.find((message) =>
    message.parts.some((part) => part.type === "text" && part.text === "F2_NOTICE"),
  )?.info.id;
  assert.ok(noticeId, "notice must be appended to canonical history");
  const retained = () => {
    const history = manager.messages(id) ?? [];
    assert.equal(history.filter((message) => message.info.id === shellId).length, 1);
    assert.equal(history.filter((message) => message.info.id === noticeId).length, 1);
    assert.equal(history.find((message) => message.info.id === shellId)?.parts[0]?.type, "tool");
    if (s.tree.revert) {
      assert.ok(
        history.findIndex((message) => message.info.id === shellId) <
          history.findIndex((message) => message.info.id === s.tree.revert?.messageID),
        "shell must precede the UI cutoff",
      );
    }
  };
  retained();
  await manager.reloadMessages(id);
  retained();
  await manager.unrevert(id);
  retained();
  await manager.revert(id, "msg_live_3");
  await manager.prompt(id, "replacement", undefined, false, "msg_replacement");
  retained();
  await manager.reloadMessages(id);
  retained();
});

test("restored offset ids support fork and reverting the first root message", async (t) => {
  const { manager, dir, state } = setup(t);
  const { id, s } = await turns(manager, dir);
  const path = s.piPath;
  assert.ok(path);
  await manager.disposeAll();
  const store = new SessionStore(state);
  const entry = store.get(id);
  assert.ok(entry);
  store.set(id, { ...entry, tree: { messageEntries: {} } });
  const restored = new SessionManager(() => undefined, new SessionStore(state), dir);
  t.after(() => restored.disposeAll());
  const first = restored.messages(id)?.find((m) => m.info.role === "user");
  assert.ok(first);
  assert.ok(first.info.id.startsWith(`msg_${id}_r`));
  await restored.revert(id, first.info.id);
  assert.equal(restored.get(id)?.tree.leafId, null);
  await restored.unrevert(id);
  const child = await restored.fork(id, first.info.id);
  assert.equal(restored.messages(child.id)?.length, 0);
});

test("unknown and malformed messageIDs return 400 without changing session or tree", async (t) => {
  const { dir } = setup(t);
  const previous = process.env.ANTECHAMBER_STATE_DIR;
  process.env.ANTECHAMBER_STATE_DIR = join(dir, "http-state");
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: dir });
  t.after(async () => {
    await server.stop();
    if (previous === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previous;
  });
  await server.start();
  const created = await fetch(`${server.url}/session`, { method: "POST" });
  const session = (await created.json()) as { id: string };
  const url = `${server.url}/session/${session.id}`;
  const before = await (await fetch(url)).json();
  for (const body of [{ messageID: "nope" }, {}, { messageID: 12 }]) {
    const response = await fetch(`${url}/revert`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    const error = (await response.json()) as { data: { message: string } };
    assert.ok(error.data.message.length > 0);
  }
  assert.deepEqual(await (await fetch(url)).json(), before);
  const redo = await fetch(`${url}/unrevert`, { method: "POST" });
  assert.equal(redo.status, 200);
});
