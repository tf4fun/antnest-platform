import { createHash } from "node:crypto";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
import { replayRequest } from "../managed-mcp/protocol.mjs";
import { decide } from "./model.mjs";

const clone = (value) => structuredClone(value);
const agentId = "rpc-business-agent";
const principalId = "rpc-business-owner";
const organizationId = "rpc-business-organization";
const timestamp = (offset) =>
  new Date(Date.UTC(2026, 9, 22) + offset).toISOString();
const setup = { cwd: "/workspace", mcpServers: [] };
const summary = {
  status: "passed",
  versions: [1, 2],
  fault_cases: 4,
  runs: 8,
  tool_calls: 8,
  model_requests: 16,
  replays: 8,
  rejections: 2,
  connections: 12,
  initializations: 12,
  business_requests: 22,
};

function runSummary(run) {
  return Object.fromEntries(
    [
      "run_id",
      "session_id",
      "agent_id",
      "principal_id",
      "state",
      "created_at",
      "updated_at",
    ].map((key) => [key, run[key]]),
  );
}

// This is captureRuntime()'s existing public Agent/Runtime projection, not a
// fabricated Tool-attempt or Runtime-stop receipt.
function capturedRuntime(generation) {
  return {
    agent_id: agentId,
    runtime_revision: `rtv_${String(generation).repeat(32)}`,
    runtime_execution_id: "rpc-runtime-" + generation,
    mcp_endpoint: `http://runtime-${generation}:8080/mcp`,
    execution_revision: String(generation).repeat(64),
    template_id: "rpc-template",
    template_revision: 1,
  };
}

function execution(version, label, step, sessionId, runtime) {
  const phase = label + "-" + step;
  const call = decide({
    model: "rpc-model",
    max_tokens: version === 1 ? 3072 : 4096,
    messages: [{ role: "user", content: phase }],
    tools: [{ function: { name: "bash" } }],
  }).call;
  const run = {
    run_id: phase + "-run",
    session_id: sessionId,
    agent_id: agentId,
    principal_id: principalId,
    state: "completed",
    created_at: timestamp(step === "write" ? 0 : 1000),
    updated_at: timestamp(step === "write" ? 500 : 1500),
    input: [{ type: "text", text: phase }],
    execution_snapshot: {
      organizationId,
      providerConnectionId: "rpc-provider",
      modelProfileId: "rpc-model-profile",
      configurationRevision: version + 10,
      accessRevision: "rpc-access",
      deadlineAt: timestamp(120000),
      agentSpecRevision: "rpc-agent-spec",
      executionRevision: runtime.execution_revision,
      runtimeMcpSourceDigest: "a".repeat(64),
      agentExecutionSpecDigest: "b".repeat(64),
      runtime: {
        revision: runtime.runtime_revision,
        executionId: runtime.runtime_execution_id,
        mcpEndpoint: runtime.mcp_endpoint,
        connectionId: `rci_${runtime.runtime_revision.slice(4)}`,
      },
      executionSpec: {
        systemPrompt: "RPC_PRIVATE_AUDIT_CANARY",
        contextPolicyVersion: "context-v1",
        skillInstructions: [],
        model: {
          baseUrl: "http://rpc-model-peer:8080/v1",
          model: "rpc-model",
          contextWindow: 8192,
          maxOutputTokens: version === 1 ? 3072 : 4096,
          supportsImages: false,
        },
        maxModelRequests: 8,
      },
      clientMcpRevisionId: sessionId + "-mcp",
    },
    terminal_class: "completed",
    executor_state: "quiescent",
    tool_effect_state: "settled",
    unknown_effect_source: null,
    stop_reason: "end_turn",
    error_class: null,
    usage_measurements: Array.from({ length: 2 }, () => ({
      inputTokens: 100,
      outputTokens: 20,
    })),
  };
  const result = {
    exit_code: 0,
    stdout: label + "\n",
    stderr: "",
    truncated: false,
    effect_state: "settled",
  };
  const toolId = createHash("sha256")
    .update(JSON.stringify([run.run_id, 0, phase + "-tool"]))
    .digest("hex");
  const events = { stream: "execution", items: [], next_cursor: null };
  const base = step === "write" ? 0 : 10;
  const add = (suffix, sequence, payload, visible = true) =>
    events.items.push({
      id: phase + "-" + suffix,
      sequence: base + sequence,
      kind: payload.kind,
      visible,
      payload: clone(payload),
      created_at: run.created_at,
    });
  add("user", 1, {
    kind: "user_message",
    messageId: phase + "-user",
    content: run.input,
  });
  const usage = {
    kind: "usage",
    used: 120,
    size: 8192,
    measurement: run.usage_measurements[0],
  };
  add("usage-tool", 2, usage);
  add(
    "dispatch",
    3,
    {
      kind: "agent_message",
      messageId: phase + "-dispatch",
      content: [],
      toolCalls: [{ id: toolId, name: call.name, arguments: call.arguments }],
    },
    false,
  );
  add("tool-start", 4, {
    kind: "tool_call",
    initial: true,
    toolCallId: toolId,
    title: "bash",
    toolKind: "execute",
    modelName: call.name,
    arguments: call.arguments,
    status: "in_progress",
  });
  add("tool-finish", 6, {
    kind: "tool_call",
    initial: false,
    toolCallId: toolId,
    status: "completed",
    content: [{ type: "text", text: JSON.stringify(result) }],
    rawOutput: result,
  });
  add("usage-reply", 7, usage);
  add("reply", 8, {
    kind: "agent_message",
    messageId: phase + "-reply",
    content: [{ type: "text", text: phase + " verified" }],
  });
  return { run, events };
}

function updates(saved, version, { replay = false } = {}) {
  const rows = [];
  const push = (update) =>
    rows.push({ sessionId: saved.run.session_id, update });
  if (version === 2 && !replay)
    push({ sessionUpdate: "state_update", state: "running" });
  for (const { visible, payload } of saved.events.items) {
    if (!visible) continue;
    if (["user_message", "agent_message"].includes(payload.kind)) {
      if (version === 1 && payload.kind === "user_message" && !replay) continue;
      const chunks = version === 1 ? payload.content : [payload.content];
      for (const content of chunks)
        push({
          sessionUpdate: payload.kind + (version === 1 ? "_chunk" : ""),
          messageId: payload.messageId,
          content: clone(content),
        });
    } else if (payload.kind === "tool_call") {
      push({
        sessionUpdate:
          version === 1 && payload.initial ? "tool_call" : "tool_call_update",
        toolCallId: payload.toolCallId,
        status: payload.status,
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.toolKind === undefined ? {} : { kind: payload.toolKind }),
        ...(payload.modelName === undefined ? {} : { name: payload.modelName }),
        ...(payload.arguments === undefined
          ? {}
          : { rawInput: clone(payload.arguments) }),
        ...(payload.rawOutput === undefined
          ? {}
          : { rawOutput: clone(payload.rawOutput) }),
        ...(payload.content === undefined
          ? {}
          : {
              content: payload.content.map((content) => ({
                type: "content",
                content: clone(content),
              })),
            }),
      });
    } else if (payload.kind === "usage")
      push({
        sessionUpdate: "usage_update",
        used: payload.used,
        size: payload.size,
      });
  }
  if (version === 2)
    push({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
    });
  return rows;
}

function connection(version, kind, role) {
  const result = {
    protocolVersion: version,
    _meta: { "antnest.dev/errors": { version: 1 } },
  };
  const identity = {
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: version,
    agentId,
  };
  return {
    version,
    kind,
    role,
    agentId,
    closed: true,
    initialization: {
      ...identity,
      method: "initialize",
      requestId: "1",
      inputSessionID: null,
      outcome: "succeeded",
      initializationResult: clone(result),
    },
    requests: [{ method: "initialize", requestId: "1" }],
    evidence: [],
    raw_frames: [{ jsonrpc: "2.0", id: 1, result }],
    updates: [],
    evidence_errors: [],
  };
}

function record(c, name, params, result, { rejected = false } = {}) {
  const requestId = String(c.requests.length + 1);
  const row = {
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: c.version,
    agentId,
    method: "session/" + name,
    requestId,
    inputSessionID: params.sessionId ?? null,
    sessionId: params.sessionId ?? result.sessionId,
    requestParams: clone(params),
    outcome: rejected ? "failed" : "succeeded",
  };
  if (rejected) {
    const error = admissionErrorReceipt("agent_unavailable");
    Object.assign(row, {
      failure: "RequestError: " + error.message,
      failureCode: error.code,
      failureData: clone(error.data),
      rejectionReceipt: {
        rpcCode: error.code,
        code: error.data.code,
        retryable: error.data.retryable,
      },
    });
    c.raw_frames.push({ jsonrpc: "2.0", id: Number(requestId), error });
  } else {
    row.requestResult = clone(result);
    c.raw_frames.push({
      jsonrpc: "2.0",
      id: Number(requestId),
      result: clone(result),
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

function fault(label, index, kind) {
  const operationId = label + "-rebuild";
  const held = {
    receipt_id: label + "-receipt-1",
    method: kind === "apply" ? "apply-execution-snapshot" : "settle-agent",
    organization_id: organizationId,
    ...(kind === "apply"
      ? { revision: index + 20 }
      : {
          agent_id: agentId,
          operation_id: operationId,
          minimum_revision: index + 20,
          mode: "wait",
          deadline_at: timestamp(90000),
          outcome: "settled",
        }),
    applied_revision: index + 20,
    request_hash: String(index + 1).repeat(64),
    response_hash: String(index + 5).repeat(64),
    status: 200,
    delivery: "held",
  };
  return {
    held,
    records: [
      { ...clone(held), delivery: "dropped" },
      {
        ...clone(held),
        receipt_id: label + "-receipt-2",
        delivery: "delivered",
      },
    ],
    ...(kind === "settle"
      ? {
          lifecycle: {
            kind: "rebuild",
            agentId,
            requestId: operationId,
            skillPreparation: true,
          },
        }
      : {}),
  };
}

// Each field is retained by client.mjs already, or is an unmodified Admin
// response/array it can retain at its existing read. No Trace or summary status
// supplies the Run, Tool, replay or proxy business proof.
function fixture() {
  const evidence = {
    agentId,
    principalId,
    organizationId,
    connections: [],
    scenarios: [],
    model: { requests: [], errors: [] },
  };
  let index = 0;
  for (const version of [1, 2])
    for (const kind of ["apply", "settle"]) {
      const label = `v${version}-${kind}`;
      const sessionId = label + "-session";
      const before = capturedRuntime(index * 2 + 1);
      const replacement =
        kind === "settle" ? capturedRuntime(index * 2 + 2) : before;
      const write = execution(version, label, "write", sessionId, before);
      const read = execution(version, label, "read", sessionId, replacement);
      for (const step of ["write", "read"])
        for (const stage of ["tool", "reply"])
          evidence.model.requests.push({ phase: label + "-" + step, stage });
      const priorModels = clone(
        evidence.model.requests.slice(0, index * 4 + 2),
      );
      const savedWrite = { rows: [runSummary(write.run)], ...clone(write) };
      const checkpoint = () => ({
        execution: clone(savedWrite),
        modelRequests: clone(priorModels),
      });
      const main = connection(version, kind, "prompt");
      record(main, "new", setup, { sessionId });
      record(
        main,
        "prompt",
        { sessionId, prompt: write.run.input },
        version === 1
          ? { stopReason: "end_turn" }
          : { messageId: label + "-write-user" },
      );
      main.updates = updates(write, version);
      const scenario = {
        version,
        kind,
        sessionId,
        auditPage: {
          items: [runSummary(read.run), runSummary(write.run)],
          next_cursor: null,
        },
        runs: [write, read],
        fault: fault(label, index, kind),
        replay: { before: checkpoint(), after: checkpoint() },
        ...(kind === "settle" ? { replacement } : {}),
      };
      if (kind === "settle") {
        const rejected = record(
          main,
          "prompt",
          { sessionId, prompt: [{ type: "text", text: label + "-denied" }] },
          undefined,
          { rejected: true },
        );
        scenario.denial = {
          requestId: rejected.requestId,
          before: { ...checkpoint(), updates: clone(main.updates) },
          after: { ...checkpoint(), updates: clone(main.updates) },
        };
      }
      evidence.connections.push(main);
      for (const role of ["replay-1", "replay-2"]) {
        const c = connection(version, kind, role);
        const spec = replayRequest(version, sessionId);
        record(c, spec.method, spec.params, {});
        c.updates = updates(write, version, { replay: true });
        if (role === "replay-2") {
          record(
            c,
            "prompt",
            { sessionId, prompt: read.run.input },
            version === 1
              ? { stopReason: "end_turn" }
              : { messageId: label + "-read-user" },
          );
          c.updates.push(...updates(read, version));
        }
        evidence.connections.push(c);
      }
      evidence.scenarios.push(scenario);
      index++;
    }
  return evidence;
}

export { fixture, runSummary, summary };
