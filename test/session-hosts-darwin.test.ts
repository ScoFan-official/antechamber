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

function leader(pid = 4242, group = 4242, state = "S", start = START): string {
  return `${pid} ${group} ${state} ${start} --internal-rpc-host-supervisor --socket /run/${SOCKET}`;
}

interface HarnessOptions {
  readonly rows: () => string[];
  readonly one?: (pid: number) => string;
  readonly onDelay?: () => void;
  readonly cwdOf?: (pid: number) => string | undefined;
  readonly realpath?: (path: string) => string;
}

function harness(options: HarnessOptions) {
  const signals: Array<[number, string]> = [];
  const calls: string[][] = [];
  const overrides: Partial<DarwinHostDependencies> = {
    run: (args) => {
      calls.push([...args]);
      if (args.includes("-A")) return options.rows().join("\n");
      const pid = Number(args[args.length - 1]);
      if (options.one !== undefined) return options.one(pid);
      return options
        .rows()
        .filter((line) => line.split(" ")[0] === String(pid))
        .join("\n");
    },
    cwdOf: options.cwdOf ?? (() => "/project"),
    realpath: options.realpath ?? ((path) => path),
    signal: (target, signal) => {
      signals.push([target, signal]);
    },
    delay: async () => {
      options.onDelay?.();
    },
    graceMs: 300,
    pollMs: 100,
  };
  return { stopper: createDarwinHostStopper(overrides), signals, calls };
}

test("darwin teardown does nothing when no session was created", async () => {
  const { stopper, calls } = harness({ rows: () => [leader()] });
  await stopper(new Map());
  assert.deepEqual(calls, [], "an empty map must not scan the process table");
});

test("darwin teardown signals the owned group and stops once it is gone", async () => {
  let alive = true;
  const { stopper, signals } = harness({
    rows: () => (alive ? [leader()] : []),
    onDelay: () => {
      alive = false;
    },
  });
  await stopper(OWNED);
  assert.deepEqual(signals, [[-4242, "SIGTERM"]], "no SIGKILL once every member is gone");
});

test("darwin teardown escalates to SIGKILL when the group survives the grace window", async () => {
  const { stopper, signals } = harness({ rows: () => [leader()] });
  await stopper(OWNED);
  assert.deepEqual(signals, [
    [-4242, "SIGTERM"],
    [-4242, "SIGKILL"],
  ]);
});

test("darwin teardown never claims a group whose working directory differs", async () => {
  const { stopper, signals } = harness({ rows: () => [leader()], cwdOf: () => "/elsewhere" });
  await stopper(OWNED);
  assert.deepEqual(signals, []);
});

test("darwin teardown never claims a group whose socket belongs to another session", async () => {
  const other = `p-${createHash("sha256").update("p:other").digest("hex").slice(0, 16)}.sock`;
  const row = `4242 4242 S ${START} --internal-rpc-host-supervisor --socket /run/${other}`;
  const { stopper, signals } = harness({ rows: () => [row] });
  await stopper(OWNED);
  assert.deepEqual(signals, []);
});

test("darwin teardown fails closed when the working directory cannot be read", async () => {
  const { stopper, signals } = harness({ rows: () => [leader()], cwdOf: () => undefined });
  await stopper(OWNED);
  assert.deepEqual(signals, [], "an unconfirmed directory must not be signalled");
});

test("darwin teardown ignores a recycled leader and says so once", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  const { stopper, signals } = harness({
    rows: () => [leader()],
    one: () => leader(4242, 4242, "S", OTHER_START),
  });
  await stopper(OWNED);
  assert.deepEqual(signals, [], "a changed start time means the group number now belongs to someone else");
  assert.equal(warning.mock.callCount(), 1);
});

test("darwin teardown recognises the host-lifecycle entry point", async () => {
  let alive = true;
  const row = `4242 4242 S ${START} node /opt/omo/host-lifecycle.js --socket /run/${SOCKET}`;
  const { stopper, signals } = harness({
    rows: () => (alive ? [row] : []),
    onDelay: () => {
      alive = false;
    },
  });
  await stopper(OWNED);
  assert.deepEqual(signals, [[-4242, "SIGTERM"]]);
});

test("darwin teardown ignores zombie leaders and non-leader groups", async () => {
  const zombie = harness({ rows: () => [leader(4242, 4242, "Z")] });
  await zombie.stopper(OWNED);
  assert.deepEqual(zombie.signals, []);

  const child = harness({ rows: () => [leader(4242, 999)] });
  await child.stopper(OWNED);
  assert.deepEqual(child.signals, [], "only a leader (pid == pgid) can own the group");
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
