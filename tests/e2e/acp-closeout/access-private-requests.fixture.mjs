import { admissionErrorReceipt } from "../../support/acp-errors.mjs";

const clone = (v) => structuredClone(v);
export function closeoutRequestFixture() {
  const connections = [],
    observations = [],
    localProbes = [],
    sessions = [];
  function connection(
    version,
    purpose,
    role,
    user = role === "foreign" ? "foreign" : "owner",
  ) {
    const n = connections.length + 1,
      agent = role === "restored" ? "owner" : role;
    const c = {
      version,
      purpose,
      phase: `v${version}-${role}`,
      label: `connection-${n}`,
      agentId: `agent-${agent}`,
      principal: { organization_id: "organization", user_id: user },
      connectionTraceID: n.toString(16).padStart(32, "0"),
      clientSpanID: n.toString(16).padStart(16, "0"),
      closed: true,
      evidence_errors: [],
      evidence: [],
      requests: [],
      raw_frames: [],
      updates: [],
    };
    const identity = (method, params = {}) => ({
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
    const initializationResult = {
      protocolVersion: version,
      _meta: { "antnest.dev/errors": { version: 1 } },
    };
    c.initialization = {
      ...identity("initialize"),
      outcome: "succeeded",
      initializationResult,
    };
    c.requests.push({ requestId: "1", method: "initialize" });
    c.raw_frames.push({ id: 1, result: clone(initializationResult) });
    connections.push(c);
    function request(name, session, scope) {
      const denied = purpose === "denied-agent" || scope !== undefined;
      const params =
        name === "list"
          ? {}
          : {
              ...(session ? { sessionId: session } : {}),
              ...(name === "prompt" && !denied
                ? {}
                : { cwd: "/workspace", mcpServers: [] }),
              ...(name === "prompt"
                ? {
                    prompt: [
                      { type: "text", text: denied ? "unauthorized" : c.phase },
                    ],
                  }
                : {}),
              ...(name === "resume" ? { replayFrom: { type: "start" } } : {}),
            };
      const row = {
        ...identity(`session/${name}`, params),
        requestParams: params,
        outcome: denied ? "failed" : "succeeded",
        sessionId: session,
      };
      const note = {
        connectionTraceID: c.connectionTraceID,
        requestId: row.requestId,
      };
      if (denied) {
        const code = scope ? "session_access_denied" : "access_denied";
        const rejection = admissionErrorReceipt(code);
        Object.assign(row, {
          failure: rejection.message,
          failureCode: rejection.code,
          failureData: clone(rejection.data),
          rejectionReceipt: {
            rpcCode: rejection.code,
            code,
            retryable: rejection.data.retryable,
          },
        });
        if (scope) note.scope = scope;
        c.raw_frames.push({
          id: Number(row.requestId),
          error: {
            code: rejection.code,
            message: rejection.message,
            data: clone(row.failureData),
          },
        });
      } else {
        row.requestResult =
          name === "new"
            ? { sessionId: `session-${n}` }
            : name === "prompt"
              ? version === 1
                ? { stopReason: "end_turn" }
                : { messageId: `message-${n}` }
              : name === "list"
                ? {
                    sessions: sessions
                      .filter(
                        (s) =>
                          s.principal_id === user && s.agent_id === c.agentId,
                      )
                      .map((s) => ({ sessionId: s.id })),
                  }
                : {};
        row.sessionId ??= row.requestResult.sessionId;
        if (name === "new")
          sessions.push({
            id: row.sessionId,
            organization_id: c.principal.organization_id,
            principal_id: user,
            agent_id: c.agentId,
            state: "active",
          });
        if (name === "list") note.listSnapshot = clone(sessions);
        if (name === "prompt")
          Object.assign(note, { phase: c.phase, runId: `run-${n}` });
        c.raw_frames.push({
          id: Number(row.requestId),
          result: clone(row.requestResult),
        });
      }
      c.requests.push({
        requestId: row.requestId,
        method: row.method,
        ...(session ? { sessionId: session } : {}),
      });
      c.evidence.push(row);
      observations.push(note);
      return row.sessionId;
    }
    return { c, request };
  }
  function replay(version, role, session) {
    connection(version, "replay", role).request(
      version === 1 ? "load" : "resume",
      session,
    );
  }
  function baseline(version, role) {
    const f = connection(version, "baseline", role),
      session = f.request("new");
    f.request("prompt", session);
    replay(version, role, session);
    return { ...f, session };
  }
  for (const version of [1, 2]) {
    connection(version, "denied-agent", "owner", "foreign").request("new");
    connection(version, "denied-agent", "foreign", "owner").request("new");
    const a = baseline(version, "owner"),
      b = baseline(version, "peer"),
      other = baseline(version, "foreign");
    for (const [target, source, scope] of [
      [b, a, "Agent"],
      [other, a, "principal"],
      [a, b, "Agent"],
      [a, other, "principal"],
    ]) {
      target.request("list");
      for (const method of [
        version === 1 ? "load" : "resume",
        "fork",
        "close",
        "delete",
        "prompt",
      ])
        target.request(method, source.session, scope);
    }
    for (const f of [a, b])
      localProbes.push({
        connectionTraceID: f.c.connectionTraceID,
        outcome: "rejected",
        failure: "closed connection",
        method: "prompt",
        params: {
          sessionId: f.session,
          prompt: [{ type: "text", text: "revoked-owner" }],
        },
        before: clone(f.c),
        after: clone(f.c),
      });
    replay(version, "foreign", other.session);
    for (const role of ["owner", "peer"])
      connection(version, "denied-agent", role).request("new");
    replay(version, "owner", a.session);
    replay(version, "peer", b.session);
    baseline(version, "restored");
  }
  return { connections, observations, localProbes };
}
