import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { commandFixture, setup } from "../acp-commands/connection.fixture.mjs";

const url = new URL("./connection.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const required = (name) => {
  assert.equal(typeof implementation[name], "function");
  return implementation[name];
};
const profiles = [
  { name: "v1-ws", version: 1 },
  { name: "v2-ws", version: 2 },
  { name: "v1-http", version: 1, http: true },
];
const initialize = (version) =>
  version === 1
    ? {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: true,
            audio: true,
            embeddedContext: true,
          },
        },
      }
    : {
        protocolVersion: 2,
        info: { name: "native-peer", version: "1" },
        capabilities: {
          session: { prompt: { image: {}, audio: {}, embeddedContext: {} } },
        },
      };
async function open(f, profile) {
  return f.register(
    await required("openPrivateNativeConnection")(
      profile,
      "agent",
      f.browser,
      f.options,
    ),
  );
}

for (const profile of profiles) {
  test(`${profile.name}: native connection keeps one real initialization and distinct wire/fork identities`, async (t) => {
    const initializationResult = initialize(profile.version);
    const f = await commandFixture(t, profile, { initializationResult });
    const client = await open(f, profile);
    const initial = client.initializationRequest;
    assert.deepEqual(client.initializationResult, initializationResult);
    assert.equal(initial.method, "initialize");
    assert.equal(initial.inputSessionID, null);
    assert.equal(initial.sessionId, undefined);
    const { sessionId } = await client.request("new", setup);
    const identity = required("nativeRequestIdentity");
    const created = identity(client, "new", "request", { sessionId });
    assert.equal(created.inputSessionID, null);
    assert.equal(created.sessionId, sessionId);
    const fork = await client.request("fork", { ...setup, sessionId });
    const forked = identity(client, "fork", "request", {
      sessionId: fork.sessionId,
    });
    assert.equal(forked.inputSessionID, sessionId);
    assert.notEqual(forked.sessionId, sessionId);
    assert.equal(
      new Set([initial, created, forked].map((x) => x.requestId)).size,
      3,
    );
    assert.throws(() => identity(client, "fork", "request", { sessionId }));
    const saved = client.lastRequest;
    client.lastRequest = { ...saved, requestId: "borrowed" };
    assert.throws(() =>
      identity(client, "fork", "request", { sessionId: fork.sessionId }),
    );
    client.lastRequest = saved;
    await client.closeAndWait();
    assert.deepEqual(
      f.calls.map((x) => x.method),
      ["initialize", "session/new", "session/fork"],
    );
    assert(f.identities.length >= 1);
    if (profile.http) {
      const actual = client
        .httpSnapshot()
        .requests.filter((r) => r.method === "POST");
      for (const row of [initial, created, forked]) {
        const receipt = actual.find(
          (r) => String(r.requestID) === row.requestId,
        );
        assert.equal(row.traceID, receipt.traceID);
        assert.equal(row.clientSpanID, receipt.clientSpanID);
      }
      assert.equal(client.httpSnapshot().pendingRequests, 0);
      assert.equal(client.httpSnapshot().streamJoined, true);
    }
  });

  for (const capability of ["image", "audio", "embeddedContext"])
    test(`${profile.name}: missing ${capability} refuses native profile after joining the actual initialized connection`, async (t) => {
      const initializationResult = initialize(profile.version);
      const capabilities =
        profile.version === 1
          ? initializationResult.agentCapabilities.promptCapabilities
          : initializationResult.capabilities.session.prompt;
      delete capabilities[capability];
      const f = await commandFixture(t, profile, { initializationResult });
      await assert.rejects(
        async () => open(f, profile),
        new RegExp(`missing ${capability} capability`, "u"),
      );
      assert.deepEqual(
        f.calls.map((x) => x.method),
        ["initialize"],
      );
      if (profile.http) await Promise.all(f.wire.map((item) => item.closed));
      else {
        await Promise.all(
          [...f.sockets.clients].map((socket) => once(socket, "close")),
        );
        assert.equal(f.sockets.clients.size, 0);
      }
    });

  test(`${profile.name}: native access denial retains exact SDK receipt and cannot become successful setup`, async (t) => {
    const f = await commandFixture(t, profile, {
      initializationResult: initialize(profile.version),
      denyNew: true,
    });
    const client = await open(f, profile);
    await assert.rejects(
      client.request("new", setup),
      (error) => error.code === -32020,
    );
    const identity = required("nativeRequestIdentity");
    const denied = identity(client, "denied", "request", {
      rejection: "access_denied",
    });
    assert.deepEqual(denied.rejectionReceipt, {
      rpcCode: -32020,
      code: "access_denied",
      retryable: false,
    });
    assert.equal(denied.inputSessionID, null);
    assert.throws(() => identity(client, "denied"));
    await client.closeAndWait();
  });
}

test("native request inventory distinguishes HTTP initialization before a connection ID is assigned", () => {
  const key = required("nativeRequestKey");
  const requests = [1, 2, 3, 4].map((number) => ({
    transport: "http",
    method: "initialize",
    requestId: "0",
    connectionID: null,
    connectionTraceID: null,
    traceID: number.toString(16).padStart(32, "0"),
  }));
  assert.equal(new Set(requests.map(key)).size, 4);
  assert.equal(
    new Set([...requests, structuredClone(requests[0])].map(key)).size,
    4,
    "the same actual HTTP request must still be recognized as a duplicate",
  );
  assert.equal(
    key({ ...requests[0], connectionID: "assigned-after-initialize" }),
    key(requests[0]),
    "later connection metadata must not change the original request identity",
  );
  assert(requests.every((request) => request.connectionID === null));
});

test("native request inventory scopes WebSocket request IDs to their actual connection", () => {
  const key = required("nativeRequestKey");
  const original = {
    transport: "websocket",
    requestId: "0",
    connectionTraceID: "1".repeat(32),
  };
  const requests = [
    original,
    { ...original, requestId: "1" },
    { ...original, connectionTraceID: "2".repeat(32) },
    {
      transport: "http",
      requestId: "0",
      traceID: original.connectionTraceID,
      connectionID: null,
    },
  ];
  assert.equal(new Set(requests.map(key)).size, 4);
  assert.equal(key(structuredClone(original)), key(original));
});

test("native request inventory rejects missing wire identity instead of substituting a label or connection ID", () => {
  const key = required("nativeRequestKey");
  for (const request of [
    { transport: "http", connectionID: "assigned", requestId: "0" },
    { transport: "websocket", traceID: "1".repeat(32), requestId: "0" },
    { transport: "http", traceID: "", requestId: "0" },
    { transport: "http", traceID: "1".repeat(32), requestId: "" },
    { transport: "other", traceID: "1".repeat(32), requestId: "0" },
  ])
    assert.throws(() => key({ ...request, label: "unique-label" }));
});

function promptClient(version, failed = false) {
  return {
    version,
    lastRequest: {
      method: "session/prompt",
      requestId: "wire-7",
      inputSessionID: "session",
    },
    updates:
      version === 1
        ? []
        : [
            {
              sessionId: "session",
              update: {
                sessionUpdate: "state_update",
                state: "idle",
                stopReason: failed ? "_failed" : "end_turn",
              },
            },
          ],
  };
}
for (const version of [1, 2])
  for (const failed of [false, true])
    test(`native prompt receipt retains actual v${version} ${failed ? "failure" : "success"} response and terminal`, () => {
      const client = promptClient(version, failed);
      const result =
        version === 2
          ? { messageId: "message" }
          : failed
            ? null
            : { stopReason: "end_turn" };
      const error =
        failed && version === 1
          ? {
              code: -32022,
              data: { code: "model_unsupported_content", retryable: false },
            }
          : null;
      const actual = required("nativePromptReceipt")(client, "session", {
        result,
        error,
        failed,
      });
      assert.equal(actual.requestId, "wire-7");
      assert.deepEqual(actual.result, result);
      assert.deepEqual(actual.terminals, client.updates);
      if (error)
        assert.deepEqual(actual.error, {
          rpcCode: -32022,
          code: "model_unsupported_content",
          retryable: false,
        });
      if (result) result.unexpected = true;
      assert.equal(actual.result?.unexpected, undefined);
    });

for (const [label, version, mutate] of [
  [
    "wrong RPC code",
    1,
    (c, o) => {
      o.error.code = -32020;
    },
  ],
  [
    "wrong model code",
    1,
    (c, o) => {
      o.error.data.code = "unknown";
    },
  ],
  [
    "retryable failure",
    1,
    (c, o) => {
      o.error.data.retryable = true;
    },
  ],
  [
    "foreign request Session",
    1,
    (c) => {
      c.lastRequest.inputSessionID = "foreign";
    },
  ],
  [
    "missing message ID",
    2,
    (c, o) => {
      o.result = {};
    },
  ],
  [
    "duplicate terminal",
    2,
    (c) => {
      c.updates.push(structuredClone(c.updates[0]));
    },
  ],
  [
    "foreign terminal",
    2,
    (c) => {
      c.updates[0].sessionId = "foreign";
    },
  ],
  [
    "wrong failed terminal",
    2,
    (c) => {
      c.updates[0].update.stopReason = "end_turn";
    },
  ],
])
  test(`native prompt cannot manufacture success from ${label}`, () => {
    const client = promptClient(version, true);
    const options = {
      failed: true,
      result: version === 1 ? null : { messageId: "message" },
      error:
        version === 1
          ? {
              code: -32022,
              data: { code: "model_unsupported_content", retryable: false },
            }
          : null,
    };
    mutate(client, options);
    assert.throws(() =>
      required("nativePromptReceipt")(client, "session", options),
    );
  });
