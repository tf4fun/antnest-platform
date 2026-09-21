import assert from "node:assert/strict";
import test from "node:test";
import {
  browserRecorder,
  createBrowserTemplate,
  assertBrowserRuns,
} from "./browser-current.mjs";

test("browser setup uses returned Provider Model identity and immutable Runtime image", async () => {
  const calls = [];
  const json = async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/admin/provider-connections")
      return { connection_id: "provider" };
    if (path === "/api/admin/model-profiles")
      return {
        items: [
          { provider_connection_id: "other", model_profile_id: "wrong" },
          { provider_connection_id: "provider", model_profile_id: "model" },
        ],
      };
    if (path === "/api/admin/templates")
      return { template_id: "template", revision: 3 };
    throw Error("unexpected endpoint");
  };
  assert.equal((await createBrowserTemplate(json, "sha256:image")).revision, 3);
  assert.equal(calls[0].options.body.models[0].model.supports_images, true);
  assert.equal(calls[2].options.body.model_profile_id, "model");
  assert.equal(calls[2].options.body.runtime.image_ref, "sha256:image");
  assert(!JSON.stringify(calls).includes("model_profile_revision_id"));
});
function recorder() {
  const r = browserRecorder("agent");
  r.created({
    requestId: "socket",
    url: "ws://localhost/api/app/agents/agent/v1/acp",
  });
  r.handshake({
    requestId: "socket",
    response: {
      status: 101,
      headers: { "X-Antnest-Trace-Id": "a".repeat(32) },
    },
  });
  return r;
}
test("browser records actual handshake, request and returned Session identity without retaining prompt content", () => {
  const r = recorder();
  r.sent({
    requestId: "socket",
    response: {
      payloadData: JSON.stringify({
        id: 1,
        method: "session/new",
        params: { cwd: "/workspace" },
      }),
    },
  });
  r.received({
    requestId: "socket",
    response: {
      payloadData: JSON.stringify({ id: 1, result: { sessionId: "session" } }),
    },
  });
  assert.deepEqual(r.requests, [
    {
      method: "session/new",
      requestId: "1",
      sessionId: "session",
      agentId: "agent",
      transport: "websocket",
      connectionTraceID: "a".repeat(32),
      kind: "request",
      label: "browser-0-session/new",
    },
  ]);
  const original = structuredClone(r.requests);
  r.received({
    requestId: "socket",
    response: {
      payloadData: JSON.stringify({
        method: "session/update",
        params: { private: "body" },
      }),
    },
  });
  assert.deepEqual(r.requests, original);
});
test("browser refuses fabricated connection identity, duplicate request and malformed JSON", () => {
  for (const response of [
    { status: 101, headers: {} },
    { status: 500, headers: { "x-antnest-trace-id": "a".repeat(32) } },
  ]) {
    const r = browserRecorder("agent");
    r.created({
      requestId: "socket",
      url: "ws://localhost/api/app/agents/agent/v1/acp",
    });
    assert.throws(() => r.handshake({ requestId: "socket", response }));
  }
  const r = recorder(),
    event = {
      requestId: "socket",
      response: {
        payloadData: JSON.stringify({
          id: 2,
          method: "session/load",
          params: { sessionId: "session" },
        }),
      },
    };
  r.sent(event);
  assert.throws(() => r.sent(event));
  assert.throws(() =>
    r.sent({ requestId: "socket", response: { payloadData: "bad" } }),
  );
});
const phases = ["write", "read", "attachments", "mobile"].map(
  (x) => `c4-browser-${x}`,
);
const runs = phases.map((phase, i) => ({
  run_id: `r${i}`,
  agent_id: "agent",
  session_id: i === 3 ? "mobile" : "desktop",
  input: [{ type: "text", text: phase }],
  state: "completed",
  terminal_class: "completed",
  executor_state: "quiescent",
  tool_effect_state: i < 2 ? "settled" : "none",
  execution_snapshot: { executionRevision: "revision" },
}));
test("four browser Runs require exact phases, execution ownership and distinct mobile Session", () => {
  assertBrowserRuns(runs, {
    agent_id: "agent",
    executable_execution_revision: "revision",
  });
  for (const mutate of [
    (r) => r.pop(),
    (r) => (r[0].tool_effect_state = "unknown"),
    (r) => (r[3].session_id = "desktop"),
    (r) => (r[1].execution_snapshot.executionRevision = "foreign"),
    (r) => (r[2].input[0].text = "wrong"),
  ]) {
    const r = structuredClone(runs);
    mutate(r);
    assert.throws(() =>
      assertBrowserRuns(r, {
        agent_id: "agent",
        executable_execution_revision: "revision",
      }),
    );
  }
});
