import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFixture, principal, setup } from "./connection.fixture.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";
import { createTraceDiagnostics } from "../../support/trace-diagnostics.mjs";

const implementation = await import("./connection.mjs");
const accessDenied = admissionErrorReceipt("access_denied");
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
  test(`${profile.name}: opt-in raw frames preserve unknown usage fields before the real SDK strips them`, async (t) => {
    const f = await commandFixture(t, profile);
    const client = await open(f, profile, { captureRawFrames: true });
    const { sessionId } = await client.request("new", setup);
    const raw = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 1100,
          size: 64000,
          cost: { amount: 0.01, currency: "USD", source: "estimated" },
          measurement: { pricing: "PRIVATE-RAW-USAGE" },
        },
      },
    };
    f.sendRawFrame(raw);
    await until(
      () => client.updates.length === 1,
      "actual SDK usage update",
      2000,
    );
    assert.equal(client.updates[0].update.measurement, undefined);
    assert.equal(client.updates[0].update.cost.source, undefined);
    assert(Array.isArray(client.rawFrames), "pre-SDK frame inventory required");
    assert.equal(client.rawFrames.length, 3);
    assert.deepEqual(client.rawFrames.at(-1), raw);
    assert.equal(client.rawFrames[0].result.protocolVersion, profile.version);
    assert.equal(client.rawFrames[1].result.sessionId, sessionId);
    const retained = client.rawFrames;
    client.rawFrames.at(-1).params.update.cost.amount = 9;
    assert.equal(client.updates[0].update.cost.amount, 0.01);
    await client.closeAndWait();
    assert.strictEqual(client.rawFrames, retained);
    assert.equal(client.rawFrames.length, 3);
    if (profile.http) {
      assert.equal(client.httpSnapshot().pendingRequests, 0);
      assert.equal(client.httpSnapshot().streamJoined, true);
    }
    await f.telemetry.flush();
    assert(!JSON.stringify(f.exports).includes("PRIVATE-RAW-USAGE"));
  });

  test(`${profile.name}: raw capture keeps the actual JSON-RPC rejection and joins cleanup`, async (t) => {
    const f = await commandFixture(t, profile, { denyNew: true });
    const client = await open(f, profile, { captureRawFrames: true });
    await assert.rejects(
      client.request("new", setup),
      (error) => error.code === accessDenied.code,
    );
    assert(
      Array.isArray(client.rawFrames),
      "raw error frame inventory required",
    );
    assert.equal(client.rawFrames.length, 2);
    const frame = client.rawFrames.at(-1);
    assert.equal(String(frame.id), client.lastRequest.requestId);
    assert.deepEqual(frame.error, accessDenied);
    await client.closeAndWait();
    if (profile.http) assert.equal(client.httpSnapshot().streamJoined, true);
  });

  test(`${profile.name}: the default connection does not retain raw incoming payloads`, async (t) => {
    const f = await commandFixture(t, profile);
    const client = await open(f, profile);
    await client.request("new", setup);
    assert.equal(client.rawFrames, undefined);
    await client.closeAndWait();
  });

  for (const captureRawFrames of ["true", 1, {}])
    test(`${profile.name}: invalid capture option ${JSON.stringify(captureRawFrames)} fails before Identity delegation`, async (t) => {
      const f = await commandFixture(t, profile);
      await assert.rejects(open(f, profile, { captureRawFrames }));
      assert.equal(f.identities.length, 0);
      assert.equal(f.calls.length, 0);
    });

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
              _meta: {
                negotiation: `${profile.name}-${supported}`,
                "antnest.dev/errors": { version: 1 },
              },
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
              _meta: {
                negotiation: `${profile.name}-${supported}`,
                "antnest.dev/errors": { version: 1 },
              },
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

  test(`${profile.name}: raw capture cancellation before a valid initialize reply preserves the original reason and joins cleanup`, async (t) => {
    const controller = new AbortController();
    const reason = new Error("cancelled at initialize reply");
    const f = await commandFixture(t, profile, {
      beforeInitializeReply: () => controller.abort(reason),
    });
    await assert.rejects(
      open(f, profile, { signal: controller.signal, captureRawFrames: true }),
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
        (error) =>
          error.code === accessDenied.code &&
          error.message === accessDenied.message &&
          error.data.code === "access_denied" &&
          error.data.retryable === false,
      );
      assert.equal(client.lastRequest.method, "session/new");
      assert.equal(client.lastRequest.inputSessionID, null);
      assert.deepEqual(client.lastRequest.rejectionReceipt, {
        rpcCode: accessDenied.code,
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

function resourceWarnings(t) {
  const messages = [];
  for (const method of ["warn", "error", "log", "info", "debug"])
    t.mock.method(console, method, (...args) =>
      messages.push({ method, args }),
    );
  return messages;
}

function assertSafeResourceWarnings(messages) {
  for (const { method, args } of messages) {
    assert.equal(method, "warn");
    assert.equal(args.length, 1);
    assert.equal(typeof args[0], "string");
    assert.match(args[0], /telemetry|diagnostic/iu);
    assert(!args[0].includes("PRIVATE-"));
  }
}

test("command resource cleanup attempts every connection before telemetry shutdown and preserves business failures", async (t) => {
  assert.equal(typeof implementation.withPrivateCommandResources, "function");
  const warnings = resourceWarnings(t);
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
      assert.deepEqual(error.errors, [business, first]);
      return true;
    },
  );
  assert.deepEqual(calls, ["first", "second", "telemetry"]);
  assert.equal(clients.size, 0);
  assertSafeResourceWarnings(warnings);
});

test("telemetry failure preserves the original action result and emits only a fixed warning", async (t) => {
  const warnings = resourceWarnings(t);
  const result = { original: "action-result" };
  for (const message of [
    "PRIVATE-FIRST-TELEMETRY",
    "PRIVATE-SECOND-TELEMETRY",
  ]) {
    let shutdowns = 0;
    const returned = await implementation.withPrivateCommandResources(
      new Set(),
      {
        shutdown() {
          shutdowns++;
          throw new Error(message, {
            cause: new Error("PRIVATE-EXPORT-CAUSE"),
          });
        },
      },
      () => Promise.resolve(result),
    );
    assert.strictEqual(returned, result);
    assert.equal(shutdowns, 1);
  }
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].args[0], warnings[1].args[0]);
  assertSafeResourceWarnings(warnings);
});

test("held telemetry shutdown is joined before its warning and original action result return", async (t) => {
  const warnings = resourceWarnings(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const result = { original: "held-action-result" };
  const calls = [];
  let joined = false,
    settled = false;
  const clients = new Set([
    {
      closeAndWait: () => {
        calls.push("client");
        return Promise.resolve();
      },
    },
  ]);
  const pending = implementation.withPrivateCommandResources(
    clients,
    {
      async shutdown() {
        calls.push("shutdown-entered");
        entered.resolve();
        try {
          await release.promise;
          throw new Error("PRIVATE-HELD-TELEMETRY");
        } finally {
          joined = true;
          calls.push("shutdown-joined");
        }
      },
    },
    () => Promise.resolve(result),
  );
  const outcome = pending.then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    },
  );
  try {
    await within(entered.promise);
    await turn();
    assert.equal(settled, false);
    assert.equal(joined, false);
    assert.equal(clients.size, 0);
    assert.deepEqual(calls, ["client", "shutdown-entered"]);
    release.resolve();
    const completed = await within(outcome);
    assert.equal(completed.error, undefined);
    assert.strictEqual(completed.value, result);
    assert.equal(joined, true);
    assert.deepEqual(calls, ["client", "shutdown-entered", "shutdown-joined"]);
    assertSafeResourceWarnings(warnings);
  } finally {
    release.resolve();
    await within(outcome);
  }
});

test("an exhausted diagnostic budget never skips actual telemetry shutdown or later work", async (t) => {
  const warnings = resourceWarnings(t);
  const directory = mkdtempSync(
    join(tmpdir(), "antnest-command-cleanup-diagnostics-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const traceDiagnostics = createTraceDiagnostics({ directory, budgetMs: 0 });
  const calls = [];
  const result = { original: "budget-action-result" };
  const returned = await implementation.withPrivateCommandResources(
    new Set(),
    {
      shutdown() {
        calls.push("shutdown");
        return Promise.reject(new Error("PRIVATE-OVER-BUDGET-TELEMETRY"));
      },
    },
    () => {
      calls.push("action");
      return Promise.resolve(result);
    },
    { traceDiagnostics },
  );
  calls.push("after");
  assert.strictEqual(returned, result);
  assert.deepEqual(calls, ["action", "shutdown", "after"]);
  assert.equal(traceDiagnostics.summary().status, "warning");
  assert.equal(
    traceDiagnostics.summary().checks.at(-1).status,
    "not_collected",
  );
  assertSafeResourceWarnings(warnings);
});

test("the optional diagnostic callback receives the original telemetry error after shutdown", async (t) => {
  const warnings = resourceWarnings(t);
  const failure = new Error("PRIVATE-ORIGINAL-TELEMETRY", {
    cause: { detail: "PRIVATE-ORIGINAL-CAUSE" },
  });
  const result = { original: "diagnostic-action-result" };
  const calls = [];
  let recorded;
  const traceDiagnostics = {
    async run(name, check) {
      calls.push("diagnostic");
      assert.equal(typeof name, "string");
      try {
        await check(new AbortController().signal);
        assert.fail("the telemetry failure was hidden from diagnostics");
      } catch (error) {
        recorded = error;
      }
      return { name, status: "failed" };
    },
  };
  const returned = await implementation.withPrivateCommandResources(
    new Set(),
    {
      shutdown() {
        calls.push("shutdown");
        return Promise.reject(failure);
      },
    },
    () => Promise.resolve(result),
    { traceDiagnostics },
  );
  assert.strictEqual(returned, result);
  assert.strictEqual(recorded, failure);
  assert.deepEqual(calls, ["shutdown", "diagnostic"]);
  assertSafeResourceWarnings(warnings);
});

for (const asynchronous of [false, true])
  test(`a ${asynchronous ? "rejected" : "thrown"} diagnostic recording failure cannot replace business or skip shutdown`, async (t) => {
    const warnings = resourceWarnings(t);
    const result = { original: "recording-action-result" };
    const calls = [];
    const returned = await implementation.withPrivateCommandResources(
      new Set(),
      {
        shutdown() {
          calls.push("shutdown");
          return Promise.reject(new Error("PRIVATE-TELEMETRY-FAILURE"));
        },
      },
      () => Promise.resolve(result),
      {
        traceDiagnostics: {
          run() {
            calls.push("diagnostic");
            const failure = new Error("PRIVATE-DIAGNOSTIC-ARCHIVE-FAILURE");
            if (asynchronous) return Promise.reject(failure);
            throw failure;
          },
        },
      },
    );
    calls.push("after");
    assert.strictEqual(returned, result);
    assert.deepEqual(calls, ["shutdown", "diagnostic", "after"]);
    assertSafeResourceWarnings(warnings);
  });

for (const failing of ["action", "client"])
  test(`the original ${failing} failure remains fatal when telemetry and diagnostic recording also fail`, async (t) => {
    const warnings = resourceWarnings(t);
    const failure = new Error(`original ${failing} failure`);
    const calls = [];
    const clients = new Set([
      {
        closeAndWait() {
          calls.push("first");
          return failing === "client"
            ? Promise.reject(failure)
            : Promise.resolve();
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
            calls.push("shutdown");
            return Promise.reject(new Error("PRIVATE-TELEMETRY-FAILURE"));
          },
        },
        () =>
          failing === "action"
            ? Promise.reject(failure)
            : Promise.resolve("result"),
        {
          traceDiagnostics: {
            run() {
              calls.push("diagnostic");
              throw new Error("PRIVATE-DIAGNOSTIC-FAILURE");
            },
          },
        },
      ),
      (error) => error === failure,
    );
    assert.deepEqual(calls, ["first", "second", "shutdown", "diagnostic"]);
    assert.equal(clients.size, 0);
    assertSafeResourceWarnings(warnings);
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

for (const profile of profiles.filter((value) => !value.http)) {
  const toolCall = {
    toolCallId: `permission-tool-v${profile.version}`,
    title: "Read the selected workspace file",
    status: "pending",
    rawInput: { path: "/workspace/permission.txt" },
  };
  const permissionRequest = {
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
    ],
    ...(profile.version === 1
      ? { toolCall }
      : {
          title: "Allow workspace read?",
          subject: { type: "tool_call", toolCall },
        }),
  };
  const prompt = (client, sessionId) =>
    client.request("prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Ask before reading the workspace file" }],
    });

  test(`${profile.name}: permission callback defaults to cancelled`, async (t) => {
    const f = await commandFixture(t, profile, { permissionRequest });
    const client = await open(f, profile);
    const { sessionId } = await client.request("new", setup);
    await within(prompt(client, sessionId));
    assert.deepEqual(f.permissionRequests, [
      { ...permissionRequest, sessionId },
    ]);
    assert.deepEqual(f.permissionOutcomes, [
      { result: { outcome: { outcome: "cancelled" } } },
    ]);
    assert.equal(f.permissionPending(), 0);
    await client.closeAndWait();
  });

  test(`${profile.name}: permission callback preserves the request and awaits the asynchronous decision`, async (t) => {
    const f = await commandFixture(t, profile, { permissionRequest });
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const received = [];
    const decision = {
      outcome: { outcome: "selected", optionId: "allow_once" },
    };
    const client = await open(f, profile, {
      requestPermission: async (request) => {
        received.push(request);
        entered.resolve();
        await release.promise;
        return decision;
      },
    });
    const { sessionId } = await client.request("new", setup);
    let finished = false;
    const prompting = prompt(client, sessionId)
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      )
      .finally(() => {
        finished = true;
      });
    try {
      await within(Promise.race([entered.promise, prompting]));
      assert.equal(received.length, 1);
      assert.deepEqual(received[0].params, { ...permissionRequest, sessionId });
      assert(received[0].signal instanceof AbortSignal);
      assert.equal(received[0].signal.aborted, false);
      await turn();
      assert.equal(finished, false);
      assert.deepEqual(f.permissionOutcomes, []);
      assert.equal(f.permissionPending(), 1);
      release.resolve();
      assert.ok((await within(prompting)).result);
      assert.deepEqual(f.permissionOutcomes, [{ result: decision }]);
      assert.equal(f.permissionPending(), 0);
    } finally {
      release.resolve();
      await client.closeAndWait();
      await prompting;
    }
  });

  test(`${profile.name}: permission callback rejection stays a failed peer request`, async (t) => {
    const f = await commandFixture(t, profile, { permissionRequest });
    let calls = 0;
    const client = await open(f, profile, {
      requestPermission: async () => {
        calls++;
        await turn();
        throw new Error("permission fixture rejected");
      },
    });
    const { sessionId } = await client.request("new", setup);
    await assert.rejects(within(prompt(client, sessionId)));
    assert.equal(calls, 1);
    assert.equal(f.permissionOutcomes.length, 1);
    assert.ok(f.permissionOutcomes[0].error);
    assert.equal(Object.hasOwn(f.permissionOutcomes[0], "result"), false);
    assert.equal(f.permissionPending(), 0);
    await client.closeAndWait();
  });

  test(`${profile.name}: permission callback receives connection cancellation and joins pending work`, async (t) => {
    const f = await commandFixture(t, profile, { permissionRequest });
    const entered = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    const release = Promise.withResolvers();
    const received = [];
    const client = await open(f, profile, {
      requestPermission: async (request) => {
        received.push(request);
        const abort = () => aborted.resolve();
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
        entered.resolve();
        try {
          await Promise.race([aborted.promise, release.promise]);
        } finally {
          request.signal.removeEventListener("abort", abort);
        }
        return { outcome: { outcome: "cancelled" } };
      },
    });
    const { sessionId } = await client.request("new", setup);
    const prompting = prompt(client, sessionId).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    try {
      await within(Promise.race([entered.promise, prompting]));
      assert.equal(received.length, 1);
      assert.deepEqual(received[0].params, { ...permissionRequest, sessionId });
      assert.equal(received[0].signal.aborted, false);
      assert.equal(f.permissionPending(), 1);
      await within(client.closeAndWait());
      await within(aborted.promise);
      assert.equal(received[0].signal.aborted, true);
      const result = await within(prompting);
      assert.equal(client.isLocalCloseError(result.error), true);
      await until(
        () => f.permissionPending() === 0 && f.sockets.clients.size === 0,
        "permission request and socket close",
        2000,
      );
      assert.equal(f.permissionOutcomes.length, 1);
      assert.ok(f.permissionOutcomes[0].error);
      assert.equal(Object.hasOwn(f.permissionOutcomes[0], "result"), false);
    } finally {
      release.resolve();
      await client.closeAndWait();
      await prompting;
    }
  });
}
