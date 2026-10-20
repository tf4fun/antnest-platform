import assert from "node:assert/strict";
import { checkPrivateACPConnection } from "../../support/private-acp-recorder.mjs";
const clone = (value) => structuredClone(value);
const text = (value) => assert(typeof value === "string" && value.length > 0);
const key = (row) => JSON.stringify([row.connectionTraceID, row.requestId]);
const unique = (rows) => assert.equal(new Set(rows).size, rows.length);
const phases = [1, 2].flatMap((v) =>
  ["owner", "peer", "foreign", "restored"].map((role) => `v${v}-${role}`),
);

// Project only original recorder rows. Annotation fields add scenario context;
// they cannot replace wire inputs, replies, identities or request outcomes.
export function indexCloseoutAccessRequests({
  connections,
  observations,
  localProbes,
}) {
  assert.equal(connections.length, 30);
  assert.equal(observations.length, 86);
  assert.equal(localProbes.length, 4);
  const notes = new Map(observations.map((row) => [key(row), row]));
  assert.equal(notes.size, observations.length);
  for (const note of observations) {
    text(note.connectionTraceID);
    text(note.requestId);
    assert(
      Object.keys(note).every((k) =>
        [
          "connectionTraceID",
          "requestId",
          "phase",
          "runId",
          "scope",
          "listSnapshot",
        ].includes(k),
      ),
    );
  }
  for (const field of ["connectionTraceID", "clientSpanID", "label"])
    unique(connections.map((c) => c[field]));
  assert.equal(
    new Set(connections.map((c) => c.principal?.organization_id)).size,
    1,
    "Closeout requires its original single organization",
  );
  const baseline = connections.filter((c) => c.purpose === "baseline");
  assert.deepEqual(baseline.map((c) => c.phase).sort(), [...phases].sort());
  const byPhase = new Map(baseline.map((c) => [c.phase, c]));
  const created = new Map(
    baseline.map((c) => [c.evidence[0]?.requestResult?.sessionId, c]),
  );
  assert.equal(created.size, 8);
  for (const id of created.keys()) text(id);
  const initializations = [],
    requests = [],
    seen = new Set(),
    counts = {},
    runIDs = [];
  for (const version of [1, 2]) {
    const group = connections.filter((c) => c.version === version);
    assert.equal(group.length, 15);
    for (const [purpose, count] of [
      ["baseline", 4],
      ["replay", 7],
      ["denied-agent", 4],
    ])
      assert.equal(group.filter((c) => c.purpose === purpose).length, count);
    assert.deepEqual(
      group
        .filter((c) => c.purpose === "replay")
        .map((c) => c.phase)
        .sort(),
      ["owner", "owner", "peer", "peer", "foreign", "foreign", "restored"]
        .map((role) => `v${version}-${role}`)
        .sort(),
    );
  }
  for (const c of connections) {
    checkPrivateACPConnection(c);
    const { version, purpose, principal } = c;
    for (const field of ["organization_id", "user_id"])
      text(principal?.[field]);
    if (purpose !== "denied-agent") {
      assert(phases.includes(c.phase));
      assert(c.phase.startsWith(`v${version}-`));
    }
    for (const row of [c.initialization, ...c.evidence]) {
      const raw = c.raw_frames.filter(
        (frame) =>
          Object.hasOwn(frame, "id") && String(frame.id) === row.requestId,
      );
      assert.equal(raw.length, 1);
      if (row.outcome === "succeeded")
        assert.deepEqual(
          raw[0].result,
          JSON.parse(
            JSON.stringify(
              row.method === "initialize"
                ? row.initializationResult
                : row.requestResult,
            ),
          ),
        );
    }
    initializations.push({
      ...clone(c.initialization),
      version,
      kind: "request",
      label: c.label + "-initialize",
      ...(purpose === "denied-agent" ? { agentAccessDenied: true } : {}),
    });
    if (purpose === "denied-agent") assert.equal(c.evidence.length, 1);
    if (purpose === "replay") {
      assert.equal(c.evidence.length, 1);
      const original = byPhase.get(c.phase),
        row = c.evidence[0];
      assert.equal(c.agentId, original.agentId);
      assert.deepEqual(principal, original.principal);
      assert.equal(
        row.method,
        version === 1 ? "session/load" : "session/resume",
      );
      assert.equal(row.outcome, "succeeded");
      assert.equal(row.sessionId, original.evidence[0].requestResult.sessionId);
    }
    if (purpose === "baseline") {
      const [start, prompt] = c.evidence;
      assert.equal(start.method, "session/new");
      assert.equal(start.outcome, "succeeded");
      assert.equal(prompt.method, "session/prompt");
      assert.equal(prompt.outcome, "succeeded");
      assert.equal(prompt.sessionId, start.requestResult.sessionId);
      const rounds = c.phase.endsWith("-owner")
        ? 2
        : c.phase.endsWith("-restored")
          ? 0
          : 1;
      assert.deepEqual(
        c.evidence.slice(2).map((r) => r.method),
        Array.from({ length: rounds }, () => [
          "session/list",
          version === 1 ? "session/load" : "session/resume",
          "session/fork",
          "session/close",
          "session/delete",
          "session/prompt",
        ]).flat(),
      );
    }
    if (purpose === "baseline") {
      const sources = c.phase.endsWith("-owner")
        ? [
            ["peer", "Agent"],
            ["foreign", "principal"],
          ]
        : c.phase.endsWith("-peer")
          ? [["owner", "Agent"]]
          : c.phase.endsWith("-foreign")
            ? [["owner", "principal"]]
            : [];
      for (const [round, [role, scope]] of sources.entries()) {
        const source = byPhase.get(`v${version}-${role}`);
        for (const row of c.evidence.slice(3 + round * 6, 8 + round * 6)) {
          assert.equal(row.outcome, "failed");
          assert.equal(notes.get(key(row))?.scope, scope);
          const sessionId = source.evidence[0].requestResult.sessionId;
          assert.equal(row.inputSessionID, sessionId);
          assert.equal(row.sessionId, sessionId);
          assert.deepEqual(row.requestParams, {
            sessionId,
            cwd: "/workspace",
            mcpServers: [],
            ...(row.method === "session/prompt"
              ? { prompt: [{ type: "text", text: "unauthorized" }] }
              : {}),
            ...(row.method === "session/resume"
              ? { replayFrom: { type: "start" } }
              : {}),
          });
        }
      }
    }
    for (const row of c.evidence) {
      const id = key(row),
        detail = notes.get(id);
      assert(
        detail && !seen.has(id),
        "missing or duplicate Closeout observation",
      );
      seen.add(id);
      assert.equal(row.requestParams.sessionId ?? null, row.inputSessionID);
      const output = {
        ...clone(row),
        version,
        kind: "request",
        label: c.label + "-" + row.requestId,
      };
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
        const raw = c.raw_frames.filter(
          (frame) =>
            Object.hasOwn(frame, "id") && String(frame.id) === row.requestId,
        );
        assert.equal(raw.length, 1);
        assert.equal(raw[0].error.code, row.failureCode);
        assert.deepEqual(raw[0].error.data, row.failureData);
        if (rejection === "session_access_denied") {
          assert(["principal", "Agent"].includes(detail.scope));
          assert.equal(
            raw[0].error.message,
            `Session belongs to another ${detail.scope}`,
          );
          const source = created.get(row.inputSessionID);
          assert(source);
          assert.equal(source.version, version);
          if (detail.scope === "principal")
            assert.notEqual(source.principal.user_id, principal.user_id);
          else {
            assert.equal(source.principal.user_id, principal.user_id);
            assert.notEqual(source.agentId, c.agentId);
          }
          output.scope = detail.scope;
        }
        output.rejection = rejection;
      } else {
        assert.equal(row.outcome, "succeeded");
        assert.notEqual(purpose, "denied-agent");
        assert.equal(row.rejectionReceipt, undefined);
        if (row.method === "session/new") {
          assert.equal(purpose, "baseline");
          assert.deepEqual(row.requestParams, {
            cwd: "/workspace",
            mcpServers: [],
          });
        } else if (row.method === "session/prompt") {
          assert.equal(purpose, "baseline");
          assert.equal(detail.phase, c.phase);
          text(detail.runId);
          runIDs.push(detail.runId);
          assert.deepEqual(row.requestParams, {
            sessionId: row.sessionId,
            prompt: [{ type: "text", text: detail.phase }],
          });
          Object.assign(output, {
            kind: "ordinary",
            phase: detail.phase,
            runId: detail.runId,
          });
        } else if (row.method === "session/list") {
          assert.deepEqual(row.requestParams, {});
          assert(Array.isArray(detail.listSnapshot));
          unique(detail.listSnapshot.map((s) => s.id));
          output.listSessionIds = detail.listSnapshot
            .filter(
              (s) =>
                s.organization_id === principal.organization_id &&
                s.principal_id === principal.user_id &&
                s.agent_id === c.agentId &&
                s.state !== "deleted",
            )
            .map((s) => s.id);
          output.listSessionIds.forEach(text);
        } else {
          assert.equal(purpose, "replay");
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
  assert.equal(seen.size, notes.size);
  assert.equal(runIDs.length, 8);
  unique(runIDs);
  assert.deepEqual(counts, {
    "session/new:failed": 8,
    "session/new:succeeded": 8,
    "session/prompt:succeeded": 8,
    "session/load:succeeded": 7,
    "session/resume:succeeded": 7,
    "session/list:succeeded": 8,
    "session/load:failed": 4,
    "session/resume:failed": 4,
    "session/fork:failed": 8,
    "session/close:failed": 8,
    "session/delete:failed": 8,
    "session/prompt:failed": 8,
  });
  const revoked = baseline.filter((c) => /-(owner|peer)$/u.test(c.phase));
  assert.deepEqual(
    localProbes.map((p) => p.connectionTraceID).sort(),
    revoked.map((c) => c.connectionTraceID).sort(),
  );
  for (const probe of localProbes) {
    const c = revoked.find(
      (c) => c.connectionTraceID === probe.connectionTraceID,
    );
    assert.equal(probe.method, "prompt");
    assert.deepEqual(probe.params, {
      sessionId: c.evidence[0].requestResult.sessionId,
      prompt: [{ type: "text", text: "revoked-owner" }],
    });
    assert.equal(probe.outcome, "rejected");
    text(probe.failure);
    assert.equal(probe.before.closed, true);
    assert.deepEqual(probe.before, c);
    assert.deepEqual(
      probe.after,
      probe.before,
      "local post-close probe changed original wire inventory",
    );
  }
  return { initializations, requests, localProbes: clone(localProbes) };
}
