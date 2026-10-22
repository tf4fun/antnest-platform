import assert from "node:assert/strict";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";

const agentID = "foundation-agent";
const principalID = "foundation-owner";
const sessionID = "foundation-session";
const deniedSessionID = "foundation-denied-session";
const phases = ["c3-held-run", "c3-after-rebuild"];
const revisions = ["a".repeat(64), "b".repeat(64)];
const timestamp = "2026-10-22T00:00:00.000000Z";
const measurement = { inputTokens: 100, outputTokens: 20 };
const setup = { cwd: "/workspace", mcpServers: [] };
const summary = {
  status: "passed",
  connections: 2,
  initializations: 2,
  business_requests: 7,
  completed_prompts: 2,
  denied_prompts: 2,
  runs: 2,
  tool_calls: 2,
  provider_requests: 4,
};

// The default entry is openFoundationConnection(), currently v1 WebSocket only.
// These are its original snapshot/requestReceipt/raw_frames fields, not Span
// inventories. Request IDs are local to a connection and may restart at 1.
function connection() {
  const result = {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    _meta: { "antnest.dev/errors": { version: 1 } },
  };
  return {
    version: 1,
    agentId: agentID,
    closed: true,
    initialization: {
      kind: "request",
      boundary: "private-acp",
      transport: "websocket",
      protocolVersion: 1,
      agentId: agentID,
      method: "initialize",
      requestId: "1",
      inputSessionID: null,
      outcome: "succeeded",
      initializationResult: structuredClone(result),
    },
    evidence: [],
    requests: [{ method: "initialize", requestId: "1" }],
    raw_frames: [{ jsonrpc: "2.0", id: 1, result }],
    updates: [],
    evidence_errors: [],
  };
}

function record(c, name, params, result, details = {}) {
  const requestId = String(c.requests.length + 1);
  const row = {
    kind: "request",
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: 1,
    agentId: agentID,
    method: "session/" + name,
    requestId,
    inputSessionID: params.sessionId ?? null,
    sessionId: params.sessionId ?? result.sessionId,
    requestParams: structuredClone(params),
    ...details,
  };
  if (row.rejection) {
    const error = admissionErrorReceipt("agent_busy");
    Object.assign(row, {
      outcome: "failed",
      failure: "RequestError: " + error.message,
      rejectionReceipt: {
        rpcCode: error.code,
        code: error.data.code,
        retryable: error.data.retryable,
      },
    });
    c.raw_frames.push({ jsonrpc: "2.0", id: Number(requestId), error });
  } else {
    Object.assign(row, {
      outcome: "succeeded",
      requestResult: structuredClone(result),
      requestReceipt: {
        requestId,
        params: structuredClone(params),
        result: structuredClone(result),
      },
    });
    c.raw_frames.push({
      jsonrpc: "2.0",
      id: Number(requestId),
      result: structuredClone(result),
    });
  }
  c.requests.push({
    method: row.method,
    requestId,
    ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
  });
  c.evidence.push(row);
  return row;
}

function runSummary(run) {
  return Object.fromEntries(
    [
      "run_id",
      "agent_id",
      "session_id",
      "principal_id",
      "state",
      "created_at",
      "updated_at",
    ].map((key) => [key, run[key]]),
  );
}

// Admin DTOs match domain/execution-audit.ts. Tool evidence is the persisted
// SessionEvent tool_call lifecycle plus its actual v1 notification projection.
// There is no invented Tool-attempt or runtime_call_stopped field in this API.
function execution(index) {
  const phase = phases[index];
  const toolName = index === 0 ? "bash" : "read";
  const toolCallId = phase + "-tool";
  const input = [{ type: "text", text: phase }];
  const args =
    index === 0
      ? {
          command:
            "printf 'held\\n' >> /workspace/.c3-run-effects\n" +
            "printf '%s' \"$$\" > /workspace/.c3-run-started\n" +
            "while [ ! -e /workspace/.c3-run-release ]; do sleep 0.1; done\n" +
            "printf 'finished\\n' >> /workspace/.c3-run-effects\n" +
            "printf 'c3-held-complete\\n'",
          working_dir: ".",
          timeout_ms: 120000,
        }
      : { path: ".c3-run-effects", offset: 1, limit: 4096 };
  const toolContent = [
    {
      type: "text",
      text: JSON.stringify(
        index === 0
          ? {
              exit_code: 0,
              stdout: "c3-held-complete\n",
              stderr: "",
              truncated: false,
            }
          : { content: "held\nfinished\n" },
      ),
    },
  ];
  const run = {
    run_id: "foundation-run-" + index,
    agent_id: agentID,
    session_id: sessionID,
    principal_id: principalID,
    state: "completed",
    created_at: timestamp,
    updated_at: timestamp,
    input,
    execution_snapshot: {
      providerConnectionId: "foundation-provider",
      modelProfileId: "foundation-model",
      configurationRevision: index + 1,
      executionRevision: revisions[index],
    },
    terminal_class: "completed",
    executor_state: "quiescent",
    tool_effect_state: "settled",
    unknown_effect_source: null,
    stop_reason: "end_turn",
    error_class: null,
    usage_measurements: [
      structuredClone(measurement),
      structuredClone(measurement),
    ],
  };
  const events = { stream: "execution", items: [], next_cursor: null };
  let sequence = index * 10;
  const event = (id, payload, visible = true) => {
    events.items.push({
      id,
      sequence: ++sequence,
      kind: payload.kind,
      visible,
      payload: structuredClone(payload),
      created_at: timestamp,
    });
  };
  event(phase + "-user", {
    kind: "user_message",
    messageId: phase + "-user",
    content: input,
  });
  const usage = {
    kind: "usage",
    used: 120,
    size: 8192,
    measurement,
  };
  event(phase + "-usage-tool", usage);
  event(
    phase + "-dispatch",
    {
      kind: "agent_message",
      messageId: phase + "-dispatch",
      content: [],
      toolCalls: [{ id: toolCallId, name: toolName, arguments: args }],
    },
    false,
  );
  event(phase + "-start", {
    kind: "tool_call",
    initial: true,
    toolCallId,
    title: toolName,
    toolKind: index === 0 ? "execute" : "read",
    modelName: toolName,
    arguments: args,
    status: "in_progress",
  });
  event(phase + "-finish", {
    kind: "tool_call",
    initial: false,
    toolCallId,
    status: "completed",
    content: toolContent,
  });
  event(phase + "-usage-reply", usage);
  event(phase + "-reply", {
    kind: "agent_message",
    messageId: phase + "-reply",
    content: [{ type: "text", text: phase + " completed" }],
  });
  return { run, events };
}

function notifications(saved, { replay = false } = {}) {
  return saved.events.items
    .filter((event) => event.visible)
    .flatMap(({ payload: value }) => {
      const wrap = (update) => ({ sessionId: sessionID, update });
      if (["user_message", "agent_message"].includes(value.kind)) {
        // v1 live prompt suppresses its original user echo; session/load replays
        // it. The loaded held Tool appears again as history, not a new dispatch.
        if (value.kind === "user_message" && !replay) return [];
        return value.content.map((content) =>
          wrap({
            sessionUpdate: value.kind + "_chunk",
            messageId: value.messageId,
            content: structuredClone(content),
          }),
        );
      }
      if (value.kind === "usage")
        return [
          wrap({
            sessionUpdate: "usage_update",
            used: value.used,
            size: value.size,
          }),
        ];
      assert.equal(value.kind, "tool_call");
      return [
        wrap({
          sessionUpdate: value.initial ? "tool_call" : "tool_call_update",
          toolCallId: value.toolCallId,
          status: value.status,
          ...(value.title === undefined ? {} : { title: value.title }),
          ...(value.toolKind === undefined ? {} : { kind: value.toolKind }),
          ...(value.modelName === undefined ? {} : { name: value.modelName }),
          ...(value.arguments === undefined
            ? {}
            : { rawInput: structuredClone(value.arguments) }),
          ...(value.content === undefined
            ? {}
            : {
                content: value.content.map((content) => ({
                  type: "content",
                  content: structuredClone(content),
                })),
              }),
        }),
      ];
    });
}

// audits are actual GET list/detail/events responses, scoped to both original
// Sessions. busy_checks capture deny()'s before/after pages, model/status requests
// and notifications for its rejected Session, bound to each original wire ID.
// execution_revisions come from the initial/rebuilt Admin Agent DTOs. No trace,
// synthetic cleanup boolean or cancellation conclusion is an admission input.
function fixture() {
  const all = [execution(0), execution(1)];
  const first = connection();
  record(first, "new", setup, { sessionId: sessionID });
  record(first, "new", setup, { sessionId: deniedSessionID });
  record(
    first,
    "prompt",
    { sessionId: sessionID, prompt: all[0].run.input },
    { stopReason: "end_turn" },
    { kind: "ordinary", phase: phases[0] },
  );
  for (let i = 0; i < 2; i++)
    record(
      first,
      "prompt",
      {
        sessionId: deniedSessionID,
        prompt: [{ type: "text", text: "c3-denied" }],
      },
      undefined,
      { rejection: "agent_busy" },
    );
  first.updates = notifications(all[0]);
  const second = connection();
  record(second, "load", { ...setup, sessionId: sessionID }, {});
  record(
    second,
    "prompt",
    { sessionId: sessionID, prompt: all[1].run.input },
    { stopReason: "end_turn" },
    { kind: "ordinary", phase: phases[1], toolName: "read" },
  );
  second.updates = [
    ...notifications(all[0], { replay: true }),
    ...notifications(all[1]),
  ];
  const providerRequests = phases.flatMap((phase, index) =>
    ["tool", "reply"].map((stage, offset) => ({
      phase,
      stage,
      received_at_ms: 1000 + index * 2000 + offset * 1000,
      trace_diagnostic: "missing_or_invalid_traceparent",
    })),
  );
  const checkpoint = () => ({
    page: { items: [], next_cursor: null },
    model_requests: [structuredClone(providerRequests[0])],
    updates: [],
  });
  return {
    agent_id: agentID,
    principal_id: principalID,
    private_connections: [first, second],
    execution_revisions: Object.fromEntries(
      phases.map((phase, index) => [phase, revisions[index]]),
    ),
    audits: [
      {
        session_id: sessionID,
        page: {
          items: all.map(({ run }) => runSummary(run)),
          next_cursor: null,
        },
        all,
      },
      {
        session_id: deniedSessionID,
        page: { items: [], next_cursor: null },
        all: [],
      },
    ],
    busy_checks: first.evidence
      .filter((row) => row.rejection)
      .map((row) => ({
        request_id: row.requestId,
        session_id: deniedSessionID,
        before: checkpoint(),
        after: checkpoint(),
      })),
    provider_requests: providerRequests,
  };
}

export {
  agentID,
  principalID,
  sessionID,
  deniedSessionID,
  phases,
  revisions,
  summary,
  runSummary,
  fixture,
};
