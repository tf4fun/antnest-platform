import { createHash } from "node:crypto";
import { caseFor as fileCaseFor } from "../e2e/acp-files/model.mjs";
import { stepsFor } from "../e2e/acp-plan/model.mjs";

export const privateCanary = "PRIVATE-PROMPT-RUN-AUDIT-FIXTURE";
const timestamp = "2026-10-22T00:00:00.000Z";
const id = (kind, value) => `${kind}_${value.toString(16).padStart(32, "0")}`;
const measurement = { inputTokens: 100, outputTokens: 20 };
const summaryKeys = [
  "run_id",
  "session_id",
  "agent_id",
  "principal_id",
  "state",
  "created_at",
  "updated_at",
];

export const promptRunAuditSummary = {
  status: "passed",
  agents: 2,
  runs: 5,
  completed: 5,
  tool_calls: 5,
};

export function runSummary(run) {
  return Object.fromEntries(summaryKeys.map((key) => [key, run[key]]));
}

function readyAgent(index, principalId) {
  const revision = (index === 0 ? "a" : "b").repeat(64);
  // Public Controller Agent shape returned by waitForAgentReady(). No private
  // Run snapshot or public Runtime connection_id is manufactured here.
  return {
    agent_id: id("agent", index + 1),
    owner_user_id: principalId,
    name: privateCanary,
    lifecycle_state: "created",
    activation_state: "enabled",
    desired_state: "enabled",
    runtime_state: "available",
    agent_spec_revision: "spec-" + index,
    executable_execution_revision: revision,
    last_successful_execution_revision: revision,
    aggregate_sequence: 3,
    runtime: {
      runtime_revision: id("rtv", index + 1),
    },
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function publicSnapshot(ready) {
  // Admin auditExecutionSnapshot's eight public fields. In particular it does
  // not disclose runtime, organizationId, accessRevision or clientMcpRevisionId.
  return {
    providerConnectionId: id("provider", 1),
    modelProfileId: id("model", 1),
    configurationRevision: 4,
    agentSpecRevision: ready.agent_spec_revision,
    executionRevision: ready.executable_execution_revision,
    deadlineAt: "2026-10-22T00:02:00.000Z",
    agentExecutionSpecDigest: "d".repeat(64),
    executionSpec: {
      systemPrompt: "Use the requested tool.",
      contextPolicyVersion: "context-v1",
      maxModelRequests: 8,
      model: {
        model: "fixture-model",
        contextWindow: 8192,
        maxOutputTokens: 1024,
        supportsImages: false,
      },
      configuration: {
        modelProfileId: id("model", 1),
        authorizationRevision: 1,
        authorization: { mode: "auto", toolRules: [] },
      },
    },
  };
}

function projectedUpdate(payload, version) {
  if (payload.kind === "user_message" || payload.kind === "agent_message") {
    // v1 suppresses the accepted user's live echo; v2 ACK identifies that
    // durable user message, never the Run. Empty model dispatches are hidden.
    if (payload.kind === "user_message" && version === 1) return [];
    if (version === 2)
      return [
        {
          sessionUpdate: payload.kind,
          messageId: payload.messageId,
          content: structuredClone(payload.content),
        },
      ];
    return payload.content.map((content) => ({
      sessionUpdate: payload.kind + "_chunk",
      messageId: payload.messageId,
      content: structuredClone(content),
    }));
  }
  if (payload.kind === "usage")
    return [
      { sessionUpdate: "usage_update", used: payload.used, size: payload.size },
    ];
  if (payload.kind === "plan")
    return [
      version === 1
        ? { sessionUpdate: "plan", entries: structuredClone(payload.entries) }
        : {
            sessionUpdate: "plan_update",
            plan: {
              type: "items",
              planId: "current",
              entries: structuredClone(payload.entries),
            },
          },
    ];
  return [
    {
      sessionUpdate:
        version === 1 && payload.initial ? "tool_call" : "tool_call_update",
      toolCallId: payload.toolCallId,
      status: payload.status,
      ...(payload.title === undefined ? {} : { title: payload.title }),
      ...(payload.toolKind === undefined ? {} : { kind: payload.toolKind }),
      ...(payload.modelName === undefined ? {} : { name: payload.modelName }),
      ...(payload.arguments === undefined
        ? {}
        : { rawInput: structuredClone(payload.arguments) }),
      ...(payload.content === undefined
        ? {}
        : {
            content: payload.content.map((content) => ({
              type: "content",
              content: structuredClone(content),
            })),
          }),
    },
  ];
}

function execution(ready, principalId, phase, version, ordinal) {
  const runId = id("run", ordinal + 1);
  const sessionId = id(
    "session",
    version === 1 ? ordinal + 1 : phase.endsWith("fork") ? 4 : 3,
  );
  const input = [{ type: "text", text: phase }];
  const file = version === 1 ? fileCaseFor(phase) : null;
  const steps = file
    ? [{ name: file.tool, arguments: file.args }]
    : stepsFor(phase).map(({ name, arguments: arguments_ }) => ({
        name,
        arguments: arguments_,
      }));
  const run = {
    run_id: runId,
    agent_id: ready.agent_id,
    session_id: sessionId,
    principal_id: principalId,
    state: "completed",
    created_at: timestamp,
    updated_at: timestamp,
    input,
    execution_snapshot: publicSnapshot(ready),
    terminal_class: "completed",
    executor_state: "quiescent",
    tool_effect_state:
      (file && !file.error) || phase.endsWith("execute") ? "settled" : "none",
    stop_reason: "end_turn",
    error_class: null,
    usage_measurements: [],
    // Admin omits a null unknown_effect_source in actual successful DTOs.
  };
  const events = { stream: "execution", items: [], next_cursor: null };
  const updates = [];
  let sequence = (ordinal + 1) * 100;
  const add = (payload, visible = true) => {
    const eventId = id(
      "message",
      (ordinal + 1) * 100 + events.items.length + 1,
    );
    const value = structuredClone(payload);
    if (["user_message", "agent_message"].includes(value.kind))
      value.messageId = eventId;
    const row = {
      id: eventId,
      sequence: (sequence += 3),
      kind: value.kind,
      visible,
      payload: value,
      created_at: timestamp,
    };
    events.items.push(row);
    if (visible)
      for (const update of projectedUpdate(value, version))
        updates.push({ sessionId, update });
    return row;
  };
  const usage = () => {
    run.usage_measurements.push(structuredClone(measurement));
    add({ kind: "usage", used: 120, size: 8192, measurement });
  };
  const user = add({ kind: "user_message", content: input });
  if (version === 2)
    updates.push({
      sessionId,
      update: { sessionUpdate: "state_update", state: "running" },
    });
  for (const [step, tool] of steps.entries()) {
    usage();
    // encodeCompletion emits the original provider ID equal to phase for each
    // response. turn-runner.ts scopes it by Run and zero-based request number.
    const toolCallId = createHash("sha256")
      .update(JSON.stringify([runId, step, phase]))
      .digest("hex");
    add(
      {
        kind: "agent_message",
        content: [],
        toolCalls: [{ id: toolCallId, ...tool }],
      },
      false,
    );
    const presentation = {
      kind: "tool_call",
      initial: true,
      toolCallId,
      title: tool.name === "update_plan" ? "Update plan" : tool.name,
      toolKind:
        tool.name === "update_plan"
          ? "other"
          : tool.name === "read"
            ? "read"
            : "edit",
      modelName: tool.name,
      arguments: tool.arguments,
    };
    if (tool.name === "update_plan") {
      // appendPlan commits a plan event and one already-terminal Tool event;
      // requiring a synthetic remote start would reject the real implementation.
      add({ kind: "plan", entries: tool.arguments.entries });
      add({
        ...presentation,
        status: "completed",
        content: [{ type: "text", text: "Plan updated." }],
      });
    } else {
      add({ ...presentation, status: "in_progress" });
      if (phase === "v1-read")
        add({
          kind: "tool_call",
          initial: false,
          toolCallId,
          status: "in_progress",
          content: [{ type: "text", text: "Reading fixture" }],
        });
      const result = file?.result ?? {
        bytes_written: Buffer.byteLength(tool.arguments.content),
        effect_state: "settled",
        effect_source: null,
      };
      add({
        kind: "tool_call",
        initial: false,
        toolCallId,
        status: file?.error ? "failed" : "completed",
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    }
  }
  usage();
  add({
    kind: "agent_message",
    content: [{ type: "text", text: `${phase} verified` }],
  });
  if (version === 2)
    updates.push({
      sessionId,
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      },
    });
  const requestId =
    version === 1 || phase.endsWith("fork") ? "2" : String(ordinal);
  const request = {
    agentId: ready.agent_id,
    protocolVersion: version,
    sessionId,
    phase,
    requestId,
    expectedTools: structuredClone(steps),
    promptReceipt: {
      requestId,
      input: structuredClone(input),
      result:
        version === 1 ? { stopReason: "end_turn" } : { messageId: user.id },
      updates,
    },
  };
  return { request, saved: { run, events } };
}

export function promptRunAuditsFixture({ filePhase = "v1-read" } = {}) {
  const principalId = id("user", 1);
  const readyAgents = [readyAgent(0, principalId), readyAgent(1, principalId)];
  const requests = [],
    agents = [];
  let ordinal = 0;
  for (const [index, ready] of readyAgents.entries()) {
    const phases =
      index === 0
        ? [filePhase, "v1-failed-edit"]
        : ["v2-create", "v2-execute", "v2-fork"];
    const all = [];
    for (const phase of phases) {
      const value = execution(ready, principalId, phase, index + 1, ordinal++);
      requests.push(value.request);
      all.push(value.saved);
    }
    // Audit list order is independent of dispatch order; bind by original IDs,
    // Session and complete input rather than by matching array positions.
    all.reverse();
    agents.push({
      agent_id: ready.agent_id,
      page: {
        items: all.map(({ run }) => runSummary(run)),
        next_cursor: null,
      },
      all,
    });
  }
  return {
    principal_id: principalId,
    ready_agents: readyAgents,
    requests,
    agents,
  };
}

export function promptRunAuditRoutes(evidence) {
  const routes = [];
  for (const agent of evidence.agents) {
    routes.push({
      path: `/api/admin/execution-audits?agent_id=${encodeURIComponent(agent.agent_id)}&limit=100`,
      body: agent.page,
    });
    for (const summary of agent.page.items) {
      const saved = agent.all.find(({ run }) => run.run_id === summary.run_id);
      const path = `/api/admin/execution-audits/${encodeURIComponent(summary.run_id)}`;
      routes.push({ path, body: saved.run });
      routes.push({ path: `${path}/events?limit=100`, body: saved.events });
    }
  }
  return routes;
}
