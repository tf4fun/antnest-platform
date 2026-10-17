import { createHash } from "node:crypto";
import { requestFixture } from "../acp-plan/trace-fixture.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import {
  addRunInformationRead,
  addPostPromptInformationRead,
  addToolLifecycleReceipt,
} from "../observability/runtime-information-run-fixtures.mjs";
import { tag } from "../observability/trace-tree.mjs";

export function fixture(phase = "v1-once") {
  const f = requestFixture("session/prompt");
  const { add, expected, trace } = f;
  expected.phase = phase;
  const denied = /deny|reject|cancel|chat/.test(phase);
  add("run", "request", "agent.run", undefined, 3, { "antnest.run.id": "run" });
  add("transaction", "run", "postgresql transaction", undefined, 4, {
    "db.system.name": "postgresql",
    "antnest.transaction.outcome": "committed",
  });
  add("insert", "transaction", "INSERT", undefined, 4, {
    "span.kind": "client",
    "db.system.name": "postgresql",
    "db.operation.name": "INSERT",
  });
  for (const [id, operation] of [
    ["info", "mcp.runtime.info"],
    ["list", "mcp.tools.list"],
  ]) {
    if (phase.endsWith("chat") && id === "list") continue;
    add(id, "run", operation, undefined, 5);
    add(`${id}-runtime`, id, "HTTP POST /mcp", "antnest-runtime", 5);
  }
  const stages = /cancel|chat/.test(phase)
    ? [0]
    : phase.includes("judge-")
      ? [0, "judge", 1]
      : [0, 1];
  f.requests = stages.map((stage, index) => {
    add(`model-${index}`, "run", "model.complete", undefined, 10 + index * 10, {
      "model.purpose": stage === "judge" ? "permission_judge" : "response",
    });
    add(
      `http-${index}`,
      `model-${index}`,
      "HTTP POST model",
      undefined,
      10 + index * 10,
      { "span.kind": "client" },
    );
    return {
      phase,
      stage,
      trace_id: trace.traceID,
      model_span_id: `http-${index}`,
    };
  });
  if (/once|deny|always$|reject$|cancel|reconnect|judge-ask/.test(phase))
    add("wait", "run", "acp.permission.wait", undefined, 22, {
      "antnest.run.id": "run",
      "antnest.session.id": "session",
      "antnest.outcome": /deny|reject/.test(phase)
        ? "rejected"
        : phase.endsWith("cancel")
          ? "cancelled"
          : "ok",
    });
  if (!denied) {
    add("call", "run", "mcp.tools.call", undefined, 24, {
      "antnest.run.id": "run",
      "tool.name": phase.includes("judge-")
        ? "mcp__fixture__echo"
        : phase.endsWith("read-hint")
          ? "read"
          : "write",
    });
    add("call-http", "call", "HTTP POST antnest-runtime", undefined, 24, {
      "span.kind": "client",
    });
    add("server", "call-http", "HTTP POST /mcp", "antnest-runtime", 24, {
      "span.kind": "server",
      "rpc.method": "tools/call",
    });
    add("tool", "server", "runtime.mcp.tool", "antnest-runtime", 24);
  }
  return f;
}

export function privateFixture(phase = "v1-once") {
  const version = Number(phase[1]);
  const f = privateBoundaryFixture(fixture(phase), { version });
  const { expected, field } = f;
  Object.assign(expected, {
    version,
    kind: "execution",
    inputSessionID: "session",
    outcome: "succeeded",
    requestParams: {
      sessionId: "session",
      prompt: [{ type: "text", text: phase }],
    },
  });
  const closed = phase === "v1-reconnect";
  if (closed)
    Object.assign(expected, { outcome: "failed", closedBeforeResponse: true });
  else
    expected.requestReceipt = {
      requestId: expected.requestId,
      params: structuredClone(expected.requestParams),
      result:
        version === 1
          ? { stopReason: phase.endsWith("cancel") ? "cancelled" : "end_turn" }
          : { messageId: `message-${phase}` },
    };
  const id = createHash("sha256")
    .update(JSON.stringify(["run", 0, phase]))
    .digest("hex");
  const run = f.trace.spans.find((s) => s.spanID === "run");
  for (const [key, value] of Object.entries({
    "antnest.session.id": "session",
    "antnest.outcome": phase.endsWith("cancel") ? "cancelled" : "ok",
    "run.terminal_class": phase.endsWith("cancel") ? "cancelled" : "completed",
    "run.executor_state": "quiescent",
    "run.tool_effect_state": /deny|reject|cancel|chat/.test(phase)
      ? "none"
      : "settled",
  }))
    field(run, key, value);
  const wait = f.trace.spans.find((s) => s.spanID === "wait");
  if (wait) {
    const choice = phase.endsWith("cancel")
      ? null
      : phase.endsWith("deny")
        ? "reject_once"
        : phase.endsWith("reject")
          ? "reject_always"
          : phase.endsWith("always")
            ? "allow_always"
            : "allow_once";
    const toolCall = {
      toolCallId: id,
      rawInput: phase.includes("judge-")
        ? { value: phase }
        : { path: `${phase}.txt`, content: `${phase}\n` },
    };
    const params = {
      sessionId: "session",
      options: [
        "allow_once",
        "allow_always",
        "reject_once",
        "reject_always",
      ].map((optionId) => ({ optionId })),
      ...(version === 1
        ? { toolCall }
        : { subject: { type: "tool_call", toolCall } }),
    };
    const delivery = (optionId, requestId) => ({
      requestId,
      params: structuredClone(params),
      outcome: optionId ? "selected" : "cancelled",
      ...(optionId ? { optionId } : {}),
    });
    expected.permissionDeliveries = phase.endsWith("reconnect")
      ? [delivery(null, "original"), delivery("allow_once", "reissued")]
      : [delivery(choice, "approval")];
    for (const [key, value] of Object.entries({
      "run.id": "run",
      "session.id": "session",
      "tool.call_id": id,
    }))
      field(wait, key, value);
  }
  return f;
}

// Controlled fixture composition only. Archived service evidence is never
// enriched, reparented or assigned synthetic completion events.
export function completePermissionRuntimeFixture(
  phase = "v1-once",
  { refresh = false, cleanup = false } = {},
) {
  const f = privateFixture(phase);
  const { trace, expected, request, field } = f;
  const version = expected.version;
  const fields = (record) =>
    Object.entries(record).map(([key, value]) => ({ key, value }));
  const event = (timestamp, name, record) => ({
    timestamp,
    fields: fields({ event: name, ...record }),
  });
  const removeTree = (span) => {
    const ids = new Set([span.spanID]);
    for (let size = -1; size !== ids.size;) {
      size = ids.size;
      for (const child of trace.spans)
        if (
          child.references.some(
            (ref) => ref.refType === "CHILD_OF" && ids.has(ref.spanID),
          )
        )
          ids.add(child.spanID);
    }
    trace.spans = trace.spans.filter((row) => !ids.has(row.spanID));
  };
  const chat = phase.endsWith("chat");
  if (chat) {
    const resources = structuredClone(trace.processes);
    f.add("list", "run", "mcp.tools.list", undefined, 5);
    f.add("list-runtime", "list", "HTTP POST /mcp", "antnest-runtime", 5);
    Object.assign(trace.processes, resources);
  }
  const information = addRunInformationRead(trace, { version });
  if (chat) removeTree(information.list);
  const find = (id) => trace.spans.find((span) => span.spanID === id);
  const call = find("call"),
    tool = find("tool");
  let work, operation;
  if (call) {
    const name = tag(call, "tool.name");
    const managed = name === "mcp__fixture__echo";
    field(call, "antnest.runtime.execution_id", "execution_test");
    field(call, "mcp.source_id", "runtime");
    operation = find(tool.references[0].spanID);
    field(operation, "mcp.tool.name", name);
    const identity = {
      "service.name": "antnest-runtime",
      "antnest.agent.id": expected.agentId,
      "antnest.runtime.generation": "1",
    };
    for (const [key, value] of Object.entries({
      "span.kind": "internal",
      "antnest.agent.id": expected.agentId,
      "antnest.runtime.generation": "1",
      "mcp.tool.name": managed ? "managed" : name,
      "mcp.tool.outcome": "success",
      "otel.status_code": "OK",
      ...(managed ? { "error.type": "" } : {}),
    }))
      field(tool, key, value);
    tool.logs = [
      event(
        tool.startTime + tool.duration - 5,
        managed ? "Managed MCP tool finished" : "Runtime MCP tool completed",
        {
          level: "INFO",
          outcome: "success",
          ...(managed
            ? { "mcp.server.tool": name, "error.type": "" }
            : {
                ...identity,
                trace_id: trace.traceID,
                span_id: tool.spanID,
                tool: name,
              }),
        },
      ),
    ];
    work = {
      spanID: "permission-work",
      traceID: trace.traceID,
      operationName: managed ? "runtime.mcp.stdio" : "runtime.executor",
      processID: tool.processID,
      startTime: tool.startTime + 10,
      duration: tool.duration - 30,
      references: [
        { refType: "CHILD_OF", traceID: trace.traceID, spanID: tool.spanID },
      ],
      tags: fields({
        "span.kind": managed ? "client" : "internal",
        "otel.status_code": "OK",
        ...(managed
          ? {
              "mcp.tool.name": name,
              "rpc.method": "tools/call",
              "antnest.protocol.outcome": "success",
            }
          : {
              "antnest.agent.id": expected.agentId,
              "antnest.runtime.generation": "1",
              "executor.tool.name": name,
              "executor.child.pid": "39",
              "executor.exit.classification": "success",
              "executor.outcome": "success",
              "process.exit.code": 0,
            }),
      }),
      logs: [],
    };
    if (!managed)
      work.logs = [
        event(
          work.startTime + work.duration - 1,
          "Runtime Executor completed",
          {
            ...identity,
            trace_id: trace.traceID,
            span_id: work.spanID,
            level: "INFO",
            outcome: "success",
            "error.type": "",
          },
        ),
      ];
    trace.spans.push(work);
  }
  if (cleanup)
    for (const owner of trace.spans.filter((span) =>
      ["mcp.tools.list", "mcp.tools.call"].includes(span.operationName),
    ))
      addToolLifecycleReceipt(trace, owner, {
        heldDiscovery: true,
        cancelledClients: ["discover"],
        cancelledServers: ["discover"],
      });
  const beforePost = trace.spans.length;
  const post = refresh
    ? addPostPromptInformationRead(
        trace,
        cleanup
          ? {
              runtimeOutcome: "canceled",
              clientOutcome: "cancelled",
            }
          : {},
      )
    : undefined;
  // The shared synthetic helper uses array length for IDs. Chat removes the
  // catalogue subtree, so give this distinct appended read its own namespace.
  if (post) {
    const added = trace.spans.slice(beforePost);
    const ids = new Map(
      added.map((span) => [span.spanID, `post-${span.spanID}`]),
    );
    for (const span of added) {
      span.spanID = ids.get(span.spanID);
      for (const ref of span.references)
        if (ids.has(ref.spanID)) ref.spanID = ids.get(ref.spanID);
      for (const entry of span.logs ?? [])
        for (const row of entry.fields)
          if (row.key === "span_id") row.value = span.spanID;
    }
  }
  if (version === 2) request.duration = 500;
  if (expected.closedBeforeResponse) {
    for (const [key, value] of Object.entries({
      error: true,
      "error.type": "Error",
      "otel.status_code": "ERROR",
      "antnest.outcome": "error",
      "antnest.operation.phase": "acp.dispatch",
    }))
      field(request, key, value);
    request.logs = [
      event(request.startTime + request.duration - 1, "antnest.error", {
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
    information,
    run: information.run,
    call,
    tool,
    work,
    operation,
    post,
    removeTree,
  };
}
