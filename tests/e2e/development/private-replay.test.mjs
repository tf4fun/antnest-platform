import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const url = new URL("./private-replay.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function fixture(t, options = {}) {
  assert.equal(typeof implementation.runDevelopmentReplay, "function");
  const output = mkdtempSync(join(tmpdir(), "antnest-development-replay-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const config = {
    output,
    privateAccess: {},
    agentId: "agent",
    sessionId: "session",
  };
  const events = [],
    browser = { accessToken: "original-session" };
  const principal = { organization_id: "organization", user_id: "owner" };
  const message = { type: "text", text: "retained message" };
  const decoded = {
    events: {
      items: [
        {
          visible: true,
          payload: {
            kind: "user_message",
            messageId: "message",
            content: [message],
          },
        },
      ],
    },
  };
  const binding = {
    boundary: "private-acp",
    transport: "websocket",
    protocolVersion: 1,
    agentId: config.agentId,
    connectionTraceID: "a".repeat(32),
    clientSpanID: "b".repeat(16),
  };
  const initialization = {
    ...binding,
    method: "initialize",
    requestId: "17",
    inputSessionID: null,
    outcome: "succeeded",
    initializationResult: { protocolVersion: 1 },
  };
  const requests = [{ requestId: "17", method: "initialize" }],
    evidence = [];
  let callbacks,
    closed = false;
  const client = {
    requests,
    initializationRequest: initialization,
    requestEvidence: evidence,
    updates: [
      {
        sessionId: "session",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "message",
          content: message,
        },
      },
    ],
    async request(name, params) {
      events.push(name);
      assert.equal(name, "load");
      assert.deepEqual(params, {
        sessionId: "session",
        cwd: "/workspace",
        mcpServers: [],
      });
      if (options.loadError) throw options.loadError;
      requests.push({
        method: "session/load",
        requestId: "29",
        sessionId: "session",
      });
      if (options.extraRequest)
        requests.push({
          method: "session/prompt",
          requestId: "30",
          sessionId: "session",
        });
      evidence.push({
        ...binding,
        method: "session/load",
        requestId: "29",
        inputSessionID: "session",
        sessionId: "session",
        outcome: "succeeded",
        requestParams: structuredClone(params),
        requestResult: {},
      });
      await callbacks.preserveConnection(1, {
        requests,
        evidence,
        closed: false,
      });
      return {};
    },
    async closeAndWait() {
      events.push("connection-close");
      if (options.connectionError) throw options.connectionError;
      closed = true;
      await callbacks.preserveConnection(1, {
        requests,
        evidence,
        closed: true,
      });
    },
  };
  const createAccess = async (actual, values) => {
    assert.equal(actual.evidence, output);
    callbacks = values;
    browser.accessToken = "later-session";
    principal.user_id = "later-owner";
    return {
      async open(id, login, original) {
        events.push("open");
        assert.equal(id, "agent");
        assert.deepEqual(login, { accessToken: "original-session" });
        assert.deepEqual(original, {
          organization_id: "organization",
          user_id: "owner",
        });
        await values.preserveAuthority(
          { operation_id: 1, kind: "connection", index: 1 },
          [{ original: true }],
        );
        return client;
      },
      async collect(receipt) {
        assert(closed, "Trace collection requires a joined connection");
        assert.equal(receipt.kind, "request");
        events.push(receipt.method);
        if (options.traceError) throw options.traceError;
        return {
          trace_id:
            receipt.method === "initialize" ? "c".repeat(32) : "d".repeat(32),
          strict_trace: "passed",
          request_id: receipt.requestId,
        };
      },
      async closeAndWait() {
        events.push("access-close");
        assert(
          !existsSync(join(output, "replay-report.json")),
          "passing report before final close",
        );
        if (options.closeError) throw options.closeError;
      },
    };
  };
  return {
    output,
    events,
    client,
    run: () =>
      implementation.runDevelopmentReplay(
        config,
        {
          browser,
          principal,
          secrets: [],
          decoded,
          files: [],
          before: "[1,2,3,4]",
          counts() {
            assert(closed, "database counts before connection joined");
            events.push("counts");
            return options.after ?? "[1,2,3,4]";
          },
        },
        { createAccess },
      ),
    report: () =>
      JSON.parse(readFileSync(join(output, "private-access.private.json"))),
  };
}

test("Development replay loads once with original authority, joins before counts and traces, and publishes after shutdown", async (t) => {
  const f = fixture(t),
    report = await f.run();
  assert.deepEqual(f.events, [
    "open",
    "load",
    "connection-close",
    "counts",
    "initialize",
    "session/load",
    "access-close",
  ]);
  assert.equal(report.status, "business_and_topology_passed");
  assert.equal(report.history_exact, true);
  assert.deepEqual(report.table_counts, {
    before: [1, 2, 3, 4],
    after: [1, 2, 3, 4],
  });
  assert.equal(report.trace.request_id, "29");
  assert.equal(report.initialization_trace.request_id, "17");
  assert.equal(f.report().closed, true);
  assert.deepEqual(f.report().errors, []);
  assert.equal(f.report().connections[0].closed, true);
  assert.deepEqual(f.report().authorities[0].receipts, [{ original: true }]);
});

for (const [name, change, message] of [
  [
    "extra execution request",
    { extraRequest: true },
    /exactly initialize and session\/load/,
  ],
  ["changed table counts", { after: "[1,3,3,4]" }, /history load created/],
  ["foreign replay Session", {}, /foreign replay/],
])
  test(`Development replay rejects ${name}, preserves failure and closes access`, async (t) => {
    const f = fixture(t, change);
    if (name === "foreign replay Session")
      f.client.updates[0].sessionId = "foreign";
    await assert.rejects(f.run(), message);
    assert.equal(f.events.at(-1), "access-close");
    assert.equal(f.report().closed, true);
    assert(f.report().errors.length > 0);
    assert(!existsSync(join(f.output, "replay-report.json")));
  });

for (const phase of [
  "loadError",
  "connectionError",
  "traceError",
  "closeError",
])
  test(`Development replay retains original ${phase} and never writes a passing report`, async (t) => {
    const original = new Error(phase),
      f = fixture(t, { [phase]: original });
    await assert.rejects(f.run(), (error) => error === original);
    assert.equal(f.events.at(-1), "access-close");
    assert(!existsSync(join(f.output, "replay-report.json")));
    assert(f.report().errors.some((text) => text.includes(phase)));
  });

test("Development replay retains independent business and shutdown errors", async (t) => {
  const original = new Error("load failed"),
    cleanup = new Error("shutdown failed");
  const f = fixture(t, { loadError: original, closeError: cleanup });
  await assert.rejects(f.run(), (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, cleanup]);
    return true;
  });
  assert.equal(f.report().closed, false);
});
