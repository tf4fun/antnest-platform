import assert from "node:assert/strict";
import test from "node:test";

const url = new URL("./access-private-requests.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const index = (input) => {
  assert.equal(typeof implementation.indexAgentAccessRequests, "function");
  return implementation.indexAgentAccessRequests(input);
};
function fixture() {
  const connections = [],
    observations = [];
  function connection(version, purpose, phase) {
    const n = connections.length + 1;
    const c = {
      version,
      purpose,
      phase,
      label: "connection-" + n,
      agentId: "agent-" + (phase?.at(-1) ?? "b"),
      principal: {
        organization_id: "org-" + (phase?.at(-1) ?? "b"),
        user_id: "owner",
      },
      closed: true,
      evidence_errors: [],
      connectionTraceID: n.toString(16).padStart(32, "0"),
      clientSpanID: n.toString(16).padStart(16, "0"),
      evidence: [],
      requests: [],
      raw_frames: [],
      updates: [],
    };
    const identity = (method, params) => ({
      boundary: "private-acp",
      transport: "websocket",
      protocolVersion: version,
      agentId: c.agentId,
      connectionTraceID: c.connectionTraceID,
      clientSpanID: c.clientSpanID,
      method,
      requestId: String(c.requests.length + 1),
      inputSessionID: params.sessionId ?? null,
    });
    c.initialization = {
      ...identity("initialize", {}),
      outcome: "succeeded",
      initializationResult: { protocolVersion: version },
    };
    c.requests.push({ requestId: "1", method: "initialize" });
    c.raw_frames.push({ id: 1, result: { protocolVersion: version } });
    connections.push(c);
    function request(name, sessionId, rejection) {
      const params =
        name === "list"
          ? {}
          : {
              cwd: "/workspace",
              mcpServers: [],
              ...(sessionId ? { sessionId } : {}),
              ...(name === "prompt"
                ? {
                    prompt: [
                      {
                        type: "text",
                        text: rejection ? "foreign-prompt" : phase,
                      },
                    ],
                  }
                : {}),
              ...(name === "resume" ? { replayFrom: { type: "start" } } : {}),
            };
      const row = {
        ...identity("session/" + name, params),
        requestParams: params,
        outcome: rejection ? "failed" : "succeeded",
        sessionId,
      };
      const metadata = {
        connectionTraceID: c.connectionTraceID,
        requestId: row.requestId,
      };
      if (rejection) {
        Object.assign(row, {
          failure: "original refusal",
          failureCode: -32020,
          failureData: { code: rejection, retryable: false },
          rejectionReceipt: {
            rpcCode: -32020,
            code: rejection,
            retryable: false,
          },
        });
        c.raw_frames.push({
          id: Number(row.requestId),
          error: {
            code: row.failureCode,
            data: structuredClone(row.failureData),
            message: "refused",
          },
        });
      } else {
        row.requestResult =
          name === "new"
            ? { sessionId: "session-" + n }
            : name === "prompt"
              ? version === 1
                ? { stopReason: "end_turn" }
                : { messageId: "message-" + n }
              : name === "list"
                ? { sessions: [{ sessionId: "session-" + n }] }
                : {};
        row.sessionId ??= row.requestResult.sessionId;
        c.raw_frames.push({
          id: Number(row.requestId),
          result: structuredClone(row.requestResult),
        });
        if (name === "list")
          metadata.listSnapshot = [
            {
              id: "session-" + n,
              organization_id: c.principal.organization_id,
              principal_id: c.principal.user_id,
              agent_id: c.agentId,
              state: "active",
            },
            {
              id: "foreign",
              organization_id: "other",
              principal_id: "owner",
              agent_id: c.agentId,
              state: "active",
            },
          ];
        if (name === "prompt")
          Object.assign(metadata, {
            phase,
            modelName: "scope-" + phase.at(-1),
            promptReceipt: {
              requestId: row.requestId,
              sessionId,
              result: structuredClone(row.requestResult),
              error: null,
              terminals: [],
            },
          });
      }
      c.requests.push({
        requestId: row.requestId,
        method: row.method,
        ...(sessionId ? { sessionId } : {}),
      });
      c.evidence.push(row);
      observations.push(metadata);
      return row.sessionId;
    }
    return { c, request };
  }
  for (const version of [1, 2]) {
    for (let i = 0; i < 4; i++)
      connection(version, "denied-agent").request(
        "new",
        undefined,
        "access_denied",
      );
    for (const key of ["a", "b"]) {
      const { request } = connection(version, "baseline", `v${version}-${key}`);
      const session = request("new");
      request("prompt", session);
      request(version === 1 ? "load" : "resume", session);
      request("list");
      for (const method of [
        version === 1 ? "load" : "resume",
        "fork",
        "close",
        "delete",
        "prompt",
      ])
        request(method, "foreign", "session_access_denied");
      if (key === "a") request("list");
    }
    connection(version, "replay", `v${version}-b`).request(
      version === 1 ? "load" : "resume",
      connections.find((c) => c.phase === `v${version}-b`).evidence[0]
        .sessionId,
    );
  }
  for (const phase of [
    "offboard-global-a",
    "offboard-global-b",
    "offboard-scim-before-b",
    "offboard-scim-peer-a",
    "offboard-scim-restored-b",
  ]) {
    const { request } = connection(2, "baseline", phase);
    const session = request("new");
    request("prompt", session);
    request("resume", session);
  }
  connection(2, "replay", "offboard-scim-before-b").request(
    "resume",
    connections.find((c) => c.phase === "offboard-scim-before-b").evidence[0]
      .sessionId,
  );
  return { connections, observations };
}
test("Agent access indexes all 20 initializations and 64 original requests including new and list", () => {
  const f = fixture(),
    before = structuredClone(f);
  const result = index(f);
  assert.equal(result.initializations.length, 20);
  assert.equal(result.requests.length, 64);
  assert.equal(result.requests.filter((r) => r.kind === "native").length, 9);
  assert.equal(
    result.requests.filter((r) => r.method === "session/list").length,
    6,
  );
  assert.equal(
    result.initializations.filter((r) => r.agentAccessDenied).length,
    8,
  );
  assert.deepEqual(f, before);
});
for (const [name, mutate] of [
  [
    "missing connection",
    (f) => {
      f.connections.pop();
    },
  ],
  [
    "unjoined connection",
    (f) => {
      f.connections[0].closed = false;
    },
  ],
  [
    "unarchived failure",
    (f) => {
      f.connections[0].evidence_errors.push("write failed");
    },
  ],
  [
    "reused connection",
    (f) => {
      f.connections[1].connectionTraceID = f.connections[0].connectionTraceID;
    },
  ],
  [
    "missing request metadata",
    (f) => {
      f.observations.pop();
    },
  ],
  [
    "duplicate metadata",
    (f) => {
      f.observations[1] = structuredClone(f.observations[0]);
    },
  ],
  [
    "substituted original metadata",
    (f) => {
      f.observations[0].outcome = "succeeded";
    },
  ],
  [
    "missing original refusal",
    (f) => {
      f.connections[0].raw_frames.pop();
    },
  ],
  [
    "wrong raw refusal",
    (f) => {
      f.connections[0].raw_frames[1].error.data.code = "agent_busy";
    },
  ],
  [
    "changed raw list",
    (f) => {
      const c = f.connections.find((c) => c.purpose === "baseline");
      const row = c.evidence.find((r) => r.method === "session/list");
      c.raw_frames.find((r) => String(r.id) === row.requestId).result.sessions =
        [{ sessionId: "foreign" }];
    },
  ],
  [
    "changed raw replay",
    (f) => {
      const c = f.connections.find((c) => c.purpose === "replay");
      c.raw_frames[1].result = { foreign: true };
    },
  ],
  [
    "changed raw v1 stopReason",
    (f) => {
      const c = f.connections.find(
        (c) => c.purpose === "baseline" && c.version === 1,
      );
      c.raw_frames[2].result.stopReason = "cancelled";
    },
  ],
  [
    "changed raw initialization",
    (f) => {
      f.connections[0].raw_frames[0].result.agentInfo = { name: "foreign" };
    },
  ],
  [
    "missing original list oracle",
    (f) => {
      delete f.observations.find((r) => r.listSnapshot).listSnapshot;
    },
  ],
  [
    "wrong model scope",
    (f) => {
      f.observations.find((r) => r.modelName).modelName = "scope-foreign";
    },
  ],
  [
    "foreign prompt receipt",
    (f) => {
      f.observations.find((r) => r.promptReceipt).promptReceipt.requestId =
        "foreign";
    },
  ],
  [
    "changed prompt input",
    (f) => {
      f.connections.find(
        (c) => c.purpose === "baseline",
      ).evidence[1].requestParams.prompt[0].text = "foreign";
    },
  ],
  [
    "recovery replays another Session",
    (f) => {
      const c = f.connections.find((c) => c.purpose === "replay");
      c.evidence[0].sessionId =
        c.evidence[0].inputSessionID =
        c.evidence[0].requestParams.sessionId =
        c.requests[1].sessionId =
          "foreign-history";
    },
  ],
  [
    "baseline prompt detached from creation",
    (f) => {
      const c = f.connections.find((c) => c.purpose === "baseline"),
        row = c.evidence[1];
      row.sessionId =
        row.inputSessionID =
        row.requestParams.sessionId =
        c.requests[2].sessionId =
          "foreign-run";
      f.observations.find(
        (o) =>
          o.connectionTraceID === c.connectionTraceID &&
          o.requestId === row.requestId,
      ).promptReceipt.sessionId = "foreign-run";
    },
  ],
  [
    "swapped baseline protocol phases",
    (f) => {
      const a = f.connections.find((c) => c.phase === "v1-a"),
        b = f.connections.find((c) => c.phase === "v2-a");
      [a.phase, b.phase] = [b.phase, a.phase];
      for (const c of [a, b]) {
        const row = c.evidence[1];
        row.requestParams.prompt[0].text = c.phase;
        f.observations.find(
          (o) =>
            o.connectionTraceID === c.connectionTraceID &&
            o.requestId === row.requestId,
        ).phase = c.phase;
      }
    },
  ],
  [
    "SCIM recovery replaced by repeated Membership recovery",
    (f) => {
      const original = f.connections.find(
        (c) => c.purpose === "baseline" && c.phase === "v2-b",
      );
      const c = f.connections.find(
        (c) => c.purpose === "replay" && c.phase === "offboard-scim-before-b",
      );
      c.phase = "v2-b";
      c.evidence[0].sessionId =
        c.evidence[0].inputSessionID =
        c.evidence[0].requestParams.sessionId =
        c.requests[1].sessionId =
          original.evidence[0].sessionId;
    },
  ],
])
  test("Agent access inventory refuses " + name, () => {
    const f = fixture();
    index(f);
    mutate(f);
    assert.throws(() => index(f));
  });
test("Agent access list expectation uses the complete original Organization/User/Agent oracle", () => {
  const f = fixture();
  const row = f.observations.find((r) => r.listSnapshot),
    own = row.listSnapshot[0];
  row.listSnapshot.push(
    ...[
      { ...own, id: "other-user", principal_id: "other" },
      { ...own, id: "other-agent", agent_id: "other" },
      { ...own, id: "deleted", state: "deleted" },
      { ...own, id: "closed", state: "closed" },
    ],
  );
  const result = index(f).requests.find(
    (r) =>
      r.connectionTraceID === row.connectionTraceID &&
      r.requestId === row.requestId,
  );
  assert.deepEqual(result.listSessionIds.sort(), [own.id, "closed"].sort());
});
