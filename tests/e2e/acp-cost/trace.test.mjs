import assert from "node:assert/strict";
import test from "node:test";
import { inspectPricingTrace } from "./trace.mjs";
function fixture() {
  const trace = { traceID: "t", processes: {}, spans: [] };
  const add = (id, parent, service, operationName, tags) => {
    trace.processes[service] = { serviceName: service };
    trace.spans.push({
      traceID: "t",
      spanID: id,
      processID: service,
      operationName,
      startTime: 10,
      duration: 1,
      references: parent
        ? [{ refType: "CHILD_OF", traceID: "t", spanID: parent }]
        : [],
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    });
  };
  const expected = {
    traceID: "t",
    route: "/internal/model-profiles/{model_profile_id}/revisions",
    publicRoute: "/api/admin/model-profiles/{model_profile_id}/revisions",
  };
  const http = (route) => ({
    "span.kind": "server",
    "http.route": route,
    "http.request.method": "POST",
    "http.response.status_code": 201,
  });
  add(
    "edge",
    undefined,
    "edge-gateway",
    "HTTP POST",
    http("/api/admin/{path...}"),
  );
  add("edge-client", "edge", "edge-gateway", "HTTP POST", {
    "span.kind": "client",
  });
  add(
    "console",
    "edge-client",
    "admin-console",
    "HTTP POST",
    http(expected.publicRoute),
  );
  add("console-client", "console", "admin-console", "HTTP POST", {
    "span.kind": "client",
  });
  add(
    "controller",
    "console-client",
    "agent-controller",
    "HTTP POST",
    http(expected.route),
  );
  add("tx", "controller", "agent-controller", "postgresql transaction", {
    "db.system.name": "postgresql",
    "antnest.transaction.outcome": "committed",
  });
  add("write", "tx", "agent-controller", "UPDATE", {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "UPDATE",
    "db.query.text": "UPDATE model_profiles SET model = $1",
  });
  return { trace, expected };
}
test("current pricing evidence requires the exact HTTP command and committed SQL write", () => {
  const f = fixture();
  assert.equal(inspectPricingTrace(f.trace, f.expected).persistence, true);
  for (const mutate of [
    (f) => {
      f.expected.traceID = "wrong";
    },
    (f) => {
      f.expected.route = "/retired";
    },
    (f) => {
      f.trace.spans = f.trace.spans.filter((s) => s.spanID !== "write");
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "write").references[0].spanID =
        "controller";
    },
    (f) => {
      f.trace.spans.find((s) => s.spanID === "tx").tags[1].value =
        "rolled_back";
    },
    (f) => {
      f.trace.spans[0].tags.push({ key: "error", value: true });
    },
    (f) => {
      f.trace.spans[0].tags.push({ key: "private", value: "PRIVATE" });
    },
  ]) {
    const bad = fixture();
    mutate(bad);
    assert.throws(() =>
      inspectPricingTrace(bad.trace, bad.expected, ["PRIVATE"]),
    );
  }
});
test("pricing timing warnings remain strict failures without weakening ancestry", () => {
  const f = fixture();
  f.trace.spans[2].warnings = ["clock skew"];
  const result = inspectPricingTrace(f.trace, f.expected);
  assert.equal(result.strict_trace, "failed");
  assert.equal(result.warning_count, 1);
});
