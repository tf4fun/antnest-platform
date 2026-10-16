import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { once } from "node:events";
import { commandFixture, principal, setup } from "./connection.fixture.mjs";

const implementation = await import("./connection.mjs");
const profiles = [
  { name: "v1-ws", version: 1 },
  { name: "v2-ws", version: 2 },
  { name: "v1-http", version: 1, http: true },
];
async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("command fixture observation deadline")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function open(fixture, profile, overrides = {}) {
  assert.equal(
    typeof implementation.openPrivateCommandConnection,
    "function",
    "private command connector is required",
  );
  return fixture.register(
    await implementation.openPrivateCommandConnection(
      profile,
      "agent",
      fixture.browser,
      { ...fixture.options, ...overrides },
    ),
  );
}

for (const profile of profiles) {
  for (const supported of [true, false])
    test(`${profile.name}: preserves actual ${supported ? "supported" : "absent and disabled"} initialization capabilities without another RPC`, async (t) => {
      const initializationResult =
        profile.version === 1
          ? {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: supported
                  ? { image: true, audio: true, embeddedContext: true }
                  : { image: false, audio: true },
              },
              agentInfo: { name: "negotiation-peer", version: "71" },
              authMethods: [],
              _meta: { negotiation: `${profile.name}-${supported}` },
            }
          : {
              protocolVersion: 2,
              info: { name: "negotiation-peer", version: "72" },
              capabilities: {
                session: {
                  prompt: supported
                    ? { image: {}, audio: {}, embeddedContext: {} }
                    : { image: null, audio: {} },
                },
              },
              _meta: { negotiation: `${profile.name}-${supported}` },
            };
      const f = await commandFixture(t, profile, { initializationResult });
      const client = await open(f, profile);
      assert.deepEqual(client.initializationResult, initializationResult);
      const retained = client.initializationResult;
      await client.request("new", setup);
      assert.strictEqual(client.initializationResult, retained);
      await client.closeAndWait();
      assert.deepEqual(client.initializationResult, initializationResult);
      assert.deepEqual(
        f.calls.map((call) => call.method),
        ["initialize", "session/new"],
      );
      if (profile.http) {
        const final = client.httpSnapshot();
        assert.equal(final.pendingRequests, 0);
        assert.equal(final.streamJoined, true);
        assert.equal(
          final.requests.filter((item) => item.rpcMethod === "initialize")
            .length,
          1,
        );
      }
    });

  test(`${profile.name}: cancellation before a valid initialize reply preserves the original reason and joins cleanup`, async (t) => {
    const controller = new AbortController();
    const reason = new Error("cancelled at initialize reply");
    const f = await commandFixture(t, profile, {
      beforeInitializeReply: () => controller.abort(reason),
    });
    await assert.rejects(
      open(f, profile, { signal: controller.signal }),
      (error) => error === reason,
    );
    assert.deepEqual(
      f.calls.map((call) => call.method),
      ["initialize"],
    );
    if (profile.http) {
      await within(Promise.all(f.wire.map((item) => item.closed)));
    } else {
      await within(
        Promise.all(
          [...f.sockets.clients].map((socket) => once(socket, "close")),
        ),
      );
      assert.equal(f.sockets.clients.size, 0);
    }
  });

  test(`${profile.name}: business records acquire the final shared connection receipt only after cleanup joins`, async (t) => {
    assert.equal(
      typeof implementation.withPrivateCommandConnection,
      "function",
    );
    const f = await commandFixture(t, profile, { holdDelete: profile.http });
    const client = await open(f, profile),
      records = [];
    let settled = false;
    const pending = implementation.withPrivateCommandConnection(
      client,
      records,
      async () => {
        const { sessionId } = await client.request("new", setup);
        records.push({ ...client.lastRequest, sessionId });
        await client.request("resume", { ...setup, sessionId });
        records.push({ ...client.lastRequest });
        assert(records.every((item) => item.httpConnection === undefined));
        assert.equal(
          f.wire.filter((item) => item.method === "DELETE").length,
          0,
        );
        return sessionId;
      },
    );
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    if (profile.http) {
      try {
        await f.deleteStarted;
        await turn();
        assert.equal(settled, false);
        assert(records.every((item) => item.httpConnection === undefined));
      } finally {
        f.releaseDelete();
      }
    }
    assert.equal(await pending, "session-1");
    assert.equal(records.length, 2);
    if (profile.http) {
      assert(records.every((item) => item.httpConnection.streamJoined));
      assert.deepEqual(records[0].httpConnection, client.httpSnapshot());
      assert.equal(records[0].httpConnection, records[1].httpConnection);
    }
  });
  test(
    `${profile.name}: the original SDK connection owns new, prompts, replay and fork requests`,
    { timeout: 10000 },
    async (t) => {
      const f = await commandFixture(t, profile, {
        holdAck: true,
        holdDelete: true,
      });
      const client = await open(f, profile);
      assert.equal(client.boundary, "private-acp");
      const recorded = [];
      const request = async (name, params) => {
        const result = await client.request(name, params);
        recorded.push(structuredClone(client.lastRequest));
        return result;
      };
      const session = (await request("new", setup)).sessionId;
      for (const text of ["/help", "/帮助"])
        await request("prompt", {
          sessionId: session,
          prompt: [{ type: "text", text }],
        });
      await request(profile.version === 1 ? "load" : "resume", {
        ...setup,
        sessionId: session,
      });
      await request("resume", { ...setup, sessionId: session });
      const fork = (await request("fork", { ...setup, sessionId: session }))
        .sessionId;
      assert.notEqual(fork, session);
      assert.equal(recorded.length, 6);
      assert(
        recorded.every((item) => item.protocolVersion === profile.version),
      );
      assert.equal(new Set(recorded.map((item) => item.requestId)).size, 6);
      assert.equal(recorded[0].inputSessionID, null);
      assert.equal(recorded[5].inputSessionID, session);
      assert.equal(
        recorded[5].sessionId,
        session,
        "caller records the distinct result Session after this input receipt",
      );
      assert(
        recorded.every(
          (item) => item.boundary === "private-acp" && item.agentId === "agent",
        ),
      );
      assert.equal(
        f.calls.filter((call) => call.method === "initialize").length,
        1,
      );
      assert.equal(f.wire.filter((item) => item.method === "DELETE").length, 0);
      assert.equal(client.updates.length, 2);
      if (profile.http) {
        const live = client.httpSnapshot();
        assert.equal(live.closing, false);
        assert(
          live.requests.some(
            (item) => item.method === "GET" && item.bodyOutcome === "pending",
          ),
        );
        const posts = live.requests.filter(
          (item) => item.method === "POST" && item.connectionID,
        );
        assert.equal(posts.length, 6);
        assert(
          posts.every(
            (item) => item.status === 202 && item.bodyOutcome === "pending",
          ),
        );
        assert.equal(new Set(posts.map((item) => item.connectionID)).size, 1);
        for (const expected of recorded) {
          const actual = posts.find(
            (item) => String(item.requestID) === expected.requestId,
          );
          assert.equal(actual.traceID, expected.traceID);
          assert.equal(actual.clientSpanID, expected.clientSpanID);
          assert.equal(actual.rpcMethod, expected.method);
          assert.equal(actual.rpcSessionID, expected.inputSessionID);
        }
      } else {
        assert(
          recorded.every(
            (item) =>
              item.connectionTraceID === client.connectionTraceID &&
              item.clientSpanID === client.clientSpanID,
          ),
        );
        assert.equal(
          f.wire.filter((item) => item.method === "UPGRADE").length,
          1,
        );
      }
      let finished = false;
      const closing = client.closeAndWait();
      assert.strictEqual(client.closeAndWait(), closing);
      void closing.then(() => {
        finished = true;
      });
      if (profile.http) {
        await f.deleteStarted;
        await turn();
        assert.equal(
          finished,
          false,
          "cleanup must await the actual DELETE body",
        );
        f.releaseDelete();
      }
      await closing;
      f.releaseAck();
      await f.telemetry.flush();
      const spans = f.spans();
      if (profile.http) {
        const final = client.httpSnapshot();
        assert.equal(final.pendingRequests, 0);
        assert.equal(final.streamJoined, true);
        assert.deepEqual(final.failures, []);
        assert(
          final.requests.every(
            (item) => item.ended && item.bodyOutcome !== "pending",
          ),
        );
        const deletions = final.requests.filter(
          (item) => item.method === "DELETE",
        );
        assert.equal(deletions.length, 1);
        assert.equal(deletions[0].status, 202);
        assert.equal(deletions[0].bodyOutcome, "eof");
        assert.equal(deletions[0].bytes, Buffer.byteLength("delete-complete"));
        assert.equal(
          final.requests.filter((item) => item.wireStarted).length,
          f.wire.length,
        );
        assert(
          f.identities.length >= f.wire.length,
          "each actual request resolves workspace authority",
        );
        assert(
          final.requests
            .filter((item) => !item.wireStarted)
            .every(
              (item) =>
                item.method === "GET" &&
                item.status === null &&
                item.bodyOutcome === "cancelled",
            ),
          "a Session SSE may be cancelled while resolving, before it reaches the wire",
        );
        assert.equal(
          new Set(f.wire.map((item) => item.headers["antnest-caller-context"]))
            .size,
          f.wire.length,
        );
        assert.equal(spans.length, f.wire.length);
        for (const item of f.wire) {
          const [, trace, span] = item.headers.traceparent.split("-");
          assert(
            spans.some(
              (value) => value.traceId === trace && value.spanId === span,
            ),
          );
        }
      } else {
        assert.equal(f.identities.length, 1);
        assert.equal(spans.length, 1);
        assert.equal(spans[0].traceId, client.connectionTraceID);
        assert.equal(spans[0].spanId, client.clientSpanID);
        await Promise.all(
          [...f.sockets.clients].map((socket) => once(socket, "close")),
        );
        assert.equal(f.sockets.clients.size, 0);
      }
      assert(
        f.wire.every(
          (item) =>
            !item.headers.cookie &&
            !item.headers.origin &&
            !item.headers["x-antnest-csrf-token"],
        ),
      );
      for (const item of f.identities) {
        assert.deepEqual(item.body, {
          access_token: "PRIVATE-COMMAND-ORIGINAL-SESSION",
          profile: "workspace",
          agent_id: "agent",
        });
        assert.equal(item.headers.cookie, undefined);
        assert.equal(
          item.headers["antnest-service-authorization"],
          `Bearer ${"G".repeat(43)}`,
        );
      }
      assert(f.secrets.includes("PRIVATE-COMMAND-ORIGINAL-SESSION"));
      assert(f.secrets.includes("W".repeat(43)));
      for (const request of f.wire)
        assert(f.secrets.includes(request.headers["antnest-caller-context"]));
      for (const secret of f.secrets)
        assert(
          !JSON.stringify({ recorded, exports: f.exports }).includes(secret),
        );
    },
  );

  test(
    `${profile.name}: a foreign user is refused by actual session/new after initialization`,
    { timeout: 10000 },
    async (t) => {
      const f = await commandFixture(t, profile, { denyNew: true });
      const client = await open(f, profile);
      await assert.rejects(
        client.request("new", setup),
        (error) => error.code === -32020 && error.data.code === "access_denied",
      );
      assert.equal(client.lastRequest.method, "session/new");
      assert.equal(client.lastRequest.inputSessionID, null);
      assert.deepEqual(client.lastRequest.rejectionReceipt, {
        rpcCode: -32020,
        code: "access_denied",
        retryable: false,
      });
      assert.deepEqual(
        f.calls.map((call) => call.method),
        ["initialize", "session/new"],
      );
      await client.request("resume", { ...setup, sessionId: "session-other" });
      assert.equal(client.lastRequest.rejectionReceipt, undefined);
      await client.closeAndWait();
    },
  );

  for (const field of ["organization_id", "user_id"])
    test(
      `${profile.name}: changed resolved ${field} cannot send ACP bytes`,
      { timeout: 10000 },
      async (t) => {
        const f = await commandFixture(t, profile, {
          identityPrincipal: () => ({
            ...principal,
            [field]: "PRIVATE-FOREIGN-PRINCIPAL",
          }),
        });
        await assert.rejects(open(f, profile));
        assert.equal(f.identities.length, 1);
        assert.equal(f.wire.length, 0);
        assert.equal(f.calls.length, 0);
      },
    );
}

test("command connection cleanup preserves the original business and close failures", async () => {
  assert.equal(typeof implementation.withPrivateCommandConnection, "function");
  const business = new Error("original business failure"),
    cleanup = new Error("close failed");
  const records = [{}],
    receipt = { streamJoined: true, failures: ["delete"] };
  await assert.rejects(
    implementation.withPrivateCommandConnection(
      {
        transport: "http",
        closeAndWait: async () => {
          throw cleanup;
        },
        httpSnapshot: () => receipt,
      },
      records,
      async () => {
        throw business;
      },
    ),
    (error) => {
      assert.deepEqual(error.errors, [business, cleanup]);
      return true;
    },
  );
  assert.equal(records[0].httpConnection, receipt);
});

test("command resource cleanup attempts every connection before telemetry shutdown and preserves all failures", async () => {
  assert.equal(typeof implementation.withPrivateCommandResources, "function");
  const calls = [],
    business = new Error("business"),
    first = new Error("first close"),
    telemetry = new Error("telemetry");
  const clients = new Set([
    {
      closeAndWait() {
        calls.push("first");
        throw first;
      },
    },
    {
      async closeAndWait() {
        await turn();
        calls.push("second");
      },
    },
  ]);
  await assert.rejects(
    implementation.withPrivateCommandResources(
      clients,
      {
        shutdown() {
          calls.push("telemetry");
          throw telemetry;
        },
      },
      async () => {
        throw business;
      },
    ),
    (error) => {
      assert.deepEqual(error.errors, [business, first, telemetry]);
      return true;
    },
  );
  assert.deepEqual(calls, ["first", "second", "telemetry"]);
  assert.equal(clients.size, 0);
});

test(
  "HTTP authority is checked again for business traffic after initialization",
  { timeout: 10000 },
  async (t) => {
    const profile = profiles[2];
    let changed = false;
    const f = await commandFixture(t, profile, {
      identityPrincipal: () =>
        changed ? { ...principal, user_id: "foreign" } : principal,
    });
    const client = await open(f, profile);
    changed = true;
    await assert.rejects(client.request("new", setup));
    await assert.rejects(client.closeAndWait());
    assert.equal(
      f.calls.filter((call) => call.method === "session/new").length,
      0,
    );
    assert(client.httpSnapshot().failures.length > 0);
  },
);

test(
  "HTTP cleanup failure is retained after a successful business request",
  { timeout: 10000 },
  async (t) => {
    const profile = profiles[2];
    const f = await commandFixture(t, profile, { deleteStatus: 503 });
    const client = await open(f, profile);
    await client.request("new", setup);
    await assert.rejects(client.closeAndWait(), /cleanup failed/);
    assert(
      client
        .httpSnapshot()
        .failures.some((item) => item.phase === "delete_status"),
    );
  },
);

for (const profile of profiles)
  test(
    `${profile.name}: cancelled Identity resolution is joined before open rejects`,
    { timeout: 10000 },
    async (t) => {
      const controller = new AbortController();
      const reason = new Error("command opening cancelled");
      const f = await commandFixture(t, profile, {
        beforeIdentityReply: () => controller.abort(reason),
      });
      await assert.rejects(
        open(f, profile, { signal: controller.signal }),
        (error) => error === reason,
      );
      assert.equal(f.identities.length, 1);
      assert.equal(f.wire.length, 0);
    },
  );

for (const profile of profiles)
  for (const holdIdentity of ["headers", "body"])
    test(
      `${profile.name}: cancelling a held Identity ${holdIdentity} closes its actual response before open settles`,
      { timeout: 10000 },
      async (t) => {
        const controller = new AbortController();
        const reason = new Error(
          "command opening cancelled during actual Identity IO",
        );
        const f = await commandFixture(t, profile, { holdIdentity });
        const opening = open(f, profile, { signal: controller.signal });
        const rejected = assert.rejects(opening, (error) => error === reason);
        void rejected.catch(() => {});
        await f.identityStarted;
        controller.abort(reason);
        let timer;
        try {
          await Promise.race([
            Promise.all([rejected, f.identityClosed]),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Identity IO was not cancelled")),
                500,
              );
            }),
          ]);
          assert.equal(f.wire.length, 0);
        } finally {
          clearTimeout(timer);
          f.releaseIdentity();
          await opening.catch(() => {});
          await rejected.catch(() => {});
        }
      },
    );

for (const profile of profiles)
  test(
    `${profile.name}: refused initialize joins the actual transport and preserves the RPC error`,
    { timeout: 10000 },
    async (t) => {
      const f = await commandFixture(t, profile, {
        initializeError: true,
        holdDelete: true,
      });
      let finished = false;
      const opening = open(f, profile)
        .then(
          () => {
            throw new Error("unexpected initialize acceptance");
          },
          (error) => error,
        )
        .finally(() => {
          finished = true;
        });
      try {
        if (profile.http) {
          await within(f.deleteStarted);
          await turn();
          assert.equal(finished, false, "open must await the held DELETE body");
          f.releaseDelete();
        }
        const error = await within(opening);
        assert.equal(error.code, -32603);
        assert.equal(error.message, "fixture initialize refused");
        assert.deepEqual(
          f.calls.map((item) => item.method),
          ["initialize"],
        );
        if (profile.http) {
          assert.equal(
            f.wire.filter((item) => item.method === "DELETE").length,
            1,
          );
          await within(Promise.all(f.wire.map((item) => item.closed)));
        } else {
          await within(
            Promise.all(
              [...f.sockets.clients].map((socket) => once(socket, "close")),
            ),
          );
          assert.equal(f.sockets.clients.size, 0);
        }
      } finally {
        f.releaseDelete();
        await opening;
      }
    },
  );

test(
  "HTTP refused initialize retains its original error alongside a failed DELETE",
  { timeout: 10000 },
  async (t) => {
    const f = await commandFixture(t, profiles[2], {
      initializeError: true,
      deleteStatus: 503,
    });
    await assert.rejects(open(f, profiles[2]), (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors[0].code, -32603);
      assert.equal(error.errors[0].message, "fixture initialize refused");
      assert.match(error.errors[1].message, /cleanup failed/);
      return true;
    });
    assert.equal(f.wire.filter((item) => item.method === "DELETE").length, 1);
    await within(Promise.all(f.wire.map((item) => item.closed)));
  },
);

test("an unsupported private HTTP protocol fails before resolving credentials", async (t) => {
  const f = await commandFixture(t, profiles[2]);
  await assert.rejects(
    open(f, { version: 2, http: true }),
    /unsupported private command protocol/,
  );
  assert.equal(f.identities.length, 0);
  assert.equal(f.wire.length, 0);
});
