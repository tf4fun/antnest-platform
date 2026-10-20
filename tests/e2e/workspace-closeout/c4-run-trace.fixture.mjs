import { c4InventoryFixture } from "./c4-inventory.fixture.mjs";
import { c4PromptExpectations } from "./c4-inventory.mjs";
import { workspaceChatFixture } from "./chat-fixtures.mjs";
import {
  nativeTraceFixture,
  actualFinishQuery,
} from "../acp-multimodal/private-trace.fixture.mjs";
import { fixture as commandFixture } from "../acp-commands/trace-fixtures.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import {
  addPostPromptInformationRead,
  addToolLifecycleReceipt,
} from "../observability/runtime-information-run-fixtures.mjs";
import { setTag } from "../observability/gateway-resolution-fixtures.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";

// Consumer fixtures compose the existing full Runtime read/tool evidence with
// the public Bridge envelope. Archived production traces are never transformed.
export function c4RunTraceFixture(
  suffix = "attachments",
  { cleanup = false } = {},
) {
  const expected = c4PromptExpectations(c4InventoryFixture()).find(
      (row) => row.phase === `c4-browser-${suffix}`,
    ),
    audio = suffix === "unsupported-audio",
    cancelled = suffix === "hold-cancel";
  let f;
  if (expected.toolName) {
    f = commandFixture("ordinary");
    const resources = structuredClone(f.trace.processes);
    f.finish = f.add("finish", "run", "SELECT", undefined, 23000, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": "SELECT",
      "db.query.text": actualFinishQuery,
    });
    Object.assign(f.trace.processes, resources);
    f.finish.duration = 1000;
    f.run = f.trace.spans.find((span) => span.spanID === "run");
    f.run.duration = 25000 - f.run.startTime;
    f.post = addPostPromptInformationRead(f.trace);
    f = privateBoundaryFixture(f);
  } else f = nativeTraceFixture({ failed: audio });
  if (cleanup) {
    const tree = traceTopology(f.trace),
      oldRead = f.post.read;
    f.trace.spans = f.trace.spans.filter(
      (span) => span !== oldRead && !tree.chain(span).includes(oldRead),
    );
    f.post = addPostPromptInformationRead(f.trace, {
      clientOutcome: "cancelled",
      runtimeOutcome: "canceled",
    });
    for (const owner of f.trace.spans.filter(
      (span) => span.operationName === "mcp.tools.call",
    ))
      addToolLifecycleReceipt(f.trace, owner, {
        cancelledClients: ["tools/call"],
        cancelledServers: ["tools/call"],
      });
  }
  const bridge = workspaceChatFixture();
  const envelope = bridge.trace.spans.filter(
    (span) =>
      !["agent-acp-service", "antnest-runtime"].includes(
        bridge.trace.processes[span.processID].serviceName,
      ) || span.spanID === "acp-http",
  );
  for (const span of f.trace.spans) {
    span.traceID = bridge.trace.traceID;
    span.startTime += 1022000;
    for (const reference of span.references ?? [])
      reference.traceID = span.traceID;
    for (const event of span.logs ?? []) {
      event.timestamp += 1022000;
      for (const field of event.fields ?? [])
        if (field.key === "trace_id") field.value = span.traceID;
    }
  }
  const request = f.trace.spans.find((span) => span.spanID === "request"),
    run = f.trace.spans.find((span) => span.spanID === "run");
  request.references = [
    { refType: "CHILD_OF", traceID: bridge.trace.traceID, spanID: "acp-http" },
  ];
  bridge.trace.spans = [...envelope, ...f.trace.spans];
  Object.assign(bridge.trace.processes, f.trace.processes);
  for (const span of envelope)
    if (["root", "upstream", "bridge"].includes(span.spanID))
      setTag(span, "http.response.status_code", 202);
  for (const span of bridge.trace.spans.filter((span) =>
    ["upstream", "bridge", "acp-http"].includes(span.spanID),
  ))
    span.duration = 65000;
  Object.assign(expected, {
    traceID: bridge.trace.traceID,
    sessionId: "session",
    runId: "run",
    runtime: {
      runtime_revision: "runtime-1",
      runtime_execution_id: "execution_test",
    },
  });
  Object.assign(expected.run, { run_id: "run", session_id: "session" });
  Object.assign(expected.receipt, {
    traceID: expected.traceID,
    sessionId: expected.sessionId,
    path: "/api/app/workspace/v1/agents/agent/sessions/session/prompts",
  });
  const state = audio ? "failed" : cancelled ? "cancelled" : "completed";
  for (const [key, value] of Object.entries({
    "antnest.run.id": expected.runId,
    "antnest.session.id": expected.sessionId,
    "antnest.runtime.revision": expected.runtime.runtime_revision,
    "antnest.runtime.execution_id": expected.runtime.runtime_execution_id,
    "antnest.execution.revision":
      expected.run.execution_snapshot.executionRevision,
    "run.terminal_class": state,
    "run.executor_state": "quiescent",
    "run.tool_effect_state": expected.toolName ? "settled" : "none",
    "antnest.operation.phase": "execute",
    "antnest.outcome": audio ? "failed" : cancelled ? "cancelled" : "ok",
  }))
    setTag(run, key, value);
  const models = bridge.trace.spans.filter(
      (span) => span.operationName === "model.complete",
    ),
    clients = bridge.trace.spans.filter(
      (span) => span.operationName === "HTTP POST model",
    );
  for (const model of models)
    for (const [key, value] of Object.entries({
      "model.name": "stage3-model",
      "antnest.runtime.revision": expected.runtime.runtime_revision,
      "antnest.runtime.execution_id": expected.runtime.runtime_execution_id,
      "antnest.execution.revision":
        expected.run.execution_snapshot.executionRevision,
    }))
      setTag(model, key, value);
  for (const client of clients) {
    setTag(client, "span.kind", "client");
    setTag(client, "http.request.method", "POST");
    setTag(client, "http.response.status_code", 200);
  }
  for (const span of bridge.trace.spans.filter(
    (span) => span.operationName === "mcp.tools.call",
  ))
    setTag(span, "tool.name", expected.toolName);
  expected.requests = clients.map((client, index) => ({
    phase: expected.phase,
    stage: expected.toolName && index === 0 ? "tool" : "reply",
    trace_id: expected.traceID,
    model_span_id: client.spanID,
    ...(cancelled ? { disconnected: true } : {}),
  }));
  if (cancelled) {
    const original = workspaceChatFixture("cache", true);
    for (const [target, source] of [
      [models[0], original.model],
      [clients[0], original.http],
    ]) {
      for (const field of source.tags) setTag(target, field.key, field.value);
      if (source.logs)
        target.logs = structuredClone(source.logs).map((event) => ({
          ...event,
          timestamp: target.startTime + target.duration - 1,
        }));
    }
    setTag(models[0], "antnest.error.origin_span_id", clients[0].spanID);
    setTag(clients[0], "http.status_code", undefined);
    setTag(clients[0], "http.response.status_code", undefined);
    bridge.trace.spans = bridge.trace.spans.filter(
      (span) =>
        !["transaction", "insert", "output", "output-read"].includes(
          span.spanID,
        ),
    );
  }
  return {
    ...bridge,
    expected,
    request,
    run,
    models,
    clients,
    finish: f.finish,
    information: f.information,
    post: f.post,
    set: setTag,
    tag,
  };
}
