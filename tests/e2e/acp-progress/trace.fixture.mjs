import { createHash } from "node:crypto";
import { fixture as ordinaryFixture } from "../acp-commands/trace-fixtures.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import {
  addPostPromptInformationRead,
  addToolLifecycleReceipt,
} from "../observability/runtime-information-run-fixtures.mjs";
import { tag } from "../observability/trace-tree.mjs";
import { cancellationFixture } from "./tool-cancellation.fixture.mjs";

const fields = (record) =>
  Object.entries(record).map(([key, value]) => ({ key, value }));
const event = (timestamp, name, record = {}) => ({
  timestamp,
  fields: fields({ event: name, ...record }),
});
const end = (span) => span.startTime + span.duration;
export const set = (span, key, value) => {
  span.tags = span.tags.filter((row) => row.key !== key);
  if (value !== undefined) span.tags.push({ key, value });
};
export const eventField = (entry, key, value) => {
  entry.fields = entry.fields.filter((row) => row.key !== key);
  entry.fields.push({ key, value });
};

// Tool progress callbacks retain the MCP call context while persisting the
// preview and publishing the Session output. Model this ACP-owned work too.
export function addProgressOutput(f) {
  const spans = [];
  const add = (name, parent, index, tags) => {
    const span = {
      spanID: `progress-output-${f.trace.spans.length}`,
      traceID: f.trace.traceID,
      operationName: name,
      processID: f.call.processID,
      startTime: f.call.startTime + 100 + index * 10,
      duration: 1,
      references: [
        {
          refType: "CHILD_OF",
          traceID: f.trace.traceID,
          spanID: parent.spanID,
        },
      ],
      tags: fields(tags),
      logs: [],
    };
    f.trace.spans.push(span);
    spans.push(span);
    return span;
  };
  const transaction = add("postgresql transaction", f.call, 0, {
    "span.kind": "internal",
    "db.system.name": "postgresql",
    "antnest.transaction.outcome": "committed",
  });
  transaction.duration = 90;
  const sql = (parent, index, query) => {
    const operation = query.split(" ")[0];
    return add(operation, parent, index, {
      "span.kind": "client",
      "db.system.name": "postgresql",
      "db.namespace": "antnest_agent_acp",
      "db.operation.name": operation,
      "db.query.text": query,
    });
  };
  const statements = [
    "BEGIN",
    "SELECT session_id FROM runs WHERE id = $1",
    "SELECT last_message_sequence FROM acp_sessions WHERE id = $1 FOR UPDATE",
    "SELECT session_id, state FROM runs WHERE id = $1 FOR UPDATE",
    "SELECT id FROM tool_attempts WHERE run_id = $1 AND tool_call_id = $2 AND state = 'in_progress'",
    "INSERT INTO session_messages( id, session_id, run_id, sequence, kind, visible, payload, created_at ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)",
    "UPDATE acp_sessions SET last_message_sequence = $2, updated_at = $3 WHERE id = $1",
    "COMMIT",
  ].map((query, index) => sql(transaction, index + 1, query));
  const output = add("acp.session.output", f.call, 10, {
    "span.kind": "internal",
    "antnest.agent.id": f.expected.agentId,
    "antnest.session.id": f.expected.sessionId,
    "antnest.operation.phase": "read",
    "antnest.outcome": "ok",
  });
  output.duration = 50;
  const sessionQuery =
    "SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id, client_mcp_revision_id, last_execution_revision, last_message_sequence, created_at, updated_at FROM acp_sessions WHERE id = $1";
  const reads = [
    sessionQuery,
    "SELECT s.last_message_sequence AS sequence, s.append_version, s.title, s.updated_at, COALESCE((SELECT jsonb_agg( CASE WHEN $3::boolean THEN jsonb_build_object( 'sequence', m.sequence, 'runId', m.run_id, 'messageId', m.id, 'payload', m.payload ) ELSE m.payload END ORDER BY m.sequence) FROM session_messages m WHERE m.session_id = s.id AND m.visible AND m.sequence > COALESCE($2::bigint, s.last_message_sequence)), '[]'::jsonb) AS events, r.state, r.stop_reason FROM acp_sessions s LEFT JOIN LATERAL (SELECT state, stop_reason FROM runs WHERE session_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1) r ON true WHERE s.id = $1",
    sessionQuery,
    "SELECT configuration, configuration_revision FROM acp_sessions WHERE id = $1 AND state <> 'deleted'",
  ].map((query, index) => sql(output, index + 11, query));
  return { transaction, output, statements, reads, spans };
}

// Controlled fixture composition only; never applied to archived raw evidence.
export function progressTraceFixture(
  phase = "v1-bash-success",
  { refresh = true, protocolFailed = false, heldDiscovery = false } = {},
) {
  const [protocol, kind, ending] = phase.split("-");
  const version = Number(protocol[1]);
  const f = privateBoundaryFixture(ordinaryFixture("ordinary"), { version });
  const { trace, expected, request } = f;
  const find = (name) =>
    trace.spans.find((span) => span.operationName === name);
  const run = find("agent.run");
  let call = find("mcp.tools.call");
  const toolName = kind === "bash" ? "bash" : "mcp__fixture__progress";
  Object.assign(expected, {
    phase,
    kind: "execution",
    inputSessionID: expected.sessionId,
    closedBeforeResponse: version === 1 && ending === "success",
    toolCallId: createHash("sha256")
      .update(JSON.stringify(["run", 0, phase]))
      .digest("hex"),
  });
  for (const [key, value] of Object.entries({
    "antnest.run.id": "run",
    "antnest.request.id": "request_0123456789abcdef0123456789abcdef",
    "antnest.operation.phase": "execute",
    "antnest.outcome": ending === "cancel" ? "unresolved" : "ok",
    "run.terminal_class": ending === "cancel" ? "unresolved" : "completed",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": ending === "cancel" ? "unknown" : "settled",
    ...(ending === "cancel"
      ? {
          "run.unknown_effect_source": "runtime_mcp",
          "otel.status_code": "ERROR",
          "error.type": "run_unresolved",
          error: true,
        }
      : {}),
  }))
    set(run, key, value);
  f.requests.forEach((row, index) =>
    Object.assign(row, { phase, stage: index ? "final" : "tool" }),
  );
  let tool, work, operation, server;
  if (ending === "cancel") {
    const removed = new Set([call.spanID]);
    for (let size = -1; size !== removed.size;) {
      size = removed.size;
      for (const span of trace.spans)
        if (
          span.references.some(
            (ref) => ref.refType === "CHILD_OF" && removed.has(ref.spanID),
          )
        )
          removed.add(span.spanID);
    }
    trace.spans = trace.spans.filter(
      (span) =>
        !removed.has(span.spanID) &&
        !["model-1", "model-http-1"].includes(span.spanID),
    );
    f.requests.length = 1;
    const c = cancellationFixture({ kind, protocolFailed, heldDiscovery });
    const ids = new Map(
      c.trace.spans.map((span) => [span.spanID, `cancel-${span.spanID}`]),
    );
    for (const span of c.trace.spans) {
      span.spanID = ids.get(span.spanID);
      span.traceID = trace.traceID;
      span.processID =
        span.processID === "acp" ? "agent-acp-service" : "antnest-runtime";
      span.startTime += 14000;
      for (const ref of span.references) {
        ref.traceID = trace.traceID;
        ref.spanID = ids.get(ref.spanID);
      }
      for (const key of [
        "antnest.runtime.execution.id",
        "antnest.runtime.execution_id",
      ])
        if (tag(span, key) !== undefined) set(span, key, "execution_test");
      for (const entry of span.logs) {
        entry.timestamp += 14000;
        for (const row of entry.fields) {
          if (row.key === "trace_id") row.value = trace.traceID;
          if (row.key === "span_id") row.value = span.spanID;
        }
      }
      trace.spans.push(span);
    }
    call = c.owner;
    tool = c.tool;
    work = c.work;
    operation = c.operation;
    server = c.invocationServer;
    call.references = [
      { refType: "CHILD_OF", traceID: trace.traceID, spanID: run.spanID },
    ];
    set(call, "antnest.run.id", "run");
    run.duration = end(call) - run.startTime + 1000;
  } else {
    if (heldDiscovery)
      addToolLifecycleReceipt(trace, call, {
        heldDiscovery: true,
        cancelledClients: ["discover"],
        cancelledServers: ["discover"],
      });
    tool = find("runtime.mcp.tool");
    operation = trace.spans.find(
      (span) => span.spanID === tool.references[0].spanID,
    );
    server = trace.spans.find(
      (span) => span.spanID === operation.references[0].spanID,
    );
    const failed = kind === "managed" && ending === "failure",
      outcome = failed ? "error" : "success";
    set(call, "tool.name", toolName);
    set(call, "antnest.runtime.execution_id", "execution_test");
    set(operation, "mcp.tool.name", toolName);
    for (const [key, value] of Object.entries({
      "span.kind": "internal",
      "antnest.agent.id": expected.agentId,
      "antnest.runtime.generation": "1",
      "mcp.tool.name": kind === "bash" ? "bash" : "managed",
      "mcp.tool.outcome": outcome,
      "otel.status_code": failed ? "ERROR" : "OK",
      ...(kind === "managed"
        ? { "error.type": failed ? "managed_tool_error" : "" }
        : {}),
      ...(failed ? { error: true } : {}),
    }))
      set(tool, key, value);
    const logIdentity = (span) => ({
      "service.name": "antnest-runtime",
      "antnest.agent.id": expected.agentId,
      "antnest.runtime.generation": "1",
      trace_id: trace.traceID,
      span_id: span.spanID,
    });
    tool.logs = [
      event(
        end(tool) - 5,
        kind === "bash"
          ? "Runtime MCP tool completed"
          : "Managed MCP tool finished",
        {
          level: "INFO",
          outcome,
          ...(kind === "bash"
            ? { ...logIdentity(tool), tool: "bash" }
            : {
                "mcp.server.tool": toolName,
                "error.type": failed ? "managed_tool_error" : "",
              }),
        },
      ),
    ];
    work = {
      spanID: "progress-work",
      traceID: trace.traceID,
      operationName: kind === "bash" ? "runtime.executor" : "runtime.mcp.stdio",
      processID: tool.processID,
      startTime: tool.startTime + 10,
      duration: tool.duration - 40,
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: tool.spanID },
      ],
      tags: fields({
        "span.kind": kind === "bash" ? "internal" : "client",
        "otel.status_code": failed ? "ERROR" : "OK",
        ...(kind === "bash"
          ? {
              "antnest.agent.id": expected.agentId,
              "antnest.runtime.generation": "1",
              "executor.tool.name": "bash",
              "executor.child.pid": "39",
              "executor.exit.classification": "success",
              "executor.outcome": "success",
              "process.exit.code": 0,
            }
          : {
              "mcp.tool.name": toolName,
              "rpc.method": "tools/call",
              "antnest.protocol.outcome": outcome,
            }),
        ...(failed ? { error: true, "error.type": "managed_tool_error" } : {}),
      }),
      logs: [],
    };
    if (kind === "bash")
      work.logs = [
        event(end(work) - 1, "Runtime Executor completed", {
          ...logIdentity(work),
          level: "INFO",
          outcome: "success",
          "error.type": "",
        }),
      ];
    if (failed) {
      for (const [key, value] of Object.entries({
        "antnest.mcp.tool_result.outcome": "tool_error",
        "antnest.outcome": "tool_error",
        "error.type": "mcp_tool_error",
        "otel.status_code": "ERROR",
        error: true,
      }))
        set(call, key, value);
      eventField(call.logs[2], "outcome", "tool_error");
      set(server, "antnest.protocol.outcome", "error");
      set(operation, "mcp.operation.outcome", "error");
      set(operation, "antnest.operation.outcome", "error");
      for (const span of [server, operation]) {
        set(span, "error.type", "managed_tool_error");
        set(span, "otel.status_code", "ERROR");
        set(span, "error", true);
      }
      eventField(operation.logs[0], "mcp.operation.outcome", "error");
      eventField(operation.logs[0], "error.type", "managed_tool_error");
      operation.logs.unshift(
        event(end(tool), "antnest.error", {
          "antnest.error.stage": "mcp.dispatch",
          "antnest.error.type": "managed_tool_error",
          "antnest.error.code": "managed_tool_error",
          "antnest.error.message":
            "Tool returned an unsuccessful protocol result",
        }),
      );
      work.logs = [
        event(end(work) - 1, "antnest.error", {
          "antnest.error.stage": "mcp.stdio",
          "antnest.error.type": "managed_tool_error",
          "antnest.error.code": "managed_tool_error",
          "antnest.error.message": "Managed tool returned isError",
        }),
      ];
    }
    trace.spans.push(work);
  }
  // v2 acknowledges admission before its asynchronous Run finishes.
  request.duration = version === 2 ? 500 : end(run) - request.startTime + 2000;
  let postRead;
  if (version === 1 && refresh) postRead = addPostPromptInformationRead(trace);
  if (expected.closedBeforeResponse) {
    for (const [key, value] of Object.entries({
      error: true,
      "error.type": "Error",
      "otel.status_code": "ERROR",
      "antnest.outcome": "error",
      "antnest.operation.phase": "acp.dispatch",
    }))
      set(request, key, value);
    request.logs = [
      event(end(request) - 1, "antnest.error", {
        "antnest.error.stage": "acp.dispatch",
        "antnest.error.type": "Error",
        "antnest.error.message": "Error: unregistered message omitted",
        "antnest.error.cause_types": "[]",
        "antnest.error.causes": JSON.stringify([
          { type: "Error", message: "Error: unregistered message omitted" },
        ]),
        "antnest.operation.phase": "acp.dispatch",
      }),
    ];
  }
  return {
    ...f,
    run,
    call,
    tool,
    work,
    operation,
    server,
    postRead,
    kind,
    ending,
    set,
    event,
    eventField,
  };
}
