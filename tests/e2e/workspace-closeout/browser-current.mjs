import assert from "node:assert/strict";

export const browserPhases = ["write", "read", "attachments", "mobile"].map(
  (x) => `c4-browser-${x}`,
);
export async function createBrowserTemplate(json, image) {
  const provider = await json("/api/admin/provider-connections", {
    status: 201,
    body: {
      provider_key: "deepseek",
      display_name: "Browser controlled Provider",
      base_url: "http://stage3-model:8080/v1",
      credential: { method: "api_key", api_key: "stage3-model-secret" },
      models: [
        {
          display_name: "Browser vision",
          model: {
            model: "stage3-model",
            context_window: 8192,
            max_output_tokens: 1024,
            supports_images: true,
          },
        },
      ],
    },
  });
  const models = (await json("/api/admin/model-profiles")).items.filter(
    (m) => m.provider_connection_id === provider.connection_id,
  );
  assert.equal(models.length, 1);
  assert(models[0].model_profile_id);
  return json("/api/admin/templates", {
    status: 201,
    body: {
      name: "Browser template",
      model_profile_id: models[0].model_profile_id,
      system_prompt: "Synthetic browser acceptance",
      max_model_requests: 8,
      runtime: { image_ref: image },
    },
  });
}
export function browserRecorder(agentId) {
  const sockets = new Map(),
    requests = [];
  const message = (event) => JSON.parse(event.response.payloadData);
  return {
    requests,
    created(event) {
      if (new URL(event.url).pathname === `/api/app/agents/${agentId}/v1/acp`)
        sockets.set(event.requestId, { requests: new Map() });
    },
    handshake(event) {
      const socket = sockets.get(event.requestId);
      if (!socket) return;
      assert.equal(event.response.status, 101);
      const traceID = Object.entries(event.response.headers).find(
        ([k]) => k.toLowerCase() === "x-antnest-trace-id",
      )?.[1];
      assert.match(traceID ?? "", /^[a-f0-9]{32}$/);
      socket.traceID = traceID;
    },
    sent(event) {
      const socket = sockets.get(event.requestId);
      if (!socket) return;
      const frame = message(event);
      if (
        !["session/new", "session/load", "session/prompt"].includes(
          frame.method,
        ) ||
        frame.id === undefined
      )
        return;
      assert(socket.traceID, "actual handshake missing");
      const id = String(frame.id);
      assert(
        !socket.requests.has(id),
        "duplicate request ID on one connection",
      );
      const expected = {
        method: frame.method,
        requestId: id,
        sessionId: frame.params?.sessionId,
        agentId,
        transport: "websocket",
        connectionTraceID: socket.traceID,
        kind: "request",
        label: `browser-${requests.length}-${frame.method}`,
      };
      if (frame.method === "session/prompt") {
        const phase = frame.params.prompt[0]?.text;
        assert(browserPhases.includes(phase));
        expected.phase = phase;
        expected.kind =
          phase.endsWith("write") || phase.endsWith("read")
            ? "ordinary"
            : "browser-no-tool";
        if (phase.endsWith("read")) expected.toolName = "read";
      }
      requests.push(expected);
      socket.requests.set(id, expected);
    },
    received(event) {
      const socket = sockets.get(event.requestId);
      if (!socket) return;
      const frame = message(event);
      if (frame.id === undefined) return;
      const expected = socket.requests.get(String(frame.id));
      if (!expected) return;
      assert(!frame.error, "browser ACP request failed");
      if (expected.method === "session/new") {
        assert(frame.result?.sessionId);
        expected.sessionId = frame.result.sessionId;
      }
    },
  };
}
export function assertBrowserRuns(runs, agent) {
  assert.equal(runs.length, 4);
  const ordered = browserPhases.map((phase) => {
    const matching = runs.filter(
      (r) => r.input[0]?.type === "text" && r.input[0].text === phase,
    );
    assert.equal(matching.length, 1);
    const run = matching[0];
    assert.equal(run.agent_id, agent.agent_id);
    assert.equal(run.state, "completed");
    assert.equal(run.terminal_class, "completed");
    assert.equal(run.executor_state, "quiescent");
    assert.equal(
      run.tool_effect_state,
      phase.endsWith("write") || phase.endsWith("read") ? "settled" : "none",
    );
    assert(agent.executable_execution_revision);
    assert.equal(
      run.execution_snapshot.executionRevision,
      agent.executable_execution_revision,
    );
    return run;
  });
  assert.equal(new Set(ordered.slice(0, 3).map((r) => r.session_id)).size, 1);
  assert.notEqual(ordered[3].session_id, ordered[0].session_id);
  return ordered;
}
