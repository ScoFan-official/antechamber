import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

async function startServer(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "antechamber-review-http-"));
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: root });
  t.after(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });
  await server.start();
  return { root, url: server.url };
}

test("R-009: OpenCode-parity rule accepts a passwordless cross-port localhost origin", async (t) => {
  const { root, url } = await startServer(t);
  const response = await fetch(`${url}/file?directory=${encodeURIComponent(root)}&path=.`, {
    headers: { Origin: "http://localhost:5173" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
});

test("R-022: malformed v2 path encoding returns BadRequestError", async (t) => {
  const { url } = await startServer(t);
  const response = await fetch(`${url}/api/session/%`);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    name: "BadRequestError",
    data: { message: "invalid URL encoding" },
  });
});

test("R-023: v2 session creation rejects a missing directory before spawning an agent", async (t) => {
  const previousBinary = process.env.ANTECHAMBER_PI_BINARY;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const { root, url } = await startServer(t);
  process.env.ANTECHAMBER_PI_BINARY = fileURLToPath(new URL("./fixtures/turn-omo.mjs", import.meta.url));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(() => {
    if (previousBinary === undefined) delete process.env.ANTECHAMBER_PI_BINARY;
    else process.env.ANTECHAMBER_PI_BINARY = previousBinary;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const response = await fetch(`${url}/api/session?directory=${encodeURIComponent(join(root, "missing"))}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    name: "InvalidRequestError",
    data: { message: "directory does not exist or is not a directory" },
  });
});
