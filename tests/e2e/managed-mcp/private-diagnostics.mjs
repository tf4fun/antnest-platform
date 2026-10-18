import assert from "node:assert/strict";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";
import { privateACPDiagnosticView } from "../observability/private-acp-diagnostics.mjs";
import {
  diagnostics,
  exactEvent,
  eventValues,
  namedEvent,
  end,
  values,
  expected as expect,
} from "../observability/runtime-tool-evidence.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { managedBusyRejection } from "./busy-diagnostics.mjs";

const errorStatus = (span) => {
  const status = tag(span, "otel.status_code");
  assert(["ERROR", 2].includes(status));
  if (tag(span, "error") !== undefined) assert.equal(tag(span, "error"), true);
  return {
    "otel.status_code": status,
    ...(tag(span, "error") === undefined ? {} : { error: true }),
  };
};

export function managedDiagnostics(
  trace,
  expected,
  { tree, request },
  information,
) {
  const neutral = information?.neutralDiagnostics ?? [],
    observations = [...(information?.timeObservations ?? [])],
    owned = [];
  const checked = new Set(),
    runtime = new Set(information?.spans ?? []);
  let busy;
  if (expected.rejection) {
    busy = managedBusyRejection(trace, tree, request, expected, observations);
    owned.push(...busy.records);
  }
  for (const proof of information?.toolLifecycles ?? []) {
    const spans = [
      proof.owner,
      ...proof.clients,
      ...proof.servers,
      ...proof.exchanges.map((pair) => pair.operation),
    ];
    for (const span of spans) {
      checked.add(span);
      runtime.add(span);
    }
    const failed = tag(proof.owner, "tool.name") === "mcp__alpha__fail";
    assert.equal(proof.parsedOutcome, failed ? "tool_error" : "success");
    if (!failed) continue;
    assert.equal(expected.phase, "managed-exercise");
    const { server, operation } = proof.invocation;
    for (const span of [server, operation])
      assert.equal(tag(span, "error.type"), "managed_tool_error");
    const tools = trace.spans.filter(
      (span) =>
        tree.parent(span) === operation &&
        span.operationName === "runtime.mcp.tool",
    );
    assert.equal(tools.length, 1);
    const tool = tools[0];
    const works = trace.spans.filter(
      (span) =>
        tree.parent(span) === tool &&
        span.operationName === "runtime.mcp.stdio",
    );
    assert.equal(works.length, 1);
    const work = works[0];
    for (const span of [tool, work]) {
      assert.equal(span.processID, operation.processID);
      assert.equal(tag(span, "error.type"), "managed_tool_error");
      const parent = tree.parent(span);
      assert(
        span.startTime >= parent.startTime && end(span) <= end(parent),
        "Managed work outside Runtime parent",
      );
      for (const [key, value] of Object.entries({
        "antnest.agent.id": expected.agentId,
        "antnest.runtime.generation": proof.invocation.generation,
      }))
        if (tag(span, key) !== undefined) assert.equal(tag(span, key), value);
      for (const [index, event] of (span.logs ?? []).entries()) {
        assert(
          Number.isFinite(event.timestamp) && event.timestamp >= span.startTime,
          "Managed event precedes its own span",
        );
        if (event.timestamp <= end(span)) continue;
        const resource = values(trace.processes[span.processID].tags);
        assert(
          [span.startTime, span.duration, event.timestamp, end(span) + 2].every(
            Number.isSafeInteger,
          ) &&
            event.timestamp === end(span) + 1 &&
            resource["telemetry.sdk.language"] === "rust" &&
            resource["telemetry.sdk.name"] === "opentelemetry",
          "Managed Runtime event outside its own span",
        );
        observations.push({
          trace_id: trace.traceID,
          span_id: span.spanID,
          process_id: span.processID,
          event_index: index,
          raw_left_us: event.timestamp,
          raw_right_us: end(span),
          raw_difference_us: 1,
          reason: "jaeger-integer-microsecond-representation",
        });
      }
    }
    const finished = namedEvent(tool, "Managed MCP tool finished");
    const completedFields = {
      event: "Managed MCP tool finished",
      level: "INFO",
      "mcp.server.tool": "mcp__alpha__fail",
      outcome: "error",
      "error.type": "managed_tool_error",
    };
    expect({ tags: finished.fields }, completedFields);
    assert.equal(tool.logs.length, 1);
    diagnostics(
      tool,
      {
        ...errorStatus(tool),
        "mcp.tool.outcome": "error",
        "error.type": "managed_tool_error",
      },
      new Map([[finished, completedFields]]),
    );
    assert.equal(tag(work, "rpc.method"), "tools/call");
    assert.equal(tag(work, "mcp.tool.name"), "mcp__alpha__fail");
    const failedEvent = exactEvent(work, "antnest.error", {
      "antnest.error.stage": "mcp.stdio",
      "antnest.error.type": "managed_tool_error",
      "antnest.error.code": "managed_tool_error",
      "antnest.error.message": "Managed tool returned isError",
    });
    assert.equal(work.logs.length, 1);
    diagnostics(
      work,
      {
        ...errorStatus(work),
        "antnest.protocol.outcome": "error",
        "error.type": "managed_tool_error",
      },
      new Map([[failedEvent, eventValues(failedEvent)]]),
    );
    const classification = namedEvent(operation, "antnest.error");
    assert(
      end(work) <= finished.timestamp &&
        failedEvent.timestamp <= finished.timestamp &&
        end(tool) <= classification.timestamp &&
        finished.timestamp <= classification.timestamp,
      "Managed error classification preceded tool completion",
    );
    for (const span of [proof.owner, server, operation, tool, work]) {
      checked.add(span);
      owned.push({
        trace_id: trace.traceID,
        span_id: span.spanID,
        reason: "managed-alpha-tool-error",
      });
    }
  }
  for (const span of trace.spans) {
    if (checked.has(span)) continue; // Every field was checked by the complete tool proof.
    assertSessionSuccess(
      busy?.views.get(span) ??
        privateACPDiagnosticView(trace, span, neutral, runtime),
    );
  }
  return {
    owned_error_spans: owned,
    neutral_diagnostics: neutral,
    time_observations: observations,
  };
}
