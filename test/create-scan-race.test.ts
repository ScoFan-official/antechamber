import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { PiRpcClient } from "../src/pi-rpc.js";
import { SessionManager } from "../src/sessions.js";
import { ocIdFor, piSessionDir, SessionStore } from "../src/session-store.js";

// OmO writes its session file when it starts, before it answers get_state (seen live: the adopted twin was created
// 617 ms before the real session). A session list that OpenChamber sends in that window scans the directory and
// finds a file no session claims yet.
async function createDuringList(t: TestContext, requestedId: string | undefined) {
  const env = { pi: process.env.ANTECHAMBER_PI_BINARY, agent: process.env.OMO_CODING_AGENT_DIR };
  // The scan trusts the header cwd, which OmO writes resolved (macOS tmpdir is a symlink).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "antechamber-create-race-")));
  const events: { type: string; properties?: unknown }[] = [];
  let manager: SessionManager | undefined;
  t.after(async () => {
    await manager?.disposeAll();
    for (const [key, value] of [
      ["ANTECHAMBER_PI_BINARY", env.pi],
      ["OMO_CODING_AGENT_DIR", env.agent],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.ANTECHAMBER_PI_BINARY = resolve("test/fixtures/fake-omo.mjs");
  process.env.OMO_CODING_AGENT_DIR = join(dir, "agent");
  const sessions = new SessionManager((_, event) => events.push(event), new SessionStore(join(dir, "state")), dir);
  manager = sessions;
  const original = PiRpcClient.prototype.command;
  let raced = false;
  t.mock.method(
    PiRpcClient.prototype,
    "command",
    async function (this: PiRpcClient, ...args: Parameters<PiRpcClient["command"]>) {
      const response = await original.apply(this, args);
      const data = response.data as { sessionFile?: string } | undefined;
      if (args[0].type === "get_state" && !raced && typeof data?.sessionFile === "string") {
        raced = true;
        // Put the file where OmO keeps it, then list before create has bound it.
        mkdirSync(piSessionDir(dir), { recursive: true });
        const native = join(piSessionDir(dir), basename(data.sessionFile));
        copyFileSync(data.sessionFile, native);
        data.sessionFile = native;
        sessions.list(dir);
      }
      return response;
    },
  );
  const created = await sessions.create(
    dir,
    undefined,
    undefined,
    requestedId === undefined ? {} : { id: requestedId },
  );
  assert.ok(raced, "the list ran while get_state was pending");
  const piSessionId = sessions.get(created.id)?.piSessionId;
  assert.ok(piSessionId);
  const twins = sessions.list(dir).filter((session) => session.slug === piSessionId);
  return { created, twin: ocIdFor(piSessionId), twins, events };
}

const lifecycle = (events: { type: string; properties?: unknown }[]) =>
  events.flatMap((event) =>
    event.type === "session.created" || event.type === "session.deleted"
      ? [`${event.type}:${(event.properties as { info: { id: string } }).info.id}`]
      : [],
  );

test("a session list during create does not adopt the new session's file as a second session", {
  timeout: 30_000,
}, async (t) => {
  const { twin, twins, events } = await createDuringList(t, "ses_requested");
  assert.deepEqual(
    twins.map((session) => session.id),
    ["ses_requested"],
  );
  assert.deepEqual(lifecycle(events), [`session.deleted:${twin}`, "session.created:ses_requested"]);
});

test("a twin under the new session's own id is replaced without a delete", { timeout: 30_000 }, async (t) => {
  const { created, twin, twins, events } = await createDuringList(t, undefined);
  assert.equal(created.id, twin);
  assert.deepEqual(
    twins.map((session) => session.id),
    [twin],
  );
  assert.deepEqual(lifecycle(events), [`session.created:${twin}`]);
});
