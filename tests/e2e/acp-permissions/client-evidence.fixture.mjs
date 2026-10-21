import { createHash } from "node:crypto";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";

// Independent captured-client contract fixture; this does not simulate service
// authorization, persistence, Run execution or collector/Docker acceptance.
export function permissionClientFixture() {
  const accessDenied = admissionErrorReceipt("access_denied");
  const agents = ["permission-agent-1", "permission-agent-2"];
  const connections = [],
    outcomes = [],
    models = [];
  let sequence = 0;
  const hex = (size) => (++sequence).toString(16).padStart(size, "0");
  const phases = [
    ["approve", ["once", "once-again", "deny", "always", "follow"]],
    ["approve", ["reject", "reject-follow"]],
    ["chat", ["chat"]],
    ["smart_approve", ["read-hint", "judge-safe", "judge-ask"]],
    ["approve", ["cancel"]],
    ["approve", ["reconnect"]],
  ];
  const choices = {
    once: "allow_once",
    "once-again": "allow_once",
    deny: "reject_once",
    always: "allow_always",
    reject: "reject_always",
    "judge-ask": "allow_once",
    cancel: null,
    reconnect: null,
  };
  for (const version of [1, 2]) {
    const agentId = agents[version - 1];
    const connection = (role) => {
      const c = {
        version,
        agentId,
        role,
        connectionTraceID: hex(32),
        clientSpanID: hex(16),
        evidence: [],
        requests: [],
        notifications: [],
        permissions: [],
        raw_frames: [],
      };
      const common = {
        boundary: "private-acp",
        transport: "websocket",
        protocolVersion: version,
        agentId,
        connectionTraceID: c.connectionTraceID,
        clientSpanID: c.clientSpanID,
      };
      c.initialization = {
        ...common,
        requestId: "0",
        method: "initialize",
        inputSessionID: null,
        outcome: "succeeded",
        initializationResult: { protocolVersion: version },
      };
      c.requests.push({ requestId: "0", method: "initialize" });
      connections.push(c);
      return c;
    };
    const add = (c, method, params, result, extra = {}) => {
      const { initializationResult: _, ...common } = c.initialization;
      void _;
      const requestId = String(c.requests.length);
      const row = {
        ...common,
        method,
        requestId,
        inputSessionID: params.sessionId ?? null,
        requestParams: structuredClone(params),
        ...(params.sessionId || result?.sessionId
          ? { sessionId: params.sessionId ?? result.sessionId }
          : {}),
        requestReceipt: {
          requestId,
          params: structuredClone(params),
          result: structuredClone(result),
        },
        ...extra,
      };
      c.evidence.push(row);
      c.requests.push({
        requestId,
        method,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      });
      return row;
    };
    const approval = (c, sessionId, phase, optionId) => {
      const toolCall = {
        toolCallId: createHash("sha256")
          .update(JSON.stringify([`fixture-run-${phase}`, 0, phase]))
          .digest("hex"),
        rawInput: phase.includes("judge-")
          ? { value: phase }
          : { path: `${phase}.txt`, content: `${phase}\n` },
      };
      const params = {
        sessionId,
        options: [
          "allow_once",
          "allow_always",
          "reject_once",
          "reject_always",
        ].map((optionId) => ({ optionId, kind: optionId, name: optionId })),
        ...(version === 1
          ? { toolCall }
          : { subject: { type: "tool_call", toolCall } }),
      };
      const row = {
        requestId: `permission-${c.permissions.length}`,
        params,
        outcome: optionId ? "selected" : "cancelled",
        ...(optionId ? { optionId } : {}),
      };
      c.permissions.push(row);
      c.raw_frames.push({
        id: row.requestId,
        method: "session/request_permission",
        params: structuredClone(params),
      });
      return row;
    };
    const denied = connection("foreign");
    add(
      denied,
      "session/new",
      { cwd: "/workspace", mcpServers: [] },
      undefined,
      {
        outcome: "rejected",
        requestReceipt: undefined,
        rejection: "access_denied",
        rejectionReceipt: {
          rpcCode: accessDenied.code,
          ...accessDenied.data,
        },
      },
    );
    const owner = connection("owner");
    let lastSession;
    for (const [group, [mode, entries]] of phases.entries()) {
      const sessionId = `session-v${version}-${group}`;
      lastSession = sessionId;
      add(
        owner,
        "session/new",
        { cwd: "/workspace", mcpServers: [] },
        { sessionId, configOptions: [] },
      );
      for (const [configId, value] of [
        ["mode", mode],
        ...(group === 0 ? [["model", "profile:alternate"]] : []),
      ])
        add(
          owner,
          "session/set_config_option",
          {
            sessionId,
            configId,
            value,
            ...(version === 2 ? { type: "id" } : {}),
          },
          {
            configOptions: [
              {
                [version === 1 ? "id" : "configId"]: configId,
                currentValue: value,
              },
            ],
          },
        );
      for (const entry of entries) {
        const phase = `v${version}-${entry}`;
        outcomes.push(phase);
        const row = add(
          owner,
          "session/prompt",
          { sessionId, prompt: [{ type: "text", text: phase }] },
          version === 1
            ? { stopReason: entry === "cancel" ? "cancelled" : "end_turn" }
            : { messageId: `message-${phase}` },
        );
        if (version === 1 && entry === "reconnect")
          Object.assign(row, {
            outcome: "failed",
            closedBeforeResponse: true,
            requestReceipt: undefined,
          });
        if (Object.hasOwn(choices, entry))
          approval(owner, sessionId, phase, choices[entry]);
        if (entry === "cancel")
          owner.notifications.push({
            version,
            agentId,
            sessionId,
            connectionTraceID: owner.connectionTraceID,
            clientSpanID: owner.clientSpanID,
            method: "session/cancel",
            index: 0,
            status: "write_completed",
            origin: "notify",
            wireObserved: true,
            writeOutcome: "completed",
          });
        const trace_id = hex(32);
        for (const stage of ["cancel", "chat"].includes(entry)
          ? [0]
          : entry.startsWith("judge-")
            ? [0, "judge", 1]
            : [0, 1])
          models.push({
            phase,
            stage,
            trace_id,
            model_span_id: hex(16),
            model: group === 0 ? "alternate" : "default",
          });
      }
    }
    const replay = connection("replay");
    add(
      replay,
      version === 1 ? "session/load" : "session/resume",
      {
        cwd: "/workspace",
        mcpServers: [],
        sessionId: lastSession,
        ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
      },
      { configOptions: [] },
    );
    approval(replay, lastSession, `v${version}-reconnect`, "allow_once");
  }
  return {
    agents,
    connections,
    outcomes,
    models,
    alternateModelID: "alternate",
    defaultModel: "default",
    alternateModel: "alternate",
  };
}
