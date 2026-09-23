import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerInvocation } from "./docker.mjs";

test("short Docker probes retain their bound while lifecycle waits use the remaining budget", () => {
  assert.deepEqual(dockerInvocation(["inspect", "agent"], "901000", 1000), {
    args: ["inspect", "agent"],
    timeoutMs: 30000,
  });
  assert.deepEqual(
    dockerInvocation(
      ["--lifecycle", "compose", "up", "--wait"],
      "901000",
      1000,
    ),
    { args: ["compose", "up", "--wait"], timeoutMs: 900000 },
  );
});

test("neither command mode can extend or bypass the overall deadline", () => {
  for (const args of [["ps"], ["--lifecycle", "compose", "up"]]) {
    assert.equal(dockerInvocation(args, "2000", 1000).timeoutMs, 1000);
    for (const deadline of [undefined, "bad", "Infinity", "1000", "-1"])
      assert.equal(dockerInvocation(args, deadline, 1000), undefined);
  }
});
