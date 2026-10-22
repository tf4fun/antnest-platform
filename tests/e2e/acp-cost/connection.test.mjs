import assert from "node:assert/strict";
import test from "node:test";
import {
  admissionErrorReceipt,
  assertAdmissionError,
} from "../../support/acp-errors.mjs";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { setImmediate as turn } from "node:timers/promises";
import {
  commandFixture,
  principal,
  setup,
} from "../acp-commands/connection.fixture.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { assertCost } from "./evidence.mjs";
import { bindCostPrompt } from "./client-evidence.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const dependencies = Object.fromEntries(
  [
    "ajv/dist/2020.js",
    "@agentclientprotocol/sdk/schema/schema.json",
    "@agentclientprotocol/sdk/schema/v2/schema.unstable.json",
  ].map((name) => [name, pathToFileURL(require.resolve(name)).href]),
);
registerHooks({
  resolve(specifier, context, next) {
    return dependencies[specifier]
      ? { url: dependencies[specifier], shortCircuit: true }
      : next(specifier, context);
  },
});
const implementation = await import("./connection.mjs");
const profiles = [
  { name: "v1-ws", version: 1 },
  { name: "v2-ws", version: 2 },
  { name: "v1-http", version: 1, http: true },
];
async function fixture(t, profile, peer = {}) {
  assert.equal(
    typeof implementation.openPrivateCostConnection,
    "function",
    "Cost private connection required",
  );
  const f = await commandFixture(t, profile, peer);
  const evidence = [];
  return {
    ...f,
    evidence,
    async open(overrides = {}) {
      return f.register(
        await implementation.openPrivateCostConnection(
          profile,
          "agent",
          f.browser,
          evidence,
          { ...f.options, ...overrides },
        ),
      );
    },
  };
}

async function sendRawFrame(f, profile, sessionId, frame) {
  if (profile.http)
    await until(() => f.hasRawStream(sessionId), "actual Session SSE", 2000);
  f.sendRawFrame(frame, profile.http ? sessionId : null);
}

for (const profile of profiles) {
  test(
    profile.name +
      ": Cost prompt binder consumes actual SDK reply and final raw terminal",
    async (t) => {
      const f = await fixture(t, profile);
      const client = await f.open();
      const { sessionId } = await client.request("new", setup);
      client.checkpoint(sessionId);
      const result = await client.request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: "phase" }],
      });
      if (profile.version === 2)
        await until(
          () =>
            client.rawUpdates.some(
              ({ update }) =>
                update.sessionUpdate === "state_update" &&
                update.state === "idle",
            ),
          "actual Cost terminal",
          2000,
        );
      bindCostPrompt(client, sessionId, result, "phase");
      assert.equal(f.evidence.at(-1).kind, "native");
      assert.deepEqual(f.evidence.at(-1).promptReceipt.result, result);
      assert.equal(
        f.evidence.at(-1).promptReceipt.requestId,
        client.lastRequest.requestId,
      );
      await client.closeAndWait();
    },
  );
  test(
    profile.name +
      ": closing independently rejects a late private notification",
    async (t) => {
      const f = await fixture(t, profile);
      const client = await f.open();
      const { sessionId } = await client.request("new", setup);
      client.checkpoint(sessionId);
      await sendRawFrame(f, profile, sessionId, {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: 1100,
            size: 64000,
            measurement: { pricing: "private" },
          },
        },
      });
      await until(
        () => client.rawUpdates.length > 0,
        "last Cost notification",
        2000,
      );
      await assert.rejects(client.closeAndWait(), /private accounting field/u);
      if (profile.http) {
        assert.equal(
          client.initializationRequest.httpConnection.streamJoined,
          true,
        );
        assert.equal(f.evidence.at(-1).httpConnection.pendingRequests, 0);
      }
    },
  );
  test(
    profile.name +
      ": Cost preserves actual initialize, fork identities and sessionless list",
    async (t) => {
      const f = await fixture(t, profile);
      const client = await f.open();
      assert.equal(client.boundary, "private-acp");
      assert.equal(
        client.initializationResult.protocolVersion,
        profile.version,
      );
      assert.equal(client.initializationRequest.method, "initialize");
      assert.equal(client.initializationRequest.inputSessionID, null);
      assert.equal(client.initializationRequest.sessionId, undefined);
      assert.deepEqual(
        client.initializationRequest.initializationResult,
        client.initializationResult,
      );
      assert.notStrictEqual(
        client.initializationRequest.initializationResult,
        client.initializationResult,
      );
      assert.equal(
        f.evidence.length,
        0,
        "initialization is not a business RPC",
      );
      const parent = await client.request("new", setup);
      const fork = await client.request("fork", {
        ...setup,
        sessionId: parent.sessionId,
      });
      const listed = await client.request("list", {});
      assert.deepEqual(
        listed.sessions.map((row) => row.sessionId),
        [parent.sessionId, fork.sessionId],
      );
      assert.deepEqual(
        f.evidence.map((row) => row.method),
        ["session/new", "session/fork", "session/list"],
      );
      assert.deepEqual(
        f.evidence.map((row) => row.inputSessionID),
        [null, parent.sessionId, null],
      );
      assert.deepEqual(
        f.evidence.map((row) => row.sessionId),
        [parent.sessionId, fork.sessionId, undefined],
      );
      assert.equal(
        new Set(
          [client.initializationRequest, ...f.evidence].map(
            (row) => row.requestId,
          ),
        ).size,
        4,
      );
      assert.equal(client.frames.length, 4);
      assert.deepEqual(client.rawUpdates, []);
      for (const row of f.evidence) {
        assert.equal(row.outcome, "succeeded");
        assert.equal(row.agentId, "agent");
        assert.equal(row.protocolVersion, profile.version);
        assert.equal(row.boundary, "private-acp");
        const call = f.calls.find((call) => call.method === row.method);
        assert.deepEqual(row.requestReceipt.params, call.params);
        assert.equal(row.requestReceipt.requestId, row.requestId);
        const frame = client.frames.find(
          (frame) => String(frame.id) === row.requestId,
        );
        assert.deepEqual(row.requestReceipt.result, frame.result);
      }
      assert.strictEqual(client.lastRequest, f.evidence.at(-1));
      await client.closeAndWait();
      if (profile.http) {
        const initial = client.initializationRequest.httpConnection;
        assert.equal(initial.streamJoined, true);
        assert.equal(initial.pendingRequests, 0);
        for (const row of f.evidence)
          assert.deepEqual(row.httpConnection, initial);
        assert(
          f.identities.length >= f.wire.length,
          "each HTTP request delegates the original workspace",
        );
        assert(f.wire.every((row) => row.headers.cookie === undefined));
      } else {
        assert.equal(f.identities.length, 1);
        for (const row of f.evidence) {
          assert.equal(row.connectionTraceID, client.connectionTraceID);
          assert.equal(row.clientSpanID, client.clientSpanID);
        }
      }
      assert(
        f.identities.every(
          (row) =>
            row.body.access_token === f.browser.accessToken &&
            row.body.agent_id === "agent" &&
            row.body.profile === "workspace",
        ),
      );
    },
  );

  test(
    profile.name +
      ": Cost checkpoints preserve unknown raw usage fields for privacy rejection",
    async (t) => {
      const f = await fixture(t, profile);
      const client = await f.open();
      const { sessionId } = await client.request("new", setup);
      client.checkpoint(sessionId);
      await sendRawFrame(f, profile, sessionId, {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: 1100,
            size: 64000,
            cost: { amount: 0.01, currency: "USD", source: "estimated" },
            measurement: { pricing: "PRIVATE-COST-USAGE" },
          },
        },
      });
      await until(() => client.rawUpdates.length === 1, "Cost raw usage", 2000);
      assert.equal(
        client.rawUpdates[0].update.measurement.pricing,
        "PRIVATE-COST-USAGE",
      );
      assert.equal(client.rawUpdates[0].update.cost.source, "estimated");
      assert.throws(
        () => implementation.validate(client, profile),
        /private accounting field|private receipt source/u,
      );
      assert.throws(
        () => client.checkpoint(sessionId),
        /private accounting field|private receipt source/u,
      );
      await assert.rejects(
        client.closeAndWait(),
        /private accounting field|private receipt source/u,
      );
      if (profile.http) {
        assert.equal(
          client.initializationRequest.httpConnection.streamJoined,
          true,
        );
        assert.equal(f.evidence.at(-1).httpConnection.pendingRequests, 0);
      }
      await f.telemetry.flush();
      assert(!JSON.stringify(f.exports).includes("PRIVATE-COST-USAGE"));
    },
  );

  test(
    profile.name +
      ": Cost checkpoints retain public usage and reject foreign Session updates",
    async (t) => {
      const f = await fixture(t, profile);
      const client = await f.open();
      const { sessionId } = await client.request("new", setup);
      client.checkpoint(sessionId);
      const frame = (id) => ({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: id,
          update: {
            sessionUpdate: "usage_update",
            used: 1100,
            size: 64000,
            cost: { amount: 0, currency: "USD" },
          },
        },
      });
      await sendRawFrame(f, profile, sessionId, frame(sessionId));
      await until(
        () => client.rawUpdates.length === 1,
        "public Cost usage",
        2000,
      );
      implementation.validate(client, profile);
      assertCost(client.updates, sessionId, 0);
      client.checkpoint(sessionId);
      assert.deepEqual(client.rawUpdates, []);
      await sendRawFrame(f, profile, sessionId, frame("unowned-session"));
      await until(
        () => client.rawUpdates.length === 1,
        "foreign Cost usage",
        2000,
      );
      assert.throws(
        () => client.checkpoint(sessionId),
        /unowned Session notification/u,
      );
      await assert.rejects(
        client.closeAndWait(),
        /unowned Session notification/u,
      );
    },
  );

  test(
    profile.name +
      ": exact access denial remains separate from successful session setup",
    async (t) => {
      const f = await fixture(t, profile, { denyNew: true });
      const client = await f.open();
      await assert.rejects(client.request("new", setup), (error) => {
        assertAdmissionError(error, "access_denied");
        return true;
      });
      assert.equal(f.evidence.length, 1);
      assert.equal(f.evidence[0].rejection, "access_denied");
      assert.equal(f.evidence[0].outcome, "rejected");
      assert.equal(f.evidence[0].requestReceipt, undefined);
      const denied = admissionErrorReceipt("access_denied");
      assert.deepEqual(f.evidence[0].rejectionReceipt, {
        rpcCode: denied.code,
        code: denied.data.code,
        retryable: denied.data.retryable,
      });
      assert.equal(f.evidence[0].inputSessionID, null);
      assert.equal(f.evidence[0].sessionId, undefined);
      await client.closeAndWait();
      if (profile.http)
        assert.equal(f.evidence[0].httpConnection.streamJoined, true);
    },
  );

  test(
    profile.name + ": failed initialization is joined before Cost open rejects",
    async (t) => {
      const f = await fixture(t, profile, { initializeError: true });
      await assert.rejects(f.open(), (error) => error.code === -32603);
      assert.equal(f.evidence.length, 0);
      assert.deepEqual(
        f.calls.map((row) => row.method),
        ["initialize"],
      );
      if (profile.http) await Promise.all(f.wire.map((row) => row.closed));
      else
        await until(
          () => f.sockets.clients.size === 0,
          "independent peer observed initialization socket close",
          2000,
        );
    },
  );

  for (const field of ["organization_id", "user_id"])
    test(
      profile.name +
        ": Cost rejects changed original " +
        field +
        " before private ACP IO",
      async (t) => {
        const f = await fixture(t, profile);
        await assert.rejects(
          f.open({ principal: { ...principal, [field]: "foreign" } }),
          (error) => {
            if (!profile.http) return /authority changed/u.test(error.message);
            assert(error instanceof AggregateError);
            assert.equal(error.errors.length, 2);
            assert.equal(
              error.errors[0].message,
              "private ACP HTTP transport failed",
            );
            assert.equal(
              error.errors[1].message,
              "private ACP HTTP cleanup failed",
            );
            assert(
              error.errors[1].errors.some(
                (item) => item.message === "private ACP HTTP headers failed",
              ),
            );
            return true;
          },
        );
        assert.equal(f.identities.length, 1);
        assert.equal(f.wire.length, 0);
        assert.deepEqual(f.calls, []);
        assert.deepEqual(f.evidence, []);
      },
    );
}

for (const profile of profiles) {
  test(
    profile.name + ": actual SDK receipts survive caller mutation",
    async (t) => {
      const f = await fixture(t, profile, { holdNew: true });
      const client = await f.open();
      const params = structuredClone(setup);
      const pending = client.request("new", params);
      void pending.catch(() => {});
      let result;
      try {
        await f.newStarted;
        params.cwd = "/caller-mutated";
        params.mcpServers.push({ name: "caller-mutated" });
        f.releaseNew();
        result = await pending;
        const row = client.lastRequest;
        const response = structuredClone(result);
        assert.deepEqual(row.requestReceipt, {
          requestId: row.requestId,
          params: setup,
          result: response,
        });
        result.sessionId = "caller-mutated";
        assert.deepEqual(row.requestReceipt.result, response);
        assert.equal(row.sessionId, response.sessionId);
        assert.deepEqual(
          f.calls.find((call) => call.method === "session/new").params,
          setup,
        );
      } finally {
        f.releaseNew();
        await pending.catch(() => {});
        await client.closeAndWait();
      }
    },
  );

  test(
    profile.name +
      ": overlapping requests cannot overwrite actual request identity",
    async (t) => {
      const f = await fixture(t, profile, { holdNew: true });
      const client = await f.open();
      const pending = client.request("new", setup);
      void pending.catch(() => {});
      try {
        await f.newStarted;
        await assert.rejects(
          client.request("list", {}),
          /Cost request overlap/u,
        );
        assert.equal(
          f.calls.some((row) => row.method === "session/list"),
          false,
        );
      } finally {
        f.releaseNew();
        await pending.catch(() => {});
        await client.closeAndWait();
      }
      const result = await pending;
      assert.equal(f.evidence.length, 1);
      assert.equal(f.evidence[0].sessionId, result.sessionId);
    },
  );

  for (const deleteStatus of profile.http ? [202, 500] : [202])
    test(
      profile.name +
        ": in-flight close preserves failed request and joined receipts, DELETE " +
        deleteStatus,
      { timeout: 8000 },
      async (t) => {
        const f = await fixture(t, profile, {
          holdNew: true,
          holdDelete: true,
          deleteStatus,
        });
        const client = await f.open();
        let requestSettled = false,
          closeSettled = false;
        const pending = client
          .request("new", setup)
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          )
          .finally(() => {
            requestSettled = true;
          });
        let closing;
        try {
          await f.newStarted;
          assert.equal(requestSettled, false);
          closing = client.closeAndWait();
          assert.strictEqual(client.closeAndWait(), closing);
          void closing
            .finally(() => {
              closeSettled = true;
            })
            .catch(() => {});
          await until(
            () => requestSettled,
            "in-flight request settled on close",
            2000,
          );
          const { error } = await pending;
          assert(error instanceof Error);
          assert(
            !(error instanceof AggregateError),
            "preserve the original request failure",
          );
          assert.equal(
            f.evidence.length,
            1,
            "retain the actual in-flight request",
          );
          const row = f.evidence[0];
          assert.equal(row.method, "session/new");
          assert.equal(row.outcome, "failed");
          assert.equal(row.inputSessionID, null);
          assert.equal(
            row.sessionId,
            undefined,
            "cancelled setup has no successful Session",
          );
          assert.equal(
            row.rejection,
            undefined,
            "transport close is not access denial",
          );
          assert.equal(row.rejectionReceipt, undefined);
          assert.equal(
            f.calls.filter((call) => call.method === "session/new").length,
            1,
          );
          if (profile.http) {
            await f.deleteStarted;
            assert.equal(closeSettled, false);
            assert.equal(
              row.httpConnection,
              undefined,
              "no premature final receipt",
            );
            const sent = f.wire.find(
              (item) => item.message?.method === "session/new",
            );
            assert.equal(String(sent.message.id), row.requestId);
          }
        } finally {
          f.releaseNew();
          f.releaseDelete();
          await pending;
          if (closing) await closing.catch(() => {});
        }
        if (profile.http) {
          const final = f.evidence[0].httpConnection;
          assert.equal(final.streamJoined, true);
          assert.equal(final.pendingRequests, 0);
          assert.strictEqual(
            final,
            client.initializationRequest.httpConnection,
          );
          assert.deepEqual(final, client.httpSnapshot());
          if (deleteStatus === 500) {
            await assert.rejects(closing, /cleanup failed/u);
            assert(final.failures.some((row) => row.phase === "delete_status"));
          } else {
            await closing;
            assert.deepEqual(final.failures, []);
          }
        } else await closing;
      },
    );

  test(
    profile.name + ": close refuses new admission without ACP IO",
    async (t) => {
      const f = await fixture(t, profile, { holdDelete: true });
      const client = await f.open();
      const closing = client.closeAndWait();
      void closing.catch(() => {});
      try {
        await assert.rejects(
          client.request("new", setup),
          /Cost connection is closing/u,
        );
        assert.deepEqual(f.evidence, []);
        assert.deepEqual(
          f.calls.map((row) => row.method),
          ["initialize"],
        );
      } finally {
        f.releaseDelete();
        await closing;
      }
    },
  );

  test(
    profile.name +
      ": unexpected RPC failure retains original error and failed wire receipt",
    async (t) => {
      const f = await fixture(t, profile, { newError: true });
      const client = await f.open();
      await assert.rejects(client.request("new", setup), (error) => {
        assert.equal(error.code, -32603);
        assert.equal(error.message, "fixture new refused");
        assert.deepEqual(error.data, {
          code: "provider_failure",
          retryable: true,
        });
        return true;
      });
      assert.equal(f.evidence.length, 1);
      assert.equal(f.evidence[0].outcome, "failed");
      assert.equal(f.evidence[0].sessionId, undefined);
      assert.equal(f.evidence[0].rejection, undefined);
      await client.closeAndWait();
      if (profile.http)
        assert.equal(f.evidence[0].httpConnection.pendingRequests, 0);
    },
  );
}

test("Cost HTTP close joins the original DELETE body before final request receipts", async (t) => {
  const f = await fixture(t, profiles[2], { holdDelete: true });
  const client = await f.open();
  await client.request("new", setup);
  let settled = false;
  const closing = client.closeAndWait().finally(() => {
    settled = true;
  });
  void closing.catch(() => {});
  try {
    await f.deleteStarted;
    await turn();
    assert.equal(settled, false);
    assert.equal(f.evidence[0].httpConnection, undefined);
  } finally {
    f.releaseDelete();
    await closing;
  }
  assert.equal(f.evidence[0].httpConnection.streamJoined, true);
  assert.equal(f.evidence[0].httpConnection.pendingRequests, 0);
  assert.equal(
    client.initializationRequest.httpConnection.requests.filter(
      (row) => row.method === "DELETE",
    ).length,
    1,
  );
});

test("Cost HTTP cleanup failure preserves its actual failed receipt", async (t) => {
  const f = await fixture(t, profiles[2], { deleteStatus: 500 });
  const client = await f.open();
  await client.request("new", setup);
  await assert.rejects(client.closeAndWait());
  assert(
    f.evidence[0].httpConnection.failures.some(
      (row) => row.phase === "delete_status",
    ),
  );
});
