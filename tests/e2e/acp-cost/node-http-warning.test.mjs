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
  "clock skew adjustment disabled; not applying calculated delta of -4.722397ms";
const deferred = "deferred-node-http-sub-ms-endpoint";
const tags = (value) =>
  Object.entries(value).map(([key, value]) => ({ key, value }));
const set = (span, key, value) => {
  span.tags = span.tags.filter((item) => item.key !== key);
  span.tags.push({ key, value });
};

function fixture(t, version = 1, difference = 445) {
  const f = costCollectorFixture(t, costSessionTraceFixture({ version }));
  const trace = f.connectionTrace;
  const [client, server] = trace.spans;
  for (const span of [client, server]) {
    const resource = trace.processes[span.processID];
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
  client.startTime = 0;
  client.duration = 1000;
  server.startTime = 0;
  server.duration =
    client.startTime + client.duration + difference - server.startTime;
  server.warnings = [warning];
  return { ...f, source: trace, client, server };
}

for (const difference of [1, 445, 999, 1000, 1001])
  test(`Node HTTP ${difference}us endpoint deferral uses the raw difference`, (t) => {
    const f = fixture(t, 1, difference);
    const before = structuredClone(f.source);
    const result = inspectCostWarningSources([f.source]);
    assert.equal(result.eligible_for_deferral, difference < 1000);
    if (difference < 1000) {
      assert.equal(result.sources[0].classification, deferred);
      assert.equal(result.sources[0].raw_end_beyond_parent_us, difference);
      assert.equal(result.sources[0].calculated_delta_us, -4722.397);
      assert.equal(result.deferred_warning_count, 1);
    }
    assert.deepEqual(f.source, before);
  });

test("Node HTTP deferral retains propagated warnings on the original source edge", (t) => {
  const f = fixture(t);
  const child = {
    ...structuredClone(f.server),
    spanID: "3".repeat(16),
    operationName: "postgres.ready",
    startTime: 0,
    duration: 100,
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
  assert.equal(result.deferred_warning_count, 2);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].span_id, f.server.spanID);
  assert.equal(result.sources[0].occurrences.length, 2);
});

for (const [name, mutate] of [
  ["missing parent", (f) => f.source.spans.shift()],
  ["unknown warning", (f) => f.server.warnings.push("unexpected warning")],
  ["duplicate warning", (f) => f.server.warnings.push(warning)],
  [
    "non-Node client",
    (f) => set(f.source.processes.client, "process.runtime.name", "go"),
  ],
  ["unidentified Node", (f) => f.source.processes.client.tags.pop()],
  ["missing host", (f) => f.source.processes.client.tags.shift()],
  [
    "foreign client service",
    (f) => (f.source.processes.client.serviceName = "another-client"),
  ],
  [
    "foreign receiver service",
    (f) => (f.source.processes.acp.serviceName = "another-service"),
  ],
  ["wrong span kind", (f) => set(f.client, "span.kind", "internal")],
  ["wrong route", (f) => set(f.server, "http.route", "/control")],
  ["wrong method", (f) => set(f.client, "http.request.method", "POST")],
  ["status mismatch", (f) => set(f.client, "http.response.status_code", 200)],
  ["conflicting status alias", (f) => set(f.client, "http.status_code", 200)],
  [
    "duplicate boundary tag",
    (f) => f.client.tags.push({ key: "span.kind", value: "client" }),
  ],
  [
    "child starts before parent",
    (f) => (f.server.startTime = f.client.startTime - 1000),
  ],
  [
    "non-millisecond start",
    (f) => {
      f.server.startTime++;
      f.server.duration--;
    },
  ],
])
  test(`Node HTTP deferral rejects ${name}`, (t) => {
    const f = fixture(t);
    mutate(f);
    try {
      const result = inspectCostWarningSources([f.source]);
      assert.equal(result.eligible_for_deferral, false);
    } catch (error) {
      assert.match(error.message, /invalid Cost warning sources/u);
    }
  });

for (const [name, collect, outcome] of [
  ["Cost", collectPrivateCostTrace, privateCostStrictOutcome],
  ["Progress", collectPrivateProgressTrace, privateProgressStrictOutcome],
])
  for (const version of [1, 2])
    test(`${name} v${version} preserves strict failure while deferring the complete Node connection`, async (t) => {
      const f = fixture(t, version);
      const before = structuredClone([...f.raw]);
      // Both current OTLP and legacy Jaeger HTTP status spellings are valid.
      for (const span of [f.client, f.server])
        span.tags.find((item) => item.key === "http.response.status_code").key =
          "http.status_code";
      const raw = structuredClone([...f.raw]);
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
            sample.policy.sources[0].classification ===
            "waived-external-node-otel-timing",
        ),
      );
      assert.deepEqual([...f.raw], raw);
      assert.notDeepEqual(raw, before);
    });
