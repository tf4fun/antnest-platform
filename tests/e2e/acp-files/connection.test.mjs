import assert from "node:assert/strict";
import test from "node:test";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";
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

for (const version of [1, 2]) {
  test(`File v${version} uses original Identity Principal, real SDK IDs and distinct fork Sessions`, async (t) => {
    const f = await commandFixture(t, { version });
    const client = f.register(
      await required("openPrivateFileConnection")(
        version,
        "agent",
        f.browser,
        f.options,
      ),
    );
    const identity = required("fileRequestIdentity");
    const initial = client.initializationRequest;
    assert.equal(initial.method, "initialize");
    assert.equal(initial.inputSessionID, null);
    assert.equal(initial.sessionId, undefined);
    assert.equal(initial.protocolVersion, version);
    assert.equal(initial.connectionTraceID, client.connectionTraceID);
    assert.equal(initial.clientSpanID, client.clientSpanID);
    assert.equal(f.identities.length, 1);
    const created = await client.request("new", setup);
    const record = identity(client, "session/new", created.sessionId);
    assert.equal(record.inputSessionID, null);
    assert.equal(record.sessionId, "session-1");
    const fork = await client.request("fork", {
      ...setup,
      sessionId: created.sessionId,
    });
    const forkRecord = identity(client, "session/fork", fork.sessionId);
    assert.equal(forkRecord.inputSessionID, created.sessionId);
    assert.equal(forkRecord.sessionId, "session-2");
    assert.notEqual(forkRecord.requestId, record.requestId);
    assert.equal(
      new Set([initial, record, forkRecord].map((item) => item.requestId)).size,
      3,
    );
    for (const item of [initial, record, forkRecord]) {
      assert.equal(item.boundary, "private-acp");
      assert.equal(item.transport, "websocket");
      assert.equal(item.agentId, "agent");
      assert.equal(
        client.requests.filter(
          (actual) =>
            actual.requestId === item.requestId &&
            actual.method === item.method,
        ).length,
        1,
      );
    }
    assert.throws(() => identity(client, "session/load", created.sessionId));
    assert.throws(() => identity(client, "session/fork", created.sessionId));
    await client.closeAndWait();
    await f.telemetry.flush();
    assert(
      f
        .spans()
        .some(
          (span) =>
            span.traceId === client.connectionTraceID &&
            span.spanId === client.clientSpanID,
        ),
    );
  });

  test(`File v${version} retains the actual SDK access denial receipt`, async (t) => {
    const f = await commandFixture(t, { version }, { denyNew: true });
    const client = f.register(
      await required("openPrivateFileConnection")(
        version,
        "agent",
        f.browser,
        f.options,
      ),
    );
    await assert.rejects(client.request("new", setup), (error) => {
      assertAdmissionError(error, "access_denied");
      return true;
    });
    const record = required("fileRequestIdentity")(
      client,
      "session/new",
      undefined,
      { denial: "access_denied" },
    );
    const denied = admissionErrorReceipt("access_denied");
    assert.deepEqual(record.rejectionReceipt, {
      rpcCode: denied.code,
      code: denied.data.code,
      retryable: denied.data.retryable,
    });
    assert.equal(record.inputSessionID, null);
    assert.throws(() =>
      required("fileRequestIdentity")(client, "session/new", undefined, {
        denial: "session_access_denied",
      }),
    );
    await client.closeAndWait();
  });

  test(`File v${version} refuses changed Identity authority before ACP upgrade`, async (t) => {
    const f = await commandFixture(
      t,
      { version },
      {
        identityPrincipal: () => ({
          organization_id: "organization",
          user_id: "foreign",
        }),
      },
    );
    const open = required("openPrivateFileConnection");
    await assert.rejects(
      open(version, "agent", f.browser, f.options),
      /authority changed/u,
    );
    assert.equal(f.wire.length, 0);
  });
}
