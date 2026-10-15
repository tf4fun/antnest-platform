import assert from "node:assert/strict";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { hasError } from "../acp-plan/requests.mjs";

const one = (items, label) => {
  assert.equal(items.length, 1, `missing or duplicate ${label}`);
  return items[0];
};
const unique = (fields) => {
  assert(Array.isArray(fields), "missing clock evidence fields");
  assert.equal(
    new Set(fields.map((f) => f.key)).size,
    fields.length,
    "duplicate clock evidence field",
  );
};
const requireTags = (span, values) => {
  assert(span, "missing cancellation timing span");
  for (const [key, value] of Object.entries(values))
    assert.equal(tag(span, key), value, `wrong cancellation timing ${key}`);
};
const end = (span) => {
  assert(
    Number.isSafeInteger(span.startTime) && span.startTime > 0,
    "invalid raw start microseconds",
  );
  assert(
    Number.isSafeInteger(span.duration) && span.duration > 0,
    "unfinished raw duration",
  );
  const result = span.startTime + span.duration;
  assert(Number.isSafeInteger(result), "unsafe raw end microseconds");
  return result;
};
const eventTag = (event, key) => tag({ tags: event.fields }, key);
function cleanClockSample(span) {
  for (const fields of [
    span.tags,
    ...(span.logs ?? []).map((event) => event.fields),
  ])
    for (const { key, value } of fields) {
      if (
        key === "outcome" ||
        key.endsWith(".outcome") ||
        key === "antnest.result"
      ) {
        assert(
          ["ok", "success", "completed", "committed", "admitted"].includes(
            value,
          ),
          "contradictory clock sample outcome",
        );
      } else if (
        /^(error($|\.)|exception\.|antnest\.(error\.|cancellation\.)|otel\.status_|http\.transport\.error\.)/u.test(
          key,
        )
      ) {
        assert(
          (key === "error.type" && value === "") ||
            (key === "error" && value === false) ||
            (key === "otel.status_code" && ["OK", "UNSET"].includes(value)),
          "unclassified clock sample diagnostic",
        );
      } else if (key === "event") {
        assert(
          ![
            "antnest.error",
            "antnest.cancelled",
            "error",
            "exception",
          ].includes(value),
          "unexpected clock sample event",
        );
      } else if (key === "level") {
        assert.equal(value, "INFO", "unexpected clock sample log level");
      }
    }
}
function acpProcess(trace, span) {
  const process = trace.processes[span.processID];
  assert.equal(process?.serviceName, "agent-acp-service");
  unique(process.tags);
  const resource = {};
  for (const name of ["service.instance.id", "host.name", "process.pid"]) {
    resource[name] = tag(process, name);
    assert(
      resource[name] !== undefined && resource[name] !== "",
      `missing ACP ${name}`,
    );
  }
  assert.equal(typeof resource["service.instance.id"], "string");
  assert.equal(typeof resource["host.name"], "string");
  assert(
    Number.isSafeInteger(resource["process.pid"]) &&
      resource["process.pid"] > 0,
    "invalid ACP process.pid",
  );
  return resource;
}

// This helper proves time bounds only. Its caller must still validate the
// original HTTP/Run/Runtime business evidence and exact error/transport receipts.
export function inspectRuntimeCancellationTiming(trace, expected) {
  const tree = traceTopology(trace),
    cancelTree = traceTopology(expected.cancelTrace);
  for (const raw of [trace, expected.cancelTrace])
    for (const span of raw.spans) {
      unique(span.tags);
      for (const event of span.logs ?? []) unique(event.fields);
    }
  const select = (id, name) => {
    const span = tree.spans.get(id);
    assert.equal(span?.operationName, name, `wrong selected ${name}`);
    end(span);
    return span;
  };
  const prompt = select(expected.promptSpanID, "acp session/prompt"),
    run = select(expected.runSpanID, "agent.run"),
    model = select(expected.modelSpanID, "model.complete"),
    tool = select(expected.toolSpanID, "mcp.tools.call"),
    finish = select(expected.finishSpanID, "SELECT"),
    server = select(expected.runtimeSpanID, "HTTP POST /mcp"),
    cancel = cancelTree.spans.get(expected.cancelSpanID);
  assert.equal(
    cancel?.operationName,
    "acp session/cancel",
    "cancellation window must be the internal ACP execution",
  );
  requireTags(cancel, {
    "span.kind": "internal",
    "rpc.method": "session/cancel",
    "antnest.agent.id": tag(prompt, "antnest.agent.id"),
    "antnest.session.id": tag(run, "antnest.session.id"),
  });
  assert(
    tag(prompt, "antnest.agent.id") &&
      tag(run, "antnest.session.id") &&
      tag(run, "antnest.run.id"),
  );
  assert(tree.chain(run).includes(prompt), "Run detached from actual prompt");
  assert(run.startTime >= prompt.startTime, "Run began before its prompt");
  for (const child of [model, tool, finish]) {
    assert.equal(
      tree.parent(child),
      run,
      "execution detached from original Run",
    );
    assert(child.startTime >= run.startTime, "execution began before its Run");
  }
  requireTags(tool, {
    "tool.name": "bash",
    "antnest.run.id": tag(run, "antnest.run.id"),
  });
  requireTags(finish, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
  });
  assert(
    /^WITH finished AS \(UPDATE runs\b/iu.test(
      (tag(finish, "db.query.text") ?? "").replace(/\s+/gu, " "),
    ),
    "wrong Run terminal SQL",
  );
  assert(!hasError(finish), "failed terminal SQL");
  const acp = acpProcess(trace, run);
  assert.deepEqual(
    acpProcess(expected.cancelTrace, cancel),
    acp,
    "cancellation belongs to another ACP process",
  );
  const sameACP = (span) => {
    assert.deepEqual(
      acpProcess(trace, span),
      acp,
      "execution belongs to another ACP process",
    );
    assert.equal(
      span.startTime % 1000,
      0,
      "expected independently integer-ms-anchored ACP span",
    );
    end(span);
  };
  for (const span of [prompt, run, model, tool, finish]) sameACP(span);
  assert.equal(cancel.startTime % 1000, 0);
  end(cancel);
  const client = tree.parent(server);
  assert.equal(client?.operationName, "HTTP POST antnest-runtime");
  assert.equal(tree.parent(client), tool, "Runtime CLIENT detached from bash");
  sameACP(client);
  requireTags(client, { "span.kind": "client", "http.request.method": "POST" });
  const nodeQuantization = [];
  function joinedEnd(child, parent, label) {
    const excess = end(child) - end(parent);
    if (excess <= 0) return;
    assert(
      child.processID === parent.processID &&
        child.startTime % 1000 === 0 &&
        parent.startTime % 1000 === 0 &&
        excess < 1000,
      label,
    );
    nodeQuantization.push({
      parent_span_id: parent.spanID,
      child_span_id: child.spanID,
      raw_end_delta_us: excess,
      resolution_us: 1000,
    });
  }
  assert(
    end(model) <= tool.startTime,
    "bash predates successful model completion",
  );
  assert(cancel.startTime <= end(tool), "bash ended before cancellation");
  assert(
    end(tool) <= finish.startTime,
    "terminal SQL predates bash completion",
  );
  joinedEnd(finish, run, "terminal SQL was not joined by Run completion");
  joinedEnd(client, tool, "Runtime CLIENT cleanup outlived its ACP call");
  assert(
    end(run) <= end(cancel) && end(finish) <= end(cancel),
    "Run completion outlived internal cancellation",
  );

  const binding = {
    "antnest.agent.id": tag(prompt, "antnest.agent.id"),
    "antnest.runtime.execution.id": expected.runtimeExecutionID,
    "antnest.runtime.generation": expected.runtimeGeneration,
  };
  assert(
    expected.runtimeExecutionID && expected.runtimeGeneration,
    "missing Runtime identity for time proof",
  );
  requireTags(server, {
    ...binding,
    "span.kind": "server",
    "http.request.method": "POST",
    "http.route": "/mcp",
    "rpc.method": "tools/call",
  });
  assert.equal(tree.service(server), "antnest-runtime");
  const runtimeProcess = trace.processes[server.processID];
  unique(runtimeProcess.tags);
  requireTags(runtimeProcess, {
    "antnest.agent.id": binding["antnest.agent.id"],
    "antnest.runtime.generation": expected.runtimeGeneration,
  });
  const ambiguities = [];
  function runtimeSpan(span) {
    assert.equal(span.processID, server.processID, "different Runtime process");
    const finishAt = end(span);
    for (const [index, event] of (span.logs ?? []).entries()) {
      assert(
        Number.isSafeInteger(event.timestamp) &&
          event.timestamp >= span.startTime &&
          event.timestamp < finishAt + 2,
        "Runtime event outside microsecond representation interval",
      );
      if (event.timestamp > finishAt)
        ambiguities.push({
          span_id: span.spanID,
          event_index: index,
          raw_delta_us: event.timestamp - finishAt,
          representation_us: 1,
        });
    }
    return span;
  }
  function childOf(parent, name) {
    const child = one(
      trace.spans.filter(
        (s) => tree.parent(s) === parent && s.operationName === name,
      ),
      name,
    );
    runtimeSpan(child);
    assert(
      child.startTime >= parent.startTime && end(child) < end(parent) + 2,
      "Runtime child outside parent representation interval",
    );
    if (end(child) > end(parent))
      ambiguities.push({
        span_id: child.spanID,
        parent_span_id: parent.spanID,
        raw_delta_us: end(child) - end(parent),
        representation_us: 1,
      });
    return child;
  }
  runtimeSpan(server);
  const operation = childOf(server, "runtime.mcp.operation"),
    runtimeTool = childOf(operation, "runtime.mcp.tool"),
    executor = childOf(runtimeTool, "runtime.executor");
  requireTags(operation, {
    ...binding,
    "rpc.method": "tools/call",
    "mcp.tool.name": "bash",
  });
  requireTags(runtimeTool, { "mcp.tool.name": "bash" });
  requireTags(executor, { "executor.tool.name": "bash" });

  function completion(span, name, values) {
    const event = one(span.logs ?? [], name);
    for (const [key, value] of Object.entries({
      event: name,
      level: "INFO",
      "error.type": "",
      "service.name": "antnest-runtime",
      "antnest.agent.id": binding["antnest.agent.id"],
      "antnest.runtime.generation": expected.runtimeGeneration,
      trace_id: trace.traceID,
      span_id: span.spanID,
      ...values,
    }))
      assert.equal(
        eventTag(event, key),
        value,
        `invalid completed clock sample ${key}`,
      );
    for (const field of event.fields)
      if (/^(exception\.|antnest\.(error|cancellation)\.)/u.test(field.key))
        assert.fail("diagnostic in completed clock sample");
  }
  const samples = [];
  for (const sample of trace.spans) {
    if (
      tree.service(sample) !== "antnest-runtime" ||
      sample.operationName !== "HTTP POST /mcp" ||
      tag(sample, "span.kind") !== "server" ||
      !["discover", "resources/read", "tools/list"].includes(
        tag(sample, "rpc.method"),
      ) ||
      !tree.chain(sample).includes(prompt)
    )
      continue;
    const source = tree.parent(sample);
    assert.equal(
      source?.operationName,
      "HTTP POST antnest-runtime",
      "clock sample has no actual ACP CLIENT",
    );
    sameACP(source);
    requireTags(source, {
      "span.kind": "client",
      "http.request.method": "POST",
    });
    requireTags(sample, binding);
    runtimeSpan(sample);
    // SDK-aborted responses are not complete EOF calibration receipts, even
    // when the protocol handler completed. They remain in raw diagnostics.
    if (
      hasError(source) ||
      tag(source, "antnest.outcome") === "cancelled" ||
      tag(source, "antnest.cancellation.type") !== undefined ||
      (source.logs?.length ?? 0) !== 0
    )
      continue;
    if (
      tag(sample, "antnest.protocol.outcome") !== "success" ||
      tag(sample, "http.transport.outcome") !== "success" ||
      hasError(sample)
    )
      continue;
    assert.equal(Number(tag(source, "http.response.status_code")), 200);
    assert.equal(Number(tag(sample, "http.response.status_code")), 200);
    const bytes = tag(source, "http.response.body.size");
    assert(
      Number.isSafeInteger(bytes) && bytes > 0,
      "clock sample has no received body",
    );
    assert.equal(
      tag(sample, "http.response.body.size"),
      bytes,
      "clock sample byte mismatch",
    );
    const action = childOf(sample, "runtime.mcp.operation");
    for (const span of [source, sample, action]) cleanClockSample(span);
    const owner = tree.parent(source);
    assert(owner, "clock CLIENT has no owning ACP operation");
    sameACP(owner);
    assert(
      source.startTime >= owner.startTime,
      "clock CLIENT began before its owning ACP operation",
    );
    joinedEnd(
      source,
      owner,
      "clock CLIENT EOF outlived its owning ACP operation",
    );
    requireTags(action, {
      ...binding,
      "rpc.method": tag(sample, "rpc.method"),
      "mcp.operation.outcome": "success",
      "antnest.operation.outcome": "success",
      "otel.status_code": "OK",
      "error.type": "",
    });
    assert(!hasError(action), "failed Runtime clock operation");
    completion(sample, "Runtime HTTP request completed", {
      "http.request.method": "POST",
      "url.path": "/mcp",
      "http.transport.outcome": "success",
    });
    assert.equal(
      Number(eventTag(sample.logs[0], "http.response.status_code")),
      200,
    );
    completion(action, "Runtime MCP operation completed", {
      "mcp.operation.name": tag(sample, "rpc.method"),
      "mcp.operation.outcome": "success",
    });
    // Node starts are independently floored to ms, while Jaeger floors the
    // start/duration/event fields to us. The SERVER start lies inside the
    // completed CLIENT interval; no assumption about SERVER end is necessary.
    samples.push({
      client_span_id: source.spanID,
      server_span_id: sample.spanID,
      lower: sample.startTime - end(source) - 1001,
      upper: sample.startTime + 1 - source.startTime,
      before: end(source) + 1001 <= cancel.startTime,
      after: source.startTime >= end(cancel) + 1001,
    });
  }
  assert(
    samples.some((s) => s.before) && samples.some((s) => s.after),
    "completed RPC samples must bracket cancellation",
  );
  const offset = {
    lower: Math.max(...samples.map((s) => s.lower)),
    upper: Math.min(...samples.map((s) => s.upper)),
  };
  assert(
    offset.lower < offset.upper,
    "Runtime clock sample intersection is empty",
  );
  const cancellationWindow = {
    lower: cancel.startTime + 1000,
    upper: end(cancel),
  };
  const runtimeEnds = [server, operation, runtimeTool, executor].map((span) => {
    const interval = {
      span_id: span.spanID,
      lower: end(span) - offset.upper,
      upper: end(span) + 2 - offset.lower,
    };
    assert(
      interval.lower >= cancellationWindow.lower &&
        interval.upper <= cancellationWindow.upper,
      "Runtime end interval outside internal cancellation window",
    );
    return interval;
  });
  return {
    status: "timing_proved_business_admission_pending",
    acp_process: acp,
    cancel_trace_id: expected.cancelTrace.traceID,
    cancel_span_id: cancel.spanID,
    clock_samples: samples,
    offset_us: offset,
    cancellation_window_us: cancellationWindow,
    runtime_ends: runtimeEnds,
    raw_server_client_end_delta_us: end(server) - end(client),
    node_end_quantization: nodeQuantization,
    representation_ambiguities: ambiguities,
  };
}
