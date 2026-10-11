import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { assertWorkspaceBytes } from "./browser-control.mjs";
import * as control from "./browser-control.mjs";

test("workspace mismatch fails without exposing actual bytes in error output", () => {
  const secret = "PRIVATE_FILE_CONTENT";
  assert.throws(
    () => assertWorkspaceBytes(Buffer.from(secret).toString("base64")),
    (error) => {
      assert(!inspect(error).includes(secret));
      return /workspace write duplicated or lost/.test(error.message);
    },
  );
  assertWorkspaceBytes(
    Buffer.from("C4_BROWSER_NOTE=alpha-beta\n").toString("base64"),
  );
});

const heldView = () => ({
  agentId: "agent",
  activeSessionId: "session",
  selectedSessionId: "session",
  availability: "busy",
  selectedView: { agentId: "agent", sessionId: "session" },
  operations: [
    {
      operationId: "old",
      sessionId: "session",
      phase: "completed",
      acceptance: "acp",
      runId: "old-run",
    },
    {
      operationId: "held",
      sessionId: "session",
      phase: "running",
      acceptance: "acp",
      runId: "held-run",
    },
  ],
});
const observe = (view) => {
  assert.equal(typeof control.observedHeldRun, "function");
  return control.observedHeldRun(view, "agent", "session");
};
test("C4 cancellation records the actual accepted Run from the member's current Bridge view", () => {
  const view = heldView();
  const before = JSON.stringify(view);
  assert.equal(observe(view).runId, "held-run");
  assert.equal(JSON.stringify(view), before);
});
for (const [name, change] of [
  ["foreign Agent", (v) => (v.agentId = "other")],
  ["foreign active Session", (v) => (v.activeSessionId = "other")],
  ["foreign selected Session", (v) => (v.selectedView.sessionId = "other")],
  ["not busy", (v) => (v.availability = "ready")],
  ["missing Run", (v) => delete v.operations[1].runId],
  ["unaccepted Run", (v) => (v.operations[1].acceptance = "bridge")],
  ["finished operation", (v) => (v.operations[1].phase = "completed")],
  [
    "ambiguous operation",
    (v) => v.operations.push({ ...v.operations[1], operationId: "other" }),
  ],
])
  test(`C4 held Run selection rejects ${name}`, () => {
    const view = heldView();
    observe(view);
    change(view);
    assert.throws(() => observe(view));
  });
