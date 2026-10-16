import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { serviceClient } from "../../support/service-grants.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { until } from "../acp-closeout/wait.mjs";
import { waitForPublication, waitForRestoredConfiguration } from "./setup.mjs";

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
const implementation = await import("./execution-state.mjs");
const path = "/rpc/agent-acp/get-agent-execution-state";
const principal = { organization_id: "organization", user_id: "observer" };
const ready = () => ({
  agent_id: "observer-agent",
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

async function fixture(t, options = {}) {
  assert.equal(
    typeof implementation.readPrivateExecutionState,
    "function",
    "private Cost state reader required",
  );
  const identities = [],
    wire = [],
    receipts = [],
    secrets = [],
    pending = new Set(),
    errors = [];
  const responseStarted = Promise.withResolvers(),
    releaseResponse = Promise.withResolvers();
  const abort = new AbortController();
  const responses = options.responses ?? [{ status: 200, body: ready() }];
  let offset = 0;
  const server = createServer((request, response) => {
    const task = (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === "/rpc/identity/resolve-access-token") {
        identities.push({
          method: request.method,
          headers: request.headers,
          body,
        });
        response
          .writeHead(options.identityStatus ?? 200, {
            "content-type": "application/json",
          })
          .end(
            JSON.stringify({
              caller_context: "PRIVATE-COST-CCT-" + identities.length,
              principal: options.identityPrincipal ?? principal,
            }),
          );
        return;
      }
      const closed = Promise.withResolvers();
      response.once("close", closed.resolve);
      wire.push({
        path: request.url,
        method: request.method,
        headers: request.headers,
        body,
        closed: closed.promise,
      });
      assert.equal(request.url, path);
      const current = responses[Math.min(offset++, responses.length - 1)];
      const raw = current.raw ?? JSON.stringify(current.body);
      response.writeHead(current.status, {
        "content-type": "application/json",
        ...(current.status === 302
          ? { location: "/redirect-must-not-follow" }
          : {}),
      });
      if (options.holdResponse) {
        response.write(raw.slice(0, 3));
        response.flushHeaders();
        responseStarted.resolve();
        await releaseResponse.promise;
        response.end(raw.slice(3));
      } else response.end(raw);
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      (error) => {
        errors.push(error);
        response.destroy();
        pending.delete(task);
      },
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = new GatewayClient(origin);
  browser.cookies.set("antnest_session", "PRIVATE-COST-ORIGINAL-SESSION");
  browser.cookies.set("antnest_csrf", "PRIVATE-COST-CSRF");
  const service = serviceClient({
    identityEndpoint: origin,
    readCredential: (grant) =>
      (grant === "gateway-identity" ? "G" : "W").repeat(43),
  });
  const active = new Set();
  t.after(async () => {
    releaseResponse.resolve();
    abort.abort(new Error("Cost state fixture cleanup"));
    await Promise.allSettled([...active]);
    const results = await Promise.allSettled([...pending]);
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await Promise.all(wire.map((row) => row.closed));
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
    if (errors.length)
      throw new AggregateError(errors, "Cost state peer failed");
  });
  return {
    browser,
    service,
    identities,
    wire,
    receipts,
    secrets,
    abort,
    responseStarted: responseStarted.promise,
    releaseResponse: releaseResponse.resolve,
    read(overrides = {}) {
      const task = implementation.readPrivateExecutionState(
        "observer-agent",
        browser,
        {
          principal,
          service,
          endpoint: origin + path,
          receipts,
          secrets,
          signal: abort.signal,
          ...overrides,
        },
      );
      active.add(task);
      void task.then(
        () => active.delete(task),
        () => active.delete(task),
      );
      return task;
    },
  };
}

test("Cost state delegates the original observer session on every actual private read", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.read(), ready());
  assert.deepEqual(await f.read(), ready());
  assert.equal(f.identities.length, 2);
  assert.equal(f.wire.length, 2);
  for (const [index, row] of f.wire.entries()) {
    assert.equal(row.path, path);
    assert.equal(row.method, "POST");
    assert.deepEqual(row.body, {});
    assert.equal(row.headers.cookie, undefined);
    assert.equal(row.headers.authorization, undefined);
    assert.equal(
      row.headers["antnest-service-authorization"],
      "Bearer " + "W".repeat(43),
    );
    assert.equal(
      row.headers["antnest-caller-context"],
      "PRIVATE-COST-CCT-" + (index + 1),
    );
    assert.deepEqual(f.identities[index].body, {
      access_token: f.browser.accessToken,
      profile: "workspace",
      agent_id: "observer-agent",
    });
    assert.equal(
      f.identities[index].headers["antnest-service-authorization"],
      "Bearer " + "G".repeat(43),
    );
    assert.equal(f.receipts[index].status, 200);
    assert.equal(f.receipts[index].agentId, "observer-agent");
    assert.deepEqual(JSON.parse(f.receipts[index].rawBody), ready());
  }
  assert(f.secrets.includes(f.browser.accessToken));
  assert(f.secrets.includes("PRIVATE-COST-CCT-2"));
  assert(f.secrets.includes("W".repeat(43)));
});

for (const field of ["organization_id", "user_id"])
  test(
    "Cost state rejects changed original " + field + " before ACP IO",
    async (t) => {
      const f = await fixture(t);
      await assert.rejects(
        f.read({ principal: { ...principal, [field]: "foreign" } }),
        /authority changed/u,
      );
      assert.equal(f.identities.length, 1);
      assert.equal(f.wire.length, 0);
      assert.equal(f.receipts.length, 0);
    },
  );

test("Cost state rejects a missing original Principal before Identity IO", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.read({ principal: undefined }),
    /original browser Principal/u,
  );
  assert.equal(f.identities.length, 0);
  assert.equal(f.wire.length, 0);
});

for (const [label, corrupt] of [
  ["foreign Agent", (s) => ({ ...s, agent_id: "foreign" })],
  [
    "camel-case fingerprint",
    ({ configuration_revision, ...s }) => ({
      ...s,
      configurationRevision: configuration_revision,
    }),
  ],
  ["short fingerprint", (s) => ({ ...s, configuration_revision: "a" })],
  ["private extra field", (s) => ({ ...s, pricing: "PRIVATE-COST-RESPONSE" })],
  [
    "missing readiness field",
    ({ active_session_id, ...s }) => {
      void active_session_id;
      return s;
    },
  ],
  ["ready with active Session", (s) => ({ ...s, active_session_id: "active" })],
  [
    "denied with fingerprint",
    (s) => ({
      ...s,
      access_allowed: false,
      availability: "offline",
      unavailable_reason: "access_denied",
    }),
  ],
])
  test("Cost state validates the full current schema: " + label, async (t) => {
    const body = corrupt(ready());
    const f = await fixture(t, { responses: [{ status: 200, body }] });
    await assert.rejects(f.read(), (error) => {
      assert(!String(error).includes("PRIVATE-COST-RESPONSE"));
      return true;
    });
    assert.equal(f.receipts.length, 1);
    assert.deepEqual(JSON.parse(f.receipts[0].rawBody), body);
  });

test("Cost publication keeps the actual changed snake-case fingerprint", async (t) => {
  const f = await fixture(t, {
    responses: [
      { status: 200, body: ready() },
      {
        status: 200,
        body: { ...ready(), configuration_revision: "b".repeat(64) },
      },
    ],
  });
  await waitForPublication(() => f.read(), "a".repeat(64));
  assert.equal(f.wire.length, 2);
  assert.equal(
    JSON.parse(f.receipts[1].rawBody).configuration_revision,
    "b".repeat(64),
  );
});

test("Cost restart retries only actual execution-state-unavailable 503 before the original ready fingerprint", async (t) => {
  const f = await fixture(t, {
    responses: [
      { status: 503, body: unavailable },
      { status: 200, body: ready() },
    ],
  });
  await waitForRestoredConfiguration(() => f.read(), "a".repeat(64));
  assert.deepEqual(
    f.receipts.map((row) => row.status),
    [503, 200],
  );
  assert.equal(f.identities.length, 2);
});

for (const [label, response] of [
  ...[401, 403, 500, 302].map((status) => [
    "HTTP " + status,
    { status, body: { code: "PRIVATE-COST-ERROR" } },
  ]),
  [
    "Identity dependency 503",
    {
      status: 503,
      body: { ...unavailable, code: "identity_dependency_unavailable" },
    },
  ],
  [
    "non-retryable 503",
    { status: 503, body: { ...unavailable, retryable: false } },
  ],
  [
    "foreign 503 envelope",
    { status: 503, body: { ...unavailable, private: "PRIVATE-COST-ERROR" } },
  ],
  ["malformed 503", { status: 503, raw: "PRIVATE-COST-ERROR" }],
  ["invalid success JSON", { status: 200, raw: "PRIVATE-COST-ERROR" }],
])
  test("Cost restart fails immediately on " + label, async (t) => {
    const f = await fixture(t, {
      responses: [response, { status: 200, body: ready() }],
    });
    await assert.rejects(
      waitForRestoredConfiguration(() => f.read(), "a".repeat(64)),
      (error) => {
        assert(!String(error).includes("PRIVATE-COST-ERROR"));
        return true;
      },
    );
    assert.equal(f.wire.length, 1, "no retry or redirect");
    assert.equal(f.receipts.length, 1);
    assert.equal(f.receipts[0].status, response.status);
    assert.equal(
      f.receipts[0].rawBody,
      response.raw ?? JSON.stringify(response.body),
    );
  });

test("Cost state does not retry Identity failure as ACP startup", async (t) => {
  const f = await fixture(t, { identityStatus: 503 });
  await assert.rejects(
    waitForRestoredConfiguration(() => f.read(), "a".repeat(64)),
    /Identity workspace Resolve/u,
  );
  assert.equal(f.identities.length, 1);
  assert.equal(f.wire.length, 0);
});

for (const status of [200, 503])
  test(
    "Cost state joins the full HTTP " +
      status +
      " body before publishing a receipt",
    async (t) => {
      const f = await fixture(t, {
        holdResponse: true,
        responses: [{ status, body: status === 200 ? ready() : unavailable }],
      });
      let settled = false;
      const task = f
        .read()
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await f.responseStarted;
        assert.equal(settled, false);
        assert.equal(f.receipts.length, 0);
      } finally {
        f.releaseResponse();
      }
      const result = await task;
      if (status === 200) assert.deepEqual(result.value, ready());
      else
        assert.equal(
          result.error?.constructor.name,
          "CostExecutionStateUnavailableError",
        );
      assert.equal(f.receipts.length, 1);
    },
  );

test("Cost state cancellation preserves the original reason and closes the real response", async (t) => {
  const f = await fixture(t, { holdResponse: true });
  const stopped = new Error("original Cost cancellation");
  let settled = false;
  const task = f.read().finally(() => {
    settled = true;
  });
  void task.catch(() => {});
  await f.responseStarted;
  f.abort.abort(stopped);
  try {
    await assert.rejects(task, (error) => error === stopped);
    await f.wire[0].closed;
    await until(() => settled, "Cost state request settled", 2000);
    assert.equal(f.receipts.length, 0);
  } finally {
    f.releaseResponse();
  }
});

for (const status of [200, 503])
  test(
    "Cost state retains complete HTTP " +
      status +
      " evidence but honors cancellation at EOF",
    async (t) => {
      const body = status === 200 ? ready() : unavailable;
      const f = await fixture(t, { responses: [{ status, body }] });
      const stopped = new Error("original Cost EOF cancellation");
      const service = {
        ...f.service,
        async send(...args) {
          const response = await f.service.send(...args);
          const read = response.text.bind(response);
          response.text = async () => {
            const raw = await read();
            f.abort.abort(stopped);
            return raw;
          };
          return response;
        },
      };
      let reads = 0;
      await assert.rejects(
        waitForRestoredConfiguration(() => {
          reads++;
          return f.read({ service });
        }, "a".repeat(64)),
        (error) => error === stopped,
      );
      assert.equal(reads, 1, "cancellation must not trigger a recovery retry");
      assert.equal(f.wire.length, 1);
      assert.equal(f.receipts.length, 1);
      assert.equal(f.receipts[0].status, status);
      assert.deepEqual(JSON.parse(f.receipts[0].rawBody), body);
    },
  );
