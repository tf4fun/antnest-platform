import "../identity-closeout/acp-client-dependencies.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { serviceClient } from "../../support/service-grants.mjs";
import { createWorkspaceAuthority } from "./private-authority.mjs";
const { createPrivateACPTelemetry } =
  await import("../identity-closeout/private-acp-telemetry.mjs");
const url = new URL("./private-state.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const principal = { organization_id: "organization", user_id: "owner" };
const token = "original-workspace-state-session";
const path = "/rpc/agent-acp/get-agent-execution-state";
const ready = {
  agent_id: "agent",
  access_allowed: true,
  availability: "ready",
  active_session_id: null,
  configuration_revision: "a".repeat(64),
  unavailable_reason: null,
};
const contains = (error, original) =>
  error === original ||
  (error?.errors ?? []).some((item) => contains(item, original));
async function fixture(
  t,
  {
    status = 200,
    body = JSON.stringify(ready),
    type = "application/json",
  } = {},
) {
  assert.equal(typeof implementation.readWorkspacePrivateState, "function");
  const requests = [],
    exports = [],
    failures = [],
    receipts = [],
    saved = [];
  const abort = new AbortController();
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const value = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({
        path: request.url,
        headers: request.headers,
        body: value,
      });
      if (request.url === "/v1/traces") {
        exports.push(value);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end("{}");
      } else if (request.url === "/rpc/identity/resolve-access-token") {
        assert.equal(value.access_token, token);
        assert.equal(value.agent_id, "agent");
        assert.equal(value.profile, "workspace");
        response
          .writeHead(200, {
            "content-type": "application/json",
            "x-antnest-trace-id": "1".repeat(32),
          })
          .end(
            JSON.stringify({
              principal,
              caller_context: "original-state-context",
            }),
          );
      } else {
        assert.equal(request.url, path);
        assert.equal(request.method, "POST");
        assert.deepEqual(value, {});
        assert.equal(request.headers.cookie, undefined);
        assert.equal(
          request.headers["antnest-caller-context"],
          "original-state-context",
        );
        assert.equal(
          request.headers["antnest-service-authorization"],
          "Bearer " + "W".repeat(43),
        );
        const trace = request.headers.traceparent?.split("-")[1];
        assert.match(trace, /^[a-f0-9]{32}$/u);
        response.writeHead(status, {
          "content-type": type,
          "x-antnest-trace-id": trace,
        });
        response.write(body.slice(0, 17));
        response.end(body.slice(17));
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
  const secrets = [];
  const authority = createWorkspaceAuthority({
    service: serviceClient({
      identityEndpoint: origin,
      readCredential: (grant) =>
        (grant === "gateway-identity" ? "G" : "W").repeat(43),
    }),
    identityEndpoint: origin,
    agentId: "agent",
    browser: { accessToken: token },
    principal,
    signal: abort.signal,
    secrets,
    preserve() {},
  });
  t.after(async () => {
    await authority.closeAndWait().catch(() => {});
    await telemetry.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  const options = {
    endpoint: origin + path,
    principal,
    service: authority.service,
    telemetry,
    signal: abort.signal,
    secrets,
    receipts,
    preserve: (value) => saved.push(structuredClone(value)),
  };
  return {
    requests,
    exports,
    receipts,
    saved,
    authority,
    abort,
    telemetry,
    options,
    read: () =>
      implementation.readWorkspacePrivateState(
        "agent",
        { accessToken: token },
        options,
      ),
  };
}

test("Workspace state binds original authority, complete raw body and an actual exported HTTP CLIENT", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.read(), ready);
  await f.telemetry.flush();
  const [row] = f.receipts;
  assert.equal(f.receipts.length, 1);
  assert.equal(row.joined, true);
  assert.equal(row.body_outcome, "eof");
  assert.equal(row.status, 200);
  assert.deepEqual(row.errors, []);
  assert.deepEqual(row.principal, principal);
  assert.equal(
    row.session_digest,
    createHash("sha256").update(token).digest("hex"),
  );
  assert.equal(row.method, "POST");
  assert.equal(row.path, path);
  assert.deepEqual(row.request_body, {});
  assert.equal(
    Buffer.from(row.raw_body_base64, "base64").toString(),
    JSON.stringify(ready),
  );
  assert.equal(row.body_bytes, Buffer.byteLength(JSON.stringify(ready)));
  assert.equal(row.response_trace_id, row.traceID);
  assert.equal(
    f.requests.find((r) => r.path === path).headers.traceparent,
    `00-${row.traceID}-${row.clientSpanID}-01`,
  );
  const spans = f.exports
    .flatMap((r) => r.resourceSpans ?? [])
    .flatMap((r) => r.scopeSpans ?? [])
    .flatMap((r) => r.spans ?? []);
  assert(
    spans.some(
      (span) =>
        span.traceId === row.traceID &&
        span.spanId === row.clientSpanID &&
        span.kind === 3,
    ),
  );
  assert.deepEqual(f.saved.at(-1), row);
  assert.equal(f.authority.snapshot().length, 1);
  assert.equal(
    f.requests.filter((r) => r.path.includes("resolve-access-token")).length,
    1,
  );
});

for (const [label, response] of [
  ["malformed JSON", { body: '{"secret":"state-response-canary"' }],
  [
    "missing field",
    { body: JSON.stringify({ ...ready, configuration_revision: undefined }) },
  ],
  [
    "foreign Agent",
    { body: JSON.stringify({ ...ready, agent_id: "state-response-canary" }) },
  ],
  ["wrong content type", { type: "text/plain" }],
  [
    "wrong status",
    { status: 403, body: JSON.stringify({ code: "state-response-canary" }) },
  ],
  [
    "startup unavailable",
    {
      status: 503,
      body: JSON.stringify({
        code: "execution_state_unavailable",
        message: "Agent execution state is unavailable",
        retryable: true,
      }),
    },
  ],
]) {
  test(
    "Workspace state retains original bytes and rejects " + label,
    async (t) => {
      const f = await fixture(t, response);
      await assert.rejects(f.read(), (error) => {
        assert(!error.message.includes("state-response-canary"));
        return true;
      });
      const [row] = f.receipts;
      assert.equal(row.joined, true);
      assert.equal(row.body_outcome, "eof");
      assert(row.errors.length > 0);
      assert.equal(row.status, response.status ?? 200);
      assert.equal(
        Buffer.from(row.raw_body_base64, "base64").toString(),
        response.body ?? JSON.stringify(ready),
      );
      assert.deepEqual(f.saved.at(-1), row);
    },
  );
}

function controlled(overrides = {}) {
  assert.equal(typeof implementation.readWorkspacePrivateState, "function");
  const receipts = [],
    order = [],
    saved = [];
  const reader = {
    reads: 0,
    async read() {
      return this.reads++
        ? { done: true }
        : { value: Buffer.from(JSON.stringify(ready)), done: false };
    },
    async cancel() {
      order.push("cancel");
    },
    releaseLock() {
      order.push("release");
    },
  };
  const options = {
    endpoint: "http://127.0.0.1:1" + path,
    principal,
    receipts,
    secrets: [],
    service: {
      async workspaceContext() {
        return { context: "original-state-context", principal };
      },
      authorization() {
        return { "Antnest-Service-Authorization": "Bearer " + "W".repeat(43) };
      },
      async send() {
        return {
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          body: { getReader: () => reader },
        };
      },
    },
    telemetry: {
      startHTTP() {
        return {
          traceID: "a".repeat(32),
          clientSpanID: "b".repeat(16),
          traceparent: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01",
          end() {
            order.push("span-end");
          },
        };
      },
    },
    preserve(value) {
      order.push("archive");
      saved.push(structuredClone(value));
    },
    ...overrides,
  };
  return {
    reader,
    options,
    receipts,
    saved,
    order,
    read: () =>
      implementation.readWorkspacePrivateState(
        "agent",
        { accessToken: token },
        options,
      ),
  };
}

test("Workspace state keeps original read, cancel, release and archive failures while joining", async () => {
  const errors = ["read", "cancel", "release", "archive"].map(
    (value) => new Error("original " + value),
  );
  const f = controlled({
    preserve() {
      throw errors[3];
    },
  });
  f.reader.read = async () => {
    throw errors[0];
  };
  f.reader.cancel = async () => {
    f.order.push("cancel");
    throw errors[1];
  };
  f.reader.releaseLock = () => {
    f.order.push("release");
    throw errors[2];
  };
  await assert.rejects(f.read(), (error) =>
    errors.every((original) => contains(error, original)),
  );
  assert.deepEqual(f.order, ["cancel", "release", "span-end"]);
  assert.equal(f.receipts[0].joined, true);
  assert.equal(f.receipts[0].errors.length, 4);
});

test("Workspace state preserves the actual request Error and ends its CLIENT before archiving", async () => {
  const original = new Error("original fetch failure"),
    f = controlled();
  f.options.service.send = async () => {
    throw original;
  };
  await assert.rejects(f.read(), (error) => error === original);
  assert.deepEqual(f.order, ["span-end", "archive"]);
  assert.equal(f.receipts[0].body_outcome, "failed");
  assert.equal(f.receipts[0].body_bytes, 0);
});

test("Workspace state keeps cancellation during its final archive by original identity", async () => {
  const abort = new AbortController(),
    reason = new Error("late state cancellation");
  const f = controlled({
    signal: abort.signal,
    async preserve() {
      await Promise.resolve();
      abort.abort(reason);
    },
  });
  await assert.rejects(f.read(), (error) => error === reason);
  assert.equal(f.receipts[0].joined, true);
  assert(f.receipts[0].errors.some((value) => value.includes(reason.message)));
});

test("Workspace state rejects an oversized body and still releases its reader", async () => {
  const f = controlled();
  f.reader.read = async () => ({
    done: false,
    value: Buffer.alloc(1024 * 1024 + 1, 32),
  });
  await assert.rejects(f.read(), /bound/u);
  assert.deepEqual(f.order, ["cancel", "release", "span-end", "archive"]);
  assert.equal(f.receipts[0].body_bytes, 1024 * 1024 + 1);
});

test("Workspace state rejects changed authority without exposing the returned Principal", async () => {
  const f = controlled();
  f.options.service.workspaceContext = async () => ({
    context: "context",
    principal: { ...principal, user_id: "state-response-canary" },
  });
  await assert.rejects(
    f.read(),
    (error) =>
      /authority/u.test(error.message) &&
      !error.message.includes("state-response-canary"),
  );
  assert.equal(f.order.length, 0);
});
