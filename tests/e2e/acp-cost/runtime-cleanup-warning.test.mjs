import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { costCollectorFixture } from "./collector.fixture.mjs";
import { inspectCostWarningSources } from "./warning-source.mjs";
import { progressTraceFixture } from "../acp-progress/trace.fixture.mjs";
import {
  collectPrivateProgressTrace,
  privateProgressStrictOutcome,
} from "../acp-progress/collector.mjs";
import { addToolLifecycleReceipt } from "../observability/runtime-information-run-fixtures.mjs";
import { inspectRuntimeToolLifecycle } from "../observability/runtime-tool-lifecycle.mjs";
import { tag } from "../observability/trace-tree.mjs";

const warning =
  "clock skew adjustment disabled; not applying calculated delta of -1.023556ms";
const reason = "reviewed-runtime-tool-http-cleanup";
const end = (span) => span.startTime + span.duration;
function fixture(t, version = 1, difference = 112) {
  const source = progressTraceFixture(`v${version}-bash-failure`);
  addToolLifecycleReceipt(source.trace, source.call, {
    cancelledClients: ["tools/call"],
  });
  const f = costCollectorFixture(t, source);
  const client = f.trace.spans.find(
    (span) => span.spanID === f.server.references[0].spanID,
  );
  // The generic cross-process fixture starts Rust 300us before this CLIENT.
  // This positive case instead models the observed non-inverted response
  // window. Move only controlled fixture data, never archived raw evidence.
  const subtree = new Set([f.server.spanID]);
  for (let prior = -1; prior !== subtree.size;) {
    prior = subtree.size;
    for (const span of f.trace.spans)
      if (
        span.references.some(
          (ref) => ref.refType === "CHILD_OF" && subtree.has(ref.spanID),
        )
      )
        subtree.add(span.spanID);
  }
  const delta = Math.max(0, client.startTime - f.server.startTime);
  for (const span of f.trace.spans.filter((span) => subtree.has(span.spanID))) {
    span.startTime += delta;
    for (const event of span.logs ?? []) event.timestamp += delta;
  }
  f.set(f.trace.processes[client.processID], "process.runtime.name", "nodejs");
  const resource = f.trace.processes[f.server.processID];
  f.set(resource, "antnest.runtime.image.id", `sha256:${"a".repeat(64)}`);
  f.set(resource, "antnest.runtime.image.reference", "antnest/runtime:fixture");
  f.server.duration = end(client) + difference - f.server.startTime;
  f.server.logs[0].timestamp = end(f.server);
  f.server.warnings = [warning];
  return { ...f, client, resource };
}
const policy = (f) => inspectCostWarningSources([f.trace]);
const proof = (f) =>
  inspectRuntimeToolLifecycle(f.trace, f.call, {
    agentId: f.expected.agentId,
    executionId: tag(f.call, "antnest.runtime.execution.id"),
  });

for (const version of [1, 2])
  for (const difference of [112, 1000, 15000])
    test(`v${version} ${difference}us Runtime tail requires the original successful parsed cleanup`, (t) => {
      const f = fixture(t, version, difference);
      const before = structuredClone(f.trace);
      assert(proof(f).ownedCancellations.has(f.client));
      const result = policy(f);
      assert.equal(result.eligible_for_review, true);
      assert.equal(result.eligible_for_deferral, false);
      assert.equal(result.deferred_warning_count, 0);
      assert.equal(result.reviewed_lifecycle_warning_count, 1);
      assert.equal(result.sources[0].classification, reason);
      assert.equal(result.sources[0].raw_end_beyond_parent_us, difference);
      assert.equal(
        result.sources[0].runtime_cleanup.tool_span_id,
        f.call.spanID,
      );
      assert.equal(
        result.sources[0].runtime_cleanup.operation_span_id,
        f.operation.spanID,
      );
      assert.equal(
        result.sources[0].runtime_cleanup.runtime_image_id,
        `sha256:${"a".repeat(64)}`,
      );
      assert.deepEqual(f.trace, before);
    });

test("Runtime cleanup warning propagation keeps the unique HTTP source and raw occurrences", (t) => {
  const f = fixture(t);
  f.operation.warnings = [warning];
  const result = policy(f);
  assert.equal(result.reviewed_lifecycle_warning_count, 2);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].span_id, f.server.spanID);
  assert.equal(result.sources[0].occurrences.length, 2);
});

for (const [name, mutate] of [
  ["missing parsed result", (f) => f.call.logs.splice(2, 1)],
  [
    "caller cancellation",
    (f) => f.set(f.call, "antnest.mcp.caller_cancelled", true),
  ],
  [
    "failed close",
    (f) => f.set(f.call, "antnest.mcp.connection.close.outcome", "failed"),
  ],
  [
    "unparsed result",
    (f) => f.set(f.call, "antnest.mcp.tool_result.outcome", "not_received"),
  ],
  [
    "no owned CLIENT cancellation",
    (f) => {
      f.set(f.client, "antnest.outcome", undefined);
      f.client.logs = [];
    },
  ],
  [
    "partial response bytes",
    (f) => f.set(f.client, "http.response.body.size", 1),
  ],
  [
    "zero response bytes",
    (f) => {
      f.set(f.client, "http.response.body.size", 0);
      f.set(f.server, "http.response.body.size", 0);
    },
  ],
  [
    "foreign Agent resource",
    (f) => f.set(f.resource, "antnest.agent.id", "foreign"),
  ],
  [
    "foreign Runtime generation",
    (f) => f.set(f.resource, "antnest.runtime.generation", "99"),
  ],
  [
    "foreign execution",
    (f) => f.set(f.operation, "antnest.runtime.execution.id", "foreign"),
  ],
  [
    "missing image ID",
    (f) => f.set(f.resource, "antnest.runtime.image.id", undefined),
  ],
  [
    "invalid image ID",
    (f) => f.set(f.resource, "antnest.runtime.image.id", "latest"),
  ],
  [
    "missing image reference",
    (f) => f.set(f.resource, "antnest.runtime.image.reference", undefined),
  ],
  ["unknown SDK", (f) => f.set(f.resource, "telemetry.sdk.language", "other")],
  [
    "duplicate resource",
    (f) =>
      f.resource.tags.push({
        key: "antnest.agent.id",
        value: f.expected.agentId,
      }),
  ],
  [
    "missing Node process identity",
    (f) =>
      f.set(f.trace.processes[f.client.processID], "process.pid", undefined),
  ],
  [
    "non-Node client",
    (f) =>
      f.set(
        f.trace.processes[f.client.processID],
        "process.runtime.name",
        "go",
      ),
  ],
  [
    "foreign operation parent",
    (f) => (f.operation.references[0].spanID = f.call.spanID),
  ],
  [
    "borrowed completion event",
    (f) => f.eventField(f.operation.logs[0], "span_id", f.server.spanID),
  ],
  ["unknown Runtime ERROR", (f) => f.set(f.server, "error", true)],
  [
    "failed protocol",
    (f) => f.set(f.server, "antnest.protocol.outcome", "error"),
  ],
  [
    "failed transport",
    (f) => f.set(f.server, "http.transport.outcome", "error"),
  ],
  [
    "unknown CLIENT diagnostic",
    (f) => f.set(f.client, "error.type", "unknown"),
  ],
  [
    "server begins before CLIENT",
    (f) => {
      const old = end(f.server);
      f.server.startTime = f.client.startTime - 1;
      f.server.duration = old - f.server.startTime;
    },
  ],
  [
    "whole Runtime subtree shifted past peer completion",
    (f) => {
      const delta = end(f.client) + 1 - f.server.startTime;
      for (const span of f.trace.spans.filter(
        (s) => s.processID === f.server.processID,
      )) {
        span.startTime += delta;
        for (const event of span.logs ?? []) event.timestamp += delta;
      }
    },
  ],
  ["unknown warning", (f) => f.server.warnings.push("unknown")],
  ["duplicate warning", (f) => f.server.warnings.push(warning)],
  [
    "second inverted propagation edge",
    (f) => {
      f.operation.warnings = [warning];
      f.operation.duration = end(f.server) - f.operation.startTime + 1;
    },
  ],
])
  test(`Runtime cleanup review rejects ${name}`, (t) => {
    const f = fixture(t);
    mutate(f);
    try {
      const result = policy(f);
      assert.equal(result.eligible_for_review, false);
      assert.equal(result.reviewed_lifecycle_warning_count, 0);
      assert(result.rejected_warning_count > 0);
    } catch (error) {
      assert.match(error.message, /invalid Cost warning sources/u);
    }
  });

for (const version of [1, 2])
  test(`Progress v${version} keeps successful parsed cleanup warning in three original archives`, async (t) => {
    const f = fixture(t, version);
    const before = structuredClone([...f.raw]);
    const result = await collectPrivateProgressTrace(
      "http://jaeger",
      f.expected,
      f.options,
    );
    const outcome = privateProgressStrictOutcome([result]);
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.exit_code, 2);
    assert.equal(result.strict_trace, "failed");
    assert.deepEqual(result.warnings, [warning]);
    assert.equal(result.progress_warning_review.deferred_warning_count, 0);
    assert.equal(
      result.progress_warning_review.waived_external_sdk_warning_count,
      1,
    );
    const archived = JSON.parse(
      readFileSync(
        join(result.evidence_directory, "progress-warning-review.private.json"),
      ),
    );
    assert.equal(archived.samples.length, 3);
    assert(
      archived.samples.every(
        (s) =>
          s.policy.sources[0].classification === "waived-external-otel-timing",
      ),
    );
    assert.deepEqual([...f.raw], before);
  });
