import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  foundationConnectionFixture,
  principal,
  setup,
} from "../lifecycle-closeout/foundation-connection.fixture.mjs";
const { createPrivateACPTelemetry } =
  await import("../identity-closeout/private-acp-telemetry.mjs");
const { inspectPrivateNotificationReceipt } =
  await import("../identity-closeout/acp-connection.mjs");
const url = new URL("./private-access.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const contains = (error, original) =>
  error === original ||
  (error?.errors ?? []).some((item) => contains(item, original));
const unauthorized = {
  code: "unauthenticated",
  message: "Authentication failed",
  retryable: false,
};

async function fixture(t, options = {}) {
  assert.equal(typeof implementation.createWorkspacePrivateAccess, "function");
  const f = await foundationConnectionFixture(t);
  const identities = [],
    failures = [],
    connections = [],
    watches = [],
    states = [],
    authorities = [];
  let reply = {
    status: 200,
    body: { caller_context: "foundation-issued-context", principal },
  };
  const identity = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(request.url, "/rpc/identity/resolve-access-token");
      assert.equal(body.access_token, f.browser.accessToken);
      assert.equal(body.profile, "workspace");
      assert.equal(body.agent_id, "agent");
      assert.equal(
        request.headers["antnest-service-authorization"],
        "Bearer " + "G".repeat(43),
      );
      identities.push({ headers: request.headers, body });
      response
        .writeHead(reply.status, {
          "content-type": "application/json",
        })
        .end(JSON.stringify(reply.body));
    })().catch((error) => {
      failures.push(error);
      response.destroy();
    });
  });
  identity.listen(0, "127.0.0.1");
  await once(identity, "listening");
  const credentials = await mkdtemp(join(tmpdir(), "workspace-access-"));
  for (const [path, value] of [
    ["edge-gateway/tokens/identity-service", "G"],
    ["agent-ui/tokens/agent-acp-service", "W"],
  ]) {
    await mkdir(join(credentials, path, ".."), { recursive: true });
    await writeFile(join(credentials, path), value.repeat(43), { mode: 0o600 });
  }
  let access;
  t.after(async () => {
    const [closed] = await Promise.allSettled(
      access ? [access.closeAndWait()] : [],
    );
    identity.closeAllConnections();
    await new Promise((resolve) => identity.close(resolve));
    await rm(credentials, { recursive: true, force: true });
    assert.deepEqual(failures, []);
    if (!options.allowCloseFailure && closed?.status === "rejected")
      throw closed.reason;
  });
  access = await implementation.createWorkspacePrivateAccess(
    {
      jaeger: f.origin,
      evidence: credentials,
      privateAccess: {
        acp: f.origin,
        identity: "http://127.0.0.1:" + identity.address().port,
        otlp: f.origin + "/v1/traces",
        credentials,
      },
    },
    {
      secrets: [],
      preserveConnection: (index, snapshot) =>
        connections.push({ index, snapshot: structuredClone(snapshot) }),
      preserveWatch: (index, snapshot) =>
        watches.push({ index, snapshot: structuredClone(snapshot) }),
      preserveState: (index, snapshot) =>
        states.push({ index, snapshot: structuredClone(snapshot) }),
      preserveAuthority: (scope, rows) =>
        authorities.push({ ...scope, rows: structuredClone(rows) }),
      ...options,
    },
  );
  return {
    ...f,
    access,
    identities,
    connections,
    watches,
    states,
    authorities,
    setIdentity(value) {
      reply = value;
    },
  };
}

test("Workspace access uses separate original authority scopes for actual private connections and state", async (t) => {
  const f = await fixture(t);
  const c = f.register(await f.access.open("agent", f.browser, principal));
  const { sessionId } = await c.request("new", setup);
  await c.notify("cancel", { sessionId });
  assert.deepEqual(
    await f.access.state("agent", f.browser, principal),
    f.state,
  );
  const closing = f.access.closeAndWait();
  assert.strictEqual(f.access.closeAndWait(), closing);
  await closing;
  assert.equal(f.identities.length, 2);
  assert.equal(f.access.snapshots().length, 1);
  assert.equal(f.access.snapshots()[0].closed, true);
  assert.equal(f.access.stateReceipts().length, 1);
  const scopes = f.access.authoritySnapshots();
  assert.deepEqual(
    scopes.map((row) => row.kind),
    ["connection", "state"],
  );
  assert.equal(new Set(scopes.map((row) => row.operation_id)).size, 2);
  assert(
    scopes.every(
      (row) => row.receipts.length === 1 && row.receipts[0].status === 200,
    ),
  );
  for (let index = 0; index < scopes.length; index++) {
    const row = scopes[index].receipts[0];
    assert.equal(row.response_trace_id, null);
    assert.match(row.traceID, /^[a-f0-9]{32}$/u);
    assert.match(row.clientSpanID, /^[a-f0-9]{16}$/u);
    assert.equal(
      f.identities[index].headers.traceparent,
      `00-${row.traceID}-${row.clientSpanID}-01`,
    );
  }
  assert.equal(
    new Set(scopes.map((scope) => scope.receipts[0].traceID)).size,
    2,
  );
  assert.equal(f.access.snapshots()[0].authority_scope, scopes[0].operation_id);
  assert.equal(
    f.access.stateReceipts()[0].authority_scope,
    scopes[1].operation_id,
  );
  assert.deepEqual(f.connections.at(-1).snapshot, f.access.snapshots()[0]);
  assert.deepEqual(f.states.at(-1).snapshot, f.access.stateReceipts()[0]);
  const [notification] = f.access.notificationReceipts();
  assert.strictEqual(
    inspectPrivateNotificationReceipt(notification),
    notification,
  );
  assert.deepEqual(notification, c.notificationReceipts[0]);
  assert.throws(() =>
    inspectPrivateNotificationReceipt(structuredClone(notification)),
  );
  assert.deepEqual(f.access.disconnectReceipts(), []);
  scopes[0].receipts.length = 0;
  assert.equal(f.access.authoritySnapshots()[0].receipts.length, 1);
  assert(f.exports.length > 0);
});

test("Workspace close joins late connection, watch and state before shutting down their exporter", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    order = [];
  let count = 0;
  const factory = (kind) => async (agent, browser, options) => {
    await options.service.workspaceContext(browser.accessToken, agent, {
      signal: options.signal,
    });
    const span = options.telemetry.startHTTP("POST");
    if (++count === 3) entered.resolve();
    await release.promise;
    order.push(kind + "-opened");
    if (kind === "state") {
      options.receipts.push({ agentId: agent, joined: true });
      span.end(200, "eof", 0);
      return { state: true };
    }
    let joined = false;
    return {
      snapshot: () => ({ kind, joined }),
      async closeAndWait() {
        joined = true;
        order.push(kind + "-joined");
        span.end(200, "cancelled", 0);
      },
    };
  };
  const f = await fixture(t, {
    factories: {
      connection: factory("connection"),
      watch: factory("watch"),
      state: factory("state"),
      telemetry(endpoint) {
        const base = createPrivateACPTelemetry(endpoint);
        return {
          ...base,
          async shutdown() {
            order.push("exporter");
            await base.shutdown();
          },
        };
      },
    },
  });
  const pending = [
    f.access.open("agent", f.browser, principal),
    f.access.watch("agent", f.browser, principal),
    f.access.state("agent", f.browser, principal),
  ];
  await entered.promise;
  const closing = f.access.closeAndWait();
  let settled = false;
  void closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await new Promise(setImmediate);
    assert.equal(settled, false);
    await assert.rejects(
      async () => f.access.open("agent", f.browser, principal),
      /closing/u,
    );
    await assert.rejects(
      async () => f.access.state("agent", f.browser, principal),
      /closing/u,
    );
  } finally {
    release.resolve();
  }
  await Promise.all(pending);
  await closing;
  assert.equal(order.at(-1), "exporter");
  assert(
    order.includes("connection-joined") &&
      order.includes("watch-joined") &&
      order.includes("state-opened"),
  );
  assert.equal(f.access.snapshots()[0].joined, true);
  assert.equal(f.access.watchSnapshots()[0].joined, true);
  assert.equal(f.access.stateReceipts()[0].joined, true);
  assert.equal(f.identities.length, 3);
  assert(f.exports.length > 0);
});

test("Workspace retains observed late opening, sibling close, archive and final exporter cancellation errors", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    abort = new AbortController();
  const originals = [
    "late opening",
    "sibling close",
    "archive",
    "exporter cancellation",
  ].map((label) => new Error("original " + label));
  let siblingJoined = false,
    exporterJoined = false;
  const f = await fixture(t, {
    signal: abort.signal,
    allowCloseFailure: true,
    preserveConnection() {
      throw originals[2];
    },
    factories: {
      async connection(agent, browser, options) {
        await options.service.workspaceContext(browser.accessToken, agent);
        return {
          snapshot: () => ({ joined: siblingJoined }),
          async closeAndWait() {
            siblingJoined = true;
            throw originals[1];
          },
        };
      },
      async watch() {
        entered.resolve();
        await release.promise;
        throw originals[0];
      },
      telemetry(endpoint) {
        const base = createPrivateACPTelemetry(endpoint);
        return {
          ...base,
          async shutdown() {
            await base.shutdown();
            exporterJoined = true;
            abort.abort(originals[3]);
          },
        };
      },
    },
  });
  await f.access.open("agent", f.browser, principal);
  const opening = f.access.watch("agent", f.browser, principal);
  void opening.catch(() => {});
  await entered.promise;
  const closing = f.access.closeAndWait();
  void closing.catch(() => {});
  release.resolve();
  await assert.rejects(opening, (error) => error === originals[0]);
  await assert.rejects(closing, (error) =>
    originals.every((original) => contains(error, original)),
  );
  assert(siblingJoined && exporterJoined);
  assert.equal(f.access.snapshots()[0].joined, true);
});

test("Workspace accepts only the actual original-token Identity 401 on a new connection attempt", async (t) => {
  const f = await fixture(t);
  const c = f.register(await f.access.open("agent", f.browser, principal));
  await c.closeAndWait();
  f.setIdentity({ status: 401, body: unauthorized });
  const receipt = await f.access.denyNewConnection(
    "agent",
    f.browser,
    principal,
    { after: Date.now() },
  );
  await f.access.closeAndWait();
  assert.equal(receipt.status, 401);
  assert.deepEqual(
    JSON.parse(Buffer.from(receipt.raw_body_base64, "base64")),
    unauthorized,
  );
  assert.equal(f.access.snapshots().length, 1);
  assert.equal(f.wire.filter((row) => row.method === "initialize").length, 1);
  assert.equal(f.identities.length, 2);
  assert.equal(f.access.authoritySnapshots().at(-1).kind, "denied-connection");
});

for (const [label, response] of [
  ["workload denial", { status: 403, body: { code: "caller_not_allowed" } }],
  [
    "dependency failure",
    { status: 503, body: { code: "dependency_unavailable" } },
  ],
  ["different 401", { status: 401, body: { code: "expired" } }],
  [
    "unexpected accepted connection",
    {
      status: 200,
      body: { caller_context: "foundation-issued-context", principal },
    },
  ],
]) {
  test(
    "Workspace does not substitute " + label + " for owner revocation",
    async (t) => {
      const f = await fixture(t, { allowCloseFailure: true });
      f.setIdentity(response);
      await assert.rejects(
        f.access.denyNewConnection("agent", f.browser, principal, {
          after: Date.now(),
        }),
      );
      await assert.rejects(f.access.closeAndWait());
      if (response.status === 200)
        assert.equal(f.access.snapshots()[0].closed, true);
      else assert.equal(f.wire.length, 0);
    },
  );
}

test("Workspace denial cannot hide an Identity archive failure", async (t) => {
  const original = new Error("original denial archive failure");
  const f = await fixture(t, {
    allowCloseFailure: true,
    preserveAuthority() {
      throw original;
    },
  });
  f.setIdentity({ status: 401, body: unauthorized });
  await assert.rejects(
    f.access.denyNewConnection("agent", f.browser, principal, {
      after: Date.now(),
    }),
    (error) => contains(error, original),
  );
  await assert.rejects(f.access.closeAndWait(), (error) =>
    contains(error, original),
  );
  assert.equal(f.wire.length, 0);
});

test("Workspace keeps a handled state failure for final resource admission and still joins a sibling connection", async (t) => {
  const f = await fixture(t, { allowCloseFailure: true });
  const c = f.register(await f.access.open("agent", f.browser, principal));
  delete f.state.configuration_revision;
  let original;
  await assert.rejects(
    f.access.state("agent", f.browser, principal),
    (error) => {
      original = error;
      return true;
    },
  );
  await assert.rejects(f.access.closeAndWait(), (error) =>
    contains(error, original),
  );
  assert.equal(c.snapshot().closed, true);
  const [row] = f.access.stateReceipts();
  assert.equal(row.joined, true);
  assert.equal(row.authority.length, 1);
  assert.equal(
    JSON.parse(Buffer.from(row.raw_body_base64, "base64"))
      .configuration_revision,
    undefined,
  );
  assert.deepEqual(f.states.at(-1).snapshot, row);
});

test("Workspace close joins an already-running collector whose original diagnostic failure stays auxiliary", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const original = new Error("original Workspace collector failure");
  const f = await fixture(t, {
    allowCloseFailure: true,
    async collectTrace(base, expected, options) {
      assert.equal(expected.label, "original");
      assert(options.directory.endsWith("/traces"));
      entered.resolve();
      await release.promise;
      await options.flush();
      throw original;
    },
  });
  const collected = f.access.collect({ label: "original" }, []);
  void collected.catch(() => {});
  await entered.promise;
  const closing = f.access.closeAndWait();
  void closing.catch(() => {});
  release.resolve();
  await assert.rejects(collected, (error) => error === original);
  await closing;
});

test("Workspace exporter failure stays auxiliary after its shutdown actually joins", async (t) => {
  const order = [];
  const f = await fixture(t, {
    factories: {
      telemetry(endpoint) {
        const base = createPrivateACPTelemetry(endpoint);
        return {
          ...base,
          async shutdown() {
            await base.shutdown();
            order.push("shutdown-joined");
            throw new Error("original exporter shutdown failure");
          },
        };
      },
    },
  });
  await f.access.closeAndWait();
  assert.deepEqual(order, ["shutdown-joined"]);
  const diagnostic = f.access.traceDiagnostics();
  assert.equal(diagnostic.role, "auxiliary");
  assert.equal(diagnostic.status, "warning");
  assert.equal(diagnostic.checks[0].status, "failed");
});

test("Workspace closes watched resources before waiting for collectors that need their finished spans", async (t) => {
  const closedGate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const order = [];
  const f = await fixture(t, {
    factories: {
      async watch(agent, browser, options) {
        await options.service.workspaceContext(browser.accessToken, agent);
        const span = options.telemetry.startHTTP("POST");
        return {
          snapshot: () => ({ joined: order.includes("watch-joined") }),
          async closeAndWait() {
            order.push("watch-joined");
            span.end(200, "cancelled", 0);
            closedGate.resolve();
          },
        };
      },
      telemetry(endpoint) {
        const base = createPrivateACPTelemetry(endpoint);
        return {
          ...base,
          async shutdown() {
            order.push("exporter");
            await base.shutdown();
          },
        };
      },
    },
    async collectTrace(_base, _expected, options) {
      entered.resolve();
      await closedGate.promise;
      await options.flush();
      order.push("collector-joined");
      return { completed: true };
    },
  });
  await f.access.watch("agent", f.browser, principal);
  const collected = f.access.collect({}, []);
  await entered.promise;
  const closing = f.access.closeAndWait();
  try {
    await new Promise(setImmediate);
    assert(
      order.includes("watch-joined"),
      "close is waiting for a collector that needs the watch to close",
    );
  } finally {
    // Release only to join a failing implementation; the assertion remains red.
    closedGate.resolve();
    await Promise.allSettled([collected, closing]);
  }
  assert.deepEqual(order, ["watch-joined", "collector-joined", "exporter"]);
  assert.deepEqual(await collected, { completed: true });
  await closing;
});
