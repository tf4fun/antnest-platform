import assert from "node:assert/strict";
import { createRequire } from "node:module";

// An isolated diagnostic, not a zero-inversion test or a timestamp correction.
const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { node, tracing } = require("@opentelemetry/sdk-node");
const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer("sequential-sdk-timing-diagnostic");
const samples = 10_000;
const nanos = ([seconds, fraction]) => seconds * 1_000_000_000 + fraction;
try {
  for (let index = 0; index < samples; index++) {
    const model = tracer.startSpan("model");
    model.end();
    assert.equal(model.isRecording(), false);
    tracer.startSpan("finish").end();
  }
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, samples * 2);
  const gaps = [];
  for (let index = 0; index < spans.length; index += 2) {
    const model = spans[index];
    const finish = spans[index + 1];
    assert.equal(model.name, "model");
    assert.equal(finish.name, "finish");
    // Subtract seconds first to avoid floating-point loss at Unix nanoseconds.
    gaps.push(
      nanos([
        finish.startTime[0] - model.endTime[0],
        finish.startTime[1] - model.endTime[1],
      ]),
    );
  }
  console.log(
    JSON.stringify({
      status: "diagnostic_complete",
      node: process.version,
      sdk_trace: require("@opentelemetry/sdk-trace/package.json").version,
      samples,
      sequential_end_before_start_verified: true,
      inversions: gaps.filter((gap) => gap < 0).length,
      minimum_gap_ns: Math.min(...gaps),
      timestamps_modified: false,
      business_code_loaded: false,
    }),
  );
} finally {
  await provider.shutdown();
}
