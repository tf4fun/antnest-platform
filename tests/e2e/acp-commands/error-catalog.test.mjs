import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { commandFixture, setup } from "./connection.fixture.mjs";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";

const implementation = await import("./connection.mjs");
const [v1, v2] = await Promise.all([
  import("@agentclientprotocol/sdk"),
  import("@agentclientprotocol/sdk/experimental/v2"),
]);
const profiles = [
  { name: "v1-http", version: 1, http: true },
  { name: "v2-ws", version: 2 },
  { name: "v1-ws", version: 1 },
];
const rejectionCodes = [
  "access_denied",
  "session_access_denied",
  "unsupported_resource_content",
  "unsupported_audio_content",
];

function initializationResult(profile) {
  return {
    ...(profile.version === 1
      ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
      : {
          protocolVersion: 2,
          info: { name: "error-catalog-peer", version: "1" },
          capabilities: {},
        }),
    _meta: {
      "antnest.dev/errors": { version: 1 },
      fixture: "error-catalog-negotiation",
    },
  };
}

async function open(fixture, profile) {
  return fixture.register(
    await implementation.openPrivateCommandConnection(
      profile,
      "agent",
      fixture.browser,
      { ...fixture.options, captureRawFrames: true },
    ),
  );
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("error-catalog connection cleanup deadline")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertJoined(fixture, profile, client) {
  if (profile.http) {
    await within(
      Promise.all(fixture.wire.flatMap((item) => item.closed ?? [])),
    );
    if (client !== undefined) {
      const final = client.httpSnapshot();
      assert.equal(final.pendingRequests, 0);
      assert.equal(final.streamJoined, true);
      assert.deepEqual(final.failures, []);
    }
  } else {
    await within(
      Promise.all(
        [...fixture.sockets.clients].map((socket) => once(socket, "close")),
      ),
    );
    assert.equal(fixture.sockets.clients.size, 0);
  }
}

for (const profile of profiles) {
  test(
    `${profile.name}: preserves a declared errors v1 capability before session effects`,
    { timeout: 10000 },
    async (t) => {
      const result = initializationResult(profile);
      const fixture = await commandFixture(t, profile, {
        initializationResult: result,
      });
      const client = await open(fixture, profile);
      try {
        assert.deepEqual(client.initializationResult, result);
        assert.deepEqual(
          fixture.calls.map((call) => call.method),
          ["initialize"],
        );
        const session = await client.request("new", setup, 2000);
        assert.equal(session.sessionId, "session-1");
        assert.equal(client.lastRequest.rejectionReceipt, undefined);
        assert.deepEqual(
          fixture.calls.map((call) => call.method),
          ["initialize", "session/new"],
        );
      } finally {
        await client.closeAndWait();
      }
      await assertJoined(fixture, profile, client);
    },
  );

  for (const code of rejectionCodes)
    test(
      `${profile.name}: retains the real SDK ${code} and records its catalog rejection`,
      { timeout: 10000 },
      async (t) => {
        const rejection = admissionErrorReceipt(code);
        const fixture = await commandFixture(t, profile, {
          initializationResult: initializationResult(profile),
          newRejection: rejection,
        });
        const client = await open(fixture, profile);
        try {
          let actual;
          await assert.rejects(client.request("new", setup, 2000), (error) => {
            const sdk = profile.version === 1 ? v1 : v2;
            assert(error instanceof sdk.RequestError);
            assertAdmissionError(error, code);
            actual = error;
            return true;
          });
          assert.equal(client.lastRequest.method, "session/new");
          assert.equal(client.lastRequest.inputSessionID, null);
          assert.equal(client.lastRequest.protocolVersion, profile.version);
          assert.deepEqual(client.lastRequest.rejectionReceipt, {
            rpcCode: rejection.code,
            code,
            retryable: rejection.data.retryable,
          });
          assert.equal(client.rawFrames.length, 2);
          const frame = client.rawFrames.at(-1);
          assert.equal(String(frame.id), client.lastRequest.requestId);
          assertAdmissionError(frame.error, code);
          assert.equal(actual.code, frame.error.code);
          assert.equal(actual.message, frame.error.message);
          assert.deepEqual(actual.data, frame.error.data);
          assert.deepEqual(
            fixture.calls.map((call) => call.method),
            ["initialize", "session/new"],
          );

          const listed = await client.request("list", {}, 2000);
          assert.deepEqual(listed.sessions, []);
          assert.equal(client.lastRequest.rejectionReceipt, undefined);
          assert.deepEqual(
            fixture.calls.map((call) => call.method),
            ["initialize", "session/new", "session/list"],
          );
        } finally {
          await client.closeAndWait();
        }
        await assertJoined(fixture, profile, client);
      },
    );

  for (const kind of ["missing", "unsupported version"])
    test(
      `${profile.name}: refuses ${kind} errors capability before session/new`,
      { timeout: 10000 },
      async (t) => {
        const result = initializationResult(profile);
        if (kind === "missing") delete result._meta["antnest.dev/errors"];
        else result._meta["antnest.dev/errors"].version = 2;
        const fixture = await commandFixture(t, profile, {
          initializationResult: result,
        });
        let client;
        try {
          await assert.rejects(async () => {
            client = await open(fixture, profile);
          }, /errors capability/iu);
          assert.deepEqual(
            fixture.calls.map((call) => call.method),
            ["initialize"],
          );
          assert.equal(
            fixture.calls.some((call) => call.method.startsWith("session/")),
            false,
          );
        } finally {
          if (client !== undefined) await client.closeAndWait();
        }
        await assertJoined(fixture, profile);
      },
    );
}
