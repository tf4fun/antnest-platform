import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { costCollectorFixture } from "./collector.fixture.mjs";
import { costSessionTraceFixture } from "./session-trace.fixture.mjs";
import { inspectCostWarningSources } from "./warning-source.mjs";
import {
  collectPrivateCostTrace,
  privateCostStrictOutcome,
} from "./collector.mjs";
import {
  collectPrivateProgressTrace,
  privateProgressStrictOutcome,
} from "../acp-progress/collector.mjs";

const warning =
  "clock skew adjustment disabled; not applying calculated delta of -5.275572ms";
const classification = "reviewed-node-ws-post-response-endpoint";
const events = [
  "antnest.http.upgrade.response.prepared",
  "antnest.http.upgrade.connection.setup.started",
  "antnest.http.upgrade.connection.setup.completed",
];
const tags = (value) =>
  Object.entries(value).map(([key, value]) => ({ key, value }));
const set = (span, key, value) => {
  span.tags = span.tags.filter((item) => item.key !== key);
  span.tags.push({ key, value });
};

function fixture(t, version = 1, difference = 1551) {
  const f = costCollectorFixture(t, costSessionTraceFixture({ version }));
  const source = f.connectionTrace;
  const [client, server] = source.spans;
  for (const span of [client, server]) {
    const resource = source.processes[span.processID];
    resource.tags = tags({
      "host.name": span.processID,
      "process.pid": 1,
      "service.instance.id": `${span.processID}:1`,
      ...Object.fromEntries(
        (resource.tags ?? []).map(({ key, value }) => [key, value]),
      ),
      "process.runtime.name": "nodejs",
      "telemetry.sdk.language": "nodejs",
      "telemetry.sdk.name": "opentelemetry",
    });
  }
  client.startTime = server.startTime = 0;
  client.duration = 1000;
  server.duration = 1000 + difference;
  server.logs = events.map((event, index) => ({
    timestamp: [500, 600, server.duration][index],
    fields: [{ key: "event", value: event, type: "string" }],
  }));
  server.warnings = [warning];
  return { ...f, source, client, server };
}

for (const version of [1, 2])
  for (const difference of [1000, 1551, 15000])
    test(`v${version} ${difference}us complete upgrade has a reviewed post-response lifetime`, (t) => {
      const f = fixture(t, version, difference);
      const before = structuredClone(f.source);
      const result = inspectCostWarningSources([f.source]);
      assert.equal(result.eligible_for_review, true);
      assert.equal(result.eligible_for_deferral, false);
      assert.equal(result.deferred_warning_count, 0);
      assert.equal(result.reviewed_lifecycle_warning_count, 1);
      assert.equal(result.rejected_warning_count, 0);
      assert.equal(result.sources[0].classification, classification);
      assert.equal(result.sources[0].raw_end_beyond_parent_us, difference);
      assert.equal(result.sources[0].calculated_delta_us, -5275.572);
      assert.deepEqual(result.sources[0].upgrade_events, f.server.logs);
      assert.deepEqual(f.source, before);
    });

test("an upgrade lifecycle does not extend or rename the sub-millisecond deferral", (t) => {
  const f = fixture(t, 1, 999);
  const result = inspectCostWarningSources([f.source]);
  assert.equal(result.eligible_for_review, true);
  assert.equal(result.eligible_for_deferral, true);
  assert.equal(result.deferred_warning_count, 1);
  assert.equal(result.reviewed_lifecycle_warning_count, 0);
  assert.equal(
    result.sources[0].classification,
    "deferred-node-http-sub-ms-endpoint",
  );
});

test("upgrade warning propagation retains the original source and every raw occurrence", (t) => {
  const f = fixture(t);
  const child = {
    ...structuredClone(f.server),
    spanID: "3".repeat(16),
    operationName: "postgres.ready",
    startTime: 0,
    duration: 100,
    logs: [],
    references: [
      {
        refType: "CHILD_OF",
        traceID: f.source.traceID,
        spanID: f.server.spanID,
      },
    ],
  };
  f.source.spans.push(child);
  const result = inspectCostWarningSources([f.source]);
  assert.equal(result.reviewed_lifecycle_warning_count, 2);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].span_id, f.server.spanID);
  assert.equal(result.sources[0].occurrences.length, 2);
  assert(result.inventory.every((item) => item.warning === warning));
});

for (const [name, mutate] of [
  ["missing parent", (f) => f.source.spans.shift()],
  ["missing phase", (f) => f.server.logs.shift()],
  ["failed setup", (f) => f.server.logs.pop()],
  ["duplicate phase", (f) => f.server.logs.push(f.server.logs[2])],
  ["out-of-order phases", (f) => f.server.logs.reverse()],
  ["inverted phase times", (f) => (f.server.logs[1].timestamp = 499)],
  ["phase before source", (f) => (f.server.logs[0].timestamp = -1)],
  ["phase after source", (f) => f.server.logs[2].timestamp++],
  ["fractional event time", (f) => (f.server.logs[0].timestamp += 0.5)],
  [
    "response prepared after peer receipt",
    (f) => {
      f.server.logs[0].timestamp = 1001;
      f.server.logs[1].timestamp = 1002;
    },
  ],
  [
    "whole server and phases shifted after peer receipt",
    (f) => {
      f.server.startTime += 5000;
      for (const event of f.server.logs) event.timestamp += 5000;
    },
  ],
  ["server starts before client", (f) => f.server.startTime--],
  [
    "phase name substitution",
    (f) => (f.server.logs[0].fields[0].value = "other.event"),
  ],
  [
    "phase attributes",
    (f) =>
      f.server.logs[0].fields.push({ key: "content", value: "unexpected" }),
  ],
  [
    "duplicate event field",
    (f) => f.server.logs[0].fields.push(f.server.logs[0].fields[0]),
  ],
  ["mistyped event field", (f) => (f.server.logs[0].fields[0].type = "int64")],
  ["missing process identity", (f) => f.source.processes.client.tags.shift()],
  [
    "non-Node client",
    (f) => set(f.source.processes.client, "process.runtime.name", "go"),
  ],
  [
    "foreign client",
    (f) => (f.source.processes.client.serviceName = "other-client"),
  ],
  [
    "foreign server",
    (f) => (f.source.processes.acp.serviceName = "other-server"),
  ],
  ["wrong route", (f) => set(f.server, "http.route", "/v1/control")],
  ["wrong listener", (f) => set(f.server, "antnest.listener", "control")],
  [
    "non-upgrade HTTP",
    (f) => {
      set(f.server, "http.response.status_code", 200);
      set(f.client, "http.response.status_code", 200);
    },
  ],
  ["method mismatch", (f) => set(f.client, "http.request.method", "POST")],
  ["status alias conflict", (f) => set(f.server, "http.status_code", 200)],
  [
    "duplicate boundary tag",
    (f) => f.server.tags.push({ key: "span.kind", value: "server" }),
  ],
  ["source ERROR", (f) => set(f.server, "otel.status_code", "ERROR")],
  ["client error", (f) => set(f.client, "error", true)],
  ["unknown warning", (f) => f.server.warnings.push("unknown")],
  ["duplicate warning", (f) => f.server.warnings.push(warning)],
])
  test(`upgrade lifetime review rejects ${name}`, (t) => {
    const f = fixture(t);
    mutate(f);
    try {
      const result = inspectCostWarningSources([f.source]);
      assert.equal(result.eligible_for_review, false);
      assert.equal(result.reviewed_lifecycle_warning_count, 0);
      assert(result.rejected_warning_count > 0);
    } catch (error) {
      assert.match(error.message, /invalid Cost warning sources/u);
    }
  });

for (const [name, collect, outcome] of [
  ["Cost", collectPrivateCostTrace, privateCostStrictOutcome],
  ["Progress", collectPrivateProgressTrace, privateProgressStrictOutcome],
])
  for (const version of [1, 2])
    test(`${name} v${version} binds lifecycle review to three archived samples and keeps strict failure`, async (t) => {
      const f = fixture(t, version);
      for (const span of [f.client, f.server])
        span.tags.find((item) => item.key === "http.response.status_code").key =
          "http.status_code";
      const before = structuredClone([...f.raw]);
      const result = await collect("http://jaeger", f.expected, f.options);
      const review = outcome([result]);
      assert.equal(review.accepted, true);
      assert.equal(review.exit_code, 2);
      assert.equal(result.strict_trace, "failed");
      assert.equal(result.warning_count, 1);
      assert.deepEqual(result.warnings, [warning]);
      assert.equal(result.complete_source_receipt.stable_samples, 3);
      const proof = JSON.parse(
        readFileSync(
          join(
            result.evidence_directory,
            `${name.toLowerCase()}-warning-review.private.json`,
          ),
        ),
      );
      assert(
        proof.samples.every(
          (sample) =>
            sample.policy.sources[0].classification === classification,
        ),
      );
      assert(
        proof.samples.every(
          (sample) => sample.policy.eligible_for_deferral === false,
        ),
      );
      const projection = result[`${name.toLowerCase()}_warning_review`];
      assert.equal(projection.deferred_warning_count, 0);
      assert.equal(projection.reviewed_lifecycle_warning_count, 1);
      assert.deepEqual([...f.raw], before);
    });
