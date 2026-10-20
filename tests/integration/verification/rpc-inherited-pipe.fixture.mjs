#!/usr/bin/env node
// The leader exits, leaving a child holding its original stdout/stderr pipes.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.argv[2] === "hold") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  process.send("ready");
  process.disconnect();
} else {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "hold"],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  child.once("message", () => process.exit(0));
}
