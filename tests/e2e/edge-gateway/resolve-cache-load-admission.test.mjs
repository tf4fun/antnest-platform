import assert from "node:assert/strict";
import test from "node:test";
import * as admission from "../../support/resolve-cache-admission.mjs";
import * as lifecycle from "./resolve-cache-owner-drain.mjs";
import { loadAdmissionFixture } from "./resolve-cache-load-admission-fixtures.mjs";
import { inspectResolveLoad } from "./resolve-cache-load.mjs";

test("HTTP load admission retains raw shutdown errors and complete actual evidence", () => {
  const { report } = loadAdmissionFixture();
  const raw = JSON.stringify(report);
  admission.assertLoadAdmission(report);
  lifecycle.inspectLoadOwnerRestoration(report.owner_lifecycle);
  assert.equal(report.error_spans, 2);
  assert.equal(report.strict_trace, "failed");
  assert.equal(JSON.stringify(report), raw);
});

test("load inspector exports safe wire, complete raw error inventory and actual refresh links", () => {
  const { f, report } = loadAdmissionFixture();
  const result = inspectResolveLoad(f.wire, f.agentID, f.settings, f, []);
  for (const key of [
    "measurement",
    "raw_error_spans",
    "archived_trace_ids",
    "refreshes",
  ])
    assert.deepEqual(result[key], report[key], key);
  assert(
    !result.measurement.requests.some((row) => Object.hasOwn(row, "body")),
  );
});

test("load admission counts actual stream errors without requiring a fixed count", () => {
  for (const count of [0, 3]) {
    const { report } = loadAdmissionFixture();
    const cleanup = report.owner_cleanup;
    if (count === 0) {
      cleanup.streams.forEach((row) => (row.error = false));
      cleanup.classified_errors = [];
      report.raw_error_spans = [];
      report.strict_trace = "passed";
    } else {
      const extra = {
        ...structuredClone(cleanup.streams[0]),
        span_id: "f".repeat(16),
      };
      cleanup.streams.push(extra);
      cleanup.classified_errors.push({
        ...structuredClone(extra),
        reason: "actual-ui-owner-drain",
      });
      report.raw_error_spans.push({
        trace_id: extra.trace_id,
        span_id: extra.span_id,
      });
    }
    report.error_spans = count;
    admission.assertLoadAdmission(report);
  }
});

test("safe load projection normalizes verified metadata while preserving raw private wire", () => {
  const { f } = loadAdmissionFixture();
  f.wire.requests[0].content_type =
    "application/json; charset=utf-8; extension=remote-private-canary";
  f.wire.requests[0].cache_control = "no-store, remote-private-canary";
  const raw = JSON.stringify(f.wire);
  const result = inspectResolveLoad(f.wire, f.agentID, f.settings, f, []);
  assert.equal(result.measurement.requests[0].content_type, "application/json");
  assert.equal(result.measurement.requests[0].cache_control, "no-store");
  assert(!JSON.stringify(result.measurement).includes("remote-private-canary"));
  assert.equal(JSON.stringify(f.wire), raw);
});

for (const [name, value] of [
  ["content_type", "application/json; remote-private-canary"],
  ["cache_control", "no-store, remote-private-canary"],
])
  test(`aggregate rejects arbitrary remote text in normalized ${name}`, () => {
    const { report } = loadAdmissionFixture();
    admission.assertLoadAdmission(report);
    report.measurement.requests[0][name] = value;
    assert.throws(() => admission.assertLoadAdmission(report));
  });

for (const [name, mutate] of [
  ["legacy policy", (r) => (r.policy_revision = 3)],
  ["wrong transport", (r) => (r.transport = "wss")],
  ["wrong measurement Agent", (r) => (r.measurement.agent_id = "foreign")],
  [
    "incomplete response",
    (r) => (r.measurement.requests[99].body_complete = false),
  ],
  ["failed response", (r) => (r.measurement.requests[50].status = 503)],
  [
    "extra body",
    (r) => (r.measurement.requests[50].body = { sensitive: "unexpected" }),
  ],
  [
    "Cookie header retained",
    (r) => (r.measurement.requests[50].cookie = "private-token"),
  ],
  [
    "session rotation",
    (r) => (r.measurement.requests[50].set_cookie_count = 1),
  ],
  ["overlapping requests", (r) => (r.measurement.requests[50].started_at = 0)],
  [
    "response omitted from timing",
    (r) => (r.measurement.requests[99].completed_at = 8001),
  ],
  ["elapsed mismatch", (r) => (r.elapsed_ms = 1)],
  [
    "duplicate HTTP Trace",
    (r) =>
      (r.measurement.requests[99].trace_id =
        r.measurement.requests[98].trace_id),
  ],
  ["HTTP receipt order mismatch", (r) => r.requests.reverse()],
  ["missing initialization", (r) => delete r.requests[0].initialize_span_id],
  [
    "warm reinitialization",
    (r) =>
      (r.requests[1].initialize_span_id = r.requests[0].initialize_span_id),
  ],
  ["business SQL absent", (r) => (r.requests[4].list_sql = 0)],
  [
    "refresh linked to 99th request",
    (r) => (r.refreshes[0].trigger_trace_id = r.requests[98].trace_id),
  ],
  [
    "refresh wrong decision",
    (r) => (r.refreshes[0].trigger_decision_id = "f".repeat(16)),
  ],
  [
    "duplicate refresh",
    (r) => r.refreshes.push(structuredClone(r.refreshes[0])),
  ],
  ["missing actual CLIENT inventory", (r) => (r.gateway_clients = [])],
  [
    "duplicate actual CLIENT",
    (r) => (r.gateway_clients[1] = r.gateway_clients[0]),
  ],
  ["CLIENT count mismatch", (r) => (r.gateway_rpc_attempts = 3)],
  [
    "foreign SERVER Trace",
    (r) => (r.identity_servers[1] = "f".repeat(32) + ":" + "f".repeat(16)),
  ],
  [
    "unclaimed raw error",
    (r) => {
      r.raw_error_spans.push({
        trace_id: r.requests[1].trace_id,
        span_id: "f".repeat(16),
      });
      r.error_spans++;
    },
  ],
  [
    "duplicate raw error",
    (r) => {
      r.raw_error_spans.push(structuredClone(r.raw_error_spans[0]));
      r.error_spans++;
    },
  ],
  [
    "extra error claim",
    (r) =>
      r.owner_cleanup.classified_errors.push(
        structuredClone(r.owner_cleanup.classified_errors[0]),
      ),
  ],
  [
    "wrong error owner reason",
    (r) => (r.owner_cleanup.classified_errors[0].reason = "ignored-warning"),
  ],
  [
    "claim on foreign initial Trace",
    (r) =>
      (r.owner_cleanup.classified_errors[0].trace_id = r.requests[1].trace_id),
  ],
  [
    "error stream not classified",
    (r) => (r.owner_cleanup.streams[0].error = false),
  ],
  [
    "early stream end",
    (r) => (r.owner_cleanup.streams[0].end_interval_ms.lower = 1),
  ],
  [
    "foreign owner scope",
    (r) => (r.owner_cleanup.owner_scope.agent_id = "foreign"),
  ],
  [
    "wrong initial UI parent",
    (r) => (r.owner_cleanup.initial_ui_span_id = "f".repeat(16)),
  ],
  [
    "DELETE outside stop",
    (r) => (r.owner_cleanup.delete_end_interval_ms.upper = 99999),
  ],
  ["same ACP clock absent", (r) => delete r.owner_cleanup.clock],
  [
    "close Trace not archived",
    (r) =>
      (r.archived_trace_ids = r.archived_trace_ids.filter(
        (id) => id !== r.owner_cleanup.close_trace_id,
      )),
  ],
  [
    "duplicate source archive",
    (r) => r.archived_trace_ids.push(r.archived_trace_ids[0]),
  ],
  ["source diagnostic mismatch", (r) => r.source_trace_ids.pop()],
  ["only convergence boolean", (r) => (r.convergence = true)],
  ["two stable rounds", (r) => r.convergence.shift()],
  ["nonconsecutive rounds", (r) => r.convergence[1].attempt++],
  [
    "different snapshot",
    (r) => (r.convergence[1].snapshot_sha256 = "b".repeat(64)),
  ],
  ["different round archive", (r) => r.convergence[1].archived_trace_ids.pop()],
  [
    "different query results",
    (r) => r.convergence[1].causal_query_ids.identity.pop(),
  ],
  [
    "all rounds missing independent DELETE",
    (r) =>
      r.convergence.forEach((round) => (round.causal_query_ids.delete = [])),
  ],
  ["only restoration boolean", (r) => delete r.owner_lifecycle.restore],
  ["restoration not complete", (r) => (r.owner_lifecycle.restored = false)],
  [
    "lifecycle failure",
    (r) => r.owner_lifecycle.failures.push("archive failed"),
  ],
  [
    "missing participant",
    (r) => delete r.owner_lifecycle.restore.after.runtime,
  ],
  [
    "replacement UI",
    (r) => (r.owner_lifecycle.restore.after["agent-ui"].id = "f".repeat(64)),
  ],
  [
    "Runtime restart",
    (r) =>
      (r.owner_lifecycle.restore.after.runtime.started_at =
        "2026-10-14T00:00:09Z"),
  ],
  [
    "UI health failure",
    (r) => (r.owner_lifecycle.restore.after["agent-ui"].health = "unhealthy"),
  ],
  [
    "restoration deadline",
    (r) => (r.owner_lifecycle.restore.completed_at = 40000),
  ],
  [
    "warning erased",
    (r) => {
      r.warning_count = 1;
      r.warnings = [];
    },
  ],
  ["raw strict cleared", (r) => (r.strict_trace = "passed")],
])
  test(`HTTP load admission rejects ${name}`, () => {
    const { report } = loadAdmissionFixture();
    admission.assertLoadAdmission(report);
    const before = JSON.stringify(report);
    mutate(report);
    assert.notEqual(
      JSON.stringify(report),
      before,
      "counterexample must change the actual report",
    );
    assert.throws(() => admission.assertLoadAdmission(report));
  });
