import assert from "node:assert/strict";
import {
  createPrivateACPRecorder,
  checkPrivateACPConnection,
} from "../../support/private-acp-recorder.mjs";
import { replayRequest } from "../managed-mcp/protocol.mjs";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";

const kinds = ["apply", "settle"],
  roles = ["prompt", "replay-1", "replay-2"];
const setup = { cwd: "/workspace", mcpServers: [] };
const unique = (values) => assert.equal(new Set(values).size, values.length);
const nonempty = (value) =>
  assert(typeof value === "string" && value.length > 0);
export function createRpcLossRecorder(client, meta, preserve) {
  assert(
    [1, 2].includes(meta.version) &&
      kinds.includes(meta.kind) &&
      roles.includes(meta.role),
  );
  return createPrivateACPRecorder(client, meta, preserve);
}
export function indexRpcLossRequests({ agentId, connections }) {
  nonempty(agentId);
  assert.equal(connections.length, 12);
  unique(connections.map((c) => c.connectionTraceID));
  unique(connections.map((c) => c.clientSpanID));
  const initializations = [],
    requests = [],
    sessions = [];
  for (const version of [1, 2])
    for (const kind of kinds) {
      const label = `v${version}-${kind}`,
        phase = label + "-write";
      const group = connections.filter(
        (c) => c.version === version && c.kind === kind,
      );
      assert.deepEqual(
        group.map((c) => c.role),
        roles,
      );
      const sessionId = group[0].evidence[0]?.requestResult?.sessionId;
      nonempty(sessionId);
      sessions.push(sessionId);
      const replay = replayRequest(version, sessionId);
      const prompt = (text) => ({
        sessionId,
        prompt: [{ type: "text", text }],
      });
      for (const c of group) {
        assert.equal(c.agentId, agentId);
        assert.match(c.connectionTraceID, /^[a-f0-9]{32}$/u);
        assert.match(c.clientSpanID, /^[a-f0-9]{16}$/u);
        checkPrivateACPConnection(c);
        initializations.push({
          ...structuredClone(c.initialization),
          version,
          kind: "request",
          label: `${label}-${c.role}-initialize`,
        });
        const calls =
          c.role === "prompt"
            ? [
                ["new", setup, "request", label + "-new"],
                ["prompt", prompt(phase), "ordinary", phase],
                ...(kind === "settle"
                  ? [
                      [
                        "prompt",
                        prompt(label + "-denied"),
                        "request",
                        label + "-denied",
                        "agent_unavailable",
                      ],
                    ]
                  : []),
              ]
            : [
                [replay.method, replay.params, "request", `${phase}-${c.role}`],
                ...(c.role === "replay-2"
                  ? [
                      [
                        "prompt",
                        prompt(label + "-read"),
                        "ordinary",
                        label + "-read",
                      ],
                    ]
                  : []),
              ];
        assert.equal(c.evidence.length, calls.length);
        for (const [
          i,
          [method, params, requestKind, requestLabel, rejection],
        ] of calls.entries()) {
          const row = c.evidence[i];
          assert.equal(row.method, "session/" + method);
          assert.deepEqual(row.requestParams, params);
          assert.equal(row.inputSessionID, params.sessionId ?? null);
          assert.equal(row.sessionId, sessionId);
          assert.equal(row.outcome, rejection ? "failed" : "succeeded");
          if (method === "new")
            assert.equal(row.requestResult.sessionId, sessionId);
          if (rejection) {
            const expected = admissionErrorReceipt(rejection);
            assert.equal(row.failureCode, expected.code);
            assert.deepEqual(row.failureData, expected.data);
            assert.deepEqual(row.rejectionReceipt, {
              rpcCode: expected.code,
              code: rejection,
              retryable: expected.data.retryable,
            });
            const raw = c.raw_frames.filter(
              (frame) =>
                Object.hasOwn(frame, "id") &&
                String(frame.id) === row.requestId,
            );
            assert.equal(
              raw.length,
              1,
              "original closed-admission response required",
            );
            assertAdmissionError(raw[0].error, rejection);
            assert.equal(raw[0].error.code, row.failureCode);
            assert.deepEqual(raw[0].error.data, row.failureData);
          }
          requests.push({
            ...structuredClone(row),
            version,
            kind: requestKind,
            label: requestLabel,
            ...(requestKind === "ordinary" ? { phase: requestLabel } : {}),
            ...(rejection ? { rejection } : {}),
          });
        }
      }
    }
  unique(sessions);
  assert.equal(initializations.length, 12);
  assert.equal(requests.length, 22);
  return { initializations, requests };
}
