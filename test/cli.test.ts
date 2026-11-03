import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { ADAPTER_VERSION } from "../src/version.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function environment(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "antechamber-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { ...process.env, HOME: home, ANTECHAMBER_STATE_DIR: join(home, "state"), OMO_CODING_AGENT_DIR: home };
}

for (const flag of ["--version", "-v"]) {
  test(`${flag} preserves the OpenChamber version probe`, (t) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, flag], {
      env: environment(t),
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "opencode v2.999.0\n");
  });
}

test("version prints the package version without starting a server", (t) => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "version"], {
    env: environment(t),
    encoding: "utf8",
    timeout: 2000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `antechamber ${manifest.version} (OpenCode API v2.999.0)\n`);
  assert.equal(ADAPTER_VERSION, manifest.version);
});

for (const command of ["help", "--help"]) {
  test(`${command} exits without starting a server`, (t) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, command], {
      env: environment(t),
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.startsWith("Usage: antechamber"));
  });
}

test("doctor --json exits nonzero for a missing backend without creating directories", (t) => {
  const env = environment(t);
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "doctor", "--json"], {
    env: { ...env, PATH: env.HOME, ANTECHAMBER_PI_BINARY: "missing-backend" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, 1);
  assert.ok(
    report.checks.some(
      (check: { name: string; status: string }) => check.name === "backend" && check.status === "FAIL",
    ),
  );
});

test("serve preserves the OpenChamber listening line and clean shutdown", { timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, ["--import", "tsx", cli, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: environment(t),
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const closed = once(child, "close");
  const line = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("\n")) resolve(output.split("\n")[0] ?? "");
    });
    child.on("exit", (code) => {
      if (!output.includes("\n")) reject(new Error(`server exited ${code}`));
    });
  });
  assert.match(line, /^opencode server listening on http:\/\/127\.0\.0\.1:\d+$/);
  child.kill("SIGTERM");
  const [code] = await closed;
  assert.equal(code, 0);
});

test("npm package configuration retains the CLI and supported Node runtime", () => {
  assert.equal(manifest.bin.antechamber, "dist/cli.js");
  assert.ok(manifest.files.includes("dist"));
  assert.equal(manifest.engines.node, ">=22");
  assert.deepEqual(manifest.publishConfig, { access: "public", provenance: true });
});
