import assert from "node:assert/strict";
import { test } from "node:test";
import { stateReady } from "./readiness.mjs";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { assertHeldCompletion } from "./completion.mjs";
import * as readiness from "./readiness.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const ajvURL = pathToFileURL(require.resolve("ajv/dist/2020.js")).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "ajv/dist/2020.js"
      ? { url: ajvURL, shortCircuit: true }
      : next(specifier, context);
  },
});

const principal = { organization_id: "organization", user_id: "owner" };
const ready = () => ({
  agent_id: "agent",
  access_allowed: true,
  configuration_revision: "a".repeat(64),
  availability: "ready",
  active_session_id: null,
  unavailable_reason: null,
});
const unavailable = {
  code: "execution_state_unavailable",
  message: "Agent execution state is unavailable",
  retryable: true,
};
function fixture({
  status = 200,
  body = ready(),
  raw,
  issued = principal,
} = {}) {
  const identities = [],
    requests = [],
    receipts = [],
    secrets = [],
    saved = [];
  const service = {
    async workspaceContext(token, agentId, options) {
      identities.push({ token, agentId, options });
      return { principal: issued, context: "private-context" };
    },
    authorization(grant) {
      assert.equal(grant, "agent-ui-acp");
      return { "Antnest-Service-Authorization": "Bearer " + "W".repeat(43) };
    },
    async send(url, grant, options) {
      requests.push({ url, grant, options });
      return new Response(raw ?? JSON.stringify(body), { status });
    },
  };
  return {
    service,
    identities,
    requests,
    receipts,
    secrets,
    saved,
    read(options = {}) {
      assert.equal(typeof readiness.readPersistenceExecutionState, "function");
      return readiness.readPersistenceExecutionState(
        "agent",
        { accessToken: "original-session" },
        {
          principal,
          service,
          receipts,
          secrets,
          preserve: async (rows) => saved.push(structuredClone(rows)),
          ...options,
        },
      );
    },
  };
}

test("legacy Restart readiness import does not load state schema or dependencies", async () => {
  const hook = registerHooks({
    resolve(specifier, context, next) {
      assert(!specifier.endsWith("private-acp-execution-state.mjs"));
      assert(!specifier.includes("agent-execution-state.schema.json"));
      assert.notEqual(specifier, "ajv/dist/2020.js");
      return next(specifier, context);
    },
  });
  try {
    const legacy = await import("./readiness.mjs?legacy-restart");
    assert.equal(
      await legacy.stateReady(async () => ({ availability: "ready" })),
      true,
    );
  } finally {
    hook.deregister();
  }
});

test("Persistence reads the complete private state with the original owner on every request", async () => {
  const f = fixture();
  assert.deepEqual(await f.read(), ready());
  assert.equal(await stateReady(() => f.read()), true);
  assert.equal(f.identities.length, 2);
  for (const row of f.identities) {
    assert.equal(row.token, "original-session");
    assert.equal(row.agentId, "agent");
  }
  for (const row of f.requests) {
    assert.equal(
      row.url,
      "http://agent-acp-service:8080/rpc/agent-acp/get-agent-execution-state",
    );
    assert.equal(row.grant, "agent-ui-acp");
    assert.deepEqual(row.options.body, {});
    assert.equal(row.options.context, "private-context");
  }
  assert.equal(f.receipts.length, 2);
  assert.deepEqual(JSON.parse(f.receipts[0].rawBody), ready());
});

for (const state of [
  { ...ready(), availability: "busy", active_session_id: "session" },
  { ...ready(), availability: "busy" },
  {
    ...ready(),
    availability: "offline",
    unavailable_reason: "agent_unavailable",
  },
])
  test(
    "Persistence retains actual " +
      state.availability +
      "/" +
      state.active_session_id +
      " state",
    async () => {
      const f = fixture({ body: state });
      assert.deepEqual(await f.read(), state);
      assert.equal(await stateReady(() => f.read()), false);
    },
  );

test("held completion checks the real busy state, not a v2 output or recovery 503", async () => {
  const f = fixture({
    body: { ...ready(), availability: "busy", active_session_id: "session" },
  });
  const state = await f.read();
  assert.equal(
    assertHeldCompletion({
      version: 1,
      resolved: false,
      availability: state.availability,
    }),
    false,
  );
  assert.throws(() =>
    assertHeldCompletion({
      version: 1,
      resolved: false,
      availability: ready().availability,
    }),
  );
  await assert.rejects(fixture({ status: 503, body: unavailable }).read());
});

test("Persistence readiness retries the exact private startup response and retains its raw body", async () => {
  const f = fixture({ status: 503, body: unavailable });
  assert.equal(await stateReady(() => f.read()), false);
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].status, 503);
  assert.deepEqual(JSON.parse(f.receipts[0].rawBody), unavailable);
});

for (const [name, response] of [
  [
    "denied owner",
    {
      body: {
        agent_id: "agent",
        access_allowed: false,
        availability: "offline",
        active_session_id: null,
        configuration_revision: null,
        unavailable_reason: "access_denied",
      },
    },
  ],
  ["foreign Agent", { body: { ...ready(), agent_id: "foreign" } }],
  [
    "Bridge projection",
    { body: { availability: "ready", activeSessionId: null } },
  ],
  [
    "wrong 503",
    {
      status: 503,
      body: { ...unavailable, code: "identity_dependency_unavailable" },
    },
  ],
  ["incomplete 503", { status: 503, raw: "PRIVATE-PERSISTENCE-ERROR" }],
  [
    "unexpected 503 field",
    {
      status: 503,
      body: { ...unavailable, private: "PRIVATE-PERSISTENCE-ERROR" },
    },
  ],
  ...[401, 403, 500].map((status) => [
    "HTTP " + status,
    { status, body: unavailable },
  ]),
])
  test("Persistence does not retry " + name, async () => {
    const f = fixture(response);
    await assert.rejects(
      stateReady(() => f.read()),
      (error) => {
        assert(!String(error).includes("PRIVATE-PERSISTENCE-ERROR"));
        return true;
      },
    );
    assert.equal(f.requests.length, 1);
    assert.equal(f.receipts.length, 1);
  });

test("Persistence rejects changed authority before any private state request", async () => {
  const f = fixture({ issued: { ...principal, user_id: "foreign" } });
  await assert.rejects(f.read());
  assert.equal(f.requests.length, 0);
  assert.equal(f.receipts.length, 0);
});

test("Persistence retains an EOF response but propagates an already aborted caller", async () => {
  const f = fixture(),
    controller = new AbortController(),
    reason = Error("state observation stopped");
  f.service.send = async () => ({
    status: 200,
    async text() {
      controller.abort(reason);
      return JSON.stringify(ready());
    },
  });
  await assert.rejects(
    f.read({ signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(f.receipts.length, 1);
});

test("Persistence preserves a complete failed state response before returning its error", async () => {
  const f = fixture({ status: 200, raw: "PRIVATE-PERSISTENCE-ERROR" });
  await assert.rejects(f.read(), /invalid .* execution state JSON/u);
  assert.equal(f.saved.length, 1);
  assert.deepEqual(f.saved[0], f.receipts);
  assert.equal(f.saved[0][0].rawBody, "PRIVATE-PERSISTENCE-ERROR");
});

test("Persistence preserves the original read error and independent archive failure", async () => {
  const f = fixture(),
    readError = Error("original Identity failure"),
    writeError = Error("state archive failed");
  f.service.workspaceContext = async () => {
    throw readError;
  };
  let writes = 0;
  await assert.rejects(
    f.read({
      preserve: async () => {
        writes++;
        throw writeError;
      },
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [readError, writeError]);
      return true;
    },
  );
  assert.equal(writes, 1);
});

test("a state archive failure cannot become readiness or a retried startup response", async () => {
  for (const response of [{}, { status: 503, body: unavailable }]) {
    const f = fixture(response),
      writeError = Error("state archive failed");
    await assert.rejects(
      stateReady(() =>
        f.read({
          preserve: async () => {
            throw writeError;
          },
        }),
      ),
      (error) => {
        if (response.status === 503) {
          assert(error instanceof AggregateError);
          assert.strictEqual(error.errors[1], writeError);
        } else assert.strictEqual(error, writeError);
        return true;
      },
    );
    assert.equal(f.receipts.length, 1);
  }
});

test("Persistence requires a private state archive callback before issuing requests", async () => {
  const f = fixture();
  await assert.rejects(f.read({ preserve: undefined }));
  assert.equal(f.identities.length, 0);
});

for (const status of [200, 503])
  test(
    "Persistence joins its state archive but preserves cancellation during HTTP " +
      status +
      " archival",
    async () => {
      const f = fixture({
        status,
        body: status === 200 ? ready() : unavailable,
      });
      const controller = new AbortController(),
        reason = Error("cancelled while saving state");
      let archived = false;
      await assert.rejects(
        stateReady(() =>
          f.read({
            signal: controller.signal,
            preserve: async (rows) => {
              assert.equal(rows.length, 1);
              controller.abort(reason);
              await Promise.resolve();
              archived = true;
            },
          }),
        ),
        (error) => {
          assert.equal(archived, true);
          if (status === 200) assert.strictEqual(error, reason);
          else {
            assert(error instanceof AggregateError);
            assert.equal(error.errors.length, 2);
            assert.strictEqual(error.errors[1], reason);
          }
          return true;
        },
      );
    },
  );

test("rehydration retries only an explicit public state HTTP 503", async () => {
  assert.equal(
    await stateReady(
      async () => ({
        availability: "offline",
        unavailable_reason: "runtime_barrier_required",
      }),
      (s) => s.unavailable_reason === "runtime_barrier_required",
    ),
    true,
  );
  assert.equal(await stateReady(async () => ({ availability: "ready" })), true);
  assert.equal(await stateReady(async () => ({ availability: "busy" })), false);
  const failure = (status) => () => assert.equal(status, 200);
  assert.equal(await stateReady(failure(503)), false);
  await assert.rejects(stateReady(failure(403)));
  await assert.rejects(
    stateReady(async () => {
      throw Error("bad JSON");
    }),
  );
});
