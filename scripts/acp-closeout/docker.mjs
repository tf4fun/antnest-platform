import { spawn } from "node:child_process";

// Docker commands may stall even when their surrounding polling loop is bounded.
const remaining = Number(process.env.ANTNEST_E2E_DEADLINE_MS) - Date.now();
if (!Number.isFinite(remaining) || remaining <= 0) process.exit(124);
const child = spawn("docker", process.argv.slice(2), {
  detached: true,
  stdio: "inherit",
});
let failure = 0;
const terminate = (code) => {
  failure = code;
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const timer = setTimeout(() => terminate(124), Math.min(30000, remaining));
process.on("SIGINT", () => terminate(130));
process.on("SIGTERM", () => terminate(143));
child.once("error", (error) => {
  console.error(error.message);
  failure = 1;
});
child.once("close", (code) => {
  clearTimeout(timer);
  process.exitCode = failure || code || (code === 0 ? 0 : 1);
});
