import { createHash } from "node:crypto";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
import { permissionClientFixture } from "./client-evidence.fixture.mjs";
import { indexPermissionRequests } from "./client-evidence.mjs";

const at = "2026-10-22T00:00:00.000000Z";
const organization = "permission-organization";
const measurement = { inputTokens: 100, outputTokens: 20 };
const summaryKeys = [
  "run_id",
  "agent_id",
  "session_id",
  "principal_id",
  "state",
  "created_at",
  "updated_at",
];
const decisions = {
  once: "allow_once",
  "once-again": "allow_once",
  deny: "reject_once",
  always: "allow_always",
  reject: "reject_always",
  "judge-ask": "allow_once",
  cancel: "cancelled",
  reconnect: "allow_once",
};
const choices = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  {
    optionId: "allow_always",
    name: "Always allow in this session",
    kind: "allow_always",
  },
  { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
  {
    optionId: "reject_always",
    name: "Always reject in this session",
    kind: "reject_always",
  },
];

function withoutTrace(value) {
  if (Array.isArray(value)) return value.map(withoutTrace);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/trace|span/iu.test(key))
      .map(([key, item]) => [key, withoutTrace(item)]),
  );
}

function wireUpdates(payload, version) {
  const value = structuredClone(payload);
  if (["user_message", "agent_message"].includes(value.kind)) {
    if (!value.content.length) return [];
    return version === 1
      ? value.content.map((content) => ({
          sessionUpdate: value.kind + "_chunk",
          messageId: value.messageId,
          content,
        }))
      : [
          {
            sessionUpdate: value.kind,
            messageId: value.messageId,
            content: value.content,
          },
        ];
  }
  if (value.kind === "usage")
    return [
      { sessionUpdate: "usage_update", used: value.used, size: value.size },
    ];
  if (value.kind !== "tool_call") return [];
  return [
    {
      sessionUpdate:
        version === 1 && value.initial ? "tool_call" : "tool_call_update",
      toolCallId: value.toolCallId,
      ...(value.title === undefined ? {} : { title: value.title }),
      ...(value.toolKind === undefined ? {} : { kind: value.toolKind }),
      ...(value.modelName === undefined ? {} : { name: value.modelName }),
      ...(value.arguments === undefined ? {} : { rawInput: value.arguments }),
      status: value.status,
      ...(value.content === undefined
        ? {}
        : {
            content: value.content.map((content) => ({
              type: "content",
              content,
            })),
          }),
    },
  ];
}

function received(connection, sessionId, update) {
  connection.raw_frames.push({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });
}

function rawReply(connection, row) {
  if (row.rejection) {
    connection.raw_frames.push({
      jsonrpc: "2.0",
      id: Number(row.requestId),
      error: admissionErrorReceipt("access_denied"),
    });
  } else if (row.requestReceipt) {
    connection.raw_frames.push({
      jsonrpc: "2.0",
      id: Number(row.requestId),
      result: structuredClone(row.requestReceipt.result),
    });
  }
}

function permissionPhase(delivery) {
  const tool = delivery.params.toolCall ?? delivery.params.subject.toolCall;
  return tool.rawInput.value ?? tool.rawInput.path.slice(0, -4);
}

// waitForAgentReady() returns the public Agent DTO itself. Its Runtime uses
// snake_case and deliberately has no private ACP connection_id field.
function readyAgent(agentId, index, owner) {
  const revision = (index === 0 ? "a" : "b").repeat(64);
  return {
    agent_id: agentId,
    organization_id: organization,
    owner_user_id: owner,
    name: `Permissions v${index + 1}`,
    desired_state: "enabled",
    lifecycle_state: "created",
    activation_state: "enabled",
    runtime_state: "available",
    access_revision: `permission-access-${index + 1}`,
    agent_spec_revision: `permission-spec-${index + 1}`,
    executable_execution_revision: revision,
    last_successful_execution_revision: revision,
    runtime: {
      runtime_revision: `rtv_${String(index + 1).repeat(32)}`,
      runtime_execution_id: `permission-execution-${index + 1}`,
      mcp_endpoint: `http://permission-runtime-${index + 1}:8080/mcp`,
    },
    aggregate_sequence: 3,
    created_at: at,
    updated_at: at,
  };
}

// This extends the existing captured SDK/index fixture with the actual Admin
// execution-audit DTOs. It is contract data, not a simulation of a running DB.
// The permissions adapter decodes request_payload before returning its request
// object; no permission-decided Span or private Tool-attempt DTO is invented.
export function permissionRunBusinessFixture() {
  const captured = permissionClientFixture();
  const principal = "permission-owner";
  const byPhase = new Map(),
    sessionSequences = new Map();
  const agents = captured.agents.map((agent_id, index) => ({
    agent_id,
    ready: readyAgent(agent_id, index, principal),
    page: { items: [], next_cursor: null },
    all: [],
  }));
  for (const connection of captured.connections) {
    connection.initialization.initializationResult.agentCapabilities = {
      loadSession: true,
    };
    connection.initialization.initializationResult._meta = {
      "antnest.dev/errors": { version: 1 },
    };
    for (const delivery of connection.permissions) {
      const phase = permissionPhase(delivery);
      const name = phase.includes("judge-") ? "mcp__fixture__echo" : "write";
      const tool = delivery.params.toolCall ?? delivery.params.subject.toolCall;
      Object.assign(tool, { title: name, name, status: "pending" });
      delivery.params.options = structuredClone(choices);
      if (connection.version === 2) delivery.params.title = `Allow ${name}?`;
    }
    if (connection.role !== "owner") continue;
    const agent = agents.find((item) => item.agent_id === connection.agentId);
    for (const row of connection.evidence.filter(
      (item) => item.method === "session/prompt",
    )) {
      const phase = row.requestParams.prompt[0].text,
        entry = phase.slice(3);
      const runId = "fixture-run-" + phase,
        sessionId = row.sessionId;
      const cancelled = entry === "cancel",
        chat = entry === "chat";
      const rejected = ["deny", "reject", "reject-follow"].includes(entry);
      const executes = !chat && !cancelled && !rejected;
      const name = entry.includes("judge-")
        ? "mcp__fixture__echo"
        : entry === "read-hint"
          ? "read"
          : "write";
      const arguments_ =
        name === "mcp__fixture__echo"
          ? { value: phase }
          : name === "read"
            ? { path: phase.slice(0, 2) + "-once.txt", limit: 1024 }
            : { path: phase + ".txt", content: phase + "\n" };
      const toolCallId = createHash("sha256")
        .update(JSON.stringify([runId, 0, phase]))
        .digest("hex");
      const call = { id: toolCallId, name, arguments: arguments_ };
      const tool = {
        source: "runtime",
        sourceId: "runtime",
        name,
        modelName: name,
        description: "",
      };
      const userId =
        connection.version === 2
          ? row.requestReceipt.result.messageId
          : "user-" + phase;
      const models = captured.models.filter((item) => item.phase === phase);
      const run = {
        run_id: runId,
        agent_id: agent.agent_id,
        session_id: sessionId,
        principal_id: principal,
        state: cancelled ? "cancelled" : "completed",
        created_at: at,
        updated_at: at,
        input: structuredClone(row.requestParams.prompt),
        execution_snapshot: {
          organizationId: agent.ready.organization_id,
          providerConnectionId: "permission-provider",
          modelProfileId: [
            "once",
            "once-again",
            "deny",
            "always",
            "follow",
          ].includes(entry)
            ? captured.alternateModelID
            : "default-profile",
          configurationRevision: 1,
          accessRevision: agent.ready.access_revision,
          agentSpecRevision: agent.ready.agent_spec_revision,
          executionRevision: agent.ready.executable_execution_revision,
          runtime: {
            revision: agent.ready.runtime.runtime_revision,
            executionId: agent.ready.runtime.runtime_execution_id,
            mcpEndpoint: agent.ready.runtime.mcp_endpoint,
            connectionId: `rci_${String(connection.version).repeat(32)}`,
          },
        },
        terminal_class: cancelled ? "cancelled" : "completed",
        executor_state: "quiescent",
        tool_effect_state: executes ? "settled" : "none",
        unknown_effect_source: null,
        stop_reason: cancelled ? null : "end_turn",
        error_class: null,
        usage_measurements: models.map(() => structuredClone(measurement)),
      };
      const events = { stream: "execution", items: [], next_cursor: null };
      const event = (suffix, payload, visible = true) => {
        const sequence = (sessionSequences.get(sessionId) ?? 0) + 1;
        sessionSequences.set(sessionId, sequence);
        events.items.push({
          id: suffix === "user" ? userId : phase + "-" + suffix,
          sequence,
          kind: payload.kind,
          visible,
          payload: structuredClone(payload),
          created_at: at,
        });
      };
      const usage = (stage) =>
        event("usage-" + stage, {
          kind: "usage",
          used: 120,
          size: 64000,
          measurement: structuredClone(measurement),
        });
      event("user", {
        kind: "user_message",
        messageId: userId,
        content: run.input,
      });
      usage(0);
      if (!chat)
        event(
          "dispatch",
          {
            kind: "agent_message",
            messageId: phase + "-dispatch",
            content: [],
            toolCalls: [call],
          },
          false,
        );
      if (entry.startsWith("judge-")) usage("judge");
      const prefixLength = events.items.length;
      if (executes) {
        event("tool-start", {
          kind: "tool_call",
          initial: true,
          toolCallId,
          title:
            name === "write"
              ? `Write /workspace/${arguments_.path}`
              : name === "read"
                ? `Read /workspace/${arguments_.path}`
                : name,
          toolKind:
            name === "write" ? "edit" : name === "read" ? "read" : "other",
          modelName: name,
          arguments: arguments_,
          status: "in_progress",
        });
        const result =
          name === "mcp__fixture__echo"
            ? { echo: phase }
            : name === "read"
              ? { content: phase.slice(0, 2) + "-once\n", truncated: false }
              : {
                  path: arguments_.path,
                  bytes_written: Buffer.byteLength(arguments_.content),
                };
        event("tool-finish", {
          kind: "tool_call",
          initial: false,
          toolCallId,
          status: "completed",
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } else if (!chat) {
        const text = cancelled
          ? "Tool was not executed because permission could not be confirmed."
          : entry === "reject-follow"
            ? "Tool execution is disabled by the Session authorization policy."
            : `Tool was not executed: ${decisions[entry]} (client_response).`;
        event("tool-rejected", {
          kind: "tool_call",
          initial: true,
          toolCallId,
          title: name,
          modelName: name,
          arguments: arguments_,
          status: "failed",
          content: [{ type: "text", text }],
        });
      }
      if (!chat && !cancelled) usage(1);
      if (!cancelled)
        event("reply", {
          kind: "agent_message",
          messageId: phase + "-reply",
          content: [{ type: "text", text: phase + " verified" }],
        });
      const permissions = {
        stream: "permissions",
        items: [],
        next_cursor: null,
      };
      if (Object.hasOwn(decisions, entry))
        permissions.items.push({
          tool_call_id: toolCallId,
          request: { runId, sessionId, call: structuredClone(call), tool },
          decision: decisions[entry],
          reason: cancelled ? "permission_stale" : "client_response",
          created_at: at,
          decided_at: at,
        });
      const saved = { run, events, permissions };
      agent.all.push(saved);
      agent.page.items.push(
        Object.fromEntries(summaryKeys.map((key) => [key, run[key]])),
      );
      byPhase.set(phase, { saved, prefixLength });
    }
  }
  for (const connection of captured.connections) {
    connection.raw_frames = [
      {
        jsonrpc: "2.0",
        id: Number(connection.initialization.requestId),
        result: structuredClone(connection.initialization.initializationResult),
      },
    ];
    const emit = (record, rows) => {
      for (const event of rows) {
        if (!event.visible) continue;
        for (const update of wireUpdates(event.payload, connection.version))
          received(connection, record.run.session_id, update);
      }
    };
    const deliver = (phase) => {
      const delivery = connection.permissions.find(
        (item) => permissionPhase(item) === phase,
      );
      if (delivery)
        connection.raw_frames.push({
          jsonrpc: "2.0",
          id: delivery.requestId,
          method: "session/request_permission",
          params: structuredClone(delivery.params),
        });
    };
    const idle = (record) => {
      if (connection.version === 2)
        received(connection, record.run.session_id, {
          sessionUpdate: "state_update",
          state: "idle",
          stopReason:
            record.run.state === "cancelled" ? "cancelled" : "end_turn",
        });
    };
    for (const row of connection.evidence) {
      if (row.method === "session/prompt") {
        const phase = row.requestParams.prompt[0].text;
        const { saved, prefixLength } = byPhase.get(phase);
        if (connection.version === 2) rawReply(connection, row);
        emit(saved, saved.events.items.slice(0, prefixLength));
        if (connection.version === 2)
          received(connection, row.sessionId, {
            sessionUpdate: "state_update",
            state: "running",
          });
        deliver(phase);
        if (!phase.endsWith("-reconnect")) {
          emit(saved, saved.events.items.slice(prefixLength));
          idle(saved);
          if (connection.version === 1) rawReply(connection, row);
        }
      } else if (["session/load", "session/resume"].includes(row.method)) {
        const phase = `v${connection.version}-reconnect`;
        const { saved, prefixLength } = byPhase.get(phase);
        emit(saved, saved.events.items.slice(0, prefixLength));
        rawReply(connection, row);
        deliver(phase);
        emit(saved, saved.events.items.slice(prefixLength));
        idle(saved);
      } else rawReply(connection, row);
    }
  }
  const inventory = indexPermissionRequests(captured);
  return withoutTrace({
    agent_ids: captured.agents,
    principal_id: principal,
    connections: captured.connections,
    inventory,
    model_requests: captured.models,
    model_names: {
      default: captured.defaultModel,
      alternate: captured.alternateModel,
    },
    agents,
  });
}

export const permissionRunBusinessSummary = {
  status: "passed",
  agents: 2,
  runs: 26,
  completed: 24,
  cancelled: 2,
  tool_executions: 16,
  permission_waits: 16,
  permission_deliveries: 18,
  model_requests: 52,
};
