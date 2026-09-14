import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { gatewayLogin, gatewayCommand } from "./stage2-gateway.mjs";

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test("Gateway client uses login cookies and CSRF, never trusted identity or fabricated trace parents", async (t) => {
  const calls = [];
  const url = await fixture(t, (request, response) => {
    calls.push(request);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/session/login") {
      response.setHeader("set-cookie", [
        "antnest_session=test-session; HttpOnly",
        "antnest_csrf=test-csrf; SameSite=Lax",
      ]);
      response.end(JSON.stringify({ principal: { user_id: "user" } }));
    } else {
      response.writeHead(202, { "x-antnest-trace-id": "a".repeat(32) });
      response.end(JSON.stringify({ operation: { request_id: "operation" } }));
    }
  });
  const login = await gatewayLogin(url, "org", "owner@example.com", "test-password");
  const result = await gatewayCommand(url, login, "/api/admin/agents", { name: "test" }, "create");
  assert.equal(result.traceId, "a".repeat(32));
  assert.equal(result.payload.operation.request_id, "operation");
  assert.equal(calls[1].headers.cookie, "antnest_session=test-session; antnest_csrf=test-csrf");
  assert.equal(calls[1].headers["x-antnest-csrf-token"], "test-csrf");
  assert.equal(calls[1].headers["idempotency-key"], "create");
  assert.equal(calls[1].headers.origin, url);
  assert.equal(calls[1].headers.traceparent, undefined);
  assert.equal(calls[1].headers["x-antnest-user-id"], undefined);
});

test("Gateway login rejects a successful response without a real session cookie", async (t) => {
  const url = await fixture(t, (_request, response) => response.end('{"principal":{}}'));
  await assert.rejects(gatewayLogin(url, "org", "owner@example.com", "test-password"));
});

for (const status of [200, 202])
  test(`Gateway command rejects status ${status} without lifecycle trace evidence`, async (t) => {
    const url = await fixture(t, (_request, response) => {
      response.writeHead(status);
      response.end("{}");
    });
    await assert.rejects(
      gatewayCommand(
        url,
        { cookie: "antnest_csrf=test", csrf: "test" },
        "/api/admin/agents",
        {},
        "create",
      ),
    );
  });
