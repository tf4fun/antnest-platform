import assert from "node:assert/strict";
import test from "node:test";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";
import { setImmediate as turn } from "node:timers/promises";
import { commandFixture, setup } from "../acp-commands/connection.fixture.mjs";
import { caseFor, stepsFor } from "./model.mjs";

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
  test(`Plan v${version} uses original Identity Principal, real SDK IDs and distinct fork Sessions`, async (t) => {
    const f = await commandFixture(t, { version });
    const client = f.register(
      await required("openPrivatePlanConnection")(
        version,
        "agent",
        f.browser,
        f.options,
      ),
    );
    const identity = required("planRequestIdentity");
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

  test(`Plan v${version} retains the actual SDK access denial receipt`, async (t) => {
    const f = await commandFixture(t, { version }, { denyNew: true });
    const client = f.register(
      await required("openPrivatePlanConnection")(
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
    const record = required("planRequestIdentity")(
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
      required("planRequestIdentity")(client, "session/new", undefined, {
        denial: "session_access_denied",
      }),
    );
    await client.closeAndWait();
  });

  test(`Plan v${version} refuses changed Identity authority before ACP upgrade`, async (t) => {
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
    const open = required("openPrivatePlanConnection");
    await assert.rejects(
      open(version, "agent", f.browser, f.options),
      /authority changed/u,
    );
    assert.equal(f.wire.length, 0);
  });
}

function promptFixture(
  version,
  {
    premature,
    missingPlan = false,
    heldClose = false,
    heldPrompt = false,
  } = {},
) {
  const phase = `v${version}-create`,
    sessionId = "session";
  const pending = Promise.withResolvers(),
    closing = Promise.withResolvers(),
    closeStarted = Promise.withResolvers();
  let closes = 0,
    requested = false;
  const client = {
    boundary: "private-acp",
    transport: "websocket",
    version,
    agentId: "agent",
    connectionTraceID: "c".repeat(32),
    clientSpanID: "1".repeat(16),
    updates: [],
    requests: [],
    request(name, params) {
      assert.equal(name, "prompt");
      assert.equal(params.sessionId, sessionId);
      assert.deepEqual(params.prompt, [{ type: "text", text: phase }]);
      requested = true;
      const actual = { method: "session/prompt", requestId: "2", sessionId };
      client.requests.push(actual);
      if (!missingPlan)
        client.updates.push({
          sessionId,
          update:
            version === 1
              ? { sessionUpdate: "plan", entries: caseFor(phase).plans[0] }
              : {
                  sessionUpdate: "plan_update",
                  plan: {
                    type: "items",
                    planId: "current",
                    entries: caseFor(phase).plans[0],
                  },
                },
        });
      if (premature === "reply")
        client.updates.push({
          sessionId,
          update: {
            sessionUpdate:
              version === 1 ? "agent_message_chunk" : "agent_message",
            content: { type: "text", text: "too early" },
          },
        });
      if (premature === "idle")
        client.updates.push({
          sessionId,
          update: {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          },
        });
      if (version === 2 || premature === "response")
        pending.resolve(
          version === 1 ? { stopReason: "end_turn" } : { messageId: "message" },
        );
      return pending.promise.finally(() => {
        client.lastRequest = {
          ...actual,
          boundary: client.boundary,
          transport: client.transport,
          agentId: client.agentId,
          version,
          protocolVersion: version,
          inputSessionID: sessionId,
          connectionTraceID: client.connectionTraceID,
          clientSpanID: client.clientSpanID,
        };
      });
    },
    async closeAndWait() {
      closes++;
      closeStarted.resolve();
      if (!heldPrompt) pending.reject(new Error("prompt connection closed"));
      if (!heldClose) closing.resolve();
      await closing.promise;
    },
  };
  return {
    client,
    phase,
    sessionId,
    pending,
    closing,
    closeStarted: closeStarted.promise,
    get closes() {
      return closes;
    },
    wait: async (predicate, label) => {
      await turn();
      assert(await predicate(), label);
    },
    async release() {
      assert(requested);
      const entries = caseFor(phase).plans[0];
      client.updates.push({
        sessionId,
        update: {
          sessionUpdate: version === 1 ? "tool_call" : "tool_call_update",
          toolCallId: "plan-tool",
          title: "Update plan",
          kind: "other",
          status: "completed",
          rawInput: stepsFor(phase)[0].arguments,
          content: [
            {
              type: "content",
              content: { type: "text", text: "Plan updated." },
            },
          ],
        },
      });
      assert(entries.length > 0);
      client.updates.push({
        sessionId,
        update: {
          sessionUpdate:
            version === 1 ? "agent_message_chunk" : "agent_message",
          content: { type: "text", text: `${phase} verified` },
        },
      });
      if (version === 2)
        client.updates.push({
          sessionId,
          update: {
            sessionUpdate: "state_update",
            state: "idle",
            stopReason: "end_turn",
          },
        });
      pending.resolve({ stopReason: "end_turn" });
    },
  };
}

for (const version of [1, 2]) {
  test(`Plan v${version} releases its model only after the early update and records the completed original Prompt`, async () => {
    const f = promptFixture(version);
    const result = await required("runPlanPrompt")(
      f.client,
      version,
      f.sessionId,
      f.phase,
      { release: f.release, wait: f.wait },
    );
    assert.equal(result.request.requestId, "2");
    assert.equal(result.request.phase, f.phase);
    assert.deepEqual(result.input, [{ type: "text", text: f.phase }]);
    assert.equal(result.request.inputSessionID, f.sessionId);
    assert.equal(result.outcome.plans, 1);
    assert.equal(result.outcome.remote_calls, 0);
    assert.equal(f.closes, 0);
    assert.notEqual(result.updates, f.client.updates);
  });
  for (const premature of version === 1
    ? ["reply", "response"]
    : ["reply", "idle"])
    test(`Plan v${version} refuses a premature ${premature} and joins the original Prompt`, async () => {
      const f = promptFixture(version, { premature });
      let released = false;
      await assert.rejects(
        required("runPlanPrompt")(f.client, version, f.sessionId, f.phase, {
          release: async () => {
            released = true;
          },
          wait: f.wait,
        }),
      );
      assert.equal(released, false);
      assert.equal(f.closes, 1);
      assert.equal(f.client.lastRequest.method, "session/prompt");
    });
}

test("Plan gate failure waits for both connection cleanup and its original pending Prompt", async () => {
  const f = promptFixture(1, { heldClose: true, heldPrompt: true });
  const gateError = new Error("model gate refused");
  let settled = false;
  const pending = required("runPlanPrompt")(f.client, 1, f.sessionId, f.phase, {
    release: async () => {
      throw gateError;
    },
    wait: f.wait,
  });
  const observed = pending
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    await f.closeStarted;
    await turn();
    assert.equal(settled, false);
    f.closing.reject(new Error("close failed"));
    await turn();
    assert.equal(settled, false);
  } finally {
    f.closing.resolve();
    f.pending.reject(new Error("original prompt joined"));
  }
  const result = await observed;
  assert(result.error instanceof AggregateError);
  assert(result.error.errors.includes(gateError));
  assert.equal(result.error.errors.length, 3);
  assert.equal(f.closes, 1);
  assert.equal(f.client.lastRequest.method, "session/prompt");
});

test("Plan missing early update closes and joins the pending Prompt without releasing the model", async () => {
  const f = promptFixture(1, { missingPlan: true });
  let released = false;
  await assert.rejects(
    required("runPlanPrompt")(f.client, 1, f.sessionId, f.phase, {
      release: async () => {
        released = true;
      },
      wait: f.wait,
    }),
  );
  assert.equal(f.closes, 1);
  assert.equal(released, false);
  assert.equal(f.client.lastRequest.method, "session/prompt");
});
