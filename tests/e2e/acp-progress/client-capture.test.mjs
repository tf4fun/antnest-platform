import assert from "node:assert/strict";
import test from "node:test";
import { commandFixture, setup } from "../acp-commands/connection.fixture.mjs";

const { openPrivateProgressConnection } = await import("./connection.mjs");
const { captureProgressConnection } = await import("./client-evidence.mjs");
const { inspectPrivateNotificationReceipt } =
  await import("../identity-closeout/acp-connection.mjs");

for (const version of [1, 2])
  test(`Progress capture joins the real v${version} connector before retaining original notification evidence`, async (t) => {
    const f = await commandFixture(t, { version });
    const client = f.register(
      await openPrivateProgressConnection(
        version,
        "agent",
        f.browser,
        f.options,
      ),
    );
    const { sessionId } = await client.request("new", setup);
    await client.notify("cancel", { sessionId });
    const captured = await captureProgressConnection({
      client,
      phase: `v${version}-bash-cancel`,
      version,
      source: "bash",
      ending: "cancel",
      agentId: "agent",
      sessionId,
      role: "prompt",
    });
    assert.equal(captured.connectionTraceID, client.connectionTraceID);
    assert.equal(captured.clientSpanID, client.clientSpanID);
    assert.deepEqual(captured.requests, client.requests);
    assert.deepEqual(captured.initialization, client.initializationRequest);
    assert.deepEqual(captured.evidence, client.requestEvidence);
    assert.deepEqual(captured.raw_frames, client.rawFrames);
    assert.equal(captured.notifications.length, 1);
    assert.strictEqual(
      inspectPrivateNotificationReceipt(captured.notifications[0]),
      captured.notifications[0],
    );
    assert.throws(() =>
      inspectPrivateNotificationReceipt(
        structuredClone(captured.notifications[0]),
      ),
    );
  });
