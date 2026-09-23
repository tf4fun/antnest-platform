import assert from "node:assert/strict";
import test from "node:test";
import { inspectPolicyTrace } from "./network-flow.mjs";

const item = { traceID: "trace", agentID: "agent-a", action: "deny_all" };
function fixture() {
  return {
    traceID: "trace",
    processes: Object.fromEntries(
      [
        "edge-gateway",
        "admin-console",
        "agent-controller",
        "antnest-runtime-egress",
      ].map((serviceName, i) => [i, { serviceName }]),
    ),
    spans: [0, 1, 2, 3].map((i) => ({
      processID: String(i),
      traceID: "trace",
      spanID: String(i),
      operationName:
        i === 3
          ? "HTTP PUT /internal/agent-policy-assignments/{agent_id}"
          : "HTTP",
      references:
        i === 0
          ? []
          : [{ refType: "CHILD_OF", traceID: "trace", spanID: String(i - 1) }],
      tags:
        i !== 3
          ? []
          : Object.entries({
              "http.request.method": "PUT",
              "http.route": "/internal/agent-policy-assignments/{agent_id}",
              "http.response.status_code": 200,
              "antnest.agent.id": "agent-a",
            }).map(([key, value]) => ({ key, value })),
    })),
  };
}
test("policy trace requires exact successful Egress write under Gateway and Console ancestry", () => {
  assert.equal(inspectPolicyTrace(fixture(), item).gateway_ancestry, true);
  const rust = fixture();
  rust.spans[3].tags.find((t) => t.key === "http.response.status_code").value =
    "200";
  assert.equal(inspectPolicyTrace(rust, item).gateway_ancestry, true);
});
for (const [label, mutate] of [
  [
    "malformed status",
    (t) =>
      (t.spans[3].tags.find(
        (x) => x.key === "http.response.status_code",
      ).value = "200 failed"),
  ],
  [
    "foreign agent",
    (t) =>
      (t.spans[3].tags.find((x) => x.key === "antnest.agent.id").value =
        "agent-b"),
  ],
  [
    "failed RPC",
    (t) =>
      (t.spans[3].tags.find(
        (x) => x.key === "http.response.status_code",
      ).value = 500),
  ],
  [
    "wrong route",
    (t) =>
      (t.spans[3].tags.find((x) => x.key === "http.route").value = "/other"),
  ],
  ["duplicate write", (t) => t.spans.push({ ...t.spans[3], spanID: "extra" })],
  ["detached Egress", (t) => (t.spans[3].references = [])],
  ["missing Console", (t) => (t.spans[2].references[0].spanID = "0")],
])
  test(`policy trace rejects ${label}`, () => {
    const trace = fixture();
    mutate(trace);
    assert.throws(() => inspectPolicyTrace(trace, item));
  });

test("policy topology retains timing warnings as strict failure without changing raw spans", () => {
  const trace = fixture();
  trace.spans[3].warnings = ["clock skew adjustment disabled; fixture"];
  const before = structuredClone(trace);
  const result = inspectPolicyTrace(trace, item);
  assert.equal(result.gateway_ancestry, true);
  assert.equal(result.strict_trace, "failed");
  assert.deepEqual(trace, before);
});
test("policy evidence scans supplied actual credentials and rejects errors anywhere in the trace", () => {
  const trace = fixture();
  trace.spans[0].tags.push({
    key: "unexpected",
    value: "actual-session-cookie",
  });
  assert.throws(() =>
    inspectPolicyTrace(trace, item, ["actual-session-cookie"]),
  );
  const failed = fixture();
  failed.spans[0].tags.push({ key: "otel.status_code", value: "ERROR" });
  assert.throws(() => inspectPolicyTrace(failed, item));
});
