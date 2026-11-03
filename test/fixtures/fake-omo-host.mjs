import { spawn } from "node:child_process";
import { once } from "node:events";

// A detached supervisor and an engine in its group, like OmO's private shard.
// FAKE_OMO_HOST_ORPHAN_ENGINE=1: the engine ignores SIGTERM and the supervisor exits without it,
// leaving a group member whose leader is gone.
const orphan = process.env.FAKE_OMO_HOST_ORPHAN_ENGINE === "1";
const engine = spawn(
  process.execPath,
  [
    "-e",
    `${orphan ? 'process.on("SIGTERM", () => {}); ' : ""}process.stdout.write("READY\\n"); setInterval(() => {}, 2147483647)`,
    "--",
    "--mode",
    "rpc",
    "--multi-session",
  ],
  { stdio: ["ignore", "pipe", "ignore"] },
);
const exited = once(engine, "exit");
process.on("SIGTERM", () => {
  if (orphan) process.exit(0);
  engine.kill("SIGTERM");
  void exited.then(() => process.exit(0));
});
await once(engine.stdout, "data");
process.stdout.write(`${JSON.stringify({ pid: process.pid, enginePid: engine.pid })}\n`);
