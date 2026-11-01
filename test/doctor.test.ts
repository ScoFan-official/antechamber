import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createContext } from "../src/commands/context.js";
import { doctor, formatDoctor } from "../src/commands/doctor.js";
import { recordRunningServer } from "../src/running-servers.js";
import { ADAPTER_VERSION } from "../src/version.js";

function fixture(t: TestContext, backend = "omo") {
  const home = fs.mkdtempSync(join(tmpdir(), "antechamber-doctor-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agent = join(home, "agent");
  fs.mkdirSync(agent);
  fs.writeFileSync(join(home, "omo.jsonc"), "{}");
  for (const name of [backend, "openchamber"]) {
    fs.writeFileSync(join(home, name), "#!/usr/bin/env node\n", { mode: 0o755 });
  }
  const settings = join(home, "settings.json");
  const cliPath = join(home, "cli.js");
  fs.writeFileSync(cliPath, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(settings, JSON.stringify({ opencodeBinary: cliPath }));
  const calls: string[][] = [];
  const ctx = createContext({
    home,
    cwd: home,
    platform: "linux",
    nodeVersion: "22.0.0",
    env: { PATH: home, ANTECHAMBER_PI_BINARY: backend, OMO_CODING_AGENT_DIR: agent },
    exec: (binary, args) => {
      calls.push([binary, ...args]);
      return `${backend} 1.2.3`;
    },
    output: () => {},
    cliPath,
    launcherPath: join(home, "bin", "opencode-antechamber"),
  });
  return { home, settings, ctx, calls };
}

test("doctor JSON is structured and all checks leave files untouched", (t) => {
  const { home, settings, ctx } = fixture(t);
  const before = fs.readdirSync(home);
  const report = doctor({ settings }, ctx);
  const json = JSON.parse(formatDoctor(report, true));
  assert.deepEqual(Object.keys(json).sort(), ["checks", "exitCode"]);
  assert.equal(json.exitCode, 0);
  assert.ok(
    json.checks.every(
      (check: { name: string; status: string; message: string }) =>
        typeof check.name === "string" &&
        ["PASS", "WARN", "FAIL", "INFO"].includes(check.status) &&
        typeof check.message === "string",
    ),
  );
  assert.equal(report.checks.find((check) => check.name === "agent-name")?.message, "OmO");
  assert.deepEqual(fs.readdirSync(home), before);
  assert.equal(fs.existsSync(join(home, ".config")), false);
});

test("doctor compares installed and running versions with the latest release", (t) => {
  const { home, settings, ctx } = fixture(t);
  const state = join(home, "state");
  const withState = { ...ctx, env: { ...ctx.env, ANTECHAMBER_STATE_DIR: state } };
  const checks = (latest?: string | Error) =>
    doctor({ settings }, withState, latest)
      .checks.filter((check) => check.name === "version" || check.name === "running")
      .map((check) => `${check.status} ${check.name}`);

  assert.deepEqual(checks(ADAPTER_VERSION), ["PASS version", "INFO running"]);
  const forget = recordRunningServer(
    state,
    { pid: process.pid, version: "0.0.1", url: "http://127.0.0.1:1", started: "2026-10-16T00:00:00.000Z" },
    fs,
  );
  recordRunningServer(
    state,
    { pid: 2 ** 22 + 1, version: "0.0.1", url: "http://127.0.0.1:2", started: "2026-10-16T00:00:00.000Z" },
    fs,
  );
  assert.deepEqual(checks(ADAPTER_VERSION), ["PASS version", "WARN running"]);
  assert.deepEqual(checks("999.0.0"), ["WARN version", "WARN running"]);
  assert.deepEqual(checks(new Error("offline")), ["INFO version", "WARN running"]);
  forget();
  recordRunningServer(
    state,
    { pid: process.pid, version: ADAPTER_VERSION, url: "http://127.0.0.1:1", started: "2026-10-16T00:00:00.000Z" },
    fs,
  );
  assert.deepEqual(checks(ADAPTER_VERSION), ["PASS version", "PASS running"]);
});

test("doctor ignores a dead recorded server on macOS too", (t) => {
  const { home, settings, ctx } = fixture(t);
  const state = join(home, "state");
  recordRunningServer(
    state,
    { pid: 2 ** 22 + 1, version: "0.0.1", url: "http://127.0.0.1:2", started: "2026-10-16T00:00:00.000Z" },
    fs,
  );
  const report = doctor(
    { settings },
    { ...ctx, platform: "darwin", env: { ...ctx.env, ANTECHAMBER_STATE_DIR: state } },
  );
  assert.equal(report.checks.find((check) => check.name === "running")?.status, "INFO");
});

test("doctor fails when backend cannot be resolved", (t) => {
  const { home, settings, ctx } = fixture(t);
  fs.unlinkSync(join(home, "omo"));
  const report = doctor({ settings }, ctx);
  assert.equal(report.exitCode, 1);
  assert.equal(report.checks.find((check) => check.name === "backend")?.status, "FAIL");
});

test("doctor warns that plain pi is best effort", (t) => {
  const { settings, ctx } = fixture(t, "pi");
  const report = doctor({ settings }, ctx);
  assert.equal(report.exitCode, 0);
  assert.equal(report.checks.find((check) => check.name === "backend-kind")?.status, "WARN");
});

test("doctor fails on an old Node version and a failed backend version probe", (t) => {
  const { settings, ctx } = fixture(t);
  const report = doctor(
    { settings },
    {
      ...ctx,
      nodeVersion: "20.19.0",
      exec: () => {
        throw new Error("version probe timed out");
      },
    },
  );
  assert.equal(report.exitCode, 1);
  assert.equal(report.checks.find((check) => check.name === "node")?.status, "FAIL");
  assert.equal(report.checks.find((check) => check.name === "backend")?.status, "FAIL");
  assert.equal(report.checks.find((check) => check.name === "private-host-teardown")?.status, "WARN");
});

test("doctor warns for missing OpenChamber and mismatched or malformed settings", (t) => {
  const { home, settings, ctx } = fixture(t);
  fs.unlinkSync(join(home, "openchamber"));
  fs.writeFileSync(settings, "{");
  const report = doctor({ settings }, { ...ctx, platform: "darwin", fs: { ...ctx.fs, accessSync: () => undefined } });
  assert.equal(report.exitCode, 0);
  assert.equal(report.checks.find((check) => check.name === "openchamber")?.status, "WARN");
  assert.equal(report.checks.find((check) => check.name === "openchamber-settings")?.status, "WARN");
  assert.equal(report.checks.find((check) => check.name === "private-host-teardown")?.status, "PASS");
});

test("doctor names the teardown mechanism of the platform it runs on", (t) => {
  const { settings, ctx } = fixture(t);
  const teardown = (report: ReturnType<typeof doctor>) =>
    report.checks.find((check) => check.name === "private-host-teardown");

  const darwin = doctor({ settings }, { ...ctx, platform: "darwin", fs: { ...ctx.fs, accessSync: () => undefined } });
  assert.equal(teardown(darwin)?.status, "PASS");
  assert.match(teardown(darwin)?.message ?? "", /ps \+ lsof/);

  const missing = doctor(
    { settings },
    {
      ...ctx,
      platform: "darwin",
      fs: {
        ...ctx.fs,
        accessSync: (path: Parameters<typeof fs.accessSync>[0], mode?: number) => {
          if (path === "/bin/ps" || path === "/usr/sbin/lsof") throw new Error("EACCES");
          return ctx.fs.accessSync(path, mode);
        },
      },
    },
  );
  assert.equal(teardown(missing)?.status, "WARN");
  assert.match(teardown(missing)?.message ?? "", /unavailable: \/bin\/ps, \/usr\/sbin\/lsof/);

  const elsewhere = doctor({ settings }, { ...ctx, platform: "win32" });
  assert.equal(teardown(elsewhere)?.status, "WARN");
  assert.match(teardown(elsewhere)?.message ?? "", /not supported on win32/);
});

test("doctor reports auth presence without disclosing the password", (t) => {
  const { settings, ctx } = fixture(t);
  const text = formatDoctor(
    doctor({ settings }, { ...ctx, env: { ...ctx.env, OPENCODE_SERVER_PASSWORD: "secret-token" } }),
    false,
  );
  assert.ok(text.includes("INFO auth:"));
  assert.equal(text.includes("secret-token"), false);
});
