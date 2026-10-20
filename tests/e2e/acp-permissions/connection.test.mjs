import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { commandFixture, setup } from "../acp-commands/connection.fixture.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { capturePermissionConnection } from "./client-evidence.mjs";
const { inspectPrivateNotificationReceipt } =
  await import("../identity-closeout/acp-connection.mjs");

const url = new URL("./connection.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const profiles = [1, 2].map((version) => ({ name: `v${version}-ws`, version }));
const within = (task) =>
  Promise.race([
    task,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("permission fixture deadline")),
        2500,
      );
      timer.unref();
      void task.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer),
      );
    }),
  ]);
function permission(version) {
  const toolCall = {
    toolCallId: `permission-tool-v${version}`,
    title: "Write workspace file",
    status: "pending",
    rawInput: { path: "/workspace/permission.txt", content: "private input" },
  };
  return {
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
    ],
    ...(version === 1
      ? { toolCall }
      : {
          title: "Allow write?",
          subject: { type: "tool_call", toolCall },
        }),
  };
}
const prompt = (client, sessionId) =>
  client.request("prompt", {
    sessionId,
    prompt: [{ type: "text", text: "permission phase" }],
  });
const observe = (task) =>
  task.then(
    (result) => ({ result }),
    (error) => ({ error }),
  );

async function fixture(t, profile, peer = {}) {
  assert.equal(
    typeof implementation.openPrivatePermissionConnection,
    "function",
    "Permissions private connection required",
  );
  const f = await commandFixture(t, profile, peer);
  return {
    ...f,
    open: async () =>
      f.register(
        await implementation.openPrivatePermissionConnection(
          profile.version,
          "agent",
          f.browser,
          f.options,
        ),
      ),
  };
}

for (const profile of profiles) {
  test(`${profile.name}: Permissions inventories initialize, new, mode/model and replay from actual requests`, async (t) => {
    const f = await fixture(t, profile, {
      setConfigOption: ({ params }) => ({
        configOptions: [
          {
            [profile.version === 1 ? "id" : "configId"]: params.configId,
            name: params.configId,
            type: "select",
            currentValue: params.value,
            options: [{ value: params.value, name: params.value }],
          },
        ],
      }),
    });
    const client = await f.open();
    const { sessionId } = await client.request("new", setup);
    for (const [configId, value] of [
      ["mode", "approve"],
      ["model", "profile:alternate"],
    ]) {
      const params = {
        sessionId,
        configId,
        value,
        ...(profile.version === 2 ? { type: "id" } : {}),
      };
      const result = await client.request("setConfigOption", params);
      assert.equal(result.configOptions[0].currentValue, value);
      params.value = "mutated after request";
      assert.equal(client.lastRequest.requestReceipt.params.value, value);
      assert.equal(client.lastRequest.requestParams.value, value);
    }
    await client.request(profile.version === 1 ? "load" : "resume", {
      ...setup,
      sessionId,
      ...(profile.version === 2 ? { replayFrom: { type: "start" } } : {}),
    });
    assert.deepEqual(
      client.requestEvidence.map((row) => row.method),
      [
        "session/new",
        "session/set_config_option",
        "session/set_config_option",
        profile.version === 1 ? "session/load" : "session/resume",
      ],
    );
    const inventory = [client.initializationRequest, ...client.requestEvidence];
    assert.equal(inventory.length, client.requests.length);
    assert.equal(new Set(inventory.map((row) => row.requestId)).size, 5);
    for (const [index, row] of inventory.entries()) {
      assert.equal(row.boundary, "private-acp");
      assert.equal(row.transport, "websocket");
      assert.equal(row.agentId, "agent");
      assert.equal(row.protocolVersion, profile.version);
      assert.equal(row.connectionTraceID, client.connectionTraceID);
      assert.equal(row.clientSpanID, client.clientSpanID);
      assert.equal(row.requestId, client.requests[index].requestId);
      assert.equal(row.method, client.requests[index].method);
      assert.equal(row.outcome, "succeeded");
    }
    assert.equal(inventory[0].inputSessionID, null);
    assert.equal(inventory[1].inputSessionID, null);
    assert.equal(inventory[1].sessionId, sessionId);
    for (const [index, row] of client.requestEvidence.entries())
      assert.deepEqual(row.requestParams, f.calls[index + 1].params);
    assert.deepEqual(
      inventory[0].initializationResult,
      client.initializationResult,
    );
    inventory[1].sessionId = "foreign";
    assert.equal(client.requestEvidence[0].sessionId, sessionId);
    assert.equal(f.identities.length, 1);
    assert.equal(f.wire[0].headers.cookie, undefined);
    await client.closeAndWait();
  });

  test(`${profile.name}: Permissions decisions retain original Session, Tool, parameters and actual delivery identity`, async (t) => {
    const request = permission(profile.version);
    const f = await fixture(t, profile, { permissionRequest: request });
    const client = await f.open();
    const { sessionId } = await client.request("new", setup);
    const prompting = observe(prompt(client, sessionId));
    try {
      await within(
        Promise.race([
          until(
            () => client.pendingPermissions.length === 1,
            "permission delivery",
            2000,
          ),
          prompting,
        ]),
      );
      assert.equal(client.pendingPermissions.length, 1);
      const entry = client.pendingPermissions[0];
      assert.deepEqual(entry.params, { ...request, sessionId });
      const snapshot = client.permissionEvidence;
      const wire = client.rawFrames.filter(
        (frame) => frame.method === "session/request_permission",
      );
      assert.equal(wire.length, 1);
      assert.equal(snapshot[0].requestId, String(wire[0].id));
      assert.deepEqual(snapshot[0].params, wire[0].params);
      assert.equal(snapshot[0].outcome, "pending");
      entry.params.sessionId = "mutated";
      entry.params.options.push({ optionId: "unoffered" });
      assert.throws(() => entry.answer("unoffered"), /option/);
      assert.equal(client.pendingPermissions[0].params.sessionId, sessionId);
      await turn();
      assert.equal(f.permissionOutcomes.length, 0);
      entry.answer("allow_once");
      assert.throws(() => entry.answer("reject_once"), /settled/);
      assert.equal(client.pendingPermissions.length, 0);
      const outcome = await within(prompting);
      assert.deepEqual(
        client.lastRequest.requestParams,
        f.calls.find((call) => call.method === "session/prompt").params,
      );
      assert.equal(outcome.error, undefined);
      assert.deepEqual(f.permissionOutcomes, [
        {
          result: {
            outcome: { outcome: "selected", optionId: "allow_once" },
          },
        },
      ]);
      assert.equal(client.permissionEvidence[0].outcome, "selected");
      assert.equal(client.permissionEvidence[0].optionId, "allow_once");
      assert.equal(snapshot[0].outcome, "pending", "snapshot must not mutate");
    } finally {
      await client.closeAndWait();
      await prompting;
    }
  });

  test(`${profile.name}: cancel receipt and ordinary close join the pending approval without replay success`, async (t) => {
    const f = await fixture(t, profile, {
      permissionRequest: permission(profile.version),
    });
    const client = await f.open();
    const { sessionId } = await client.request("new", setup);
    const prompting = observe(prompt(client, sessionId));
    try {
      await until(
        () => client.pendingPermissions.length === 1,
        "pending permission",
        2000,
      );
      const entry = client.pendingPermissions[0];
      await client.notify("cancel", { sessionId });
      await until(
        () => f.calls.some((call) => call.method === "session/cancel"),
        "cancel on peer",
        2000,
      );
      const closing = client.closeAndWait();
      assert.strictEqual(client.closeAndWait(), closing);
      await within(closing);
      assert.equal(client.pendingPermissions.length, 0);
      assert.equal(client.permissionEvidence[0].outcome, "cancelled");
      assert.throws(() => entry.answer("allow_once"), /settled/);
      assert.equal(
        client.isLocalCloseError((await within(prompting)).error),
        true,
      );
      assert.equal(client.lastRequest.outcome, "failed");
      assert.equal(client.lastRequest.closedBeforeResponse, undefined);
      assert.equal(
        inspectPrivateNotificationReceipt(client.lastNotification).sessionId,
        sessionId,
      );
      const captured = await capturePermissionConnection({
        client,
        version: profile.version,
        agentId: "agent",
        role: "owner",
      });
      assert.equal(
        inspectPrivateNotificationReceipt(captured.notifications[0]).sessionId,
        sessionId,
      );
      assert.deepEqual(captured.evidence, client.requestEvidence);
      assert.deepEqual(captured.permissions, client.permissionEvidence);
      await until(
        () => f.permissionPending() === 0 && f.sockets.clients.size === 0,
        "permission peer joined",
        2000,
      );
    } finally {
      await client.closeAndWait();
      await prompting;
    }
  });

  test(`${profile.name}: replay disconnect distinguishes original v1 close from the completed v2 prompt`, async (t) => {
    const f = await fixture(t, profile, {
      permissionRequest: permission(profile.version),
      permissionPromptResponseEarly: profile.version === 2,
    });
    const client = await f.open();
    const { sessionId } = await client.request("new", setup);
    const prompting = observe(prompt(client, sessionId));
    try {
      await until(
        () => client.pendingPermissions.length === 1,
        "pending replay approval",
        2000,
      );
      if (profile.version === 2)
        assert.ok((await within(prompting)).result.messageId);
      await within(client.disconnectForReplay());
      const outcome = await within(prompting);
      assert.deepEqual(
        client.lastRequest.requestParams,
        f.calls.find((call) => call.method === "session/prompt").params,
      );
      if (profile.version === 1) {
        assert.equal(client.isLocalCloseError(outcome.error), true);
        assert.equal(
          client.isLocalCloseError(new Error(outcome.error.message)),
          false,
        );
        assert.equal(client.lastRequest.closedBeforeResponse, true);
        assert.equal(client.lastRequest.outcome, "failed");
      } else {
        assert.equal(outcome.error, undefined);
        assert.equal(client.lastRequest.closedBeforeResponse, undefined);
        assert.equal(client.lastRequest.outcome, "succeeded");
        assert.deepEqual(
          client.lastRequest.requestReceipt.result,
          outcome.result,
        );
      }
      assert.equal(client.pendingPermissions.length, 0);
      assert.equal(client.permissionEvidence[0].params.sessionId, sessionId);
      assert.equal(client.permissionEvidence[0].outcome, "cancelled");
      await until(
        () => f.permissionPending() === 0,
        "replay peer request joined",
        2000,
      );
    } finally {
      await client.closeAndWait();
      await prompting;
    }
  });

  test(`${profile.name}: Permissions retains the exact foreign-owner rejection and no successful Session`, async (t) => {
    const f = await fixture(t, profile, { denyNew: true });
    const client = await f.open();
    const result = await observe(client.request("new", setup));
    assert.equal(result.error.code, -32020);
    assert.deepEqual(result.error.data, {
      code: "access_denied",
      retryable: false,
    });
    assert.equal(client.lastRequest.outcome, "rejected");
    assert.equal(client.lastRequest.rejection, "access_denied");
    assert.deepEqual(client.lastRequest.rejectionReceipt, {
      rpcCode: -32020,
      code: "access_denied",
      retryable: false,
    });
    assert.equal(client.lastRequest.sessionId, undefined);
    assert.equal(client.lastRequest.requestReceipt, undefined);
    assert.deepEqual(client.lastRequest.requestParams, setup);
    assert.deepEqual(client.updates, []);
    assert.deepEqual(client.permissionEvidence, []);
    await client.closeAndWait();
  });

  test(`${profile.name}: a real peer failure cannot be swallowed as a reconnect`, async (t) => {
    const f = await fixture(t, profile, { barrierPrompt: true });
    const client = await f.open();
    const { sessionId } = await client.request("new", setup);
    const result = await observe(prompt(client, sessionId));
    assert.equal(result.error.data.code, "runtime_barrier_required");
    assert.equal(client.isLocalCloseError(result.error), false);
    await assert.rejects(client.disconnectForReplay(), /pending approval/);
    assert.equal(client.lastRequest.outcome, "failed");
    assert.equal(client.lastRequest.closedBeforeResponse, undefined);
    await client.closeAndWait();
  });

  test(`${profile.name}: overlapping business requests cannot replace the held approval identity`, async (t) => {
    const f = await fixture(t, profile, {
      permissionRequest: permission(profile.version),
      permissionPromptResponseEarly: profile.version === 2,
    });
    const client = await f.open();
    const { sessionId } = await client.request("new", setup);
    const prompting = observe(prompt(client, sessionId));
    try {
      await until(
        () => client.pendingPermissions.length === 1,
        "held approval",
        2000,
      );
      if (profile.version === 2) {
        assert.ok((await within(prompting)).result.messageId);
        assert.equal(client.pendingPermissions.length, 1);
        assert.deepEqual(
          client.updates,
          [],
          "pending approval is not terminal",
        );
      }
      await assert.rejects(
        client.request("setConfigOption", {
          sessionId,
          configId: "mode",
          value: "chat",
          ...(profile.version === 2 ? { type: "id" } : {}),
        }),
        /overlap/,
      );
      assert.equal(
        f.calls.some((call) => call.method === "session/set_config_option"),
        false,
      );
      client.pendingPermissions[0].answer("reject_once");
      assert.equal((await within(prompting)).error, undefined);
      assert.equal(client.lastRequest.method, "session/prompt");
      assert.equal(client.lastRequest.sessionId, sessionId);
    } finally {
      await client.closeAndWait();
      await prompting;
    }
  });
}

test("v1: an already replied prompt cannot acquire an unanswered replay receipt", async (t) => {
  const f = await fixture(t, profiles[0], {
    permissionRequest: permission(1),
    permissionPromptResponseEarly: true,
  });
  const client = await f.open();
  const { sessionId } = await client.request("new", setup);
  const result = await prompt(client, sessionId);
  assert.equal(result.stopReason, "end_turn");
  await until(
    () => client.pendingPermissions.length === 1,
    "already replied approval",
    2000,
  );
  await assert.rejects(client.disconnectForReplay(), /unanswered/);
  assert.equal(client.lastRequest.outcome, "succeeded");
  assert.equal(client.lastRequest.closedBeforeResponse, undefined);
  await client.closeAndWait();
});
