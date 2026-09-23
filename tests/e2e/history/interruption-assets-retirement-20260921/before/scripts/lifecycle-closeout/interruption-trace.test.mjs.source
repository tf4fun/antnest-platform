import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectInterruptedTrace } from "./interruption-trace.mjs";
import { createHash } from "node:crypto";
const child =
  "acr_" +
  createHash("sha256")
    .update("request-test\0runtime_update")
    .digest("hex")
    .slice(0, 32);
import { workflowFixture } from "../observability/workflow-fixtures.mjs";
function fixture() {
  const admission = workflowFixture("rebuild");
  const rpc = admission.spans.find(
    (s) => s.spanID === "client-rpc-lifecycle.runtime_update",
  );
  rpc.tags.push(
    { key: "rpc.method", value: "update" },
    { key: "antnest.operation.request_id", value: child },
    { key: "http.response.status_code", value: 200 },
  );
  return {
    admission,
    requestID: "request-test",
    agentID: "agent-test",
    killed: {
      request_id: "request-test",
      agent_id: "agent-test",
      phase: "runtime_update",
      child_request_id: child,
    },
  };
}
test("recovery uses SDK ancestry and the original downstream request", () => {
  assert.equal(
    inspectInterruptedTrace(fixture()).recovered_child_request,
    child,
  );
});
for (const [name, mutate] of [
  [
    "wrong child",
    (f) => {
      f.killed.child_request_id = "other";
    },
  ],
  [
    "wrong agent",
    (f) => {
      f.killed.agent_id = "other";
    },
  ],
  [
    "wrong phase",
    (f) => {
      f.killed.phase = "publish";
    },
  ],
  [
    "missing server",
    (f) => {
      f.admission.spans = f.admission.spans.filter(
        (s) => s.spanID !== "rpc-lifecycle.runtime_update",
      );
    },
  ],
  [
    "missing workflow",
    (f) => {
      f.admission.spans = f.admission.spans.filter(
        (s) => s.spanID !== "workflow",
      );
    },
  ],
  [
    "unrelated RPC",
    (f) => {
      f.admission.spans.find(
        (s) => s.spanID === "rpc-lifecycle.runtime_update",
      ).references[0].spanID = "gateway";
    },
  ],
])
  test("rejects " + name, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspectInterruptedTrace(f));
  });
