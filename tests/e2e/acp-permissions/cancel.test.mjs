import "../identity-closeout/acp-client-dependencies.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { cancelPermissionPrompt } from "./cancel.mjs";
const { withPrivateCommandConnection } =
  await import("../acp-commands/connection.mjs");

function fixture(version, options = {}) {
  const pending = Promise.withResolvers(),
    notified = Promise.withResolvers();
  const calls = [];
  let closed = false;
  const client = {
    transport: "websocket",
    updates: [],
    pendingPermissions: [],
    request(method, params, timeout) {
      calls.push({ method, params, timeout });
      this.pendingPermissions.push({
        params: {
          sessionId: params.sessionId,
          options: [{ optionId: "allow_once" }],
          toolCall: { rawInput: { path: "cancel.txt" } },
        },
      });
      return pending.promise;
    },
    async notify(method, params) {
      calls.push({ method, params });
      if (Object.hasOwn(options, "error")) pending.reject(options.error);
      else
        pending.resolve(
          version === 1
            ? { stopReason: "cancelled" }
            : { messageId: "actual-ack" },
        );
      if (!options.holdTerminal) terminal();
      notified.resolve();
    },
    async closeAndWait() {
      await Promise.resolve();
      closed = true;
      if (options.cleanupError) throw options.cleanupError;
    },
  };
  function terminal() {
    client.pendingPermissions.length = 0;
    client.updates.push({
      sessionId: "session",
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled",
      },
    });
  }
  return {
    client,
    calls,
    notified: notified.promise,
    terminal,
    closed: () => closed,
  };
}

for (const version of [1, 2]) {
  test(`v${version}: cancellation checks the original request and terminal state before cleanup`, async () => {
    const f = fixture(version);
    await withPrivateCommandConnection(f.client, [], () =>
      cancelPermissionPrompt(f.client, version, "session"),
    );
    assert.deepEqual(f.calls, [
      {
        method: "prompt",
        params: {
          sessionId: "session",
          prompt: [{ type: "text", text: `v${version}-cancel` }],
        },
        timeout: 120000,
      },
      { method: "cancel", params: { sessionId: "session" } },
    ]);
    assert.equal(f.closed(), true);
  });
  for (const error of [
    new Error("original request refusal"),
    { code: "original-rejection" },
  ])
    for (const cleanupFails of [false, true])
      test(`v${version}: preserves ${error instanceof Error ? "Error" : "rejection object"} with cleanup failure=${cleanupFails}`, async () => {
        const cleanupError = new Error("independent cleanup refusal");
        const f = fixture(version, {
          error,
          ...(cleanupFails ? { cleanupError } : {}),
        });
        await assert.rejects(
          withPrivateCommandConnection(f.client, [], () =>
            cancelPermissionPrompt(f.client, version, "session"),
          ),
          (actual) => {
            if (cleanupFails) {
              assert(actual instanceof AggregateError);
              assert.equal(actual.errors.length, 2);
              assert.strictEqual(actual.errors[0], error);
              assert.strictEqual(actual.errors[1], cleanupError);
            } else assert.strictEqual(actual, error);
            return true;
          },
        );
        assert.equal(f.closed(), true);
      });
}

test("v2 cancellation ACK does not complete before its terminal update", async () => {
  const f = fixture(2, { holdTerminal: true });
  let settled = false;
  const operation = withPrivateCommandConnection(f.client, [], () =>
    cancelPermissionPrompt(f.client, 2, "session"),
  ).finally(() => {
    settled = true;
  });
  try {
    await f.notified;
    await turn();
    assert.equal(settled, false);
    assert.equal(f.closed(), false);
  } finally {
    f.terminal();
    await operation;
  }
  assert.equal(f.closed(), true);
});
