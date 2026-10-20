import {
  initialBridgeStream,
  applyBridgeEvent,
} from "../../../services/agent-ui/web/src/lib/bridge-stream.ts";
import assert from "node:assert/strict";
import { tag } from "../observability/trace-tree.mjs";
import {
  clockOffsetBounds,
  phaseOffsetBounds,
  bracketOffsetBounds,
} from "../../support/verification/clock-interval.mjs";
import { groupAlive, processStat } from "../workspace-closeout/process.mjs";

const ns = (value) => {
  assert(
    typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value),
    "invalid monotonic sample",
  );
  return BigInt(value);
};
const one = (rows, label) => {
  assert.equal(rows.length, 1, "missing or duplicate " + label);
  return rows[0];
};
const fields = (rows) => {
  assert(Array.isArray(rows));
  const result = Object.fromEntries(rows.map((t) => [t.key, t.value]));
  assert.equal(Object.keys(result).length, rows.length, "duplicate field");
  return result;
};
function http(receipt, method, status) {
  assert.match(receipt.trace_id, /^[a-f0-9]{32}$/u);
  assert.equal(
    receipt.response_trace_id,
    receipt.trace_id,
    "wrong original response Trace header",
  );
  assert.equal(
    receipt.trace.traceID,
    receipt.trace_id,
    "foreign original trace",
  );
  assert.equal(receipt.status, status);
  const trace = receipt.trace;
  const span = one(
    trace.spans.filter(
      (s) =>
        s.operationName === "agent_ui.http.request" &&
        trace.processes[s.processID]?.serviceName === "agent-ui",
    ),
    "original UI HTTP span",
  );
  assert.equal(span.traceID, receipt.trace_id);
  const tags = fields(span.tags);
  assert.equal(tags["span.kind"], "server");
  assert.equal(tags["http.request.method"], method);
  assert.equal(tags["http.route"], "/api/app/workspace/v1/*");
  assert.equal(Number(tag(span, "http.response.status_code")), status);
  const reference = one(
    span.references.filter((r) => r.refType === "CHILD_OF"),
    "Gateway parent",
  );
  assert.equal(reference.traceID, trace.traceID);
  const parent = one(
    trace.spans.filter((s) => s.spanID === reference.spanID),
    "actual Gateway parent",
  );
  assert.equal(trace.processes[parent.processID]?.serviceName, "edge-gateway");
  const resource = fields(trace.processes[span.processID].tags);
  const identity = Object.fromEntries(
    ["service.instance.id", "host.name", "process.pid"].map((key) => {
      assert(
        resource[key] !== undefined && String(resource[key]).length,
        "missing process identity",
      );
      return [key, resource[key]];
    }),
  );
  return {
    span,
    identity,
    gateway: processIdentity(trace.processes[parent.processID]),
    start: ns(tags["antnest.ui.http.started_monotonic_ns"]),
  };
}
function elapsed(start, end) {
  const value = ns(end) - ns(start);
  assert(value >= 0n, "completion precedes cancellation");
  assert(value <= 1000000000n, "cancellation exceeded one second");
  return value;
}

function parseOffsetBounds(r, source, phases, bounds) {
  const observation = r.input_observation,
    observer = r.input_observer;
  assert(observation && observer, "missing native input observation");
  assert.equal(r.upload.requested_trace_id, r.upload.trace_id);
  assert.equal(observation.trace_id, r.upload.trace_id);
  assert.equal(observation.body_bytes, r.upload.body_bytes);
  assert.equal(
    observation.triggered,
    1,
    "native EOF must trigger exactly once",
  );
  assert.equal(observer.connections, 1);
  assert(
    Number.isSafeInteger(observer.messages) &&
      observer.messages >= 2 &&
      observer.messages <= 256,
  );
  assert.equal(observer.failure, undefined, "native input observer failed");
  assert.equal(observer.joined, true, "native input observer not joined");
  assert.equal(r.cancel.joined, true, "prepared cancel client not joined");
  assert.equal(
    r.cancel.body_bytes,
    Buffer.byteLength(JSON.stringify(r.cancel.request)),
  );
  for (const [key, index] of [
    ["receive", 0],
    ["eof", 1],
  ]) {
    assert(observation[key], "missing native " + key + " notice");
    assert.deepEqual(
      observation[key].notice,
      {
        traceId: r.upload.trace_id,
        spanId: source.span.spanID,
        processIdentity: source.identity,
        phase: phases[index].phase,
        bytes: phases[index].bytes,
        monotonic_ns: phases[index].monotonic_ns,
      },
      "notice differs from original native HTTP phase",
    );
  }
  const prepared = ns(r.cancel.prepared_ns),
    ready = ns(r.cancel.socket_ready_ns),
    armed = ns(observation.armed_ns),
    upload = ns(r.upload.sent_ns),
    received = ns(observation.receive.received_ns),
    eof = ns(observation.eof.received_ns),
    sent = ns(r.cancel.sent_ns),
    written = ns(r.cancel.written_ns);
  assert(
    prepared <= ready && ready <= armed && armed <= upload,
    "cancel socket must be prepared before arming the original upload",
  );
  assert(
    upload <= received &&
      received <= eof &&
      ns(r.upload.eof_sent_ns) <= eof &&
      eof <= sent &&
      sent <= written &&
      written <= ns(r.cancel.complete_ns),
    "invalid native EOF and cancellation receipt sequence",
  );
  // UI minus host offset: the original EOF happened before its host receipt,
  // so offset >= native EOF - receipt. Apply this causal bound only to the
  // parse window. Original HTTP/SSE checks retain the full calibration envelope.
  const causalLower = ns(phases[1].monotonic_ns) - eof,
    lower = BigInt(bounds.lower_ns),
    upper = BigInt(bounds.upper_ns);
  assert(causalLower <= upper, "native EOF contradicts clock calibration");
  return {
    lower_ns: String(causalLower > lower ? causalLower : lower),
    upper_ns: String(upper),
  };
}

export function inspectCapacityCase(r) {
  assert(["body-incomplete", "body-completion-and-parse"].includes(r.phase));
  assert(["operation-cancel", "commands-stop"].includes(r.cancel_path));
  const s = r.scope;
  for (const value of Object.values(s))
    assert(typeof value === "string" && value.length);
  assert.notEqual(s.user_a, s.user_b);
  assert.notEqual(s.agent_a, s.agent_b);
  assert.notEqual(
    s.session_a,
    s.session_a_aux,
    "distinct Session selections required",
  );
  assert.notEqual(
    s.session_b,
    s.session_b_aux,
    "distinct Session selections required",
  );
  const path = (agent) =>
    "/api/app/workspace/v1/agents/" + encodeURIComponent(agent);
  assert.equal(
    r.upload.path,
    path(s.agent_a) +
      "/sessions/" +
      encodeURIComponent(s.session_a) +
      "/prompts",
  );
  const u = http(r.upload, "POST", 202),
    c = http(r.cancel, "POST", 200);
  assert.deepEqual(c.identity, u.identity, "cancel reached another UI process");
  assert.deepEqual(c.gateway, u.gateway);
  assert.equal(r.upload.response.operationId, r.upload.intent_id);
  assert.equal(r.upload.response.acceptance, "bridge");
  assert.equal(r.upload.capabilities.image, true);
  assert.equal(r.upload.limit, 16 * 1024 * 1024, "unexpected configured limit");
  assert(Number.isSafeInteger(r.upload.body_bytes) && r.upload.body_bytes > 0);
  assert(
    Number.isSafeInteger(r.upload.wire_bytes) &&
      r.upload.wire_bytes >= r.upload.limit * 0.99 &&
      r.upload.wire_bytes <= r.upload.limit,
    "load is not valid near-limit input",
  );
  assert.equal(r.upload.attachments.length, 3);
  for (const attachment of r.upload.attachments) {
    assert.match(attachment.sha256, /^[a-f0-9]{64}$/u);
    assert(
      Number.isSafeInteger(attachment.size) &&
        attachment.size > 0 &&
        attachment.size <= 4 * 1024 * 1024,
    );
    assert.equal(attachment.width, 1024);
    assert.equal(attachment.height, 1020);
  }
  assert.deepEqual(
    r.upload_model.images,
    r.upload.attachments.map(({ sha256, size }) => ({ sha256, size })),
    "provider did not accept original images",
  );
  assert.equal(r.upload_model.phase, r.upload.intent_id);
  uploadModelBinding(r);
  assert.equal(r.held_model.phase, r.accepted.operationId);
  assert.equal(r.held_model.stage, "tool");
  assert.equal(r.held_model.continuations, 0, "held work continued naturally");
  const phases = r.upload.trace.spans
    .find((v) => v === u.span)
    .logs.map((e) => fields(e.fields))
    .filter((e) => e.event === "antnest.ui.prompt_input");
  assert.deepEqual(
    phases.map((p) => p.phase),
    ["receive-started", "body-eof", "body-parsed", "input-prepared"],
  );
  let previous = u.start;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    assert.deepEqual(Object.keys(p).sort(), [
      "bytes",
      "event",
      "monotonic_ns",
      "phase",
    ]);
    assert(
      Number.isSafeInteger(p.bytes) &&
        p.bytes > 0 &&
        p.bytes <= r.upload.body_bytes,
    );
    if (i) assert.equal(p.bytes, r.upload.body_bytes);
    const at = ns(p.monotonic_ns);
    assert(at >= previous, "unordered input phase");
    previous = at;
  }
  const seen = new Set([r.upload.trace_id, r.cancel.trace_id]);
  assert.equal(seen.size, 2);
  const offsets = {};
  for (const phase of ["before", "after"]) {
    const samples = r.calibration[phase];
    assert(samples.length >= 2, "missing bracketing calibration");
    offsets[phase] = phaseOffsetBounds(
      samples.map((sample) => {
        assert(!seen.has(sample.trace_id), "duplicate calibration source");
        seen.add(sample.trace_id);
        const h = http(sample, "GET", 200);
        assert.deepEqual(h.identity, u.identity, "clock process changed");
        assert.deepEqual(h.gateway, u.gateway);
        const sent = ns(sample.sent_ns),
          complete = ns(sample.complete_ns);
        assert(sent <= complete);
        if (phase === "before")
          assert(
            complete < ns(r.upload.sent_ns),
            "calibration does not precede upload",
          );
        else
          assert(
            sent > ns(r.upload.complete_ns) &&
              sent > ns(r.runtime.quiescent.at_ns),
            "calibration does not follow completed work",
          );
        return clockOffsetBounds({
          local_send_ns: sample.sent_ns,
          remote_receive_ns: String(h.start),
          remote_send_ns: String(h.start),
          local_receive_ns: sample.complete_ns,
        });
      }),
    );
    assert(offsets[phase], "conflicting calibration observations");
  }
  // Same-rate monotonic clocks, phase-local fixed offset. Preserve uncertainty
  // and observed drift with the full before/after envelope, never a midpoint.
  const bounds = bracketOffsetBounds(offsets.before, offsets.after);
  for (const [receipt, h] of [
    [r.upload, u],
    [r.cancel, c],
  ]) {
    assert(
      ns(receipt.sent_ns) <= ns(receipt.complete_ns),
      "inverted original HTTP window",
    );
    assert(
      h.start >= ns(receipt.sent_ns) + BigInt(bounds.lower_ns) &&
        h.start <= ns(receipt.complete_ns) + BigInt(bounds.upper_ns),
      "HTTP clock outside original client window",
    );
  }
  assert(
    ns(phases.at(-1).monotonic_ns) <=
      ns(r.upload.complete_ns) + BigInt(bounds.upper_ns),
    "upload phases continued after response",
  );
  const eofSent = ns(r.upload.eof_sent_ns);
  assert(
    ns(r.upload.sent_ns) <= eofSent && eofSent <= ns(r.upload.complete_ns),
    "invalid client EOF sequence",
  );
  assert(
    eofSent + BigInt(bounds.lower_ns) <= ns(phases[1].monotonic_ns),
    "client EOF contradicts actual native EOF",
  );
  if (r.phase === "body-completion-and-parse")
    assert(eofSent <= ns(r.cancel.sent_ns), "parse cancel preceded client EOF");
  const parsing = r.phase === "body-completion-and-parse";
  const inputBounds = parsing
    ? parseOffsetBounds(r, u, phases, bounds)
    : bounds;
  const earliest = ns(r.cancel.sent_ns) + BigInt(inputBounds.lower_ns),
    latest =
      ns(parsing ? r.cancel.written_ns : r.cancel.sent_ns) +
      BigInt(inputBounds.upper_ns);
  const [start, end] =
    r.phase === "body-incomplete"
      ? [phases[0], phases[1]]
      : [phases[1], phases[2]];
  assert(
    ns(start.monotonic_ns) <= earliest && latest < ns(end.monotonic_ns),
    "cancel not proved inside actual input phase",
  );
  const operation = r.accepted;
  assert.equal(operation.sessionId, s.session_b);
  assert.equal(operation.acceptance, "acp");
  assert(operation.runId);
  assert(["accepted", "running"].includes(operation.phase));
  const expected =
    r.cancel_path === "operation-cancel"
      ? { expectedRunId: operation.runId }
      : {
          text: "/stop",
          sessionId: s.session_b,
          operationId: operation.operationId,
          expectedRunId: operation.runId,
        };
  assert.deepEqual(r.cancel.request, expected);
  assert.equal(
    r.cancel.path,
    r.cancel_path === "operation-cancel"
      ? path(s.agent_b) +
          "/sessions/" +
          encodeURIComponent(s.session_b) +
          "/operations/" +
          encodeURIComponent(operation.operationId) +
          "/cancel"
      : path(s.agent_b) + "/commands",
  );
  if (r.cancel_path === "operation-cancel") {
    assert.equal(r.cancel.response.operationId, operation.operationId);
    assert.equal(r.cancel.response.runId, operation.runId);
    assert(["cancelling", "uncertain"].includes(r.cancel.response.phase));
    if (r.cancel.response.phase === "uncertain")
      assert.equal(
        r.cancel.response.errorClass,
        "cancelled_tool_outcome_unknown",
        "terminal cancellation response lacks its specific outcome",
      );
  } else assert.equal(r.cancel.response.command, "stop");
  for (const key of ["operationId", "sessionId", "runId", "acceptance"])
    assert.equal(r.terminal.operation[key], operation[key]);
  assert.equal(r.terminal.operation.phase, "uncertain");
  assert.equal(
    r.terminal.operation.errorClass,
    "cancelled_tool_outcome_unknown",
    "same Run cancellation-specific terminal missing",
  );
  const runtime = r.runtime;
  assert.equal(runtime.organization_id, s.organization_id);
  assert.equal(runtime.container.agent_id, s.agent_b);
  for (const key of [
    "execution_revision",
    "runtime_revision",
    "runtime_execution_id",
  ])
    assert(typeof runtime[key] === "string" && runtime[key].length);
  assert.match(runtime.container.id, /^[a-f0-9]{64}$/u);
  workBinding(r);
  const original = runtime.started;
  assert(Number.isSafeInteger(original.work.pgid) && original.work.pgid > 1);
  for (const observation of [
    original,
    runtime.before_cancel,
    runtime.quiescent,
  ]) {
    assert.deepEqual(
      observation.container,
      runtime.container,
      "Runtime instance replaced",
    );
    assert.equal(
      observation.status.execution_id,
      runtime.runtime_execution_id,
      "Runtime execution replaced",
    );
    assert.equal(observation.status.status, "ready");
    assert.equal(observation.work.pid, original.work.pid);
    assert.equal(observation.work.pgid, original.work.pgid);
    assert.equal(
      observation.work.effects,
      "started\n",
      "unexpected actual work progress",
    );
  }
  for (const sample of [original, runtime.before_cancel]) {
    assert(ns(sample.at_ns) < ns(r.cancel.sent_ns));
    assert.equal(processStat(sample.work.stat).pid, original.work.pid);
    assert.equal(processStat(sample.work.stat).group, original.work.pgid);
    assert(
      groupAlive(sample.work.processes, original.work.pgid),
      "work already idle before cancel",
    );
  }
  assert(
    !groupAlive(runtime.quiescent.work.processes, original.work.pgid),
    "original Runtime work still alive",
  );
  for (const [key, value] of Object.entries({
    run_id: operation.runId,
    session_id: s.session_b,
    agent_id: s.agent_b,
    principal_id: s.user_b,
    state: "unresolved",
    terminal_class: "unresolved",
    executor_state: "quiescent",
    tool_effect_state: "unknown",
    error_class: "cancelled_tool_outcome_unknown",
  }))
    assert.equal(r.audit[key], value, "wrong cancellation audit " + key);
  const durations = [
    r.cancel.complete_ns,
    r.terminal.at_ns,
    runtime.quiescent.at_ns,
  ].map((end) => elapsed(r.cancel.sent_ns, end));
  const completed =
    ns(r.cancel.sent_ns) + durations.reduce((a, b) => (a > b ? a : b));
  if (r.phase === "body-incomplete")
    assert(
      ns(r.upload.eof_sent_ns) >= completed,
      "body completed before B cancellation finished",
    );
  assert.equal(r.pool.length, 64);
  const ids = new Set(),
    owners = new Map(),
    selections = new Map();
  for (const stream of r.pool) {
    streamSource(stream, r, u, completed);
    assert.match(stream.trace_id, /^[a-f0-9]{32}$/u);
    assert(!ids.has(stream.trace_id), "duplicate stream");
    ids.add(stream.trace_id);
    assert.equal(stream.organization_id, s.organization_id);
    assert([s.user_a, s.user_b].includes(stream.principal_id));
    assert.equal(stream.status, 200);
    assert.equal(stream.view.agentId, stream.agent_id);
    assert.equal(stream.view.selectedSessionId, stream.session_id);
    if (stream.agent_id === s.agent_a) {
      assert.equal(stream.principal_id, s.user_a);
      assert(
        [s.session_a, s.session_a_aux].includes(stream.session_id),
        "undeclared primary Session",
      );
    }
    if (stream.agent_id === s.agent_b) {
      assert.equal(stream.principal_id, s.user_b);
      assert(
        [s.session_b, s.session_b_aux].includes(stream.session_id),
        "undeclared primary Session",
      );
    }
    const key = JSON.stringify([
      stream.organization_id,
      stream.principal_id,
      stream.agent_id,
    ]);
    owners.set(key, (owners.get(key) ?? 0) + 1);
    if (!selections.has(key)) selections.set(key, new Map());
    const sessions = selections.get(key);
    sessions.set(stream.session_id, (sessions.get(stream.session_id) ?? 0) + 1);
    assert(
      ns(stream.live_before_ns) < ns(r.cancel.sent_ns) &&
        ns(stream.live_after_ns) >= completed,
      "pool not live through completion",
    );
    assert(
      ns(stream.closed_ns) > completed && stream.joined === true,
      "stream closed early or not joined",
    );
  }
  assert.equal(owners.size, 4);
  assert([...owners.values()].every((count) => count === 16));
  for (const sessions of selections.values()) {
    assert.equal(sessions.size, 2, "two Session selections per owner required");
    assert(
      [...sessions.values()].every((count) => count === 8),
      "Session subscriber capacity must be eight",
    );
  }
  assert(owners.has(JSON.stringify([s.organization_id, s.user_a, s.agent_a])));
  assert(owners.has(JSON.stringify([s.organization_id, s.user_b, s.agent_b])));
  overflowSource(r, u.gateway);
  assert.equal(r.overflow.status, 503);
  assert.equal(r.overflow.body.code, "workspace_unavailable");
  assert.equal(
    r.overflow.body.message,
    "Workspace stream capacity is unavailable",
  );
  assert(
    ns(r.overflow.sent_ns) <= ns(r.overflow.complete_ns) &&
      ns(r.overflow.complete_ns) < ns(r.cancel.sent_ns),
  );
  return {
    completion_ms: Number(completed - ns(r.cancel.sent_ns)) / 1e6,
    sse_streams: r.pool.length,
    clock_offset_ns: bounds,
    ...(parsing ? { input_phase_offset_ns: inputBounds } : {}),
    phase: r.phase,
    cancel_path: r.cancel_path,
  };
}

function requireTags(span, expected) {
  const tags = fields(span.tags);
  for (const [key, value] of Object.entries(expected))
    assert.equal(
      key === "http.response.status_code" ? tag(span, key) : tags[key],
      value,
      "wrong work binding " + key,
    );
}
function workBinding(r) {
  const snapshot = r.run_snapshot,
    s = r.scope,
    o = r.accepted,
    rt = r.runtime;
  for (const [key, value] of Object.entries({
    run_id: o.runId,
    session_id: s.session_b,
    organization_id: s.organization_id,
    snapshot_organization_id: s.organization_id,
    agent_id: s.agent_b,
    principal_id: s.user_b,
    bridge_intent_id: o.operationId,
    execution_revision: rt.execution_revision,
    runtime_revision: rt.runtime_revision,
    runtime_execution_id: rt.runtime_execution_id,
    state: "running",
  }))
    assert.equal(snapshot[key], value, "wrong original Run snapshot " + key);
  assert.match(snapshot.snapshot_sha256, /^[a-f0-9]{64}$/u);
  const trace = r.work_trace;
  assert.equal(trace.traceID, r.held_model.trace_id);
  const byID = new Map(trace.spans.map((s) => [s.spanID, s]));
  assert.equal(byID.size, trace.spans.length);
  const parent = (span) => {
    const ref = one(
      span.references.filter((r) => r.refType === "CHILD_OF"),
      "work parent",
    );
    assert.equal(ref.traceID, trace.traceID);
    const found = byID.get(ref.spanID);
    assert(found);
    return found;
  };
  const named = (name) =>
    one(
      trace.spans.filter((s) => s.operationName === name),
      name,
    );
  const modelHTTP = byID.get(r.held_model.model_span_id);
  assert.equal(modelHTTP?.operationName, "HTTP POST model");
  const model = parent(modelHTTP);
  assert.equal(model.operationName, "model.complete");
  const run = parent(model);
  assert.equal(run.operationName, "agent.run");
  requireTags(run, {
    "antnest.run.id": o.runId,
    "antnest.session.id": s.session_b,
  });
  const binding = {
    "antnest.organization.id": s.organization_id,
    "antnest.execution.revision": rt.execution_revision,
    "antnest.runtime.revision": rt.runtime_revision,
    "antnest.runtime.execution_id": rt.runtime_execution_id,
  };
  const tool = named("mcp.tools.call");
  assert.equal(parent(tool), run);
  for (const span of [run, model, tool]) {
    assert.equal(
      trace.processes[span.processID].serviceName,
      "agent-acp-service",
    );
    requireTags(span, binding);
  }
  let current = one(
    trace.spans.filter(
      (span) =>
        span.operationName === "runtime.executor" &&
        fields(span.tags)["executor.tool.name"] === "bash",
    ),
    "held Bash executor",
  );
  const executor = current;
  requireTags(executor, {
    "executor.tool.name": "bash",
    "executor.child.pid": String(rt.started.work.pgid),
    "executor.exit.classification": "canceled",
  });
  const runtimeID = executor.processID;
  for (const name of [
    "runtime.executor",
    "runtime.mcp.tool",
    "runtime.mcp.operation",
    "HTTP POST /mcp",
  ]) {
    assert.equal(current.operationName, name);
    assert.equal(current.processID, runtimeID);
    if (["runtime.mcp.operation", "HTTP POST /mcp"].includes(name))
      requireTags(current, {
        "antnest.agent.id": s.agent_b,
        "antnest.runtime.execution.id": rt.runtime_execution_id,
        "antnest.runtime.generation": String(rt.container.generation),
      });
    current = parent(current);
  }
  assert.equal(current.operationName, "HTTP POST antnest-runtime");
  assert.equal(parent(current), tool);
  const resource = trace.processes[runtimeID];
  assert.equal(resource.serviceName, "antnest-runtime");
  const tags = fields(resource.tags);
  for (const [key, value] of Object.entries({
    "antnest.agent.id": s.agent_b,
    "antnest.runtime.generation": String(rt.container.generation),
    "antnest.runtime.image.id": rt.container.image,
  }))
    assert.equal(tags[key], value);
}
function processIdentity(process) {
  const tags = fields(process.tags);
  return Object.fromEntries(
    ["service.instance.id", "host.name", "process.pid"].map((key) => {
      assert(tags[key] !== undefined && String(tags[key]).length);
      return [key, tags[key]];
    }),
  );
}
function streamSource(stream, r, u, completed) {
  assert.equal(stream.raw.trace_id, stream.trace_id);
  assert.equal(stream.raw.status, 200);
  const traced = http(stream, "GET", 200);
  assert.deepEqual(traced.identity, u.identity);
  assert.deepEqual(traced.gateway, u.gateway);
  let buffer = stream.raw.frames
    .map((f) => f.raw)
    .join("")
    .replace(/\r\n/gu, "\n");
  const parsed = [];
  for (const frame of buffer.split("\n\n")) {
    if (!frame.trim()) continue;
    const lines = frame.split("\n"),
      data = lines.filter((l) => l === "data" || l.startsWith("data:"));
    if (!data.length) continue;
    const event = JSON.parse(
      data.map((l) => l.slice(5).replace(/^ /u, "")).join("\n"),
    );
    assert.deepEqual(
      lines.filter((l) => l.startsWith("event:")).map((l) => l.slice(6).trim()),
      [event.type],
    );
    parsed.push(event);
  }
  assert.deepEqual(
    parsed,
    stream.raw.events.map((e) => e.raw),
    "raw SSE frames and events diverged",
  );
  let state = initialBridgeStream(stream.agent_id, stream.session_id),
    ready;
  for (const [index, event] of parsed.entries()) {
    const next = applyBridgeEvent(state, event);
    assert(
      ["view", "ignore"].includes(next.action),
      "invalid original SSE sequence",
    );
    state = next.state;
    if (next.action === "view" && ready === undefined)
      ready = stream.raw.events[index];
  }
  assert(ready);
  assert.deepEqual(ready.raw.view, stream.view);
  assert.equal(stream.ready_at_ms, ready.at);
  assert(Number.isFinite(ready.at) && ready.at <= r.overflow.sent_perf_ms);
  assert(
    Number.isFinite(r.cancel.sent_perf_ms) &&
      r.overflow.sent_perf_ms < r.cancel.sent_perf_ms,
  );
  const completionMS = Math.max(
    r.terminal.at_perf_ms,
    r.runtime.quiescent.at_perf_ms,
    r.cancel.complete_perf_ms ?? r.cancel.sent_perf_ms,
  );
  assert(Number.isFinite(completionMS) && stream.live_after_ms >= completionMS);
  assert.equal(stream.raw.closure.kind, "local-close");
  assert(
    stream.raw.closure.at > stream.live_after_ms &&
      stream.raw.closure.at > completionMS,
  );
  assert(ns(stream.ready_ns) <= ns(r.overflow.sent_ns));
  assert(
    ns(stream.closed_ns) > ns(stream.live_after_ns) &&
      ns(stream.closed_ns) > completed,
  );
}

function uploadModelBinding(r) {
  const o = r.upload_terminal,
    s = r.scope;
  assert.equal(o.operationId, r.upload.intent_id);
  assert.equal(o.sessionId, s.session_a);
  assert.equal(o.acceptance, "acp");
  assert.equal(o.phase, "completed");
  assert(o.runId);
  for (const [key, value] of Object.entries({
    run_id: o.runId,
    session_id: s.session_a,
    agent_id: s.agent_a,
    principal_id: s.user_a,
    state: "completed",
  }))
    assert.equal(r.upload_audit[key], value);
  const trace = r.upload_work_trace;
  assert.equal(trace.traceID, r.upload_model.trace_id);
  const modelHTTP = one(
    trace.spans.filter((span) => span.spanID === r.upload_model.model_span_id),
    "upload model request",
  );
  assert.equal(modelHTTP.operationName, "HTTP POST model");
  const parent = (span) => {
    const ref = one(
      span.references.filter((r) => r.refType === "CHILD_OF"),
      "upload model parent",
    );
    assert.equal(ref.traceID, trace.traceID);
    return one(
      trace.spans.filter((s) => s.spanID === ref.spanID),
      "upload ancestor",
    );
  };
  const model = parent(modelHTTP),
    run = parent(model);
  assert.equal(model.operationName, "model.complete");
  assert.equal(run.operationName, "agent.run");
  for (const span of [run, model, modelHTTP])
    assert.equal(
      trace.processes[span.processID]?.serviceName,
      "agent-acp-service",
    );
  requireTags(run, {
    "antnest.run.id": o.runId,
    "antnest.session.id": s.session_a,
  });
  requireTags(model, { "antnest.organization.id": s.organization_id });
}
function overflowSource(r, gateway) {
  const receipt = r.overflow;
  assert.equal(receipt.response_trace_id, receipt.trace_id);
  assert.equal(receipt.trace.traceID, receipt.trace_id);
  assert.equal(
    receipt.path,
    "/api/app/workspace/v1/agents/" +
      encodeURIComponent(r.scope.agent_a) +
      "/events?sessionId=" +
      encodeURIComponent(r.scope.session_a),
  );
  const spans = receipt.trace.spans;
  assert(
    !spans.some(
      (s) => receipt.trace.processes[s.processID]?.serviceName === "agent-ui",
    ),
    "overflow was forwarded to UI",
  );
  const server = one(
    spans.filter(
      (s) =>
        receipt.trace.processes[s.processID]?.serviceName === "edge-gateway" &&
        fields(s.tags)["span.kind"] === "server",
    ),
    "overflow Gateway HTTP",
  );
  requireTags(server, {
    "http.request.method": "GET",
    "http.route": "/api/app/workspace/v1/{path...}",
    "http.response.status_code": 503,
  });
  assert.deepEqual(
    processIdentity(receipt.trace.processes[server.processID]),
    gateway,
  );
}
