import assert from "node:assert/strict";
import test from "node:test";
import { withSuspendedRuntime } from "./health-flow.mjs";

for (const fault of ["none", "pause", "observe"]) {
  test(`owned Runtime always resumes after ${fault}`, async () => {
    const calls = [];
    const failure = new Error("verification interrupted");
    const pause = async (args) => {
      calls.push(args);
      if (fault === "pause") throw failure;
    };
    // Separate cleanup client remains usable after the verification client fails.
    const resume = async (args) => calls.push(args);
    const action = async () => {
      calls.push("observe");
      if (fault === "observe") throw failure;
      return "healthy evidence";
    };
    const result = withSuspendedRuntime(pause, resume, "owned-id", action);
    if (fault === "none") assert.equal(await result, "healthy evidence");
    else await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(calls[0], ["kill", "--signal", "STOP", "owned-id"]);
    assert.deepEqual(calls.at(-1), ["kill", "--signal", "CONT", "owned-id"]);
    assert.equal(
      calls.filter((c) => c === "observe").length,
      fault === "pause" ? 0 : 1,
    );
  });
}
