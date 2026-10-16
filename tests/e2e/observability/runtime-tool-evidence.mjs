import assert from "node:assert/strict";
import { tag, traceTopology } from "./trace-tree.mjs";

const one = (items, label) => {
  assert.equal(items.length, 1, `missing or duplicate tool ${label}`);
  return items[0];
};
const values = (fields = []) => {
  const result = Object.fromEntries(
    fields.map(({ key, value }) => [key, value]),
  );
  assert.equal(
    Object.keys(result).length,
    fields.length,
    "duplicate tool evidence field",
  );
  return result;
};
const end = (span) => {
  assert(
    Number.isFinite(span?.startTime) &&
      Number.isFinite(span?.duration) &&
      span.duration >= 0,
    "unfinished tool span",
  );
  return span.startTime + span.duration;
};
const expected = (span, fields) => {
  values(span.tags);
  for (const [key, value] of Object.entries(fields))
    assert.equal(tag(span, key), value, `wrong tool ${key}`);
};
const eventValues = (event) => values(event.fields);
const namedEvent = (span, name) =>
  one(
    (span.logs ?? []).filter((row) => eventValues(row).event === name),
    name,
  );
const exactEvent = (span, name, fields = {}) => {
  const event = namedEvent(span, name);
  assert.deepEqual(eventValues(event), { event: name, ...fields });
  return event;
};
const http200 = (span) => {
  for (const key of ["http.response.status_code", "http.status_code"])
    if (key === "http.response.status_code" || tag(span, key) !== undefined)
      assert([200, "200"].includes(tag(span, key)), "failed tool HTTP status");
};
const record = (span, event, reason) => ({
  trace_id: span.traceID,
  span_id: span.spanID,
  event_index: span.logs.indexOf(event),
  event_timestamp_us: event.timestamp,
  reason,
});
const diagnosticKey =
  /^(error($|\.)|exception\.|db\.response\.status_code$|antnest\.(error\.|cancellation\.|result$|operation\.phase$|stream\.termination$|http\.request_cancelled$)|otel\.status_|http\.transport\.error\.)/u;
function diagnostics(span, allowed = {}, events = new Map()) {
  for (const group of [
    { fields: span.tags, allowed },
    ...(span.logs ?? []).map((event) => ({
      fields: event.fields,
      allowed: events.get(event) ?? {},
    })),
  ]) {
    for (const [key, value] of Object.entries(values(group.fields))) {
      if (Object.hasOwn(group.allowed, key))
        assert.equal(
          value,
          group.allowed[key],
          "contradictory tool diagnostic",
        );
      else if (["http.response.status_code", "http.status_code"].includes(key))
        assert([200, "200"].includes(value), "failed tool HTTP diagnostic");
      else if (
        [
          "rpc.response.status_code",
          "jsonrpc.error_code",
          "process.exit.code",
        ].includes(key)
      )
        assert.equal(value, 0, "failed tool protocol or process");
      else if (key === "executor.exit.classification")
        assert.equal(value, "success", "failed tool executor classification");
      else if (
        key === "outcome" ||
        key.endsWith(".outcome") ||
        key === "antnest.result"
      )
        assert(
          ["success", "ok", "completed", "committed", "admitted"].includes(
            value,
          ),
          "unowned tool outcome",
        );
      else if (diagnosticKey.test(key))
        assert(
          (key === "error" && value === false) ||
            (key === "error.type" && value === "") ||
            (key === "antnest.error.class" && value === "none") ||
            (key === "otel.status_code" &&
              ["OK", "UNSET", 0, 1].includes(value)),
          "unowned tool error diagnostic",
        );
      else if (key === "level")
        assert(
          !["WARN", "ERROR", "FATAL"].includes(value),
          "unowned tool warning",
        );
      else if (key === "event")
        assert(
          !/^(?:error|exception|antnest\.(?:error|cancelled|stream\.termination|mcp\..*))$/u.test(
            value,
          ),
          "unowned tool lifecycle event",
        );
      assert(
        !/^antnest\.payload\./u.test(key) &&
          !/^http\.(?:request|response)\.headers?(?:$|\.)/u.test(key),
        "tool evidence contains content",
      );
      if (/^http\.(?:request|response)\.body(?:$|\.)/u.test(key))
        assert(
          key.endsWith(".size") && Number.isSafeInteger(value) && value >= 0,
          "tool body evidence is not a byte count",
        );
    }
  }
}

export function runtimeToolEvidence(trace, owner, { agentId }) {
  const tree = traceTopology(trace);
  const children = (span) =>
    trace.spans.filter((item) => tree.parent(item) === span);
  const timeObservations = [],
    neutralDiagnostics = [],
    ownedCancellations = new Set();
  const process = (span, service) => {
    assert.equal(tree.service(span), service);
    const resource = values(trace.processes[span.processID].tags);
    if (service === "agent-acp-service")
      assert(
        typeof resource["host.name"] === "string" &&
          resource["host.name"].length > 0 &&
          Number.isSafeInteger(resource["process.pid"]) &&
          resource["process.pid"] > 0 &&
          typeof resource["service.instance.id"] === "string" &&
          resource["service.instance.id"].length > 0,
        "missing actual tool process identity",
      );
    else {
      // Rust publishes Runtime scope, not the Node host/PID/instance resource.
      assert.equal(
        resource["antnest.agent.id"],
        agentId,
        "foreign tool Runtime resource Agent",
      );
      assert.equal(
        resource["antnest.runtime.generation"],
        tag(span, "antnest.runtime.generation"),
        "foreign tool Runtime resource generation",
      );
    }
    return resource;
  };
  const sameProcess = (span, parent, service) => {
    process(span, service);
    process(parent, service);
    assert.equal(span.processID, parent.processID, "foreign tool process");
  };
  const nodeBefore = (child, parent, left, right, boundary) => {
    assert(
      Number.isFinite(left) && Number.isFinite(right),
      "invalid tool endpoint",
    );
    if (left <= right) return;
    sameProcess(child, parent, "agent-acp-service");
    assert.equal(
      tree.parent(child),
      parent,
      "tool endpoint lacks actual direct parent",
    );
    const resource = process(child, "agent-acp-service");
    assert(
      [child, parent].every(
        (span) =>
          Number.isSafeInteger(span.startTime) && span.startTime % 1000 === 0,
      ) && left - right < 1000,
      "tool endpoint outside deferred same-Node sub-ms boundary: " + boundary,
    );
    timeObservations.push({
      trace_id: trace.traceID,
      tool_span_id: owner.spanID,
      span_id: child.spanID,
      parent_span_id: parent.spanID,
      process_id: child.processID,
      host_name: resource["host.name"],
      process_pid: resource["process.pid"],
      service_instance_id: resource["service.instance.id"],
      boundary,
      raw_left_us: left,
      raw_right_us: right,
      raw_difference_us: left - right,
      raw_child_start_us: child.startTime,
      raw_parent_start_us: parent.startTime,
      reason: "deferred-same-node-sdk-sub-ms-endpoint",
    });
  };
  const eventsInside = (span, runtime = false) => {
    for (const [index, event] of (span.logs ?? []).entries()) {
      values(event.fields);
      assert(
        Number.isFinite(event.timestamp) && event.timestamp >= span.startTime,
        "tool event precedes own span",
      );
      if (event.timestamp <= end(span)) continue;
      const resource = process(
        span,
        runtime ? "antnest-runtime" : "agent-acp-service",
      );
      assert(
        runtime &&
          [span.startTime, span.duration, event.timestamp, end(span) + 2].every(
            Number.isSafeInteger,
          ) &&
          event.timestamp < end(span) + 2 &&
          resource["telemetry.sdk.language"] === "rust" &&
          resource["telemetry.sdk.name"] === "opentelemetry",
        "tool event outside own span",
      );
      timeObservations.push({
        trace_id: trace.traceID,
        tool_span_id: owner.spanID,
        span_id: span.spanID,
        process_id: span.processID,
        boundary: "runtime-event-within-span",
        event_index: index,
        raw_left_us: event.timestamp,
        raw_right_us: end(span),
        raw_difference_us: event.timestamp - end(span),
        raw_span_start_us: span.startTime,
        raw_span_duration_us: span.duration,
        representation_us: 1,
        reason: "jaeger-integer-microsecond-representation",
      });
    }
  };
  return {
    tree,
    children,
    timeObservations,
    neutralDiagnostics,
    ownedCancellations,
    process,
    sameProcess,
    nodeBefore,
    eventsInside,
  };
}

export {
  one,
  values,
  end,
  expected,
  eventValues,
  namedEvent,
  exactEvent,
  http200,
  record,
  diagnostics,
};
