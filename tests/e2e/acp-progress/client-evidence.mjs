import assert from "node:assert/strict";
import { terminalStatus } from "./evidence.mjs";

const phases = [1, 2].flatMap((version) =>
  ["bash", "managed"].flatMap((source) =>
    ["success", "failure", "cancel"].map(
      (ending) => `v${version}-${source}-${ending}`,
    ),
  ),
);
const nonempty = (value) => typeof value === "string" && value.length > 0;
const unique = (values, label) =>
  assert.equal(
    new Set(values).size,
    values.length,
    `duplicate Progress ${label}`,
  );

// This binds the scenario inventory to every SDK request. Notification objects
// stay original; only the actual collector can establish their provenance and
// admit the original server Trace. Raw frame snapshots are private evidence.
export async function captureProgressConnection({ client, ...meta }) {
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
    raw_frames: structuredClone(client.rawFrames),
  };
}

export function indexProgressRequests({
  agents,
  connections,
  scenarios,
  outcomes,
  models,
}) {
  assert.equal(agents.length, 4);
  assert(agents.every(nonempty));
  unique(agents, "Agent");
  assert.deepEqual(
    scenarios.map((row) => row.phase),
    phases,
  );
  assert.deepEqual(
    outcomes.map((row) => row.phase),
    phases,
  );
  for (const key of ["sessionId", "toolCallId"]) {
    assert(scenarios.every((row) => nonempty(row[key])));
    unique(
      scenarios.map((row) => row[key]),
      key,
    );
  }
  assert.equal(connections.length, 28);
  unique(
    connections.map((row) => row.connectionTraceID),
    "connection",
  );
  unique(
    connections.map((row) => row.clientSpanID),
    "CLIENT span",
  );
  assert.equal(models.length, 20);
  const providerTraces = [];
  const requests = [],
    initializations = [],
    notifications = [];
  for (const [index, phase] of phases.entries()) {
    const [protocol, source, ending] = phase.split("-");
    const version = Number(protocol.slice(1)),
      agentId = agents[Math.floor(index / 3)];
    const scenario = scenarios[index],
      outcome = outcomes[index];
    assert.equal(outcome.early_progress, true);
    assert.equal(outcome.replay, true);
    assert.equal(outcome.terminal, terminalStatus(version, source, ending));
    assert.equal(
      outcome.actual_execution_stopped,
      ending === "cancel" ? true : undefined,
    );
    const calls = models.filter((row) => row.phase === phase);
    assert.deepEqual(
      calls.map((row) => row.stage),
      ending === "cancel" ? ["tool"] : ["tool", "final"],
    );
    for (const call of calls)
      assert.match(call.trace_id ?? "", /^[a-f0-9]{32}$/u);
    assert.equal(new Set(calls.map((row) => row.trace_id)).size, 1);
    providerTraces.push(calls[0].trace_id);
    const group = connections.filter((row) => row.phase === phase);
    assert.deepEqual(
      group.map((row) => row.role),
      ending === "success"
        ? ["prompt", "live-replay", "terminal-replay"]
        : ["prompt", "terminal-replay"],
    );
    for (const connection of group) {
      const { role, connectionTraceID, clientSpanID } = connection;
      for (const [key, value] of Object.entries({
        version,
        source,
        ending,
        agentId,
        sessionId: scenario.sessionId,
      }))
        assert.equal(
          connection[key],
          value,
          `foreign Progress connection ${key}`,
        );
      assert.match(connectionTraceID ?? "", /^[a-f0-9]{32}$/u);
      assert.match(clientSpanID ?? "", /^[a-f0-9]{16}$/u);
      const methods =
        role === "prompt"
          ? ["session/new", "session/prompt"]
          : [
              version === 1 ? "session/load" : "session/resume",
              ...(ending === "cancel" ? ["session/prompt"] : []),
            ];
      assert.deepEqual(
        connection.evidence.map((row) => row.method),
        methods,
      );
      const rows = [connection.initialization, ...connection.evidence];
      assert.equal(rows[0].method, "initialize");
      assert.equal(connection.requests.length, rows.length);
      unique(
        rows.map((row) => row.requestId),
        "request ID on connection",
      );
      for (const [offset, row] of rows.entries()) {
        assert(nonempty(row.requestId));
        const inputSessionID = ["initialize", "session/new"].includes(
          row.method,
        )
          ? null
          : scenario.sessionId;
        for (const [key, value] of Object.entries({
          boundary: "private-acp",
          transport: "websocket",
          protocolVersion: version,
          agentId,
          connectionTraceID,
          clientSpanID,
          inputSessionID,
        }))
          assert.equal(row[key], value, `foreign Progress request ${key}`);
        if (row.method !== "initialize")
          assert.equal(row.sessionId, scenario.sessionId);
        const wire = connection.requests[offset];
        assert.equal(wire.requestId, row.requestId);
        assert.equal(wire.method, row.method);
        assert.equal(wire.sessionId ?? null, inputSessionID);
        const prompt = row.method === "session/prompt" && role === "prompt";
        const barrier =
          row.method === "session/prompt" && role === "terminal-replay";
        const disconnected = prompt && version === 1 && ending === "success";
        assert.equal(
          row.outcome,
          barrier ? "rejected" : disconnected ? "failed" : "succeeded",
        );
        assert.equal(row.closedBeforeResponse, disconnected ? true : undefined);
        assert.equal(
          row.rejection,
          barrier ? "runtime_barrier_required" : undefined,
        );
        if (barrier)
          assert.deepEqual(row.rejectionReceipt, {
            rpcCode: -32020,
            code: "runtime_barrier_required",
            retryable: false,
          });
        else assert.equal(row.rejectionReceipt, undefined);
        const expected = {
          ...structuredClone(row),
          label: `${phase}:${role}:${row.method}`,
          kind: prompt ? "execution" : "request",
          ...(prompt ? { phase, toolCallId: scenario.toolCallId } : {}),
        };
        (row.method === "initialize" ? initializations : requests).push(
          expected,
        );
      }
      const cancelled = ending === "cancel" && role === "prompt";
      assert.equal(connection.notifications.length, cancelled ? 1 : 0);
      for (const receipt of connection.notifications) {
        for (const [key, value] of Object.entries({
          version,
          agentId,
          sessionId: scenario.sessionId,
          method: "session/cancel",
          connectionTraceID,
          clientSpanID,
          index: 0,
          status: "write_completed",
          origin: "notify",
          wireObserved: true,
          writeOutcome: "completed",
        }))
          assert.equal(
            receipt[key],
            value,
            `foreign Progress notification ${key}`,
          );
        notifications.push({ phase, receipt });
      }
    }
  }
  unique(providerTraces, "Provider Trace across phases");
  assert.equal(requests.length, 44);
  assert.equal(initializations.length, 28);
  assert.equal(notifications.length, 4);
  return { requests, initializations, notifications };
}
