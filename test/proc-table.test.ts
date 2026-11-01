import assert from "node:assert/strict";
import test from "node:test";
import { createDarwinProcTable, type PsRunner } from "../src/proc-table-darwin.js";
import { createProcessTable } from "../src/proc-table.js";

// Captured verbatim from macOS 27.2 with `ps -ww -o pid=,pgid=,stat=,lstart= -A`: right-aligned
// columns, four-space gap after the state, and trailing padding after the date.
const LIVE_LEADER = "    1     1 Ss   Sun Nov  1 14:27:55 2026    ";
const LIVE_CHILD = " 9672  9671 S    Sun Nov  1 15:55:23 2026    ";
const ZOMBIE = " 4321  4321 Z    Sun Nov  1 16:00:00 2026    ";

function stub(output: string, calls: string[][] = []): PsRunner {
  return (args) => {
    calls.push([...args]);
    return output;
  };
}

test("darwin identity reads the pid, group and start time from ps", () => {
  const calls: string[][] = [];
  const table = createDarwinProcTable(stub(`${LIVE_CHILD}\n`, calls));
  assert.deepEqual(table.identity(9672), { pid: 9672, group: 9671, start: "Sun Nov  1 15:55:23 2026" });
  assert.deepEqual(calls, [["-ww", "-o", "pid=,pgid=,stat=,lstart=", "-p", "9672"]]);
});

test("darwin identity keeps a stable, opaque start time across calls", () => {
  const table = createDarwinProcTable(stub(`${LIVE_CHILD}\n`));
  const first = table.identity(9672);
  const second = table.identity(9672);
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.start, "Sun Nov  1 15:55:23 2026");
  assert.equal(
    first.start,
    second.start,
    "two calls against the same process must compare equal, which is all dispose uses start for",
  );
});

test("darwin identity treats a zombie as gone", () => {
  for (const state of ["Z", "Z+"]) {
    const line = ZOMBIE.replace(" Z ", ` ${state} `);
    assert.equal(createDarwinProcTable(stub(`${line}\n`)).identity(4321), undefined);
  }
});

test("darwin identity fails closed when ps cannot read the process", () => {
  const table = createDarwinProcTable(() => {
    throw Object.assign(new Error("ps: process not found"), { code: 1 });
  });
  assert.equal(table.identity(999_999), undefined);
});

test("darwin identity ignores empty, malformed and mismatched rows", () => {
  assert.equal(createDarwinProcTable(stub("")).identity(9672), undefined);
  assert.equal(createDarwinProcTable(stub("garbage\n")).identity(9672), undefined);
  const other = " 5555  5555 S    Sun Nov  1 15:55:23 2026";
  assert.equal(createDarwinProcTable(stub(`${other}\n`)).identity(9672), undefined, "pid must match the request");
});

test("darwin identity rejects pids ps cannot represent", () => {
  const calls: string[][] = [];
  const table = createDarwinProcTable(stub(`${LIVE_CHILD}\n`, calls));
  for (const pid of [0, -1, 1.5]) assert.equal(table.identity(pid), undefined);
  assert.deepEqual(calls, [], "an unusable pid must not reach ps");
});

test("darwin groupMembers keeps the requested group and drops zombies", () => {
  const output = [LIVE_LEADER, LIVE_CHILD, ZOMBIE, " 7000  6999 S    Sun Nov  1 15:55:23 2026", ""].join("\n");
  const calls: string[][] = [];
  const members = createDarwinProcTable(stub(output, calls)).groupMembers(9671);
  assert.deepEqual(members, [{ pid: 9672, group: 9671, start: "Sun Nov  1 15:55:23 2026" }]);
  assert.deepEqual(calls, [["-ww", "-o", "pid=,pgid=,stat=,lstart=", "-A"]]);
});

test("darwin groupMembers returns nothing when ps fails", () => {
  const table = createDarwinProcTable(() => {
    throw Object.assign(new Error("ps failed"), { code: 1 });
  });
  assert.deepEqual(table.groupMembers(9671), []);
});

test("createProcessTable exposes both readers on every platform", () => {
  for (const platform of ["darwin", "linux", "freebsd"] as const) {
    const table = createProcessTable(platform);
    assert.equal(typeof table.identity, "function");
    assert.equal(typeof table.groupMembers, "function");
  }
  assert.deepEqual(createProcessTable("linux").groupMembers(4_000_000), [], "a group nobody owns is empty");
});

// Real /bin/ps, no spawned process: the assertion is about the column format, which is what a
// fixture cannot prove. Skipped where ps is not the macOS one.
test("darwin reads this test process from the live process table", { skip: process.platform !== "darwin" }, () => {
  const table = createDarwinProcTable();
  const self = table.identity(process.pid);
  assert.ok(self !== undefined, "the running test process must have an identity");
  assert.equal(self.pid, process.pid);
  assert.ok(self.group > 0);
  assert.notEqual(self.start, "");
  assert.ok(
    table.groupMembers(self.group).some((member) => member.pid === process.pid),
    "the process must be listed among its own group members",
  );
});
