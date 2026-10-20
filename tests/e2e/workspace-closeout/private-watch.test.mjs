import "../identity-closeout/acp-client-dependencies.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { serviceClient } from "../../support/service-grants.mjs";
const { createPrivateACPTelemetry } =
  await import("../identity-closeout/private-acp-telemetry.mjs");
const url = new URL("./private-watch.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const principal = { organization_id: "organization", user_id: "owner" };
const token = "original-workspace-session";
const digest = createHash("sha256").update(token).digest("hex");
const path = "/rpc/agent-acp/watch-agent-execution-state";
const ready = {
  agent_id: "agent",
  access_allowed: true,
  availability: "ready",
  active_session_id: null,
  configuration_revision: "a".repeat(64),
  unavailable_reason: null,
};
const denied = {
  agent_id: "agent",
  access_allowed: false,
  availability: "offline",
  active_session_id: null,
  configuration_revision: null,
  unavailable_reason: "access_denied",
};
const frame = (value) =>
  "event: workspace_state\ndata: " + JSON.stringify(value) + "\n\n";
async function fixture(t) {
  assert.equal(typeof implementation.openWorkspacePrivateWatch, "function");
  const requests = [],
    exports = [],
    saved = [],
    clients = [],
    failures = [];
  const abort = new AbortController();
  let reply;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ path: request.url, headers: request.headers, body });
      if (request.url === "/rpc/identity/resolve-access-token") {
        assert.equal(body.access_token, token);
        assert.equal(body.agent_id, "agent");
        assert.equal(body.profile, "workspace");
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            caller_context: "original-issued-context",
            principal,
          }),
        );
      } else if (request.url === "/v1/traces") {
        exports.push(body);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end("{}");
      } else {
        assert.equal(request.url, path);
        assert.equal(request.method, "POST");
        assert.equal(request.headers.cookie, undefined);
        assert.equal(
          request.headers["antnest-caller-context"],
          "original-issued-context",
        );
        assert.equal(
          request.headers["antnest-service-authorization"],
          "Bearer " + "W".repeat(43),
        );
        assert.deepEqual(body, {});
        reply = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame(ready));
      }
    })().catch((error) => {
      failures.push(error);
      response.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  const telemetry = createPrivateACPTelemetry(origin + "/v1/traces");
  t.after(async () => {
    for (const client of clients) await client.closeAndWait().catch(() => {});
    abort.abort();
    await telemetry.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  return {
    requests,
    exports,
    saved,
    telemetry,
    abort,
    async open() {
      const client = await implementation.openWorkspacePrivateWatch(
        "agent",
        { accessToken: token },
        {
          principal,
          signal: abort.signal,
          secrets: [],
          telemetry,
          endpoint: origin + path,
          preserve: (value) => saved.push(structuredClone(value)),
          service: serviceClient({
            identityEndpoint: origin,
            readCredential: (grant) =>
              (grant === "gateway-identity" ? "G" : "W").repeat(43),
          }),
        },
      );
      clients.push(client);
      await client.ready();
      return client;
    },
    write: (value) => reply.write(frame(value)),
    end: () => reply.end(),
    reset: () => reply.destroy(),
  };
}
const expected = (receipt, mode, window) => ({
  agentID: "agent",
  principal,
  session_digest: digest,
  traceID: receipt.traceID,
  clientSpanID: receipt.clientSpanID,
  mode,
  window,
  ...(mode === "revocation"
    ? {
        revocationTraceID: "c".repeat(32),
        revocationStart: structuredClone(receipt.revocation_start),
      }
    : {}),
});

test("Workspace local watch retains actual private body, original identity, event indices and joined CLIENT", async (t) => {
  const f = await fixture(t),
    watch = await f.open();
  const first = await watch.wait((state) => state.availability === "ready");
  assert.equal(watch.states.indexOf(first), 0);
  assert(Object.isFrozen(first));
  f.write({ ...ready, availability: "busy", active_session_id: "session" });
  const next = await watch.wait((state) => state.availability === "busy", 1);
  assert.equal(watch.states.indexOf(next), 1);
  const window = { start: Date.now() };
  await watch.closeAndWait();
  window.end = Date.now();
  const receipt = watch.snapshot();
  implementation.assertWorkspaceWatchReceipt(
    receipt,
    expected(receipt, "local-close", window),
  );
  assert.deepEqual(f.saved.at(-1), receipt);
  assert.equal(f.requests.filter((r) => r.path === path).length, 1);
  assert.equal(receipt.response_trace_id, null);
  await f.telemetry.flush();
  const spans = f.exports
    .flatMap((r) => r.resourceSpans ?? [])
    .flatMap((r) => r.scopeSpans ?? [])
    .flatMap((r) => r.spans ?? []);
  assert(
    spans.some(
      (span) =>
        span.traceId === receipt.traceID &&
        span.spanId === receipt.clientSpanID &&
        span.kind === 3,
    ),
  );
});

test("Workspace denied state does not locally cancel the observer; only real EOF proves revocation", async (t) => {
  const f = await fixture(t),
    watch = await f.open();
  const boundary = watch.beginRevocation();
  assert(Object.isFrozen(boundary));
  assert.throws(() => watch.beginRevocation());
  const window = { start: boundary.observedAt };
  f.write(denied);
  await watch.wait((state) => !state.access_allowed, 1);
  assert.equal(watch.snapshot().joined, false);
  assert.equal(watch.closure, undefined);
  assert.throws(() =>
    implementation.assertWorkspaceWatchReceipt(
      watch.snapshot(),
      expected(watch.snapshot(), "revocation", { ...window, end: Date.now() }),
    ),
  );
  f.end();
  await watch.waitClosed();
  window.end = Date.now();
  const first = watch.closure;
  const receipt = await watch.closeAndWait();
  assert.equal(watch.closure, first);
  implementation.assertWorkspaceWatchReceipt(
    receipt,
    expected(receipt, "revocation", window),
  );
  assert.equal(receipt.body_outcome, "eof");
  assert.deepEqual(receipt.events.at(-1), denied);
});

for (const kind of [
  "missing denial",
  "event after denial",
  "local cleanup",
  "network reset",
  "parent abort",
]) {
  test(
    "Workspace revocation rejects " + kind + " using real HTTP",
    async (t) => {
      const f = await fixture(t),
        watch = await f.open();
      const window = { start: watch.beginRevocation().observedAt };
      if (kind !== "missing denial") {
        f.write(denied);
        await watch.wait((state) => !state.access_allowed, 1);
      }
      if (kind === "event after denial") f.write(ready);
      if (kind === "local cleanup") await watch.closeAndWait();
      else if (kind === "network reset") f.reset();
      else if (kind === "parent abort")
        f.abort.abort(new Error("original parent abort"));
      else f.end();
      if (kind !== "local cleanup") await watch.waitClosed().catch(() => {});
      await watch.closeAndWait().catch(() => {});
      window.end = Date.now();
      assert.throws(() =>
        implementation.assertWorkspaceWatchReceipt(
          watch.snapshot(),
          expected(watch.snapshot(), "revocation", window),
        ),
      );
    },
  );
}

test("Workspace cannot borrow a denial observed before the revocation window", async (t) => {
  const f = await fixture(t),
    watch = await f.open();
  f.write(denied);
  await watch.wait((state) => !state.access_allowed, 1);
  assert.throws(() => watch.beginRevocation());
  const window = { start: Date.now() };
  f.end();
  await watch.waitClosed();
  window.end = Date.now();
  const receipt = await watch.closeAndWait();
  assert.throws(() =>
    implementation.assertWorkspaceWatchReceipt(
      receipt,
      expected(receipt, "revocation", window),
    ),
  );
});

function validReceipt() {
  const events = [ready, denied],
    raw = Buffer.from(events.map(frame).join(""));
  return {
    agentId: "agent",
    principal,
    session_digest: digest,
    method: "POST",
    path,
    request_body: {},
    traceID: "a".repeat(32),
    clientSpanID: "b".repeat(16),
    status: 200,
    content_type: "text/event-stream",
    response_trace_id: null,
    events: structuredClone(events),
    terminal_events: [],
    body_outcome: "eof",
    raw_body_base64: raw.toString("base64"),
    body_bytes: raw.length,
    closure: {
      kind: "transport-end",
      traceID: "a".repeat(32),
      clientSpanID: "b".repeat(16),
      observedAt: 150,
      receivedEvents: 2,
    },
    joined: true,
    errors: [],
    revocation_start: {
      traceID: "a".repeat(32),
      clientSpanID: "b".repeat(16),
      observedAt: 100,
      receivedEvents: 1,
    },
  };
}
test("Workspace watch gate independently replays original body and exact sanitized denial", () => {
  assert.equal(typeof implementation.assertWorkspaceWatchReceipt, "function");
  const receipt = validReceipt();
  implementation.assertWorkspaceWatchReceipt(
    receipt,
    expected(receipt, "revocation", { start: 100, end: 200 }),
  );
});
for (const [label, mutate] of [
  [
    "missing authorized boundary",
    (r) => {
      delete r.revocation_start;
    },
  ],
  [
    "boundary already includes denial",
    (r) => {
      r.revocation_start.receivedEvents = 2;
    },
  ],
  [
    "boundary time changed",
    (r) => {
      r.revocation_start.observedAt = 149;
    },
  ],
  [
    "foreign Agent",
    (r) => {
      r.agentId = "foreign";
    },
  ],
  [
    "foreign Principal",
    (r) => {
      r.principal = { ...principal, user_id: "other" };
    },
  ],
  [
    "other Session",
    (r) => {
      r.session_digest = "d".repeat(64);
    },
  ],
  [
    "wrong HTTP status",
    (r) => {
      r.status = 503;
    },
  ],
  [
    "wrong response Trace",
    (r) => {
      r.response_trace_id = "d".repeat(32);
    },
  ],
  [
    "unjoined reader",
    (r) => {
      r.joined = false;
    },
  ],
  [
    "reader or archive error",
    (r) => {
      r.errors.push("original failure");
    },
  ],
  [
    "body length mismatch",
    (r) => {
      r.body_bytes++;
    },
  ],
  [
    "parsed denial without original body",
    (r) => {
      const raw = Buffer.from(frame(ready));
      r.raw_body_base64 = raw.toString("base64");
      r.body_bytes = raw.length;
    },
  ],
  [
    "changed terminal state",
    (r) => {
      r.events.at(-1).configuration_revision = "e".repeat(64);
    },
  ],
  [
    "terminal error envelope",
    (r) => {
      r.terminal_events.push({ code: "execution_state_unavailable" });
    },
  ],
  [
    "closure before revoke",
    (r) => {
      r.closure.observedAt = 99;
    },
  ],
  [
    "closure outside window",
    (r) => {
      r.closure.observedAt = 201;
    },
  ],
  [
    "wrong closure identity",
    (r) => {
      r.closure.clientSpanID = "d".repeat(16);
    },
  ],
  [
    "wrong closure event count",
    (r) => {
      r.closure.receivedEvents--;
    },
  ],
]) {
  test("Workspace watch gate rejects " + label, () => {
    assert.equal(typeof implementation.assertWorkspaceWatchReceipt, "function");
    const receipt = validReceipt(),
      scope = expected(receipt, "revocation", { start: 100, end: 200 });
    mutate(receipt);
    assert.throws(() =>
      implementation.assertWorkspaceWatchReceipt(receipt, scope),
    );
  });
}
