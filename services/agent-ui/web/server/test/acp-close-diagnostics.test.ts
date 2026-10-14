import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { AcpCloseFailures } from "../src/adapters/acp-close-diagnostics.ts";
import { AcpHttpBridge } from "../src/adapters/acp-http.ts";
import { startBridgeTelemetry } from "../src/telemetry.ts";
import { testScope } from "./support/auth-fixture.ts";

const secret = "private-token-cookie-host-and-exception-canary";
for (const [code, classification] of [
  ["ECONNREFUSED", "connection_refused"], ["ECONNRESET", "connection_reset"],
  ["EPIPE", "broken_pipe"], ["ENOTFOUND", "name_unresolved"],
  ["ETIMEDOUT", "connection_timeout"], ["UND_ERR_CONNECT_TIMEOUT", "connection_timeout"],
  ["UND_ERR_SOCKET", "socket_closed"], ["ABORT_ERR", "aborted"],
]) test(`close diagnostics retain only the fixed ${classification} classification (${code})`, () => {
  const failures = new AcpCloseFailures();
  failures.record("delete_request", new TypeError(secret, {
    cause: Object.assign(new Error(secret), { code, address: secret, headers: secret }),
  }));
  assert.deepEqual(failures.entries, [{ stage: "delete_request",
    causes: ["unknown", classification], truncated: false }]);
  assert(!JSON.stringify(failures).includes(secret));
});

for (const name of ["AbortError", "TimeoutError"])
  test(`close diagnostics classify ${name} without exporting its message`, () => {
    const failures = new AcpCloseFailures();
    failures.record("delete_body", new DOMException(secret, name));
    assert.deepEqual(failures.entries[0].causes, [name === "AbortError" ? "aborted" : "timeout"]);
    assert(!JSON.stringify(failures).includes(secret));
  });

for (const cause of [null, undefined, secret, { code: secret, name: secret, message: secret }])
  test(`close diagnostics do not export an unrecognized ${typeof cause} cause`, () => {
    const failures = new AcpCloseFailures();
    failures.record("delete_request", cause);
    assert.deepEqual(failures.entries[0].causes, ["unknown"]);
    assert(!JSON.stringify(failures).includes(secret));
  });

for (const field of ["code", "name", "cause", "errors"])
  test(`close diagnostics preserve cleanup when the ${field} getter throws`, () => {
    const failures = new AcpCloseFailures();
    const cause = new AggregateError([], secret);
    Object.defineProperty(cause, field, { get() { throw new Error(secret); } });
    failures.record("delete_request", cause);
    assert(failures.entries[0].causes.includes("classification_failed"));
    assert(failures.truncated);
    assert(!JSON.stringify(failures).includes(secret));
  });

test("close diagnostics never inspect an arbitrary exception message", () => {
  const failures = new AcpCloseFailures();
  const cause = Object.assign(new Error(), { code: "ECONNREFUSED" });
  Object.defineProperty(cause, "message", { get() { throw new Error(secret); } });
  failures.record("delete_request", cause);
  assert.deepEqual(failures.entries[0].causes, ["connection_refused"]);
  assert.equal(failures.truncated, false);
});

test("close diagnostics bound cyclic, deep and aggregate causes and retain truncation", () => {
  const cyclic = new Error(secret); cyclic.cause = cyclic;
  let deep: Error = new Error(secret);
  for (let i = 0; i < 100; i++) deep = new Error(secret, { cause: deep });
  for (const cause of [cyclic, deep, new AggregateError(Array.from({ length: 100 }, () => new Error(secret)), secret)]) {
    const failures = new AcpCloseFailures();
    failures.record("delete_request", cause);
    assert(failures.truncated);
    assert(failures.entries[0].causes.length <= 16);
    assert(!JSON.stringify(failures).includes(secret));
  }
});

test("close diagnostics bound events while preserving the actual failure count", () => {
  const failures = new AcpCloseFailures();
  for (let i = 0; i < 50; i++) failures.record("body_cleanup", new Error(secret));
  assert.equal(failures.count, 50);
  assert.equal(failures.entries.length, 16);
  assert(failures.truncated);
  assert(!JSON.stringify(failures).includes(secret));
});

test("a body cleanup failure remains distinct from a completed DELETE receipt", async (t) => {
  const received: any[] = [];
  const collector = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    if (request.url === "/v1/traces") received.push(JSON.parse(Buffer.concat(parts).toString()));
    response.writeHead(200).end();
  });
  t.after(async () => {
    collector.closeAllConnections();
    if (collector.listening) await new Promise<void>((resolve, reject) =>
      collector.close(error => error ? reject(error) : resolve()));
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  const address = collector.address();
  assert(address && typeof address !== "string");
  const telemetry = await startBridgeTelemetry({ disabled: false,
    endpoint: new URL(`http://127.0.0.1:${address.port}`), serviceName: "close-body-failure-test" });
  const bodies: ReadableStream[] = [];
  let ready!: () => void, deletions = 0;
  const connected = new Promise<void>(resolve => { ready = resolve; });
  let bridge: AcpHttpBridge | undefined;
  try {
    await telemetry.observeHttp("GET", "/initial-owner", async () => {
      bridge = await AcpHttpBridge.open({ baseUrl: new URL("http://acp.invalid"),
        scope: testScope({ organizationId: "org-1", principalId: "user-1", agentId: "agent-1" }),
        callbacks: { update() {}, requestPermission() { return { outcome: { outcome: "cancelled" } }; } },
        fetchImpl: async (input, init) => {
          const request = new Request(input, init);
          if (request.method === "DELETE") { deletions++; return new Response(null, { status: 202 }); }
          let response: Response;
          if (request.method === "GET") {
            response = new Response(new ReadableStream({ cancel() { throw new Error(secret); } }),
              { headers: { "content-type": "text/event-stream" } });
            ready();
          } else {
            const message = await request.json();
            response = Response.json({ jsonrpc: "2.0", id: message.id, result: {
              protocolVersion: message.params.protocolVersion, agentCapabilities: { loadSession: true },
              _meta: { "antnest.dev/bridge": { intentReceipt: 1, targetCancel: 1, deliveryMark: 1 } },
            } }, { headers: { "acp-connection-id": secret } });
          }
          if (response.body) bodies.push(response.body);
          return response;
        },
      });
      return 200;
    });
    await connected;
    await assert.rejects(bridge!.close(), /cleanup failed/);
    assert.equal(deletions, 1);
    assert(bodies.every(body => !body.locked));
  } finally {
    await bridge?.close().catch(() => {});
    await telemetry.shutdown();
  }
  const spans = received.flatMap(batch => batch.resourceSpans.flatMap((resource: any) =>
    resource.scopeSpans.flatMap((scope: any) => scope.spans)));
  const closes = spans.filter(span => span.name === "agent_ui.acp.close");
  assert.equal(closes.length, 1);
  const closing = closes[0];
  const attrs = Object.fromEntries(closing.attributes.map(({ key, value }: any) =>
    [key.replace("antnest.ui.acp.close.", ""), value.stringValue ?? value.boolValue ?? Number(value.intValue)]));
  for (const [key, expected] of Object.entries({ outcome: "failed", target_observed: true,
    delete_attempts: 1, delete_responses: 1, delete_completed: 1, delete_status: 202,
    pending_requests: 0, stream_joined: true, failures: 1, diagnostics_truncated: false }))
    assert.equal(attrs[key], expected, key);
  assert.equal(closing.events.length, 1);
  assert.equal(closing.events[0].name, "antnest.ui.acp.close.failure");
  const stage = closing.events[0].attributes.find(({ key }: any) => key === "stage");
  assert.equal(stage.value.stringValue, "body_cleanup");
  assert(!JSON.stringify(closing).includes(secret));
});
