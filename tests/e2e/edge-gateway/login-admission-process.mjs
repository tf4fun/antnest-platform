import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ownerPath = (directory) => join(directory, "login-admission-owner.json");
const cancellationPath = (directory) =>
  join(directory, "login-admission-cancelled");
function readOwner(directory) {
  try {
    return JSON.parse(readFileSync(ownerPath(directory), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function claimClient(
  directory = "/tmp",
  { pid = process.pid, script = process.argv[1] } = {},
) {
  const owner = { pid, script, nonce: randomUUID() };
  writeFileSync(ownerPath(directory), JSON.stringify(owner), {
    mode: 0o600,
    flag: "wx",
  });
  // Publish ownership before checking the cancellation fence. A cancel that
  // observed no owner must still prevent a late Node initialization from doing
  // HTTP work; a cancel after this check will observe and join our PID.
  if (existsSync(cancellationPath(directory))) {
    releaseClient(directory, owner);
    throw new Error("login admission client cancelled before start");
  }
  return owner;
}

export function releaseClient(directory, owner) {
  const current = readOwner(directory);
  if (!current) return;
  assert.equal(current.nonce, owner.nonce, "client process ownership changed");
  unlinkSync(ownerPath(directory));
}

export async function cancelClient({
  directory = "/tmp",
  graceMs = 1000,
  joinMs = 5000,
  readCommand = (pid) =>
    readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"),
  kill = (pid, signal) => process.kill(pid, signal),
} = {}) {
  writeFileSync(cancellationPath(directory), "cancelled\n", { mode: 0o600 });
  const owner = readOwner(directory);
  if (!owner) return { joined: true, state: "idle", forced: false };
  assert(
    Number.isSafeInteger(owner.pid) &&
      owner.pid > 1 &&
      owner.pid !== process.pid,
  );
  const running = () => {
    try {
      kill(owner.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  let command;
  try {
    command = readCommand(owner.pid);
  } catch (error) {
    if (error.code !== "ENOENT" || running()) throw error;
  }
  let forced = false;
  if (command) {
    assert(command.includes(owner.script), "client process ownership mismatch");
    const signal = (value) => {
      try {
        kill(owner.pid, value);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    signal("SIGTERM");
    const graceful = performance.now() + graceMs;
    while (running() && performance.now() < graceful) await delay(10);
    if (running()) {
      forced = true;
      signal("SIGKILL");
    }
    const deadline = performance.now() + joinMs;
    while (running() && performance.now() < deadline) await delay(10);
    assert(!running(), "container client did not terminate");
  }
  releaseClient(directory, owner);
  return { joined: true, state: "terminated", forced };
}
