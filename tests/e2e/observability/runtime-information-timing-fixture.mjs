import assert from "node:assert/strict";

// Synthetic consumer fixture only. Never apply to archived production traces.
export function scaleReadFixtureTrace(trace) {
  for (const span of trace.spans) {
    span.startTime *= 1000;
    span.duration *= 1000;
    for (const event of span.logs ?? [])
      if (Number.isFinite(event.timestamp)) event.timestamp *= 1000;
  }
}

export function addReadEndpointObservation(trace, read) {
  const reference = read.references.find((row) => row.refType === "CHILD_OF");
  const parent = trace.spans.find((span) => span.spanID === reference.spanID);
  assert.equal(
    parent.startTime % 1000,
    0,
    "fixture requires a Node start anchor",
  );
  read.startTime = Math.floor(read.startTime / 1000) * 1000;
  assert(read.startTime >= parent.startTime);
  read.duration = parent.startTime + parent.duration + 1 - read.startTime;
  const process = trace.processes[read.processID];
  process.tags ??= [];
  for (const [key, value] of Object.entries({
    "host.name": "fixture-acp-host",
    "process.pid": 2,
    "service.instance.id": "fixture-acp-instance",
  }))
    if (!process.tags.some((row) => row.key === key))
      process.tags.push({ key, value });
  return {
    trace_id: trace.traceID,
    read_span_id: read.spanID,
    parent_span_id: parent.spanID,
    boundary: "read-joined-by-request",
    raw_left_us: read.startTime + read.duration,
    raw_right_us: parent.startTime + parent.duration,
    raw_difference_us: 1,
  };
}

export function addRuntimeEventRepresentations(trace, read, span) {
  const process = trace.processes[span.processID];
  process.tags ??= [];
  for (const [key, value] of Object.entries({
    "telemetry.sdk.language": "rust",
    "telemetry.sdk.name": "opentelemetry",
  }))
    if (!process.tags.some((row) => row.key === key))
      process.tags.push({ key, value });
  return span.logs.map((event, event_index) => {
    event.timestamp = span.startTime + span.duration + 1;
    return {
      trace_id: trace.traceID,
      read_span_id: read.spanID,
      span_id: span.spanID,
      process_id: span.processID,
      boundary: "runtime-event-within-span",
      event_index,
      raw_left_us: event.timestamp,
      raw_right_us: span.startTime + span.duration,
      raw_difference_us: 1,
      raw_span_start_us: span.startTime,
      raw_span_duration_us: span.duration,
      representation_us: 1,
      reason: "jaeger-integer-microsecond-representation",
    };
  });
}

export function assertReadEndpointObservations(result, expected, baseline) {
  assert.equal(result.time_observations?.length, expected.length);
  for (const row of expected) {
    const actual = result.time_observations.find(
      (item) =>
        item.trace_id === row.trace_id &&
        item.read_span_id === row.read_span_id &&
        item.boundary === row.boundary &&
        (row.span_id === undefined || item.span_id === row.span_id) &&
        item.event_index === row.event_index,
    );
    assert(actual, "original endpoint observation was lost");
    for (const [key, value] of Object.entries(row))
      assert.equal(actual[key], value);
  }
  if (baseline)
    for (const key of [
      "strict_trace",
      "warning_count",
      "warnings",
      "error_spans",
      "reviewed_error_spans",
      "owned_error_spans",
      "owned_error_count",
      "neutral_diagnostics",
      "non_error_diagnostics",
    ])
      assert.deepEqual(
        result[key],
        baseline[key],
        "timing observations changed original " + key,
      );
}
