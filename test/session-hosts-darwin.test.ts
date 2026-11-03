import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  createDarwinHostStopper,
  createSessionHostStopper,
  type DarwinHostDependencies,
} from "../src/session-hosts.js";

const SESSION = "sess-abc";
const SOCKET = `p-${createHash("sha256").update(`p:${SESSION}`).digest("hex").slice(0, 16)}.sock`;
const START = "Sun Nov  1 15:55:48 2026";
const OTHER_START = "Mon Nov  2 10:00:00 2026";
const OWNED = new Map([[SESSION, "/project"]]);

interface Row {
  readonly pid: number;
  readonly group: number;
  readonly state?: string;
  readonly start?: string;
  readonly args: string;
}

const SUPERVISOR = `node omo --internal-rpc-host-supervisor --socket /run/${SOCKET}`;
const leader = (overrides: Partial<Row> = {}): Row => ({ pid: 4242, group: 4242, args: SUPERVISOR, ...overrides });
const engine = (overrides: Partial<Row> = {}): Row => ({
  pid: 4243,
  group: 4242,
  args: "node omo --mode rpc",
  ...overrides,
});

/** `ps -ww -o pid=,pgid=,stat=,lstart=,args= -A` under LC_ALL=C. */
function psLine(row: Row): string {
  return `${String(row.pid).padStart(5)} ${String(row.group).padStart(5)} ${(row.state ?? "S").padEnd(4)} ${row.start ?? START} ${row.args}`;
}

interface HarnessOptions {
  readonly onSignal?: (table: Row[], pid: number, signal: NodeJS.Signals) => Row[];
  readonly cwdOf?: (pid: number) => string | undefined;
  readonly realpath?: (path: string) => string;
  readonly run?: DarwinHostDependencies["run"];
}

function harness(initial: Row[], options: HarnessOptions = {}) {
  let table = initial;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const calls: string[][] = [];
  const stopper = createDarwinHostStopper({
    run:
      options.run ??
      ((args) => {
        calls.push([...args]);
        return `${table.map(psLine).join("\n")}\n`;
      }),
    cwdOf: options.cwdOf ?? (() => "/project"),
    realpath: options.realpath ?? ((path) => path),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (options.onSignal !== undefined) table = options.onSignal(table, pid, signal);
    },
    delay: async () => undefined,
    graceMs: 300,
    pollMs: 100,
  });
  return { stopper, signals, calls };
}

const removeOn =
  (signal: NodeJS.Signals) =>
  (table: Row[], pid: number, sent: NodeJS.Signals): Row[] =>
    sent === signal ? table.filter((row) => row.pid !== pid) : table;

test("darwin teardown does nothing when no session was created", async () => {
  const { stopper, calls } = harness([leader()]);
  await stopper(new Map());
  assert.deepEqual(calls, [], "an empty map must not scan the process table");
});

test("darwin teardown sends SIGTERM to every member of an owned group and stops once they exit", async () => {
  const { stopper, signals } = harness([leader(), engine()], { onSignal: removeOn("SIGTERM") });
  await stopper(OWNED);
  assert.deepEqual(signals, [
    [4242, "SIGTERM"],
    [4243, "SIGTERM"],
  ]);
});

test("darwin teardown escalates to SIGKILL for members that survive the grace window", async () => {
  const { stopper, signals } = harness([leader(), engine()], { onSignal: removeOn("SIGKILL") });
  await stopper(OWNED);
  assert.deepEqual(signals, [
    [4242, "SIGTERM"],
    [4243, "SIGTERM"],
    [4242, "SIGKILL"],
    [4243, "SIGKILL"],
  ]);
});

test("darwin teardown still kills a member that outlives its supervisor", async () => {
  // The supervisor exits on SIGTERM; the engine ignores it. Linux kills the engine by its recorded identity.
  const { stopper, signals } = harness([leader(), engine()], {
    onSignal: (table, pid, signal) =>
      signal === "SIGKILL" || pid === 4242 ? table.filter((row) => row.pid !== pid) : table,
  });
  await stopper(OWNED);
  assert.deepEqual(signals, [
    [4242, "SIGTERM"],
    [4243, "SIGTERM"],
    [4243, "SIGKILL"],
  ]);
});

test("darwin teardown reports members that survive SIGKILL", async () => {
  const { stopper } = harness([leader(), engine()]);
  await assert.rejects(stopper(OWNED), /private OmO hosts survived shutdown: 4242, 4243/);
});

test("darwin teardown never signals a recycled PID", async () => {
  // Between the ownership scan and the signal scan the engine exits and an unrelated process takes its PID.
  const scans = [
    [leader(), engine()],
    [leader(), engine({ group: 9000, start: OTHER_START })],
  ];
  const { stopper, signals } = harness([], {
    run: () => `${(scans.shift() ?? []).map(psLine).join("\n")}\n`,
  });
  await stopper(OWNED);
  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
});

test("darwin teardown never claims a group whose working directory differs", async () => {
  const { stopper, signals } = harness([leader(), engine()], { cwdOf: () => "/elsewhere" });
  await stopper(OWNED);
  assert.deepEqual(signals, []);
});

test("darwin teardown fails closed when the working directory cannot be read", async () => {
  const { stopper, signals } = harness([leader()], { cwdOf: () => undefined });
  await stopper(OWNED);
  assert.deepEqual(signals, [], "an unconfirmed directory must not be signalled");
});

test("darwin teardown never claims a group whose socket belongs to another session", async () => {
  const other = `p-${createHash("sha256").update("p:other").digest("hex").slice(0, 16)}.sock`;
  const { stopper, signals } = harness([leader({ args: `omo --internal-rpc-host-supervisor --socket /run/${other}` })]);
  await stopper(OWNED);
  assert.deepEqual(signals, []);
});

test("darwin teardown only reads the shard from the --socket value", async () => {
  const args = `omo --internal-rpc-host-supervisor --socket /run/other.sock --log /run/${SOCKET}`;
  const { stopper, signals } = harness([leader({ args })]);
  await stopper(OWNED);
  assert.deepEqual(signals, [], "a shard name in another argument confers no ownership");
});

test("darwin teardown accepts a socket directory that contains spaces", async () => {
  const args = `omo --internal-rpc-host-supervisor --socket /Users/someone/Application Support/omo/${SOCKET}`;
  const { stopper, signals } = harness([leader({ args })], { onSignal: removeOn("SIGTERM") });
  await stopper(OWNED);
  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
});

test("darwin teardown recognises the host-lifecycle entry point", async () => {
  const args = `node /opt/omo/host-lifecycle.js --socket /run/${SOCKET}`;
  const { stopper, signals } = harness([leader({ args })], { onSignal: removeOn("SIGTERM") });
  await stopper(OWNED);
  assert.deepEqual(signals, [[4242, "SIGTERM"]]);
});

test("darwin teardown ignores zombie leaders and non-leader groups", async () => {
  const zombie = harness([leader({ state: "Z" }), engine()]);
  await zombie.stopper(OWNED);
  assert.deepEqual(zombie.signals, []);

  const child = harness([leader({ group: 999 })]);
  await child.stopper(OWNED);
  assert.deepEqual(child.signals, [], "only a leader (pid == pgid) can own the group");
});

test("darwin teardown reports a ps failure instead of skipping silently", async () => {
  const { stopper } = harness([], {
    run: () => {
      throw new Error("ps: timed out");
    },
  });
  await assert.rejects(stopper(OWNED), /ps: timed out/);
});

test("darwin is selected without probing python and without warning", async (t: TestContext) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  let probes = 0;
  const stop = createSessionHostStopper("darwin", () => {
    probes++;
    return undefined;
  });
  await stop(new Map());
  assert.equal(probes, 0, "the darwin path does not need pidfd or python3");
  assert.equal(warning.mock.callCount(), 0, "a supported platform must not warn");
});
