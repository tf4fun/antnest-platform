import { reset } from "../edge-gateway/resolve-cache-stream-fixtures.mjs";
export const phaseNames = [
  "receive-started",
  "body-eof",
  "body-parsed",
  "input-prepared",
];
const tag = (key, value) => ({ key, value });
export function httpFixture(id, start, method = "GET", status = 200, phases) {
  const attributes = [
    tag("span.kind", "server"),
    tag("http.request.method", method),
    tag("http.route", "/api/app/workspace/v1/*"),
    tag("http.response.status_code", status),
    tag("antnest.ui.http.started_monotonic_ns", String(start)),
  ];
  return {
    traceID: id,
    processes: {
      ui: {
        serviceName: "agent-ui",
        tags: [
          tag("service.instance.id", "ui-instance"),
          tag("host.name", "ui-host"),
          tag("process.pid", 1),
        ],
      },
      edge: {
        serviceName: "edge-gateway",
        tags: [
          tag("service.instance.id", "edge-instance"),
          tag("host.name", "edge-host"),
          tag("process.pid", 1),
        ],
      },
    },
    spans: [
      {
        traceID: id,
        spanID: "1".repeat(16),
        operationName: "edge",
        processID: "edge",
        references: [],
        tags: [],
        logs: [],
      },
      {
        traceID: id,
        spanID: "2".repeat(16),
        operationName: "agent_ui.http.request",
        processID: "ui",
        references: [
          { refType: "CHILD_OF", traceID: id, spanID: "1".repeat(16) },
        ],
        tags: attributes,
        logs: (phases ?? []).map((time, index) => ({
          timestamp: 100 + index,
          fields: [
            tag("event", "antnest.ui.prompt_input"),
            tag("phase", phaseNames[index]),
            tag("bytes", index === 0 ? 65536 : 16720000),
            tag("monotonic_ns", String(time)),
          ],
        })),
      },
    ],
  };
}
export function capacityFixture(
  phase = "body-completion-and-parse",
  cancel_path = "operation-cancel",
) {
  const scope = {
    organization_id: "org",
    user_a: "user-a",
    user_b: "user-b",
    agent_a: "agent-a",
    agent_b: "agent-b",
    session_a: "session-a",
    session_b: "session-b",
    session_a_aux: "session-a-aux",
    session_b_aux: "session-b-aux",
  };
  const b = "/api/app/workspace/v1/agents/agent-b",
    sp = b + "/sessions/session-b";
  const op = {
    operationId: "held",
    sessionId: "session-b",
    runId: "run-b",
    acceptance: "acp",
    phase: "running",
  };
  const physical = {
    id: "a".repeat(64),
    agent_id: "agent-b",
    image: "sha256:" + "b".repeat(64),
    started_at: "2026-10-18T00:00:00Z",
    restarts: 0,
    generation: 1,
    running: true,
    health: "healthy",
  };
  const sample = (at, alive = true) => ({
    at_ns: String(at),
    container: { ...physical },
    status: { execution_id: "execution-b", status: "ready" },
    work: {
      pid: 40,
      pgid: 40,
      stat: alive ? "40 (sh) S 1 40 0" : "",
      processes: alive ? "40 (sh) S 1 40 0\n41 (sleep) S 40 40 0\n" : "",
      effects: "started\n",
    },
  });
  const receipt = (id, at) => ({
    trace_id: id.repeat(32),
    path: b + "/view",
    status: 200,
    sent_ns: String(at - 100),
    complete_ns: String(at + 100),
    trace: httpFixture(id.repeat(32), at + 1000),
  });
  const cancelTime = phase === "body-incomplete" ? 20000000 : 60000000;
  const traces = ["3".repeat(32), "4".repeat(32)];
  const cancelBody =
    cancel_path === "operation-cancel"
      ? { expectedRunId: "run-b" }
      : {
          text: "/stop",
          sessionId: "session-b",
          operationId: "held",
          expectedRunId: "run-b",
        };
  const r = {
    phase,
    cancel_path,
    scope,
    upload: {
      trace_id: traces[0],
      path: "/api/app/workspace/v1/agents/agent-a/sessions/session-a/prompts",
      status: 202,
      sent_ns: "5000000",
      eof_sent_ns: "50000000",
      complete_ns: "300000000",
      body_bytes: 16720000,
      wire_bytes: 16720110,
      limit: 16777216,
      intent_id: "upload",
      capabilities: { image: true },
      attachments: [0, 1, 2].map((i) => ({
        sha256: String(i + 1).repeat(64),
        size: 4180000,
        width: 1024,
        height: 1020,
      })),
      trace: httpFixture(
        traces[0],
        5001000,
        "POST",
        202,
        [10000000, 50000000, 100000000, 120000000],
      ),
      response: {
        operationId: "upload",
        acceptance: "bridge",
        phase: "dispatching",
      },
    },
    calibration: {
      before: [receipt("5", 1000000), receipt("6", 2000000)],
      after: [receipt("7", 900000000), receipt("8", 910000000)],
    },
    cancel: {
      trace_id: traces[1],
      path:
        cancel_path === "operation-cancel"
          ? sp + "/operations/held/cancel"
          : b + "/commands",
      status: 200,
      request: cancelBody,
      response:
        cancel_path === "operation-cancel"
          ? { ...op, phase: "cancelling" }
          : { command: "stop", text: "Cancellation requested." },
      sent_ns: String(cancelTime),
      complete_ns: String(cancelTime + 20000000),
      trace: httpFixture(traces[1], cancelTime + 1000, "POST"),
    },
    accepted: op,
    terminal: {
      operation: { ...op, phase: "cancelled" },
      at_ns: String(cancelTime + 30000000),
    },
    runtime: {
      organization_id: "org",
      execution_revision: "execution-rev",
      runtime_revision: "runtime-rev",
      runtime_execution_id: "execution-b",
      container: { ...physical },
      started: sample(3000000),
      before_cancel: sample(cancelTime - 1000000),
      quiescent: sample(cancelTime + 40000000, false),
    },
    audit: {
      run_id: "run-b",
      session_id: "session-b",
      agent_id: "agent-b",
      principal_id: "user-b",
      state: "cancelled",
      terminal_class: "cancelled",
      executor_state: "quiescent",
    },
    pool: Array.from({ length: 64 }, (_, i) => {
      const owner = Math.floor(i / 16),
        agent = ["agent-a", "agent-b", "filler-a", "filler-b"][owner],
        session =
          ["session-a", "session-b", "filler-session-a", "filler-session-b"][
            owner
          ] + (i % 16 < 8 ? "" : "-aux");
      return {
        organization_id: "org",
        principal_id: owner % 2 === 0 ? "user-a" : "user-b",
        agent_id: agent,
        session_id: session,
        trace_id: (i + 20).toString(16).padStart(32, "0"),
        status: 200,
        view: { agentId: agent, selectedSessionId: session },
        live_before_ns: String(cancelTime - 2000000),
        live_after_ns: String(cancelTime + 50000000),
        closed_ns: "950000000",
        joined: true,
      };
    }),
    overflow: {
      status: 503,
      body: {
        code: "workspace_unavailable",
        message: "Workspace stream capacity is unavailable",
      },
      sent_ns: String(cancelTime - 3000000),
      complete_ns: String(cancelTime - 2500000),
    },
    upload_model: {
      phase: "upload",
      images: [0, 1, 2].map((i) => ({
        sha256: String(i + 1).repeat(64),
        size: 4180000,
      })),
    },
    held_model: { phase: "held", stage: "tool", continuations: 0 },
  };
  r.terminal.operation.phase = "uncertain";
  r.terminal.operation.errorClass = "cancelled_tool_outcome_unknown";
  Object.assign(r.audit, {
    state: "unresolved",
    terminal_class: "unresolved",
    tool_effect_state: "unknown",
    error_class: "cancelled_tool_outcome_unknown",
  });
  r.run_snapshot = {
    run_id: op.runId,
    session_id: scope.session_b,
    organization_id: scope.organization_id,
    snapshot_organization_id: scope.organization_id,
    agent_id: scope.agent_b,
    principal_id: scope.user_b,
    bridge_intent_id: op.operationId,
    execution_revision: r.runtime.execution_revision,
    runtime_revision: r.runtime.runtime_revision,
    runtime_execution_id: r.runtime.runtime_execution_id,
    state: "running",
    snapshot_sha256: "e".repeat(64),
  };
  r.work_trace = {
    traceID: "c".repeat(32),
    processes: {
      acp: { serviceName: "agent-acp-service", tags: [] },
      runtime: { serviceName: "antnest-runtime", tags: [] },
    },
    spans: [
      {
        spanID: "a".repeat(16),
        processID: "acp",
        operationName: "agent.run",
        references: [],
        tags: [
          tag("antnest.run.id", op.runId),
          tag("antnest.agent.id", scope.agent_b),
          tag("antnest.session.id", scope.session_b),
        ],
      },
      {
        spanID: "b".repeat(16),
        processID: "acp",
        operationName: "model.complete",
        references: [
          {
            refType: "CHILD_OF",
            traceID: "c".repeat(32),
            spanID: "a".repeat(16),
          },
        ],
        tags: [
          tag("antnest.organization.id", scope.organization_id),
          tag("antnest.execution.revision", r.runtime.execution_revision),
          tag("antnest.runtime.revision", r.runtime.runtime_revision),
          tag("antnest.runtime.execution_id", r.runtime.runtime_execution_id),
        ],
      },
      {
        spanID: "c".repeat(16),
        processID: "acp",
        operationName: "HTTP POST model",
        references: [
          {
            refType: "CHILD_OF",
            traceID: "c".repeat(32),
            spanID: "b".repeat(16),
          },
        ],
        tags: [],
      },
      {
        spanID: "d".repeat(16),
        processID: "runtime",
        operationName: "runtime.executor",
        references: [
          {
            refType: "CHILD_OF",
            traceID: "c".repeat(32),
            spanID: "a".repeat(16),
          },
        ],
        tags: [
          tag("antnest.agent.id", scope.agent_b),
          tag("antnest.runtime.execution.id", r.runtime.runtime_execution_id),
          tag("antnest.runtime.generation", "1"),
          tag("executor.tool.name", "bash"),
          tag("executor.child.pid", "40"),
          tag("executor.exit.classification", "canceled"),
        ],
      },
    ],
  };
  r.held_model.trace_id = r.work_trace.traceID;
  r.held_model.model_span_id = "c".repeat(16);
  for (const receipt of [
    r.upload,
    r.cancel,
    ...r.calibration.before,
    ...r.calibration.after,
  ])
    receipt.response_trace_id = receipt.trace_id;
  for (const row of r.pool) {
    row.ready_ns = "2000000";
    row.ready_at_ms = 2;
    row.live_after_ms = Number(row.live_after_ns) / 1e6;
    const event = { type: "snapshot", agentId: row.agent_id, view: row.view };
    row.raw = {
      trace_id: row.trace_id,
      status: 200,
      events: [{ at: 2, raw: event }],
      frames: [
        {
          at: 2,
          raw: "event: snapshot\ndata: " + JSON.stringify(event) + "\n\n",
        },
      ],
      closure: { kind: "local-close", at: 950 },
    };
    row.response_trace_id = row.trace_id;
    row.trace = httpFixture(row.trace_id, 1500000);
  }
  r.cancel.sent_perf_ms = cancelTime / 1e6;
  r.overflow.sent_perf_ms = Number(r.overflow.sent_ns) / 1e6;
  r.terminal.at_perf_ms = Number(r.terminal.at_ns) / 1e6;
  r.runtime.quiescent.at_perf_ms = Number(r.runtime.quiescent.at_ns) / 1e6;

  const binding = {
    "antnest.organization.id": scope.organization_id,
    "antnest.execution.revision": r.runtime.execution_revision,
    "antnest.runtime.revision": r.runtime.runtime_revision,
    "antnest.runtime.execution_id": r.runtime.runtime_execution_id,
  };
  r.work_trace.spans[0].tags.push(
    ...Object.entries(binding).map(([k, v]) => tag(k, v)),
  );
  const executor = r.work_trace.spans.pop(),
    rtid = "runtime";
  const chain = [
    ["mcp.tools.call", "acp", binding],
    ["HTTP POST antnest-runtime", "acp", {}],
    [
      "HTTP POST /mcp",
      rtid,
      {
        "antnest.agent.id": scope.agent_b,
        "antnest.runtime.execution.id": r.runtime.runtime_execution_id,
        "antnest.runtime.generation": "1",
      },
    ],
    [
      "runtime.mcp.operation",
      rtid,
      {
        "antnest.agent.id": scope.agent_b,
        "antnest.runtime.execution.id": r.runtime.runtime_execution_id,
        "antnest.runtime.generation": "1",
      },
    ],
    ["runtime.mcp.tool", rtid, {}],
  ];
  let parent = "a".repeat(16);
  for (let i = 0; i < chain.length; i++) {
    const [name, processID, tags] = chain[i],
      spanID = String(i + 3).repeat(16);
    r.work_trace.spans.push({
      spanID,
      processID,
      operationName: name,
      references: [
        { refType: "CHILD_OF", traceID: r.work_trace.traceID, spanID: parent },
      ],
      tags: Object.entries(tags).map(([k, v]) => tag(k, v)),
    });
    parent = spanID;
  }
  executor.references[0].spanID = parent;
  r.work_trace.spans.push(executor);
  r.work_trace.processes.runtime.tags = [
    tag("antnest.agent.id", scope.agent_b),
    tag("antnest.runtime.generation", "1"),
    tag("antnest.runtime.image.id", r.runtime.container.image),
  ];
  for (const row of r.pool) {
    const event = reset(row.session_id, 1);
    event.agentId = row.agent_id;
    event.view.agentId = row.agent_id;
    event.view.selectedView.agentId = row.agent_id;
    row.view = event.view;
    row.raw.events = [{ at: 2, raw: event }];
    row.raw.frames = [
      { at: 2, raw: "event: reset\ndata: " + JSON.stringify(event) + "\n\n" },
    ];
  }

  r.upload.eof_sent_ns = phase === "body-incomplete" ? "70000000" : "49000000";
  if (phase === "body-incomplete")
    r.upload.trace.spans[1].logs[1].fields.find(
      (f) => f.key === "monotonic_ns",
    ).value = "80000000";

  r.upload_terminal = {
    operationId: r.upload.intent_id,
    sessionId: scope.session_a,
    runId: "run-a",
    acceptance: "acp",
    phase: "completed",
  };
  r.upload_audit = {
    run_id: "run-a",
    session_id: scope.session_a,
    agent_id: scope.agent_a,
    principal_id: scope.user_a,
    state: "completed",
  };
  r.upload_work_trace = structuredClone(r.work_trace);
  r.upload_work_trace.traceID = "d".repeat(32);
  r.upload_work_trace.spans = r.upload_work_trace.spans.slice(0, 3);
  for (const span of r.upload_work_trace.spans) {
    for (const ref of span.references)
      ref.traceID = r.upload_work_trace.traceID;
    for (const t of span.tags) {
      if (t.key === "antnest.run.id") t.value = "run-a";
      if (t.key === "antnest.agent.id") t.value = scope.agent_a;
      if (t.key === "antnest.session.id") t.value = scope.session_a;
    }
  }
  r.upload_model.trace_id = r.upload_work_trace.traceID;
  r.upload_model.model_span_id = "c".repeat(16);
  r.overflow.trace_id = "e".repeat(32);
  r.overflow.response_trace_id = r.overflow.trace_id;
  r.overflow.path =
    "/api/app/workspace/v1/agents/agent-a/events?sessionId=session-a";
  r.overflow.trace = httpFixture(r.overflow.trace_id, 10000000);
  r.overflow.trace.spans.splice(1);
  r.overflow.trace.spans[0].tags = [
    tag("span.kind", "server"),
    tag("http.request.method", "GET"),
    tag("http.route", "/api/app/workspace/v1/{path...}"),
    tag("http.response.status_code", 503),
  ];

  if (phase === "body-completion-and-parse") {
    r.upload.requested_trace_id = r.upload.trace_id;
    Object.assign(r.cancel, {
      prepared_ns: "3500000",
      socket_ready_ns: "4000000",
      written_ns: String(cancelTime + 1000),
      body_bytes: Buffer.byteLength(JSON.stringify(r.cancel.request)),
      joined: true,
    });
    const notice = (index) => {
      const source = r.upload.trace.spans[1];
      const phase = Object.fromEntries(
        source.logs[index].fields.map(({ key, value }) => [key, value]),
      );
      return {
        traceId: source.traceID,
        spanId: source.spanID,
        processIdentity: Object.fromEntries(
          r.upload.trace.processes.ui.tags.map(({ key, value }) => [
            key,
            value,
          ]),
        ),
        phase: phase.phase,
        bytes: phase.bytes,
        monotonic_ns: phase.monotonic_ns,
      };
    };
    r.input_observation = {
      trace_id: r.upload.trace_id,
      body_bytes: r.upload.body_bytes,
      armed_ns: "4500000",
      triggered: 1,
      receive: { notice: notice(0), received_ns: "10000000" },
      eof: { notice: notice(1), received_ns: "50001000" },
    };
    r.input_observer = {
      connections: 1,
      messages: 2,
      ignored: 0,
      joined: true,
    };
  }

  return r;
}
