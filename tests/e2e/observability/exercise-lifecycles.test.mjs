import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./exercise-lifecycles.mjs", import.meta.url);
for (const [name, args, message] of [
  [
    "unknown lifecycle",
    ["--kind", "restart"],
    "unsupported lifecycle selection",
  ],
  ["target missing", ["--kind", "disable"], "existing Agent required"],
  [
    "invalid target",
    ["--kind", "disable", "--agent", "../wrong"],
    "existing Agent required",
  ],
  [
    "ambiguous target",
    ["--agent", "agent_" + "a".repeat(32)],
    "Agent selection requires one lifecycle",
  ],
]) {
  test(`lifecycle runner rejects ${name} before reading credentials`, () => {
    const result = spawnSync(
      process.execPath,
      [script.pathname, "--confirm-development", ...args],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 1);
    assert(result.stderr.includes(message), result.stderr);
  });
}
