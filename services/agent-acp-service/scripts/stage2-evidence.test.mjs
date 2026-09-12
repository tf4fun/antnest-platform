import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectLifecycleTraces, inspectAcpControllerCalls } from "./stage2-trace-assert.mjs";
import { assertPromptEvidence } from "./stage2-acp-evidence.mjs";

function lifecycle() {
  const make = (traceID) => ({ traceID, spans: [], processes: {} });
  const add = (trace, service, operationName, spanID, parent, tags = {}) => {
    trace.processes[service] = { serviceName: service };
    const span = {
      traceID: trace.traceID,
      spanID,
      processID: service,
      operationName,
      duration: 10,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      references: parent ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }] : [],
    };
    trace.spans.push(span);
    return span;
  };
  const admission = make("admission");
  add(admission, "agent-controller", "HTTP POST /internal/agents", "http", null, {
    "http.route": "/internal/agents",
    "http.response.status_code": 202,
    "antnest.lifecycle.kind": "create",
    "antnest.agent.id": "agent",
  });
  add(admission, "agent-controller", "HTTP POST identity-service", "auth", "http");
  add(
    admission,
    "identity-service",
    "HTTP POST /rpc/identity/resolve-owner-authorization",
    "identity",
    "auth",
  );
  const phases = ["network_ensure", "runtime_initialize", "publish"];
  const workers = phases.map((phase, i) => {
    const trace = make(`worker${i + 1}`);
    const root = add(trace, "agent-controller", "recover Agent lifecycle operation", "root", null, {
      "antnest.lifecycle.request_id": "request",
      "antnest.lifecycle.kind": "create",
      "antnest.agent.id": "agent",
      "antnest.lifecycle.phase": phase,
      "antnest.lifecycle.recovery.attempt": i + 1,
      "antnest.lifecycle.recovery.terminal": i === 2,
      "antnest.lifecycle.recovery.state": i === 2 ? "completed" : "running",
    });
    root.references = [{ refType: "FOLLOWS_FROM", traceID: "admission", spanID: "http" }];
    if (i) root.references.push({ refType: "FOLLOWS_FROM", traceID: `worker${i}`, spanID: "root" });
    if (i === 1) {
      add(trace, "agent-controller", "HTTP POST runtime-controller", "call", "root");
      add(trace, "runtime-controller", "runtime.lifecycle.initialize_runtime", "server", "call");
      add(trace, "runtime-controller", "runtime.platform.create", "platform", "server");
    } else {
      add(trace, "agent-controller", "HTTP PUT runtime-egress", "call", "root");
      add(
        trace,
        "antnest-runtime-egress",
        i === 0
          ? "HTTP PUT /internal/agent-networks/{agent_id}"
          : "HTTP PUT /internal/agent-network-attachments/{agent_id}",
        "server",
        "call",
      );
    }
    return trace;
  });
  return { admission, workers, requestID: "request", agentID: "agent" };
}

function controllerCalls() {
  const trace = {
    traceID: "execution",
    processes: {
      acp: { serviceName: "agent-acp-service" },
      controller: { serviceName: "agent-controller" },
    },
    spans: [],
  };
  for (const [operation, route] of [
    ["resolve_agent_access", "resolve-agent-access"],
    ["acquire_run", "acquire-run"],
    ["finish_run", "finish-run"],
  ]) {
    const add = (id, processID, operationName, kind, parent) =>
      trace.spans.push({
        traceID: trace.traceID,
        spanID: id,
        processID,
        operationName,
        tags: [{ key: "span.kind", value: kind }],
        references: parent ? [{ refType: "CHILD_OF", traceID: trace.traceID, spanID: parent }] : [],
      });
    add(operation, "acp", `agent_controller.${operation}`, "internal");
    add(`${operation}-client`, "acp", "HTTP POST agent-controller", "client", operation);
    add(
      `${operation}-server`,
      "controller",
      `HTTP POST /rpc/agent-controller/${route}`,
      "server",
      `${operation}-client`,
    );
  }
  return trace;
}

test("ACP Controller assertions distinguish INTERNAL operations from exact HTTP CLIENT parents", () => {
  inspectAcpControllerCalls(controllerCalls());
});

for (const [name, mutate] of [
  [
    "server parent bypasses CLIENT",
    (trace) => {
      trace.spans[2].references[0].spanID = "resolve_agent_access";
    },
  ],
  [
    "wrong parent trace",
    (trace) => {
      trace.spans[2].references[0].traceID = "foreign";
    },
  ],
  [
    "duplicate CLIENT send",
    (trace) => {
      trace.spans.push({ ...structuredClone(trace.spans[1]), spanID: "duplicate-client" });
    },
  ],
  [
    "missing finish SERVER",
    (trace) => {
      trace.spans.pop();
    },
  ],
  [
    "adapter is still CLIENT",
    (trace) => {
      trace.spans[0].tags[0].value = "client";
    },
  ],
])
  test(`ACP rejects ${name}`, () => {
    const trace = controllerCalls();
    mutate(trace);
    assert.throws(() => inspectAcpControllerCalls(trace));
  });

test("Stage 2 verifies admission and linked asynchronous workers, including reused span IDs", () => {
  const evidence = inspectLifecycleTraces(lifecycle());
  assert.equal(evidence.phase_traces, 3);
  assert.equal(evidence.causal_links_verified, true);
});

test("Stage 2 allows complete RPC content only when explicitly enabled", () => {
  const fixture = lifecycle();
  const receiver = fixture.workers[0].spans.at(-1);
  receiver.tags.push(
    { key: "rpc.method", value: "ensure_agent_network" },
    { key: "span.kind", value: "server" },
  );
  receiver.logs = [
    {
      fields: [
        { key: "event", value: "antnest.request" },
        {
          key: "antnest.payload.json",
          value: JSON.stringify({ newField: { token: "stage2-model-secret" } }),
        },
      ],
    },
  ];
  assert.throws(() => inspectLifecycleTraces(fixture));
  inspectLifecycleTraces({ ...fixture, captureRpcContent: true });
  receiver.tags.push({ key: "unexpected", value: "stage2-model-secret" });
  assert.throws(() => inspectLifecycleTraces({ ...fixture, captureRpcContent: true }));
  receiver.tags.pop();
  receiver.tags.find((tag) => tag.key === "span.kind").value = "client";
  assert.throws(() => inspectLifecycleTraces({ ...fixture, captureRpcContent: true }));
});

for (const [name, mutate] of [
  ["missing phase", (f) => f.workers.splice(1, 1)],
  [
    "wrong admission link",
    (f) => {
      f.workers[0].spans[0].references[0].traceID = "foreign";
    },
  ],
  [
    "wrong previous attempt trace",
    (f) => {
      f.workers[2].spans[0].references[1].traceID = "worker1";
    },
  ],
  [
    "duplicate attempt",
    (f) => {
      f.workers[1].spans[0].tags.find((t) => t.key.endsWith(".attempt")).value = 1;
    },
  ],
  [
    "foreign Agent",
    (f) => {
      f.workers[1].spans[0].tags.find((t) => t.key === "antnest.agent.id").value = "other";
    },
  ],
  [
    "disconnected runtime",
    (f) => {
      f.workers[1].spans[2].references = [];
    },
  ],
  [
    "unfinished publication",
    (f) => {
      f.workers[2].spans[0].tags.find((t) => t.key.endsWith(".terminal")).value = false;
    },
  ],
  [
    "worker secret leakage",
    (f) => {
      f.workers[1].spans[1].tags.push({ key: "custom", value: "stage2-owner-password" });
    },
  ],
  [
    "tool result attribute",
    (f) => {
      f.admission.spans[0].tags.push({ key: "tool.result", value: "redacted" });
    },
  ],
])
  test(`Stage 2 rejects ${name}`, () => {
    const fixture = lifecycle();
    mutate(fixture);
    assert.throws(() => inspectLifecycleTraces(fixture));
  });

const answer = "Stage 2 Runtime Tool execution completed.";
const event = (update) => ({ sessionId: "session", update });
function prompt(chunked = false) {
  return [
    event({ sessionUpdate: "state_update", state: "running" }),
    event({ sessionUpdate: "tool_call_update", toolCallId: "write", status: "completed" }),
    ...(chunked
      ? [answer.slice(0, 12), answer.slice(12)].map((text) =>
          event({
            sessionUpdate: "agent_message_chunk",
            messageId: "answer",
            content: { type: "text", text },
          }),
        )
      : [
          event({
            sessionUpdate: "agent_message",
            messageId: "answer",
            content: [{ type: "text", text: answer }],
          }),
        ]),
    event({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }),
  ];
}

for (const chunked of [false, true])
  test(`Stage 2 accepts complete v2 ${chunked ? "chunks" : "message"}`, () => {
    assert.equal(assertPromptEvidence({}, prompt(chunked), "session"), answer);
  });

for (const [name, mutate] of [
  [
    "foreign Session",
    (updates) => {
      updates[2].sessionId = "foreign";
    },
  ],
  [
    "uncompleted Tool",
    (updates) => {
      updates[1].update.status = "in_progress";
    },
  ],
  [
    "answer before Tool completion",
    (updates) => {
      [updates[1], updates[2]] = [updates[2], updates[1]];
    },
  ],
  [
    "truncated answer",
    (updates) => {
      updates[2].update.content[0].text = "Stage 2";
    },
  ],
  ["missing idle", (updates) => updates.pop()],
  [
    "failed Run",
    (updates) => {
      updates.at(-1).update.stopReason = "error";
    },
  ],
  ["duplicate answer", (updates) => updates.splice(3, 0, structuredClone(updates[2]))],
])
  test(`Stage 2 rejects ${name}`, () => {
    const updates = prompt();
    mutate(updates);
    assert.throws(() => assertPromptEvidence({}, updates, "session"));
  });

test("Stage 2 must not combine chunks from unrelated responses", () => {
  const updates = prompt(true);
  updates[3].update.messageId = "another-answer";
  assert.throws(() => assertPromptEvidence({}, updates, "session"));
});

test("Stage 2 rejects running after Tool and answer", () => {
  const updates = prompt();
  updates.splice(2, 0, updates.shift());
  assert.throws(() => assertPromptEvidence({}, updates, "session"));
});

test("Stage 2 selects the last emitted response rather than the last inserted message ID", () => {
  const updates = prompt();
  const chunk = (text) =>
    event({
      sessionUpdate: "agent_message_chunk",
      messageId: "interleaved",
      content: { type: "text", text },
    });
  updates.splice(2, 0, chunk("Earlier "));
  updates.splice(4, 0, chunk("incorrect answer"));
  assert.throws(() => assertPromptEvidence({}, updates, "session"));
});

test("Stage 2 rejects complete but reordered lifecycle phases", () => {
  const fixture = lifecycle();
  [fixture.workers[0], fixture.workers[1]] = [fixture.workers[1], fixture.workers[0]];
  for (const [i, trace] of fixture.workers.entries()) {
    const root = trace.spans[0];
    root.tags.find((t) => t.key.endsWith(".attempt")).value = i + 1;
    root.references = [{ refType: "FOLLOWS_FROM", traceID: "admission", spanID: "http" }];
    if (i)
      root.references.push({
        refType: "FOLLOWS_FROM",
        traceID: fixture.workers[i - 1].traceID,
        spanID: "root",
      });
  }
  assert.throws(() => inspectLifecycleTraces(fixture));
});
