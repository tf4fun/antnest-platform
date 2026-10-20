import assert from "node:assert/strict";
import test from "node:test";
const url = new URL("./stage2-trace-credentials.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const session = "ant_api_original_stage2_session",
  context = "original-workspace-cct";
function fixture() {
  return {
    traceID: "a".repeat(32),
    processes: { identity: { serviceName: "identity-service" } },
    spans: [
      {
        spanID: "b".repeat(16),
        processID: "identity",
        operationName: "HTTP POST /rpc/identity/resolve-access-token",
        tags: Object.entries({
          "span.kind": "server",
          "rpc.system.name": "antnest.http-json",
          "rpc.service": "identity",
          "rpc.method": "resolve_access_token",
          "http.request.method": "POST",
          "http.route": "/rpc/identity/resolve-access-token",
          "http.response.status_code": 200,
        }).map(([key, value]) => ({ key, value })),
        logs: [
          {
            fields: [
              { key: "event", value: "antnest.request" },
              {
                key: "antnest.payload.json",
                value: JSON.stringify({
                  access_token: session,
                  profile: "console",
                }),
              },
            ],
          },
        ],
      },
    ],
  };
}
function inspect(trace, sessions = [session]) {
  assert.equal(typeof implementation.assertStage2TraceCredentials, "function");
  return implementation.assertStage2TraceCredentials(trace, {
    secrets: [session, context],
    sessions,
  });
}
test("enabled Identity RPC capture retains only the exact original session in its Resolve request", () => {
  const trace = fixture(),
    before = JSON.stringify(trace);
  inspect(trace);
  assert.equal(JSON.stringify(trace), before);
});
for (const [name, mutate] of [
  [
    "another service",
    (f) => {
      f.processes.identity.serviceName = "agent-acp-service";
    },
  ],
  [
    "another method",
    (f) => {
      f.spans[0].tags.find((v) => v.key === "rpc.method").value = "unrelated";
    },
  ],
  [
    "another route",
    (f) => {
      f.spans[0].tags.find((v) => v.key === "http.route").value =
        "/rpc/identity/unrelated";
    },
  ],
  [
    "response capture",
    (f) => {
      f.spans[0].logs[0].fields[0].value = "antnest.response";
    },
  ],
  [
    "unknown session",
    (f) => {
      f.spans[0].logs[0].fields[1].value = JSON.stringify({
        access_token: "ant_api_unknown",
        profile: "console",
      });
    },
  ],
  [
    "session repeated in another field",
    (f) => {
      f.spans[0].logs[0].fields[1].value = JSON.stringify({
        access_token: session,
        profile: "console",
        extra: session,
      });
    },
  ],
  [
    "context in request",
    (f) => {
      f.spans[0].logs[0].fields[1].value = JSON.stringify({
        access_token: session,
        profile: "console",
        caller_context: context,
      });
    },
  ],
  [
    "duplicate token hiding a context",
    (f) => {
      f.spans[0].logs[0].fields[1].value = `{"access_token":"${context}","access_token":"${session}","profile":"console"}`;
    },
  ],
  [
    "duplicate profile hiding a credential",
    (f) => {
      f.spans[0].logs[0].fields[1].value = `{"access_token":"${session}","profile":"${context}","profile":"console"}`;
    },
  ],
  [
    "duplicate Agent hiding a credential",
    (f) => {
      f.spans[0].logs[0].fields[1].value = `{"access_token":"${session}","profile":"console","agent_id":"${context}","agent_id":"agent"}`;
    },
  ],
  [
    "secret in metadata",
    (f) => {
      f.spans[0].tags.push({ key: "leak", value: session });
    },
  ],
  [
    "duplicate RPC identity",
    (f) => {
      f.spans[0].tags.push({ key: "rpc.method", value: "unrelated" });
    },
  ],
])
  test(`Stage2 capture rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.equal(
      typeof implementation.assertStage2TraceCredentials,
      "function",
    );
    assert.throws(() => inspect(f));
  });
test("an original session must be recorded by the actual login before capture is allowed", () => {
  assert.equal(typeof implementation.assertStage2TraceCredentials, "function");
  assert.throws(() => inspect(fixture(), []));
});
