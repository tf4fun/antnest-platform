import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as warningReview from "./warning-source.mjs";
import { costCollectorFixture } from "./collector.fixture.mjs";
import { costSessionTraceFixture } from "./session-trace.fixture.mjs";
import { progressTraceFixture } from "../acp-progress/trace.fixture.mjs";
import {
  collectPrivateCostTrace,
  privateCostStrictOutcome,
} from "./collector.mjs";
import {
  collectPrivateProgressTrace,
  privateProgressStrictOutcome,
} from "../acp-progress/collector.mjs";

const warning =
  "clock skew adjustment disabled; not applying calculated delta of -1.08351ms";
const classification = "waived-external-node-otel-timing";
const fields = (values) =>
  Object.entries(values).map(([key, value]) => ({ key, value }));
const review = (...args) => {
  assert.equal(typeof warningReview.reviewCostWarningSources, "function");
  return warningReview.reviewCostWarningSources(...args);
};

function fixture(t, version = 1) {
  const f = costCollectorFixture(t, costSessionTraceFixture({ version }));
  const source = f.connectionTrace;
  const [client, server] = source.spans;
  for (const span of [client, server]) {
    const resource = source.processes[span.processID];
    resource.tags = fields({
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
  client.duration = 3472;
  server.startTime = 2000;
  server.duration = 1639;
  server.warnings = [warning];
  const ready = {
    ...structuredClone(server),
    spanID: "3".repeat(16),
    operationName: "postgres.ready",
    duration: 442,
    references: [
      { refType: "CHILD_OF", traceID: source.traceID, spanID: server.spanID },
    ],
    tags: fields({ "span.kind": "internal", "db.system.name": "postgresql" }),
  };
  const sql = {
    ...structuredClone(ready),
    spanID: "4".repeat(16),
    operationName: "SELECT",
    startTime: 3000,
    duration: 296,
    references: [
      { refType: "CHILD_OF", traceID: source.traceID, spanID: ready.spanID },
    ],
    tags: fields({
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.query.text": "SELECT 1",
    }),
  };
  source.spans.push(ready, sql);
  return { ...f, source, client, server, ready, sql };
}

for (const version of [1, 2])
  test(`v${version} confirmed Node SDK timing diagnostics do not require per-edge proofs`, (t) => {
    const f = fixture(t, version);
    const before = structuredClone(f.source);
    assert.equal(
      warningReview.inspectCostWarningSources([f.source]).eligible_for_review,
      false,
    );
    const result = review([f.source]);
    assert.equal(result.eligible_for_review, true);
    assert.equal(result.waived_external_sdk_warning_count, 3);
    assert.equal(result.rejected_warning_count, 0);
    assert.equal(result.warning_count, 3);
    assert(
      result.inventory.every((item) => item.classification === classification),
    );
    assert.deepEqual(
      result.inventory.map((item) => item.warning),
      [warning, warning, warning],
    );
    assert.deepEqual(f.source, before);
  });

test("external SDK waiver has no one-millisecond investigation threshold", (t) => {
  const f = fixture(t);
  f.server.duration += 15000;
  f.sql.duration += 12000;
  const result = review([f.source]);
  assert.equal(result.eligible_for_review, true);
  assert.equal(result.waived_external_sdk_warning_count, 3);
});

for (const [name, mutate] of [
  ["unknown diagnostic", (f) => (f.sql.warnings = ["unknown warning"])],
  ["unattributed diagnostic", (f) => (f.source.warnings = [warning])],
  ["missing parent", (f) => (f.sql.references[0].spanID = "9".repeat(16))],
  ["unidentified process", (f) => (f.source.processes.acp.tags = [])],
  ["unknown service", (f) => (f.source.processes.acp.serviceName = "unknown")],
  [
    "unreviewed Go SDK",
    (f) => {
      for (const item of f.source.processes.acp.tags)
        if (
          ["process.runtime.name", "telemetry.sdk.language"].includes(item.key)
        )
          item.value = "go";
    },
  ],
])
  test(`external SDK policy does not relabel ${name}`, (t) => {
    const f = fixture(t);
    mutate(f);
    try {
      assert.equal(review([f.source]).eligible_for_review, false);
    } catch (error) {
      assert.match(error.message, /invalid Cost warning sources/u);
    }
  });

for (const [name, collect, outcome] of [
  ["Cost", collectPrivateCostTrace, privateCostStrictOutcome],
  ["Progress", collectPrivateProgressTrace, privateProgressStrictOutcome],
])
  for (const version of [1, 2])
    test(`${name} v${version} preserves SDK diagnostics and archive binding while continuing admission`, async (t) => {
      const f = fixture(t, version);
      const before = structuredClone([...f.raw]);
      const result = await collect("http://jaeger", f.expected, f.options);
      assert.equal(result.strict_trace, "failed");
      assert.equal(result.warning_count, 3);
      assert.equal(result.complete_source_receipt.stable_samples, 3);
      assert.equal(outcome([result]).accepted, true);
      assert.equal(outcome([result]).exit_code, 2);
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
          (sample) => sample.policy.waived_external_sdk_warning_count === 3,
        ),
      );
      assert.equal(
        result[`${name.toLowerCase()}_warning_review`]
          .waived_external_sdk_warning_count,
        3,
      );
      assert.deepEqual([...f.raw], before);
      result.warning_count = 0;
      assert.equal(outcome([result]).accepted, false);
    });

test("an internal connection error remains blocking with a known SDK warning", async (t) => {
  const f = fixture(t);
  f.sql.tags.push({ key: "error", value: true });
  await assert.rejects(
    collectPrivateProgressTrace("http://jaeger", f.expected, f.options),
  );
});

function runtimeFixture(t, phase = "v1-bash-cancel") {
  const f = costCollectorFixture(t, progressTraceFixture(phase));
  const client = f.trace.spans.find(
    (span) => span.spanID === f.server.references[0].spanID,
  );
  f.server.duration =
    client.startTime + client.duration + 2297 - f.server.startTime;
  f.server.warnings = [warning];
  return f;
}

for (const version of [1, 2])
  for (const tool of ["bash", "managed"])
    test(`v${version} ${tool} Runtime cancellation retains SDK timing diagnostics without blocking business acceptance`, async (t) => {
      const f = runtimeFixture(t, `v${version}-${tool}-cancel`);
      const before = structuredClone([...f.raw]);
      const result = await collectPrivateProgressTrace(
        "http://jaeger",
        f.expected,
        f.options,
      );
      assert.equal(result.strict_trace, "failed");
      assert.equal(result.warning_count, 1);
      assert.equal(
        result.progress_warning_review.waived_external_sdk_warning_count,
        1,
      );
      assert.equal(privateProgressStrictOutcome([result]).accepted, true);
      assert.equal(privateProgressStrictOutcome([result]).exit_code, 2);
      assert.deepEqual([...f.raw], before);
      const policy = review([f.trace]);
      assert.equal(
        policy.inventory[0].classification,
        "waived-external-otel-timing",
      );
      assert.equal(policy.sources[0].external_sdk, "opentelemetry-rust");
    });

for (const [name, mutate] of [
  [
    "internal error",
    (f) => f.set(f.server, "error.type", "unexpected_internal_failure"),
  ],
  [
    "unknown SDK",
    (f) =>
      f.set(
        f.trace.processes[f.server.processID],
        "telemetry.sdk.name",
        "unknown",
      ),
  ],
  ["missing parent", (f) => (f.server.references[0].spanID = "f".repeat(16))],
])
  test(`Runtime SDK timing waiver does not admit ${name}`, async (t) => {
    const f = runtimeFixture(t);
    mutate(f);
    await assert.rejects(
      collectPrivateProgressTrace("http://jaeger", f.expected, f.options),
    );
  });
