import assert from "node:assert/strict";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
import { verifyModelRequests } from "./expectations.mjs";

const groups = [
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
const setup = { cwd: "/workspace", mcpServers: [] };
const nonempty = (value) =>
  assert(typeof value === "string" && value.length > 0);
const unique = (values, label) =>
  assert.equal(
    new Set(values).size,
    values.length,
    `duplicate Permissions ${label}`,
  );

// Notification objects carry the transport's private provenance. Keep those
// objects original; all other snapshots are plain private evidence.
export async function capturePermissionConnection({ client, ...meta }) {
  await client.closeAndWait();
  assert.equal(client.boundary, "private-acp");
  assert.equal(client.transport, "websocket");
  assert.equal(client.version, meta.version);
  assert.equal(client.agentId, meta.agentId);
  return {
    ...meta,
    connectionTraceID: client.connectionTraceID,
    clientSpanID: client.clientSpanID,
    initialization: client.initializationRequest,
    evidence: client.requestEvidence,
    requests: structuredClone(client.requests),
    notifications: client.notifications,
    permissions: client.permissionEvidence,
    raw_frames: structuredClone(client.rawFrames),
  };
}

// Inventory the actual scripted calls, including denied and unanswered calls.
// The client separately establishes terminal output; collectors establish the
// service work. Counts here cannot stand in for either business or Trace gates.
export function indexPermissionRequests(
  {
    agents,
    connections,
    outcomes,
    models,
    alternateModelID,
    defaultModel,
    alternateModel,
  },
  { requireTrace = true } = {},
) {
  assert.equal(agents.length, 2);
  agents.forEach(nonempty);
  unique(agents, "Agent");
  nonempty(alternateModelID);
  assert.equal(connections.length, 6);
  if (requireTrace) {
    unique(
      connections.map((c) => c.connectionTraceID),
      "upgrade Trace",
    );
    unique(
      connections.map((c) => c.clientSpanID),
      "upgrade CLIENT",
    );
  }
  verifyModelRequests(models, defaultModel, alternateModel);
  const phases = [1, 2].flatMap((v) =>
    groups.flatMap(([, names]) => names.map((name) => `v${v}-${name}`)),
  );
  assert.deepEqual(outcomes, phases);
  const requests = [],
    initializations = [],
    notifications = [],
    permissions = [];
  const sessions = [],
    runTraces = [];
  for (const version of [1, 2]) {
    const peers = connections.filter((c) => c.version === version);
    assert.deepEqual(
      peers.map((c) => c.role),
      ["foreign", "owner", "replay"],
    );
    const [foreign, owner, replay] = peers;
    for (const c of peers) {
      assert.equal(c.agentId, agents[version - 1]);
      if (requireTrace) {
        assert.match(c.connectionTraceID, /^[a-f0-9]{32}$/u);
        assert.match(c.clientSpanID, /^[a-f0-9]{16}$/u);
      }
      const rows = [c.initialization, ...c.evidence];
      assert.equal(rows[0]?.method, "initialize");
      assert.equal(rows[0].outcome, "succeeded");
      assert.equal(rows[0].inputSessionID, null);
      assert.equal(rows[0].sessionId, undefined);
      assert.equal(rows[0].requestReceipt, undefined);
      assert.equal(rows[0].initializationResult?.protocolVersion, version);
      unique(
        rows.map((row) => row.requestId),
        "request ID on connection",
      );
      assert.deepEqual(
        c.requests.map(({ requestId, method, sessionId }) => ({
          requestId,
          method,
          sessionId: sessionId ?? null,
        })),
        rows.map(({ requestId, method, inputSessionID }) => ({
          requestId,
          method,
          sessionId: inputSessionID,
        })),
      );
      for (const row of rows) {
        nonempty(row.requestId);
        for (const [key, value] of Object.entries({
          boundary: "private-acp",
          transport: "websocket",
          protocolVersion: version,
          agentId: c.agentId,
          ...(requireTrace
            ? {
                connectionTraceID: c.connectionTraceID,
                clientSpanID: c.clientSpanID,
              }
            : {}),
        }))
          assert.equal(row[key], value, `foreign Permissions ${key}`);
      }
      initializations.push({
        ...structuredClone(c.initialization),
        version,
        kind: "request",
        label: `v${version}:${c.role}:initialize`,
        ...(c.role === "foreign" ? { agentAccessDenied: true } : {}),
      });
      unique(
        c.permissions.map((row) => row.requestId),
        "permission delivery",
      );
      assert.deepEqual(
        c.raw_frames
          .filter((frame) => frame.method === "session/request_permission")
          .map(({ id, params }) => ({ requestId: String(id), params })),
        c.permissions.map(({ requestId, params }) => ({ requestId, params })),
      );
      permissions.push(
        ...c.permissions.map((row) => ({
          ...structuredClone(row),
          version,
          agentId: c.agentId,
          connectionTraceID: c.connectionTraceID,
          clientSpanID: c.clientSpanID,
        })),
      );
    }
    function consume(c) {
      let offset = 0;
      return {
        take(method, params, extra = {}) {
          const row = c.evidence[offset++];
          assert.equal(
            row?.method,
            method,
            "missing, extra or reordered Permissions request",
          );
          assert.deepEqual(
            row.requestParams,
            params,
            "changed Permissions request input",
          );
          assert.equal(row.inputSessionID, params.sessionId ?? null);
          assert.equal(row.closedBeforeResponse, extra.closedBeforeResponse);
          assert.equal(row.outcome, extra.outcome ?? "succeeded");
          assert.equal(row.rejection, extra.rejection);
          if (extra.rejection) {
            const expected = admissionErrorReceipt("access_denied");
            assert.deepEqual(row.rejectionReceipt, {
              rpcCode: expected.code,
              ...expected.data,
            });
          } else assert.equal(row.rejectionReceipt, undefined);
          if (row.outcome === "succeeded") {
            assert.equal(row.requestReceipt?.requestId, row.requestId);
            assert.deepEqual(row.requestReceipt.params, params);
            assert(
              row.requestReceipt.result &&
                typeof row.requestReceipt.result === "object",
            );
          } else assert.equal(row.requestReceipt, undefined);
          if (method === "session/new") {
            assert.equal(row.sessionId, row.requestReceipt?.result.sessionId);
            if (row.outcome === "succeeded") {
              nonempty(row.sessionId);
              sessions.push(row.sessionId);
            }
          } else assert.equal(row.sessionId, params.sessionId);
          const expected = {
            ...structuredClone(row),
            version,
            kind: "request",
            label: `v${version}:${c.role}:${row.requestId}:${method}`,
            ...extra,
          };
          requests.push(expected);
          return expected;
        },
        end() {
          assert.equal(
            offset,
            c.evidence.length,
            "unaccounted Permissions request",
          );
        },
      };
    }
    const stranger = consume(foreign);
    stranger.take("session/new", setup, {
      outcome: "rejected",
      rejection: "access_denied",
    });
    stranger.end();
    assert.deepEqual(foreign.permissions, []);
    assert.deepEqual(foreign.notifications, []);
    assert(
      !foreign.raw_frames.some((frame) => frame.method === "session/update"),
      "foreign owner received private output",
    );
    const current = consume(owner);
    let cancelSession, reconnectSession;
    const expectedPermissions = [];
    for (const [group, [mode, entries]] of groups.entries()) {
      const created = current.take("session/new", setup);
      const sessionId = created.sessionId;
      for (const [configId, value] of [
        ["mode", mode],
        ...(group === 0 ? [["model", `profile:${alternateModelID}`]] : []),
      ]) {
        const changed = current.take(
          "session/set_config_option",
          {
            sessionId,
            configId,
            value,
            ...(version === 2 ? { type: "id" } : {}),
          },
          { configuration: { configId, value } },
        );
        const options = changed.requestReceipt.result.configOptions;
        assert(Array.isArray(options));
        assert.deepEqual(
          options
            .filter(
              (option) =>
                option[version === 1 ? "id" : "configId"] === configId,
            )
            .map((option) => option.currentValue),
          [value],
        );
      }
      for (const entry of entries) {
        const phase = `v${version}-${entry}`;
        const closed = version === 1 && entry === "reconnect";
        const expected = current.take(
          "session/prompt",
          { sessionId, prompt: [{ type: "text", text: phase }] },
          {
            kind: "execution",
            phase,
            ...(closed
              ? { outcome: "failed", closedBeforeResponse: true }
              : {}),
          },
        );
        if (!closed) {
          const result = expected.requestReceipt.result;
          if (version === 1)
            assert.deepEqual(result, {
              stopReason: entry === "cancel" ? "cancelled" : "end_turn",
            });
          else {
            assert.deepEqual(Object.keys(result), ["messageId"]);
            nonempty(result.messageId);
          }
        }
        const calls = models.filter((row) => row.phase === phase);
        if (requireTrace) {
          for (const call of calls) {
            assert.match(call.trace_id ?? "", /^[a-f0-9]{32}$/u);
            assert.match(call.model_span_id ?? "", /^[a-f0-9]{16}$/u);
          }
          unique(
            calls.map((call) => call.model_span_id),
            "model CLIENT",
          );
          assert.equal(new Set(calls.map((call) => call.trace_id)).size, 1);
        }
        expected.traceID = calls[0].trace_id;
        runTraces.push(expected.traceID);
        if (Object.hasOwn(choices, entry))
          expectedPermissions.push({
            phase,
            sessionId,
            optionId: choices[entry],
          });
        if (entry === "cancel") cancelSession = sessionId;
        if (entry === "reconnect") reconnectSession = sessionId;
      }
    }
    current.end();
    const restored = consume(replay);
    restored.take(version === 1 ? "session/load" : "session/resume", {
      ...setup,
      sessionId: reconnectSession,
      ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
    });
    restored.end();
    assert.equal(owner.notifications.length, 1);
    assert.deepEqual(replay.notifications, []);
    const receipt = owner.notifications[0];
    for (const [key, value] of Object.entries({
      version,
      agentId: owner.agentId,
      sessionId: cancelSession,
      ...(requireTrace
        ? {
            connectionTraceID: owner.connectionTraceID,
            clientSpanID: owner.clientSpanID,
          }
        : {}),
      method: "session/cancel",
      index: 0,
      status: "write_completed",
      origin: "notify",
      wireObserved: true,
      writeOutcome: "completed",
    }))
      assert.equal(receipt[key], value, `foreign Permissions cancel ${key}`);
    notifications.push({ phase: `v${version}-cancel`, receipt });
    const deliveries = [...owner.permissions, ...replay.permissions];
    expectedPermissions.push({
      phase: `v${version}-reconnect`,
      sessionId: reconnectSession,
      optionId: "allow_once",
    });
    assert.equal(owner.permissions.length, 8);
    assert.equal(replay.permissions.length, 1);
    assert.equal(deliveries.length, expectedPermissions.length);
    for (const [offset, actual] of deliveries.entries()) {
      const { phase, sessionId, optionId } = expectedPermissions[offset];
      assert.equal(actual.params.sessionId, sessionId);
      assert.equal(actual.outcome, optionId ? "selected" : "cancelled");
      assert.equal(actual.optionId, optionId ?? undefined);
      if (optionId)
        assert(
          actual.params.options.some((option) => option.optionId === optionId),
        );
      const tool =
        version === 1
          ? actual.params.toolCall
          : actual.params.subject?.toolCall;
      assert.match(tool?.toolCallId ?? "", /^[a-f0-9]{64}$/u);
      assert.deepEqual(
        tool.rawInput,
        phase.includes("judge-")
          ? { value: phase }
          : { path: `${phase}.txt`, content: `${phase}\n` },
      );
      const execution = requests.find((row) => row.phase === phase);
      execution.permissionDeliveries ??= [];
      const connection = offset < owner.permissions.length ? owner : replay;
      execution.permissionDeliveries.push({
        ...structuredClone(actual),
        connectionTraceID: connection.connectionTraceID,
        clientSpanID: connection.clientSpanID,
      });
    }
    assert.deepEqual(
      owner.permissions.at(-1).params,
      replay.permissions[0].params,
      "reconnect changed pending permission",
    );
    unique(
      owner.permissions.map(
        (row) =>
          (version === 1 ? row.params.toolCall : row.params.subject.toolCall)
            .toolCallId,
      ),
      "permission Tool",
    );
  }
  assert.equal(sessions.length, 12);
  unique(sessions, "Session");
  assert.equal(runTraces.length, 26);
  if (requireTrace) unique(runTraces, "Run Trace");
  assert.equal(requests.length, 56);
  return { requests, initializations, notifications, permissions };
}
