import assert from "node:assert/strict";
import { test } from "node:test";
import { assertKilled } from "./process.mjs";
test("SIGKILL evidence distinguishes interruption from graceful failure or a different container", () => {
  const before = {
      Id: "a",
      RestartCount: 0,
      Config: { Labels: { project: "owned" } },
      State: { Running: true, StartedAt: "start", OOMKilled: false },
    },
    after = structuredClone(before);
  after.State.Running = false;
  after.State.ExitCode = 137;
  assertKilled(before, after);
  for (const change of [
    (x) => (x.State.ExitCode = 1),
    (x) => (x.State.OOMKilled = true),
    (x) => (x.Id = "b"),
    (x) => (x.RestartCount = 1),
    (x) => (x.State.StartedAt = "changed"),
  ]) {
    const wrong = structuredClone(after);
    change(wrong);
    assert.throws(() => assertKilled(before, wrong));
  }
});
