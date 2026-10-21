import assert from "node:assert/strict";
import test from "node:test";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";
import {
  stage2ConnectionFixture,
  setup,
} from "./stage2-private-connection.fixture.mjs";
const url = new URL("./stage2-private-connection.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const includesError = (error, original) =>
  error === original ||
  (error.errors ?? []).some((item) => includesError(item, original));
async function open(t, options = {}) {
  assert.equal(typeof implementation.openStage2Connection, "function");
  const f = await stage2ConnectionFixture(t, options);
  const saved = [];
  const client = f.register(
    await implementation.openStage2Connection("agent", f.browser, {
      ...f.options,
      preserve: (snapshot) => saved.push(structuredClone(snapshot)),
      ...options.client,
    }),
  );
  return { ...f, client, saved };
}

test(
  "Stage2 binds concurrent held ACK and busy rejection to their original wire IDs",
  { timeout: 10000 },
  async (t) => {
    const f = await open(t, { holdAck: true }),
      c = f.client;
    const first = (await c.newSession()).sessionId;
    const other = (await c.newSession()).sessionId;
    let settled = false;
    const completion = c.prompt(first).finally(() => {
      settled = true;
    });
    void completion.catch(() => {});
    await f.entered;
    await c.denied(other, ["agent_busy"]);
    assert.equal(settled, false);
    assert(
      f.saved.some((snapshot) =>
        snapshot.evidence.some(
          (row) =>
            row.method === "session/prompt" &&
            row.inputSessionID === first &&
            row.requestId,
        ),
      ),
    );
    f.complete();
    assert.deepEqual(await completion, {
      session_id: first,
      message: "Stage 2 Runtime Tool execution completed.",
    });
    await c.closeAndWait();
    const snapshot = c.snapshot();
    assert.equal(snapshot.closed, true);
    assert.equal(snapshot.version, 2);
    assert.equal(
      snapshot.initialization.initializationResult.protocolVersion,
      2,
    );
    const prompts = snapshot.evidence.filter(
      (row) => row.method === "session/prompt",
    );
    assert.deepEqual(
      prompts.map((row) => [row.inputSessionID, row.outcome]),
      [
        [first, "succeeded"],
        [other, "failed"],
      ],
    );
    assert.equal(new Set(prompts.map((row) => row.requestId)).size, 2);
    for (const row of prompts) {
      const original = f.wire.find((item) => String(item.id) === row.requestId);
      assert.deepEqual(row.requestParams, original.params);
      assert.equal(row.connectionTraceID, snapshot.connectionTraceID);
    }
    assert.equal(
      prompts[0].requestResult.messageId,
      prompts[0].completion.ack.messageId,
    );
    const busy = admissionErrorReceipt("agent_busy");
    assert.deepEqual(prompts[1].rejectionReceipt, {
      rpcCode: busy.code,
      code: "agent_busy",
      retryable: busy.data.retryable,
    });
    const refusal = snapshot.raw_frames.find(
      (frame) => String(frame.id) === prompts[1].requestId,
    );
    assert(refusal, "original busy refusal frame required");
    assertAdmissionError(refusal.error, "agent_busy");
    assert.deepEqual(
      f.identities.map((row) => row.body),
      [
        {
          access_token: f.browser.accessToken,
          profile: "workspace",
          agent_id: "agent",
        },
      ],
    );
    assert.equal(
      f.identities[0].headers["antnest-service-authorization"],
      `Bearer ${"G".repeat(43)}`,
    );
    assert.equal(f.upgrades[0].path, "/v2/acp");
    assert.equal(f.upgrades[0].headers.cookie, undefined);
    assert.equal(f.upgrades[0].headers["x-antnest-user-id"], undefined);
    assert.equal(
      f.upgrades[0].headers["antnest-service-authorization"],
      `Bearer ${"W".repeat(43)}`,
    );
    await f.telemetry.flush();
    const spans = f.exports.flatMap((body) =>
      body.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    assert(
      spans.some(
        (span) =>
          span.traceId === snapshot.connectionTraceID &&
          span.spanId === snapshot.clientSpanID &&
          span.kind === 3,
      ),
    );
  },
);

test(
  "Stage2 preserves the acknowledged request when the actual peer dies before completion",
  { timeout: 10000 },
  async (t) => {
    const f = await open(t),
      c = f.client;
    const session = await c.newSession();
    const completion = c.prompt(session.sessionId);
    void completion.catch(() => {});
    await f.entered;
    f.terminate();
    await assert.rejects(completion, /clos|disconnect|ended/iu);
    await c.closeAndWait();
    const row = c
      .snapshot()
      .evidence.find((item) => item.method === "session/prompt");
    assert.equal(row.outcome, "succeeded");
    assert(row.requestResult.messageId);
    assert.equal(row.completion, undefined);
    assert.match(row.completion_failure, /clos|disconnect|ended/iu);
  },
);

test(
  "Stage2 joins an active completion when the caller closes the connection",
  { timeout: 10000 },
  async (t) => {
    const f = await open(t),
      c = f.client;
    const { sessionId } = await c.newSession();
    const completion = c.prompt(sessionId);
    void completion.catch(() => {});
    await f.entered;
    await c.closeAndWait();
    await assert.rejects(completion, /clos|disconnect|ended/iu);
    assert.equal(c.snapshot().closed, true);
    assert(c.snapshot().evidence.at(-1).completion_failure);
  },
);

test(
  "Stage2 does not turn a successful wire reply into successful evidence after an archive failure",
  { timeout: 10000 },
  async (t) => {
    const original = new Error("Stage2 archive failed");
    let fail = false;
    const f = await open(t, {
      expectedCleanupFailure: true,
      client: {
        preserve() {
          if (fail) throw original;
        },
      },
    });
    fail = true;
    await assert.rejects(f.client.request("new", setup), (error) =>
      includesError(error, original),
    );
    await assert.rejects(f.client.closeAndWait(), (error) =>
      includesError(error, original),
    );
    const snapshot = f.client.snapshot();
    assert.equal(snapshot.closed, true);
    assert.match(snapshot.evidence_errors.join("\n"), /Stage2 archive failed/u);
  },
);
