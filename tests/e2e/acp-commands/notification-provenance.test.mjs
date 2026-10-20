import assert from "node:assert/strict";
import test from "node:test";
import { commandFixture } from "./connection.fixture.mjs";
import { createNotificationEvidence } from "./notification-evidence.mjs";

const connections = await import("../identity-closeout/acp-connection.mjs");
const { openPrivateCommandConnection } = await import("./connection.mjs");
const profiles = [
  { name: "v1-ws", version: 1 },
  { name: "v2-ws", version: 2 },
];
function validator() {
  assert.equal(
    typeof connections.inspectPrivateNotificationReceipt,
    "function",
  );
  return connections.inspectPrivateNotificationReceipt;
}
async function fixture(t, profile) {
  const validate = validator();
  const f = await commandFixture(t, profile);
  const client = f.register(
    await openPrivateCommandConnection(profile, "agent", f.browser, {
      ...f.options,
      captureNotifications: true,
    }),
  );
  return { ...f, client, validate };
}

for (const profile of profiles) {
  test(`${profile.name}: only original terminal notification snapshots after actual close authorize trace correlation`, async (t) => {
    const { client, validate } = await fixture(t, profile);
    await client.notify("cancel", { sessionId: "s" });
    const before = client.lastNotification;
    assert.equal(before.status, "write_completed");
    assert.throws(() => validate(before), /closed|terminal/);
    await client.closeAndWait();
    assert.throws(() => validate(before), /closed|terminal/);
    const after = client.lastNotification;
    assert.strictEqual(validate(after), after);
    assert.strictEqual(validate(client.notifications[0]).sessionId, "s");
    for (const forged of [
      structuredClone(after),
      { ...after },
      Object.create(after),
      new Proxy(after, {}),
    ])
      assert.throws(() => validate(forged), /original|receipt/);
  });

  test(`${profile.name}: a later rejected call invalidates earlier snapshots and the complete final inventory`, async (t) => {
    const { client, validate } = await fixture(t, profile);
    await client.notify("cancel", { sessionId: "s" });
    await client.closeAndWait();
    const before = client.lastNotification;
    assert.strictEqual(validate(before), before);
    await assert.rejects(client.notify("cancel", { sessionId: "late" }));
    assert.throws(() => validate(before), /changed|inventory/);
    assert.throws(() => validate(client.notifications[0]), /inventory|failed/);
    assert.throws(() => validate(client.lastNotification), /inventory|failed/);
  });

  test(`${profile.name}: identical notification keys remain ambiguous even if one trace later appears`, async (t) => {
    const { client, validate } = await fixture(t, profile);
    await Promise.all([
      client.notify("cancel", { sessionId: "s" }),
      client.notify("cancel", { sessionId: "s" }),
    ]);
    await client.closeAndWait();
    for (const receipt of client.notifications)
      assert.throws(() => validate(receipt), /ambiguous|duplicate/);
  });

  test(`${profile.name}: separate actual Sessions have independently valid original receipts`, async (t) => {
    const { client, validate } = await fixture(t, profile);
    await Promise.all([
      client.notify("cancel", { sessionId: "a" }),
      client.notify("cancel", { sessionId: "b" }),
    ]);
    await client.closeAndWait();
    for (const receipt of client.notifications)
      assert.strictEqual(validate(receipt), receipt);
  });

  test(`${profile.name}: failed closure cannot authorize an earlier successful write`, async (t) => {
    const { client, sockets, validate } = await fixture(t, profile);
    await client.notify("cancel", { sessionId: "first" });
    const [peer] = sockets.clients;
    peer.terminate();
    await client.waitForClose(2000);
    await assert.rejects(client.notify("cancel", { sessionId: "failed" }));
    await assert.rejects(client.closeAndWait());
    assert.throws(() => validate(client.notifications[0]), /closed|terminal/);
  });
}

test("the public recorder factory cannot mint a private connector receipt", async () => {
  const validate = validator();
  const recorder = createNotificationEvidence({
    agentId: "agent",
    version: 1,
    connectionTraceID: "a".repeat(32),
    clientSpanID: "b".repeat(16),
  });
  await recorder.notify(
    "session/cancel",
    { sessionId: "s" },
    (method, params) =>
      recorder.write({ jsonrpc: "2.0", method, params }, async () => {}),
  );
  recorder.stop();
  await recorder.join();
  const receipt = recorder.snapshot()[0];
  assert.equal(receipt.status, "write_completed");
  assert.throws(() => validate(receipt), /original|receipt/);
});
