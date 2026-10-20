import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { commandFixture, setup } from "./connection.fixture.mjs";
import { until } from "../acp-closeout/wait.mjs";

const { openPrivateCommandConnection } = await import("./connection.mjs");
const { connectACP } = await import("../identity-closeout/acp-connection.mjs");
const profiles = [
  { name: "v1-ws", version: 1 },
  { name: "v2-ws", version: 2 },
];
const open = async (f, profile, options = {}) =>
  f.register(
    await openPrivateCommandConnection(profile, "agent", f.browser, {
      ...f.options,
      ...options,
    }),
  );

for (const profile of profiles) {
  test(`${profile.name}: opt-in notification evidence uses original no-ID frames and actual private connection`, async (t) => {
    const f = await commandFixture(t, profile);
    const client = await open(f, profile, { captureNotifications: true });
    const frames = [];
    const [peer] = f.sockets.clients;
    peer.on("message", (bytes) => frames.push(JSON.parse(bytes.toString())));
    const params = {
      sessionId: "original",
      _meta: { canary: "PRIVATE-NOTIFICATION-PARAMS" },
    };
    const sending = client.notify("cancel", params);
    params.sessionId = "mutated";
    assert.equal(await sending, undefined);
    await until(
      () =>
        frames.length === 1 &&
        f.calls.some(({ method }) => method === "session/cancel"),
      "actual peer cancellation notification",
      2000,
    );
    assert.equal(Object.hasOwn(frames[0], "id"), false);
    assert.equal(frames[0].method, "session/cancel");
    assert.equal(frames[0].params.sessionId, "original");
    assert.equal(frames[0].params._meta.canary, "PRIVATE-NOTIFICATION-PARAMS");
    assert.deepEqual(client.notifications, [
      {
        agentId: "agent",
        version: profile.version,
        connectionTraceID: client.connectionTraceID,
        clientSpanID: client.clientSpanID,
        index: 0,
        method: "session/cancel",
        sessionId: "original",
        origin: "notify",
        status: "write_completed",
        wireObserved: true,
        writeOutcome: "completed",
      },
    ]);
    assert.deepEqual(client.lastNotification, client.notifications[0]);
    assert.throws(() => {
      client.notifications[0].status = "wrong";
    }, TypeError);
    assert.throws(() => {
      client.lastNotification = {};
    }, TypeError);
    assert.equal(
      client.requests.length,
      1,
      "notification must not invent a request ID or an extra initialize",
    );
    await client.closeAndWait();
    await f.telemetry.flush();
    assert(!JSON.stringify(client.notifications).includes("PRIVATE"));
    assert(!JSON.stringify(f.exports).includes("PRIVATE-NOTIFICATION-PARAMS"));
  });

  test(`${profile.name}: cancellation writes while the actual SDK prompt response is still pending`, async (t) => {
    const f = await commandFixture(t, profile, { holdPrompt: true });
    const client = await open(f, profile, { captureNotifications: true });
    const { sessionId } = await client.request("new", setup);
    let finished = false;
    const prompt = client
      .request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: "held" }],
      })
      .finally(() => {
        finished = true;
      });
    void prompt.catch(() => {});
    try {
      await f.promptStarted;
      await client.notify("cancel", { sessionId });
      await until(
        () => f.calls.some(({ method }) => method === "session/cancel"),
        "peer cancellation while prompt pending",
        2000,
      );
      assert.equal(finished, false);
      assert.equal(client.lastNotification.status, "write_completed");
      f.releasePrompt();
      await prompt;
      await client.closeAndWait();
    } finally {
      f.releasePrompt();
      await prompt.catch(() => {});
    }
  });

  test(`${profile.name}: same-session concurrent notifications keep separate actual frames`, async (t) => {
    const f = await commandFixture(t, profile);
    const client = await open(f, profile, { captureNotifications: true });
    await Promise.all([
      client.notify("cancel", { sessionId: "s" }),
      client.notify("cancel", { sessionId: "s" }),
    ]);
    await until(
      () =>
        f.calls.filter(({ method }) => method === "session/cancel").length ===
        2,
      "two actual notifications",
      2000,
    );
    assert.deepEqual(
      client.notifications.map(({ index, status }) => [index, status]),
      [
        [0, "write_completed"],
        [1, "write_completed"],
      ],
    );
    await client.closeAndWait();
  });

  test(`${profile.name}: closing before queued notifications write joins each rejection`, async (t) => {
    const f = await commandFixture(t, profile);
    const client = await open(f, profile, { captureNotifications: true });
    const sends = [
      client.notify("cancel", { sessionId: "s" }),
      client.notify("cancel", { sessionId: "s" }),
    ];
    const results = Promise.allSettled(sends);
    await assert.rejects(client.closeAndWait());
    assert((await results).every(({ status }) => status === "rejected"));
    assert.equal(client.notifications.length, 2);
    assert(
      client.notifications.every(
        ({ status }) =>
          status === "closed_before_write" || status === "closed_during_write",
      ),
    );
    await assert.rejects(client.notify("cancel", { sessionId: "late" }));
    assert.equal(client.lastNotification.status, "closed_before_write");
  });

  test(`${profile.name}: default notification calls keep the existing API without retaining receipts`, async (t) => {
    const f = await commandFixture(t, profile);
    const client = await open(f, profile);
    assert.equal(await client.notify("cancel", { sessionId: "s" }), undefined);
    assert.equal(client.notifications, undefined);
    assert.equal(client.lastNotification, undefined);
    await client.closeAndWait();
  });

  for (const captureNotifications of ["true", 1, {}])
    test(`${profile.name}: invalid notification capture option fails before Identity delegation`, async (t) => {
      const f = await commandFixture(t, profile);
      await assert.rejects(open(f, profile, { captureNotifications }));
      assert.equal(f.identities.length, 0);
      assert.equal(f.wire.length, 0);
    });
}

test("HTTP notification capture is explicitly unsupported before any Identity or transport call", async (t) => {
  const profile = { name: "v1-http", version: 1, http: true };
  const f = await commandFixture(t, profile);
  await assert.rejects(
    open(f, profile, { captureNotifications: true }),
    /WebSocket/,
  );
  assert.equal(f.identities.length, 0);
  assert.equal(f.wire.length, 0);
});

test("v2 close joins a notification still waiting for SDK initialization", async (t) => {
  const profile = profiles[1];
  const f = await commandFixture(t, profile, { holdInitialize: true });
  const issued = await f.service.workspaceContext(
    f.browser.accessToken,
    "agent",
  );
  const client = f.register(
    connectACP(2, "agent", undefined, {
      boundary: "private-acp",
      endpoint: f.endpoint,
      context: issued.context,
      authorization: f.service.authorization("agent-ui-acp"),
      telemetry: f.telemetry,
      captureNotifications: true,
    }),
  );
  let initialized = false,
    notified = false;
  const initializing = client.initialize().finally(() => {
    initialized = true;
  });
  void initializing.catch(() => {});
  await f.initializeStarted;
  const sent = client.notify("cancel", { sessionId: "s" }).finally(() => {
    notified = true;
  });
  void sent.catch(() => {});
  try {
    await turn();
    assert.equal(
      initialized,
      false,
      "actual initialize reply must still be held",
    );
    assert.equal(
      notified,
      false,
      "notification must be waiting, not rejected before initialize",
    );
    assert.equal(client.notifications[0].status, "queued");
    assert.equal(client.notifications[0].wireObserved, false);
    await assert.rejects(client.closeAndWait());
    await assert.rejects(initializing);
    await assert.rejects(sent);
    assert.equal(client.notifications.length, 1);
    assert.equal(client.notifications[0].status, "closed_before_write");
    assert.equal(client.notifications[0].wireObserved, false);
  } finally {
    f.releaseInitialize();
    await Promise.allSettled([initializing, sent]);
  }
});
