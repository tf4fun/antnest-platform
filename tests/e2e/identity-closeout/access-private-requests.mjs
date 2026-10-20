import assert from "node:assert/strict";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";

const text = (value) => assert(typeof value === "string" && value.length > 0);
const key = (row) => JSON.stringify([row.connectionTraceID, row.requestId]);
const phases = [
  "v1-a",
  "v1-b",
  "v2-a",
  "v2-b",
  "offboard-global-a",
  "offboard-global-b",
  "offboard-scim-before-b",
  "offboard-scim-peer-a",
  "offboard-scim-restored-b",
];

// Keep all original recorder fields. Access annotations cannot replace wire
// identity, inputs, results or errors, and list expectations come from the
// complete database observation made before that particular SDK request.
export function indexAgentAccessRequests({ connections, observations }) {
  assert.equal(connections.length, 20);
  assert.equal(observations.length, 64);
  const metadata = new Map(observations.map((row) => [key(row), row]));
  assert.equal(
    metadata.size,
    observations.length,
    "duplicate access observation",
  );
  for (const row of observations) {
    text(row.connectionTraceID);
    text(row.requestId);
    assert(
      Object.keys(row).every((name) =>
        [
          "connectionTraceID",
          "requestId",
          "listSnapshot",
          "phase",
          "modelName",
          "promptReceipt",
        ].includes(name),
      ),
      "access annotation replaces an original field",
    );
  }
  for (const field of ["connectionTraceID", "clientSpanID", "label"])
    assert.equal(
      new Set(connections.map((c) => c[field])).size,
      20,
      "duplicate access " + field,
    );
  const initializations = [],
    requests = [],
    seen = new Set(),
    promptPhases = [],
    created = [];
  const counts = {};
  const baselines = new Map(
    connections
      .filter((c) => c.purpose === "baseline")
      .map((c) => [c.phase, c]),
  );
  assert.equal(baselines.size, 9);
  assert.deepEqual(
    connections
      .filter((c) => c.purpose === "replay")
      .map((c) => c.phase)
      .sort(),
    ["v1-b", "v2-b", "offboard-scim-before-b"].sort(),
  );
  for (const version of [1, 2]) {
    const group = connections.filter((c) => c.version === version);
    assert.equal(group.length, version === 1 ? 7 : 13);
    for (const [purpose, count] of [
      ["denied-agent", 4],
      ["baseline", version === 1 ? 2 : 7],
      ["replay", version === 1 ? 1 : 2],
    ])
      assert.equal(group.filter((c) => c.purpose === purpose).length, count);
  }
  for (const connection of connections) {
    checkPrivateACPConnection(connection);
    for (const row of [connection.initialization, ...connection.evidence]) {
      if (row.outcome !== "succeeded") continue;
      const raw = connection.raw_frames.filter(
        (frame) =>
          Object.hasOwn(frame, "id") && String(frame.id) === row.requestId,
      );
      assert.equal(raw.length, 1);
      // JSON omits undefined optional properties; retain every actual wire
      // property and the full SDK result without rewriting either original.
      assert.deepEqual(
        raw[0].result,
        JSON.parse(
          JSON.stringify(
            row.method === "initialize"
              ? row.initializationResult
              : row.requestResult,
          ),
        ),
        "original access result differs from SDK receipt",
      );
    }
    const { version, principal, purpose, label } = connection;
    if (purpose !== "denied-agent") {
      assert(phases.includes(connection.phase));
      assert.equal(version, connection.phase.startsWith("v1-") ? 1 : 2);
    }
    for (const field of ["organization_id", "user_id"])
      text(principal?.[field]);
    initializations.push({
      ...structuredClone(connection.initialization),
      version,
      kind: "request",
      label: label + "-initialize",
      ...(purpose === "denied-agent" ? { agentAccessDenied: true } : {}),
    });
    if (purpose === "denied-agent") assert.equal(connection.evidence.length, 1);
    if (purpose === "replay") {
      assert.equal(connection.evidence.length, 1);
      assert(
        ["v1-b", "v2-b", "offboard-scim-before-b"].includes(connection.phase),
      );
      const row = connection.evidence[0];
      assert.equal(
        row.method,
        version === 1 ? "session/load" : "session/resume",
      );
      assert.equal(row.outcome, "succeeded");
      assert.equal(
        row.sessionId,
        baselines.get(connection.phase)?.evidence[0].requestResult.sessionId,
      );
      assert.equal(
        connection.agentId,
        baselines.get(connection.phase)?.agentId,
      );
    }
    if (purpose === "baseline") {
      const [created, prompt, replay] = connection.evidence;
      assert.deepEqual(
        [created?.method, prompt?.method, replay?.method],
        [
          "session/new",
          "session/prompt",
          version === 1 ? "session/load" : "session/resume",
        ],
      );
      for (const row of [created, prompt, replay]) {
        assert.equal(row.outcome, "succeeded");
        assert.equal(row.sessionId, created.requestResult.sessionId);
      }
    }
    for (const row of connection.evidence) {
      const id = key(row),
        detail = metadata.get(id);
      assert(
        detail && !seen.has(id),
        "missing or duplicate access request observation",
      );
      seen.add(id);
      const output = {
        ...structuredClone(row),
        version,
        kind: "request",
        label: label + "-" + row.requestId,
      };
      assert.equal(row.requestParams.sessionId ?? null, row.inputSessionID);
      const counted = row.method + ":" + row.outcome;
      counts[counted] = (counts[counted] ?? 0) + 1;
      if (row.outcome === "failed") {
        const rejection =
          row.method === "session/new"
            ? "access_denied"
            : "session_access_denied";
        assert.equal(purpose === "denied-agent", rejection === "access_denied");
        assert.equal(row.failureCode, -32020);
        assert.deepEqual(row.failureData, {
          code: rejection,
          retryable: false,
        });
        assert.deepEqual(row.rejectionReceipt, {
          rpcCode: -32020,
          code: rejection,
          retryable: false,
        });
        const raw = connection.raw_frames.filter(
          (frame) =>
            Object.hasOwn(frame, "id") && String(frame.id) === row.requestId,
        );
        assert.equal(raw.length, 1, "original access refusal reply missing");
        assert.equal(raw[0].error.code, row.failureCode);
        assert.deepEqual(raw[0].error.data, row.failureData);
        output.rejection = rejection;
      } else {
        assert.notEqual(purpose, "denied-agent");
        assert.equal(row.rejectionReceipt, undefined);
        if (row.method === "session/new") {
          assert.equal(purpose, "baseline");
          assert.deepEqual(row.requestParams, {
            cwd: "/workspace",
            mcpServers: [],
          });
          text(row.sessionId);
          created.push(row.sessionId);
        } else if (row.method === "session/prompt") {
          assert.equal(purpose, "baseline");
          assert(phases.includes(detail.phase));
          assert.equal(connection.phase, detail.phase);
          assert.equal(detail.modelName, "scope-" + detail.phase.at(-1));
          assert.deepEqual(row.requestParams.prompt, [
            { type: "text", text: detail.phase },
          ]);
          assert.equal(detail.promptReceipt?.requestId, row.requestId);
          assert.equal(detail.promptReceipt.sessionId, row.sessionId);
          assert.deepEqual(detail.promptReceipt.result, row.requestResult);
          Object.assign(output, {
            kind: "native",
            phase: detail.phase,
            modelName: detail.modelName,
            promptReceipt: structuredClone(detail.promptReceipt),
          });
          promptPhases.push(detail.phase);
        } else if (row.method === "session/list") {
          assert.deepEqual(row.requestParams, {});
          assert(
            Array.isArray(detail.listSnapshot),
            "original list database observation required",
          );
          assert.equal(
            new Set(detail.listSnapshot.map((s) => s.id)).size,
            detail.listSnapshot.length,
          );
          output.listSessionIds = detail.listSnapshot
            .filter(
              (s) =>
                s.organization_id === principal.organization_id &&
                s.principal_id === principal.user_id &&
                s.agent_id === connection.agentId &&
                s.state !== "deleted",
            )
            .map((s) => s.id);
          output.listSessionIds.forEach(text);
        } else {
          assert.equal(
            row.method,
            version === 1 ? "session/load" : "session/resume",
          );
          assert.deepEqual(row.requestParams, {
            sessionId: row.sessionId,
            cwd: "/workspace",
            mcpServers: [],
            ...(version === 2 ? { replayFrom: { type: "start" } } : {}),
          });
        }
      }
      requests.push(output);
    }
  }
  assert.equal(seen.size, metadata.size);
  assert.deepEqual(promptPhases.sort(), [...phases].sort());
  assert.equal(new Set(created).size, 9);
  assert.deepEqual(counts, {
    "session/new:failed": 8,
    "session/new:succeeded": 9,
    "session/prompt:succeeded": 9,
    "session/load:succeeded": 3,
    "session/resume:succeeded": 9,
    "session/list:succeeded": 6,
    "session/load:failed": 2,
    "session/resume:failed": 2,
    "session/fork:failed": 4,
    "session/close:failed": 4,
    "session/delete:failed": 4,
    "session/prompt:failed": 4,
  });
  return { initializations, requests };
}
