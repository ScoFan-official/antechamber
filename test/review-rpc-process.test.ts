import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { PiRpcClient, type ProcessTable } from "../src/pi-rpc.js";

test("R-019: a correlated response cannot satisfy a different command", async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new ChildProcess(), { stdin, stdout, stderr });
  t.mock.method(childProcess, "spawn", () => proc);
  syncBuiltinESMExports();
  const pi = new PiRpcClient({ cwd: process.cwd() });
  t.after(async () => {
    await pi.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const sent = once(stdin, "data", { signal: AbortSignal.timeout(1_000) });
  const pending = pi.command({ type: "get_state" }, 1_000);
  const [chunk] = await sent;
  const request = JSON.parse(String(chunk)) as { id: string };
  stdout.write(
    `${JSON.stringify({ type: "response", id: request.id, command: "set_model", success: true, data: {} })}\n`,
  );

  await assert.rejects(pending, /mismatched|unexpected|malformed/i);
  assert.equal(pi.isBusy, false);
});

async function startReviewServer(t: import("node:test").TestContext, fixture: string) {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { AdapterServer } = await import("../src/server.js");
  const root = mkdtempSync(join(tmpdir(), "antechamber-review-rpc-"));
  const previousBinary = process.env.ANTECHAMBER_PI_BINARY;
  const previousState = process.env.ANTECHAMBER_STATE_DIR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.ANTECHAMBER_PI_BINARY = fixture;
  process.env.ANTECHAMBER_STATE_DIR = join(root, "state");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
  t.after(async () => {
    await server.stop();
    if (previousBinary === undefined) delete process.env.ANTECHAMBER_PI_BINARY;
    else process.env.ANTECHAMBER_PI_BINARY = previousBinary;
    if (previousState === undefined) delete process.env.ANTECHAMBER_STATE_DIR;
    else process.env.ANTECHAMBER_STATE_DIR = previousState;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();
  return { root, server, url: server.url };
}

test("R-003: stdin EPIPE rejects the command without terminating its host process", { timeout: 10_000 }, async () => {
  const fixture = fileURLToPath(new URL("./fixtures/review-rpc-stdin-epipe.mjs", import.meta.url));
  const child = childProcess.spawn(process.execPath, ["--import", "tsx", fixture], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const [code, signal] = await once(child, "close", { signal: AbortSignal.timeout(5_000) });

  assert.equal(code, 0, `stdin EPIPE crashed the RPC host: ${stderr}`);
  assert.equal(signal, null);
  assert.match(stdout, /EPIPE_REJECTED/);
});

async function stopOwnedFixtureHost(t: TestContext, env: NodeJS.ProcessEnv = {}): Promise<void> {
  const { createHash, randomUUID } = await import("node:crypto");
  const { mkdirSync, mkdtempSync, rmSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { stopSessionHosts } = await import("../src/session-hosts.js");
  const { trackDetachedFixture } = await import("./fixtures/detached-fixture.js");
  const root = mkdtempSync(join(tmpdir(), "antechamber-r004-"));
  const real = join(root, "real");
  const linked = join(root, "linked");
  const owner = randomUUID();
  mkdirSync(real);
  symlinkSync(real, linked, "dir");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const socket = join(linked, `p-${createHash("sha256").update(`p:${owner}`).digest("hex").slice(0, 16)}.sock`);
  const fixture = fileURLToPath(new URL("./fixtures/fake-omo-host.mjs", import.meta.url));
  const child = childProcess.spawn(process.execPath, [fixture, "--internal-rpc-host-supervisor", "--socket", socket], {
    cwd: linked,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackDetachedFixture(t, child);
  const output = child.stdout;
  assert.ok(output);
  const [data] = await once(output, "data", { signal: AbortSignal.timeout(10_000) });
  const identity: { pid: number; enginePid: number } = JSON.parse(String(data));

  await stopSessionHosts(new Map([[owner, linked]]));

  // The supervisor is this process's child: it stays a zombie until Node reaps it.
  if (child.exitCode === null && child.signalCode === null)
    await once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  assert.throws(() => process.kill(identity.pid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(identity.enginePid, 0), { code: "ESRCH" });
}

// Real ps/lsof on macOS and /proc + pidfd on Linux; the injected unit tests cannot prove either.
const realTeardown = { skip: !["linux", "darwin"].includes(process.platform), timeout: 30_000 };

test(
  "R-004: private-host shutdown reaches an owned supervisor started through a directory symlink",
  realTeardown,
  (t) => stopOwnedFixtureHost(t),
);

test("R-004b: private-host shutdown kills an engine that outlives its supervisor", realTeardown, (t) =>
  stopOwnedFixtureHost(t, { FAKE_OMO_HOST_ORPHAN_ENGINE: "1" }),
);

test("R-005: disposing an exited child never signals its former numeric process group", async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    pid: 424242,
    exitCode: 0,
    signalCode: null,
  });
  let graceTimer: (() => void) | undefined;
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  t.mock.method(childProcess, "spawn", () => proc);
  t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals | 0) => {
    signals.push([pid, signal]);
    return true;
  });
  syncBuiltinESMExports();
  const pi = new PiRpcClient({
    cwd: process.cwd(),
    clock: {
      now: Date.now,
      setInterval,
      clearInterval,
      setTimeout: (callback, delay) => {
        graceTimer = callback;
        const timer = setTimeout(() => {}, delay);
        timer.unref();
        return timer;
      },
      clearTimeout,
    },
  });
  t.after(async () => {
    await pi.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const disposing = pi.dispose();
  graceTimer?.();
  await disposing;

  assert.deepEqual(signals, [], "an exited leader cannot authorize a raw negative-PID signal");
});

function disposableChild(t: TestContext, processTable: ProcessTable, killError?: (pid: number) => string | undefined) {
  const proc = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 424242,
    exitCode: null as number | null,
    signalCode: null,
  });
  let graceTimer: (() => void) | undefined;
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  t.mock.method(childProcess, "spawn", () => proc);
  t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals | 0) => {
    signals.push([pid, signal]);
    const code = killError?.(pid);
    if (code !== undefined) throw Object.assign(new Error(`kill ${code}`), { code });
    return true;
  });
  syncBuiltinESMExports();
  const pi = new PiRpcClient({
    cwd: process.cwd(),
    processTable,
    clock: {
      now: Date.now,
      setInterval,
      clearInterval,
      setTimeout: (callback, delay) => {
        graceTimer = callback;
        const timer = setTimeout(() => {}, delay);
        timer.unref();
        return timer;
      },
      clearTimeout,
    },
  });
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const exit = (): void => {
    proc.exitCode = 0;
    proc.emit("exit", 0, null);
  };
  return { pi, signals, exit, grace: () => graceTimer?.() };
}

test("R-005: a leader exiting during disposal leaves only re-identified group members to SIGKILL", async (t) => {
  const snapshot = [
    { pid: 424242, group: 424242, start: "100" },
    { pid: 424243, group: 424242, start: "101" },
    { pid: 424244, group: 424242, start: "102" },
  ];
  const { pi, signals, exit, grace } = disposableChild(t, {
    groupMembers: (group) => (group === 424242 ? snapshot : []),
    // 424243 is still the owned grandchild; 424244 exited and its PID now belongs to another group.
    identity: (pid) =>
      pid === 424243
        ? { pid, group: 424242, start: "101" }
        : pid === 424244
          ? { pid, group: 424244, start: "999" }
          : undefined,
  });

  const disposing = pi.dispose();
  exit();
  grace();
  await disposing;

  assert.deepEqual(signals, [
    [-424242, "SIGTERM"],
    [424243, "SIGKILL"],
  ]);
});

test("R-005: a leader still unreaped at the grace deadline is killed with its group", async (t) => {
  const { pi, signals, exit, grace } = disposableChild(t, {
    groupMembers: () => [],
    identity: () => undefined,
  });

  const disposing = pi.dispose();
  grace();
  exit();
  await disposing;

  assert.deepEqual(signals, [
    [-424242, "SIGTERM"],
    [-424242, "SIGKILL"],
  ]);
});

test("R-005: a leader exiting with no verifiable survivors ends disposal without further signals", async (t) => {
  const { pi, signals, exit } = disposableChild(t, {
    groupMembers: () => [{ pid: 424243, group: 424242, start: "101" }],
    identity: () => undefined,
  });

  const disposing = pi.dispose();
  exit();
  await disposing;

  assert.deepEqual(signals, [[-424242, "SIGTERM"]]);
});

test("an exited but unreaped leader (macOS group EPERM) still completes disposal on exit", async (t) => {
  const { pi, signals, exit } = disposableChild(t, { groupMembers: () => [], identity: () => undefined }, (pid) =>
    pid < 0 ? "EPERM" : undefined,
  );

  const disposing = pi.dispose();
  exit();
  await disposing;
  await pi.dispose();

  assert.deepEqual(signals, [[-424242, "SIGTERM"]]);
});

test("R-018: stdout EOF rejects later RPC commands before writing stdin", async (t) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new ChildProcess(), { stdin, stdout, stderr });
  t.mock.method(childProcess, "spawn", () => proc);
  syncBuiltinESMExports();
  const pi = new PiRpcClient({ cwd: process.cwd() });
  t.after(async () => {
    await pi.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const ended = once(stdout, "end", { signal: AbortSignal.timeout(1_000) });
  stdout.end();
  await ended;
  const pending = pi.command({ type: "get_state" });
  const outcome = pending.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  assert.equal(stdin.read(), null, "stdout EOF must prevent post-EOF stdin frames");
  assert.match(await outcome, /pi process is not running/);
});

test("R-020: a failed catalog load is retried by the next provider request", { timeout: 10_000 }, async (t) => {
  const { join } = await import("node:path");
  const fixture = fileURLToPath(new URL("./fixtures/review-rpc-catalog.mjs", import.meta.url));
  const { root, url } = await startReviewServer(t, fixture);
  const previousCountFile = process.env.REVIEW_RPC_CATALOG_COUNT_FILE;
  process.env.REVIEW_RPC_CATALOG_COUNT_FILE = join(root, "catalog-attempts");
  t.after(() => {
    if (previousCountFile === undefined) delete process.env.REVIEW_RPC_CATALOG_COUNT_FILE;
    else process.env.REVIEW_RPC_CATALOG_COUNT_FILE = previousCountFile;
  });

  const first = await fetch(`${url}/provider`);
  assert.equal(first.status, 200);
  const second = await fetch(`${url}/provider`);

  assert.equal(second.status, 200);
  assert.match(JSON.stringify(await second.json()), /recovered-model/);
});

test("R-011: first prompt_async reuses the optimistic user identity without a duplicate", {
  timeout: 10_000,
}, async (t) => {
  const { openEvents } = await import("./bug-harness.js");
  const fixture = fileURLToPath(new URL("./fixtures/turn-omo.mjs", import.meta.url));
  const { server, url } = await startReviewServer(t, fixture);
  const createdResponse = await fetch(`${url}/session`, { method: "POST", body: "{}" });
  assert.equal(createdResponse.status, 200);
  const created: unknown = await createdResponse.json();
  if (typeof created !== "object" || created === null || !("id" in created) || typeof created.id !== "string")
    throw new Error("session creation did not return an ID");
  const sessionID = created.id;
  const messageID = "msg_r011_optimistic";
  const stream = await openEvents(`${url}/event`);
  const global = await openEvents(`${url}/global/event`);
  t.after(async () => {
    await Promise.all([stream.close(), global.close()]);
  });
  const isOptimisticUser = (event: Record<string, unknown>): boolean =>
    event.type === "message.updated" &&
    JSON.stringify(event).includes(`"id":"${messageID}"`) &&
    JSON.stringify(event).includes('"role":"user"');
  const userEvent = stream.wait(isOptimisticUser);
  const globalUserEvent = global.wait(
    (frame) =>
      typeof frame.payload === "object" &&
      frame.payload !== null &&
      isOptimisticUser(frame.payload as Record<string, unknown>),
  );
  void userEvent.catch(() => undefined);
  void globalUserEvent.catch(() => undefined);

  const response = await fetch(`${url}/session/${sessionID}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageID, parts: [{ type: "text", text: "first turn" }] }),
  });

  assert.equal(response.status, 204);
  await Promise.all([userEvent, globalUserEvent]);
  await server["sessions"]["operations"].get(sessionID);
  const history: unknown = await (await fetch(`${url}/session/${sessionID}/message`)).json();
  if (!Array.isArray(history)) throw new Error("message history did not return an array");
  const userIDs = history.flatMap((message) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("info" in message) ||
      typeof message.info !== "object" ||
      message.info === null ||
      !("id" in message.info) ||
      !("role" in message.info) ||
      message.info.role !== "user" ||
      typeof message.info.id !== "string"
    )
      return [];
    return [message.info.id];
  });
  const eventIDs = (frames: readonly Record<string, unknown>[]) =>
    frames.flatMap((event) => {
      if (!isOptimisticUser(event)) return [];
      const properties = event.properties;
      if (
        typeof properties !== "object" ||
        properties === null ||
        !("info" in properties) ||
        typeof properties.info !== "object" ||
        properties.info === null ||
        !("id" in properties.info) ||
        typeof properties.info.id !== "string"
      )
        return [];
      return [properties.info.id];
    });

  assert.deepEqual(userIDs, [messageID]);
  assert.deepEqual(eventIDs(stream.frames), [messageID]);
  assert.deepEqual(
    eventIDs(
      global.frames.flatMap((frame) =>
        typeof frame.payload === "object" && frame.payload !== null ? [frame.payload as Record<string, unknown>] : [],
      ),
    ),
    [messageID],
  );
});
