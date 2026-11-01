import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { AdapterServer } from "../src/server.js";

function setting(t: TestContext, name: string, value: string | undefined): void {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  });
}

async function start(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "antechamber-security-"));
  setting(t, "ANTECHAMBER_STATE_DIR", join(directory, "state"));
  const server = new AdapterServer({ host: "127.0.0.1", port: 0, defaultDirectory: directory });
  t.after(async () => {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await server.start();
  return { server, directory };
}

interface ErrorBody {
  name: string;
  data: { message: string };
}
const errorOf = async (response: Response) => (await response.json()) as ErrorBody;
const listOf = async (response: Response) => (await response.json()) as string[];

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

for (const path of ["/global/health", "/event", "/global/event", "/api/event", "/session/missing/shell", "/api/info"]) {
  test(`password protects ${path} before routing`, async (t) => {
    setting(t, "OPENCODE_SERVER_PASSWORD", "secret");
    const { server } = await start(t);
    const response = await fetch(server.url + path);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Basic /);
    assert.equal((await errorOf(response)).name, "UnauthorizedError");
  });
}

for (const passwordEnv of ["OPENCODE_SERVER_PASSWORD", "ANTECHAMBER_SERVER_PASSWORD", "OCPI_SERVER_PASSWORD"]) {
  test(`default Basic username works with ${passwordEnv}`, async (t) => {
    setting(t, "OPENCODE_SERVER_PASSWORD", undefined);
    setting(t, passwordEnv, "secret:with:colon");
    const { server } = await start(t);
    const response = await fetch(`${server.url}/global/health`, {
      headers: { Authorization: basic("opencode", "secret:with:colon") },
    });
    assert.equal(response.status, 200);
  });
}

test("OpenCode password takes precedence and username can be overridden", async (t) => {
  setting(t, "OPENCODE_SERVER_PASSWORD", "primary");
  setting(t, "ANTECHAMBER_SERVER_PASSWORD", "fallback");
  setting(t, "OPENCODE_SERVER_USERNAME", "operator");
  const { server } = await start(t);
  for (const [user, password, status] of [
    ["operator", "primary", 200],
    ["opencode", "primary", 401],
    ["operator", "fallback", 401],
  ] as const) {
    assert.equal(
      (
        await fetch(`${server.url}/global/health`, {
          headers: { Authorization: basic(user, password) },
        })
      ).status,
      status,
    );
  }
});

test("passwordless same-origin loopback origin is echoed rather than wildcarded", async (t) => {
  const { server } = await start(t);
  const response = await fetch(`${server.url}/global/health`, { headers: { Origin: server.url } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), server.url);
  assert.equal(response.headers.get("vary"), "Origin");
});

for (const origin of [
  "http://localhost:5173",
  "https://127.0.0.1:9999",
  "http://[::1]:3000",
  "http://localhost:80",
  "https://127.0.0.1:443",
  "http://127.9.8.7:5173",
]) {
  test(`OpenCode-parity rule accepts passwordless cross-port loopback origin ${origin}`, async (t) => {
    const { server } = await start(t);
    const response = await fetch(`${server.url}/global/health`, { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  });
}

for (const origin of [
  "https://evil.example",
  "http://localhost.evil.example",
  "null",
  "http://localhost/path",
  "file://localhost",
  "http://evil@localhost",
  "http://127.0.0.256",
]) {
  test(`untrusted origin ${origin} is rejected`, async (t) => {
    const { server } = await start(t);
    const response = await fetch(`${server.url}/global/health`, { headers: { Origin: origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
}

test("OpenCode-parity rule accepts a passwordless POST /api/session from another loopback port", async (t) => {
  setting(t, "ANTECHAMBER_PI_BINARY", fileURLToPath(new URL("./fixtures/turn-omo.mjs", import.meta.url)));
  const { server, directory } = await start(t);
  setting(t, "PI_CODING_AGENT_DIR", join(directory, "agent"));
  const origin = "http://127.0.0.1:5173";
  const response = await fetch(`${server.url}/api/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  const body = (await response.json()) as { data: { id: string } };
  assert.equal(typeof body.data.id, "string");
});

for (const origin of ["http://192.168.1.50:4096", "tauri://localhost"]) {
  test(`with a password, proxied origin ${origin} is served without CORS headers`, async (t) => {
    setting(t, "OPENCODE_SERVER_PASSWORD", "secret");
    const { server } = await start(t);
    const authorized = await fetch(`${server.url}/global/health`, {
      headers: { Origin: origin, Authorization: basic("opencode", "secret") },
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("access-control-allow-origin"), null);
    const anonymous = await fetch(`${server.url}/global/health`, { headers: { Origin: origin } });
    assert.equal(anonymous.status, 401);
  });
}

test("allowlist and authorized preflight use explicit CORS origins", async (t) => {
  setting(t, "ANTECHAMBER_ALLOWED_ORIGINS", " https://trusted.example, https://second.example ");
  setting(t, "OPENCODE_SERVER_PASSWORD", "secret");
  const { server } = await start(t);
  const response = await fetch(`${server.url}/event`, {
    method: "OPTIONS",
    headers: { Origin: "https://trusted.example", Authorization: basic("opencode", "secret") },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://trusted.example");
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /Authorization/i);
  assert.equal((await fetch(`${server.url}/event`, { method: "OPTIONS" })).status, 401);
});

test("requests without Origin do not get wildcard CORS", async (t) => {
  const { server } = await start(t);
  assert.equal((await fetch(`${server.url}/global/health`)).headers.get("access-control-allow-origin"), null);
});

for (const body of ["{", "null", "[]", "true", '"text"', "42"]) {
  for (const path of ["/session", "/api/project/example"]) {
    test(`invalid object body ${body} returns 400 at ${path}`, async (t) => {
      const { server } = await start(t);
      const response = await fetch(server.url + path, { method: path === "/session" ? "POST" : "PATCH", body });
      assert.equal(response.status, 400);
      const error = await errorOf(response);
      assert.deepEqual(Object.keys(error).sort(), ["data", "name"]);
      assert.equal(error.name, "InvalidRequestError");
      assert.equal(typeof error.data.message, "string");
    });
  }
}

test("Content-Length limit rejects before the client sends its body", { timeout: 5000 }, async (t) => {
  setting(t, "ANTECHAMBER_MAX_BODY_BYTES", "16");
  const { server } = await start(t);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      `${server.url}/api/project/example`,
      {
        method: "PATCH",
        headers: { "Content-Length": "17" },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.once("error", reject);
    t.after(() => req.destroy());
    req.flushHeaders();
  });
  assert.equal(status, 413);
});

test("chunked body limit rejects while streaming and leaves health working", { timeout: 5000 }, async (t) => {
  setting(t, "ANTECHAMBER_MAX_BODY_BYTES", "16");
  const { server } = await start(t);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${server.url}/api/project/example`, { method: "PATCH" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once("error", reject);
    t.after(() => req.destroy());
    req.write(" ".repeat(17)); // No end: crossing the limit must produce the response.
  });
  assert.equal(status, 413);
  assert.equal((await fetch(`${server.url}/global/health`)).status, 200);
});

test("empty and exact-limit object bodies remain valid", async (t) => {
  setting(t, "ANTECHAMBER_MAX_BODY_BYTES", "2");
  const { server } = await start(t);
  for (const body of ["", "{}"]) {
    const response = await fetch(`${server.url}/api/project/example`, { method: "PATCH", body });
    assert.equal(response.status, 400);
    assert.equal((await errorOf(response)).name, "UnsupportedError");
  }
});

test("body limits count UTF-8 bytes rather than characters", async (t) => {
  setting(t, "ANTECHAMBER_MAX_BODY_BYTES", "16");
  const { server } = await start(t);
  const response = await fetch(`${server.url}/api/project/example`, {
    method: "PATCH",
    body: JSON.stringify({ x: "\u00e9".repeat(5) }),
  });
  assert.equal(response.status, 413);
});

test("SSE caps all protocol subscriptions and releases disconnected slots", { timeout: 10_000 }, async (t) => {
  const { server } = await start(t);
  const responses: ServerResponse[] = [];
  // Hold the client streams: Node 26 fetch cancels the body of a collected Response, freeing its slot.
  const streams: Response[] = [];
  const clients = server["sseClients"];
  for (let i = 0; i < 64; i++) {
    const path = i % 2 === 0 ? "/event" : "/api/event";
    const response = await fetch(server.url + path, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    streams.push(response);
    // Capture the real server response so slot release can be awaited without polling.
    const res = [...clients.keys()].at(-1);
    assert.ok(res);
    responses.push(res);
  }
  const overflow = await fetch(`${server.url}/global/event`);
  assert.equal(overflow.status, 503);
  const first = responses[0];
  assert.ok(first);
  const closed = once(first, "close");
  first.destroy();
  await closed;
  const admitted = await fetch(`${server.url}/api/event`);
  assert.equal(admitted.status, 200);
  assert.equal(clients.size, 64);
  // streams[0] was destroyed server-side above; release the live ones.
  await Promise.all(streams.slice(1).map((stream) => stream.body?.cancel()));
});

for (const path of ["/event", "/api/event"]) {
  test(`SSE ${path} drops a blocked subscriber beyond the pending byte cap`, async (t) => {
    const { server, directory } = await start(t);
    const response = await fetch(server.url + path);
    assert.equal(response.status, 200);
    const res = [...server["sseClients"].keys()][0];
    assert.ok(res);
    // Model a socket that cannot drain; preserve real ServerResponse.write buffering.
    res.cork();
    const closed = once(res, "close");
    for (let i = 0; i < 12 && !res.destroyed; i++) {
      server["broadcast"](directory, {
        type: "model.changed",
        properties: {
          sessionID: "missing",
          model: { providerID: "test", modelID: "x".repeat(1024 * 1024) },
        },
      });
    }
    assert.equal(res.destroyed, true);
    await closed;
    assert.equal(server["sseClients"].size, 0);
  });
}

test("SSE drops a subscriber when HTTP framing takes its pending bytes over the cap", async (t) => {
  const { server } = await start(t);
  const response = await fetch(`${server.url}/event`);
  assert.equal(response.status, 200);
  const res = [...server["sseClients"].keys()][0];
  assert.ok(res);
  assert.ok(res.socket);
  res.socket.cork(); // Include HTTP chunk framing in the socket's pending bytes.
  const closed = once(res, "close");
  server["writeSSE"](res, "x".repeat(8 * 1024 * 1024 - res.writableLength));
  assert.equal(res.destroyed, true);
  await closed;
});

test("file search stops beyond the maximum directory depth", async (t) => {
  const { server, directory } = await start(t);
  let nested = directory;
  for (let depth = 0; depth < 34; depth++) {
    nested = join(nested, "d");
    mkdirSync(nested);
  }
  writeFileSync(join(nested, "too-deep.txt"), "");
  const response = await fetch(`${server.url}/find/file?query=too-deep&dirs=false`);
  assert.deepEqual(await response.json(), []);
});

test("directory listing and requested file search results are capped", async (t) => {
  const { server, directory } = await start(t);
  for (let i = 0; i < 1010; i++) writeFileSync(join(directory, `match-${i}.txt`), "");
  const listing = await listOf(await fetch(`${server.url}/file`));
  assert.equal(listing.length, 1000);
  const matches = await listOf(await fetch(`${server.url}/find/file?query=match&limit=99999`));
  assert.equal(matches.length, 1000);
});

test("file search bounds visited directories even when the result cap is not reached", async (t) => {
  const { server, directory } = await start(t);
  for (let branch = 0; branch < 40; branch++) {
    const parent = join(directory, `branch-${branch}`);
    mkdirSync(parent);
    for (let leaf = 0; leaf < 40; leaf++) {
      const child = join(parent, `leaf-${leaf}`);
      mkdirSync(child);
      writeFileSync(join(child, "needle.txt"), "");
    }
  }
  const matches = await listOf(await fetch(`${server.url}/find/file?query=needle&dirs=false&limit=1000`));
  assert.ok(matches.length > 0);
  assert.ok(matches.length < 1000);
});

for (const [method, path, status, name] of [
  ["POST", "/global/upgrade", 409, "UnsupportedError"],
  ["PATCH", "/config", 400, "UnsupportedError"],
  ["GET", "/missing", 404, "NotFoundError"],
  ["GET", "/api/session/missing", 404, "NotFoundError"],
] as const) {
  test(`error serialization is consistent for ${path}`, async (t) => {
    const { server } = await start(t);
    const response = await fetch(server.url + path, { method });
    assert.equal(response.status, status);
    const error = await errorOf(response);
    assert.deepEqual(Object.keys(error).sort(), ["data", "name"]);
    assert.equal(error.name, name);
    assert.equal(typeof error.data.message, "string");
  });
}

test("debug logs are private and omit request query strings", async (t) => {
  const { server, directory } = await start(t);
  const path = join(directory, "debug.log");
  setting(t, "ANTECHAMBER_DEBUG", "1");
  setting(t, "ANTECHAMBER_DEBUG_LOG", path);
  await fetch(`${server.url}/global/health?token=SECRET_QUERY`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path, "utf8").includes("SECRET_QUERY"));
  assert.ok(readFileSync(path, "utf8").includes("/global/health"));
});

test("CLI refuses a non-loopback listener without explicit authorization", { timeout: 5000 }, async () => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "serve", "--hostname", "0.0.0.0", "--port", "0"],
    {
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: "",
        ANTECHAMBER_SERVER_PASSWORD: "",
        OCPI_SERVER_PASSWORD: "",
        ANTECHAMBER_ALLOW_INSECURE: "",
        OCPI_ALLOW_INSECURE: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  // Abort is a failure bound, not a timing assertion.
  const deadline = AbortSignal.timeout(4000);
  deadline.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  const [code] = await exited;
  assert.equal(code, 1);
  assert.match(stderr, /OPENCODE_SERVER_PASSWORD/);
  assert.match(stderr, /--insecure-no-auth/);
});

for (const mode of ["opencode-password", "adapter-password", "insecure-env", "insecure-flag"]) {
  test(`CLI admits a non-loopback listener with ${mode} and uses a private default log`, {
    timeout: 10_000,
  }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "antechamber-security-cli-"));
    const args = ["--import", "tsx", "src/cli.ts", "serve", "--hostname", "0.0.0.0", "--port", "0"];
    if (mode === "insecure-flag") args.push("--insecure-no-auth");
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        TMPDIR: directory,
        ANTECHAMBER_STATE_DIR: join(directory, "state"),
        OPENCODE_SERVER_PASSWORD: mode === "opencode-password" ? "secret" : "",
        OPENCODE_SERVER_USERNAME: "opencode",
        ANTECHAMBER_SERVER_PASSWORD: mode === "adapter-password" ? "secret" : "",
        OCPI_SERVER_PASSWORD: "",
        OCPI_ALLOW_INSECURE: "",
        ANTECHAMBER_DEBUG_LOG: "",
        OCPI_DEBUG_LOG: "",
        ANTECHAMBER_ALLOW_INSECURE: mode === "insecure-env" ? "1" : "",
        ANTECHAMBER_DEBUG: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    t.after(async () => {
      child.kill("SIGTERM");
      await exited;
      rmSync(directory, { recursive: true, force: true });
    });
    const url = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        const match = stdout.match(/listening on (http:\/\/\S+)/);
        if (match?.[1]) resolve(match[1].replace("0.0.0.0", "127.0.0.1"));
      });
      child.once("exit", () => reject(new Error(`CLI exited before listening: ${stderr}`)));
      AbortSignal.timeout(5000).addEventListener("abort", () => reject(new Error("CLI startup deadline")), {
        once: true,
      });
    });
    const response = await fetch(`${url}/global/health?token=PRIVATE_QUERY`, {
      headers: { Authorization: basic("opencode", "secret") },
    });
    assert.equal(response.status, 200);
    const log = join(directory, `antechamber-debug-${process.getuid?.() ?? "user"}.log`);
    assert.equal(statSync(log).mode & 0o777, 0o600);
    assert.ok(!readFileSync(log, "utf8").includes("PRIVATE_QUERY"));
  });
}
