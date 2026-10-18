import assert from "node:assert/strict";
import test from "node:test";
import { assertHealthOwner, withSuspendedRuntime } from "./health-flow.mjs";

test("Health binds the member to the original creation organization without requiring private fields in Console", () => {
  const agent = { agent_id: "agent", owner_user_id: "member" };
  const scope = encodeURIComponent(JSON.stringify(["organization", "admin"]));
  assertHealthOwner(
    { organization_id: "organization", user_id: "member" },
    agent,
    scope,
  );
  for (const principal of [
    { organization_id: "foreign", user_id: "member" },
    { organization_id: "organization", user_id: "admin" },
  ])
    assert.throws(() => assertHealthOwner(principal, agent, scope));
});

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

for (const fault of ["pause", "observe", "cancel"]) {
  test(`owned Runtime retains ${fault} and independent resume failures`, async () => {
    const original = new Error(fault);
    const cleanup = new Error("SIGCONT failed");
    const calls = [];
    const pause = async () => {
      calls.push("pause");
      if (fault === "pause") throw original;
    };
    await assert.rejects(
      withSuspendedRuntime(
        pause,
        async () => {
          calls.push("resume");
          throw cleanup;
        },
        "owned-id",
        async () => {
          if (fault === "cancel") {
            const controller = new AbortController();
            controller.abort(original);
            controller.signal.throwIfAborted();
          }
          throw original;
        },
      ),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.errors[0] === original &&
        error.errors[1] === cleanup,
    );
    assert.deepEqual(calls, ["pause", "resume"]);
  });
}

test("successful observation still fails when independent resume fails", async () => {
  const cleanup = new Error("SIGCONT failed");
  await assert.rejects(
    withSuspendedRuntime(
      async () => {},
      async () => {
        throw cleanup;
      },
      "owned-id",
      async () => "done",
    ),
    (error) => error === cleanup,
  );
});
