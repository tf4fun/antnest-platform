import { createHash } from "node:crypto";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
import { runSummary } from "./foundation-business-fixtures.mjs";

const organization = "loss-organization";
const owner = "loss-owner";
const timestamp = "2026-10-22T00:00:00.000000Z";
const scope = "antnest-lifecycle-ab123456";
const usage = { inputTokens: 100, outputTokens: 20 };
const setup = { cwd: "/workspace", mcpServers: [] };

export const lossBusinessSummary = {
  status: "passed",
  agents: 2,
  connections: 6,
  initializations: 6,
  business_requests: 14,
  runs: 4,
  completed_runs: 4,
  persisted_tools: 4,
  denied_prompts: 2,
  provider_requests: 8,
  replays: 6,
};

function ready(mode, generation) {
  const revision = (mode === "live" ? ["a", "b"] : ["c", "d"])[
    generation - 1
  ].repeat(64);
  return {
    agent: {
      agent_id: "loss-" + mode,
      owner_user_id: owner,
      name: mode + " loss Agent",
      desired_state: "enabled",
      lifecycle_state: "created",
      activation_state: "enabled",
      runtime_state: "available",
      aggregate_sequence: generation * 3,
      agent_spec_revision: mode + "-spec-" + generation,
      executable_execution_revision: revision,
      last_successful_execution_revision: revision,
      runtime: {
        runtime_revision: mode + "-runtime-" + generation,
      },
      configuration: {
        template: {
          template_id: "loss-template",
          revision: 1,
          name: "Loss template",
        },
        model_profile: {
          model_profile_id: "loss-model-profile",
          revision_id: "loss-model-profile-revision",
          revision: 1,
          name: "Loss model profile",
          model: {
            base_url: "http://model:8080/v1",
            model: "loss-model",
            context_window: 8192,
            max_output_tokens: 1024,
            supports_images: false,
          },
        },
        max_model_requests: 4,
        context_policy_version: "context-v1",
        runtime: {
          image_ref: "loss-runtime:fixture",
          resources: {
            memory_bytes: 268435456,
            pids_limit: 128,
            tmpfs_bytes: 67108864,
          },
        },
      },
      runtime_observed_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
    container: {
      Id: mode + "-container-" + generation,
      Config: {
        Labels: {
          "io.antnest.agent-id": "loss-" + mode,
          "io.antnest.runtime-controller-scope": scope,
          "io.antnest.runtime-generation": String(generation),
        },
      },
      State: { Running: true, Health: { Status: "healthy" } },
    },
    volume: mode + "-workspace",
    skillVolume: mode + "-skills-" + generation,
    receiverVolume: mode + "-receiver-" + generation,
  };
}

// Same parsed public Admin Agent/Run/detail/event DTOs that lossCase() reads.
// Private organization/access/Runtime bindings are absent from these projections;
// the ready Runtime revision and inspected container retain physical lineage.
// Physical Runtime/SQL/cleanup acceptance stays in the real flow.
function execution(mode, moment, state) {
  const after = moment === "after";
  const phase = "c5-" + mode + "-" + moment;
  const toolName = after ? "read" : "bash";
  const toolCallId = createHash("sha256")
    .update(JSON.stringify([phase + "-run", 0, phase + "-tool"]))
    .digest("hex");
  const agent = state.agent;
  const input = [{ type: "text", text: phase }];
  const args = after
    ? { path: ".c5-loss.txt", offset: 1, limit: 4096 }
    : {
        command: `printf '${mode}-preserved\\n' >> /workspace/.c5-loss.txt; printf ${mode}-written`,
        working_dir: ".",
        timeout_ms: 5000,
      };
  const output = after
    ? { content: mode + "-preserved\n", effect_state: "settled" }
    : {
        exit_code: 0,
        stdout: mode + "-written",
        stderr: "",
        truncated: false,
        effect_state: "settled",
      };
  const run = {
    run_id: phase + "-run",
    agent_id: agent.agent_id,
    session_id: mode + "-session",
    principal_id: owner,
    state: "completed",
    created_at: timestamp,
    updated_at: timestamp,
    input,
    execution_snapshot: {
      providerConnectionId: "loss-provider",
      modelProfileId: "loss-model-profile",
      configurationRevision: after ? 2 : 1,
      agentSpecRevision: agent.agent_spec_revision,
      executionRevision: agent.executable_execution_revision,
      deadlineAt: "2026-10-22T00:02:00.000Z",
      agentExecutionSpecDigest: "e".repeat(64),
      executionSpec: {
        systemPrompt: "Complete the original Loss business prompt.",
        contextPolicyVersion: agent.configuration.context_policy_version,
        maxModelRequests: agent.configuration.max_model_requests,
        model: {
          model: agent.configuration.model_profile.model.model,
          contextWindow: agent.configuration.model_profile.model.context_window,
          maxOutputTokens:
            agent.configuration.model_profile.model.max_output_tokens,
          supportsImages:
            agent.configuration.model_profile.model.supports_images,
        },
        configuration: {
          modelProfileId: "loss-model-profile",
          authorizationRevision: 1,
          authorization: { mode: "auto", toolRules: [] },
        },
      },
    },
    terminal_class: "completed",
    executor_state: "quiescent",
    tool_effect_state: "settled",
    unknown_effect_source: null,
    stop_reason: "end_turn",
    error_class: null,
    usage_measurements: [structuredClone(usage), structuredClone(usage)],
  };
  const events = { stream: "execution", next_cursor: null, items: [] };
  let sequence = after ? 20 : 0;
  const event = (suffix, payload, visible = true) =>
    events.items.push({
      id: phase + "-" + suffix,
      sequence: ++sequence,
      kind: payload.kind,
      visible,
      payload: structuredClone(payload),
      created_at: timestamp,
    });
  event("user", {
    kind: "user_message",
    messageId: phase + "-user",
    content: input,
  });
  const measurement = {
    kind: "usage",
    used: 120,
    size: 8192,
    measurement: usage,
  };
  event("usage-tool", measurement);
  event(
    "dispatch",
    {
      kind: "agent_message",
      messageId: phase + "-dispatch",
      content: [],
      toolCalls: [{ id: toolCallId, name: toolName, arguments: args }],
    },
    false,
  );
  event("start", {
    kind: "tool_call",
    initial: true,
    toolCallId,
    title: toolName,
    toolKind: after ? "read" : "execute",
    modelName: toolName,
    arguments: args,
    status: "in_progress",
    ...(after ? { locations: [{ path: "/workspace/.c5-loss.txt" }] } : {}),
  });
  event("finish", {
    kind: "tool_call",
    initial: false,
    toolCallId,
    status: "completed",
    content: [{ type: "text", text: JSON.stringify(output) }],
    rawOutput: output,
    ...(after ? { file: { path: "/workspace/.c5-loss.txt" } } : {}),
  });
  event("usage-reply", measurement);
  event("reply", {
    kind: "agent_message",
    messageId: phase + "-reply",
    content: [{ type: "text", text: phase + " completed" }],
  });
  return { run, events };
}

function notifications(saved, replay = false) {
  return saved.events.items
    .filter((event) => event.visible)
    .flatMap(({ payload: p }) => {
      const wrap = (update) => ({ sessionId: saved.run.session_id, update });
      if (p.kind === "user_message" || p.kind === "agent_message") {
        if (p.kind === "user_message" && !replay) return [];
        return p.content.map((content) =>
          wrap({
            sessionUpdate: p.kind + "_chunk",
            messageId: p.messageId,
            content: structuredClone(content),
          }),
        );
      }
      if (p.kind === "usage")
        return [
          wrap({ sessionUpdate: "usage_update", used: p.used, size: p.size }),
        ];
      return [
        wrap({
          sessionUpdate: p.initial ? "tool_call" : "tool_call_update",
          toolCallId: p.toolCallId,
          status: p.status,
          ...(p.title === undefined ? {} : { title: p.title }),
          ...(p.toolKind === undefined ? {} : { kind: p.toolKind }),
          ...(p.modelName === undefined ? {} : { name: p.modelName }),
          ...(p.arguments === undefined
            ? {}
            : { rawInput: structuredClone(p.arguments) }),
          ...(p.rawOutput === undefined
            ? {}
            : { rawOutput: structuredClone(p.rawOutput) }),
          ...(p.file === undefined
            ? p.locations === undefined
              ? {}
              : { locations: structuredClone(p.locations) }
            : { locations: [{ path: p.file.path }] }),
          ...(p.content === undefined
            ? {}
            : {
                content: p.content.map((content) => ({
                  type: "content",
                  content: structuredClone(content),
                })),
              }),
        }),
      ];
    });
}

function connection(agentId) {
  const result = {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
    _meta: { "antnest.dev/errors": { version: 1 } },
  };
  return {
    version: 1,
    agentId,
    closed: true,
    evidence_errors: [],
    initialization: {
      kind: "request",
      boundary: "private-acp",
      transport: "websocket",
      protocolVersion: 1,
      agentId,
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
  };
}

function request(c, name, params, result, details = {}) {
  const requestId = String(c.requests.length + 1);
  const row = {
    kind: "request",
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: 1,
    agentId: c.agentId,
    method: "session/" + name,
    requestId,
    inputSessionID: params.sessionId ?? null,
    sessionId: params.sessionId ?? result?.sessionId,
    requestParams: structuredClone(params),
    ...details,
  };
  if (row.rejection) {
    const error = admissionErrorReceipt("agent_unavailable");
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
  c.evidence.push(row);
  c.requests.push({
    method: row.method,
    requestId,
    ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
  });
  return row;
}

// All data is hand-written current business evidence. No historical Trace
// fixture, downloaded artifact, Span inventory or synthetic cleanup flag is used.
// Each case has three actual recorder shapes: new/prompt/load, load/denied,
// load/prompt. The live request ID and replay ID remain connection-local.
export function lossBusinessFixture() {
  const provider_requests = ["live", "cold"].flatMap((mode, caseIndex) =>
    ["before", "after"].flatMap((moment, momentIndex) =>
      ["tool", "reply"].map((stage, stageIndex) => ({
        phase: "c5-" + mode + "-" + moment,
        stage,
        received_at_ms:
          Date.parse(timestamp) +
          (caseIndex * 4 + momentIndex * 2 + stageIndex) * 100 +
          1,
        trace_diagnostic: "missing_or_invalid_traceparent",
      })),
    ),
  );
  const private_connections = [];
  const agents = [];
  for (const [caseIndex, mode] of ["live", "cold"].entries()) {
    const initial = ready(mode, 1),
      replacement = ready(mode, 2);
    replacement.agent.readiness = "ready";
    const before = execution(mode, "before", initial);
    const after = execution(mode, "after", replacement);
    const id = initial.agent.agent_id,
      session_id = before.run.session_id;
    const first = connection(id),
      second = connection(id),
      third = connection(id);
    request(first, "new", setup, { sessionId: session_id });
    request(
      first,
      "prompt",
      { sessionId: session_id, prompt: before.run.input },
      { stopReason: "end_turn" },
      { kind: "ordinary", phase: `c5-${mode}-before`, toolName: "bash" },
    );
    const loadFirst = request(
      first,
      "load",
      { ...setup, sessionId: session_id },
      {},
    );
    const loadSecond = request(
      second,
      "load",
      { ...setup, sessionId: session_id },
      {},
    );
    const denial = request(
      second,
      "prompt",
      {
        sessionId: session_id,
        prompt: [{ type: "text", text: `c5-${mode}-denied` }],
      },
      undefined,
      { rejection: "agent_unavailable" },
    );
    const loadThird = request(
      third,
      "load",
      { ...setup, sessionId: session_id },
      {},
    );
    request(
      third,
      "prompt",
      { sessionId: session_id, prompt: after.run.input },
      { stopReason: "end_turn" },
      { kind: "ordinary", phase: `c5-${mode}-after`, toolName: "read" },
    );
    const replay = notifications(before, true);
    first.updates = [...notifications(before), ...structuredClone(replay)];
    second.updates = structuredClone(replay);
    third.updates = [...structuredClone(replay), ...notifications(after)];
    private_connections.push(first, second, third);
    const baseline = { items: [runSummary(before.run)], next_cursor: null };
    const baselineModel = provider_requests.slice(0, caseIndex * 4 + 2);
    const history = replay.filter(({ update }) =>
      [
        "user_message_chunk",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
      ].includes(update.sessionUpdate),
    );
    const checkpoint = () => ({
      page: structuredClone(baseline),
      model_requests: structuredClone(baselineModel),
    });
    const denialCheckpoint = () => ({
      ...checkpoint(),
      updates: structuredClone(second.updates),
    });
    agents.push({
      id,
      mode,
      session_id,
      initial,
      replacement,
      before_run: structuredClone(before.run),
      after_run: structuredClone(after.run),
      audit: {
        page: {
          items: [runSummary(after.run), runSummary(before.run)],
          next_cursor: null,
        },
        all: [after, before],
      },
      denial: {
        connection_index: caseIndex * 3 + 1,
        request_id: denial.requestId,
        before: denialCheckpoint(),
        after: denialCheckpoint(),
      },
      replays: [loadFirst, loadSecond, loadThird].map((row, index) => ({
        connection_index: caseIndex * 3 + index,
        request_id: row.requestId,
        before: checkpoint(),
        after: { ...checkpoint(), history: structuredClone(history) },
      })),
    });
  }
  return {
    principal: { organization_id: organization, user_id: owner },
    creation_principal: encodeURIComponent(
      JSON.stringify([organization, "loss-administrator"]),
    ),
    private_connections,
    provider_requests,
    agents,
  };
}
