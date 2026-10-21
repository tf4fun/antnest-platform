import assert from "node:assert/strict";
import {
  checkPrivateACPConnection,
  createPrivateACPRecorder,
} from "../../support/private-acp-recorder.mjs";
import { replayRequest } from "../managed-mcp/protocol.mjs";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";

export { preservePrivateACPFailure as preserveRestartFailure } from "../../support/private-acp-recorder.mjs";

const setup = { cwd: "/workspace", mcpServers: [] };
const kinds = ["completed", "model-held", "tool-held", "inflight"];
const roles = ["prompt", "replay-1", "replay-2", "rebuild"];
const nonempty = (value) =>
  assert(typeof value === "string" && value.length > 0);
const unique = (values, label) =>
  assert.equal(
    new Set(values).size,
    values.length,
    `duplicate Restart ${label}`,
  );
export function createRestartRecorder(client, meta, preserve) {
  assert(
    [1, 2].includes(meta.version) &&
      kinds.includes(meta.kind) &&
      roles.includes(meta.role),
  );
  return createPrivateACPRecorder(client, meta, preserve);
}

export function indexRestartRequests({ agentId, connections }) {
  nonempty(agentId);
  assert.equal(connections.length, 26);
  unique(
    connections.map((row) => row.connectionTraceID),
    "connection Trace",
  );
  unique(
    connections.map((row) => row.clientSpanID),
    "connection CLIENT",
  );
  const requests = [],
    initializations = [],
    sessions = [];
  for (const version of [1, 2])
    for (const kind of kinds) {
      const label = `v${version}-${kind}`;
      const phase =
        kind === "inflight" ? `v${version}-tool-inflight` : label + "-fault";
      const group = connections.filter(
        (row) => row.version === version && row.kind === kind,
      );
      assert.deepEqual(
        group.map((row) => row.role),
        kind === "inflight" ? roles : roles.slice(0, 3),
      );
      const sessionId = group[0].evidence[0]?.requestResult?.sessionId;
      nonempty(sessionId);
      sessions.push(sessionId);
      const other =
        kind === "inflight"
          ? group[0].evidence[1]?.requestResult?.sessionId
          : undefined;
      if (kind === "inflight") {
        nonempty(other);
        sessions.push(other);
      }
      const replay = replayRequest(version, sessionId);
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
                ["new", setup, "request", label + "-new", sessionId],
                ...(kind === "inflight"
                  ? [["new", setup, "request", label + "-other-new", other]]
                  : []),
                [
                  "prompt",
                  { sessionId, prompt: [{ type: "text", text: phase }] },
                  kind === "completed" ? "ordinary" : "interruption",
                  phase,
                  sessionId,
                ],
              ]
            : [
                [
                  replay.method,
                  replay.params,
                  "request",
                  c.role === "rebuild"
                    ? label + "-rebuild-replay"
                    : label + "-" + c.role,
                  sessionId,
                ],
                ...(c.role === "replay-1"
                  ? []
                  : kind === "inflight" && c.role === "replay-2"
                    ? [
                        [
                          "prompt",
                          {
                            sessionId: other,
                            prompt: [
                              { type: "text", text: "unresolved-denied" },
                            ],
                          },
                          "request",
                          label + "-denied",
                          other,
                          "runtime_barrier_required",
                        ],
                      ]
                    : [
                        [
                          "prompt",
                          {
                            sessionId,
                            prompt: [{ type: "text", text: label + "-post" }],
                          },
                          "ordinary",
                          label + "-post",
                          sessionId,
                        ],
                      ]),
              ];
        assert.equal(c.evidence.length, calls.length);
        for (const [
          i,
          [method, params, requestKind, requestLabel, target, rejection],
        ] of calls.entries()) {
          const row = c.evidence[i];
          assert.equal(row.method, "session/" + method);
          assert.deepEqual(row.requestParams, params);
          assert.equal(row.inputSessionID, params.sessionId ?? null);
          assert.equal(row.sessionId, target);
          const failed =
            rejection !== undefined ||
            (requestKind === "interruption" && version === 1);
          assert.equal(row.outcome, failed ? "failed" : "succeeded");
          if (method === "new")
            assert.equal(row.requestResult.sessionId, target);
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
              "original barrier rejection reply required",
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
            ...(["ordinary", "interruption"].includes(requestKind)
              ? { phase: requestLabel }
              : {}),
            ...(rejection ? { rejection } : {}),
          });
        }
      }
    }
  unique(sessions, "Session");
  assert.equal(requests.length, 46);
  assert.equal(initializations.length, 26);
  return { requests, initializations };
}
