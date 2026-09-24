import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createWorkspaceHttpServer } from "../src/http/node-server.ts";

test("Node Bridge serves readiness without creating an ACP owner", async () => {
  let handled = 0;
  const server = createWorkspaceHttpServer({
    async handle() {
      handled += 1;
      return null;
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready",
      service: "agent-ui-bridge",
    });
    assert.equal(handled, 0);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("Node Bridge records bounded HTTP routes and final response statuses", async () => {
  const observed: Array<{ method: string; route: string; status: number }> = [];
  const server = createWorkspaceHttpServer({
    async handle() { return Response.json({ ok: true }); },
  }, { telemetry: {
    async observeHttp(method, route, work) {
      const status = await work();
      observed.push({ method, route, status });
      return status;
    },
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    await fetch(`${base}/status`);
    await fetch(`${base}/api/app/workspace/v1/agents/private-agent/view`);
    assert.deepEqual(observed, [
      { method: "GET", route: "/status", status: 200 },
      { method: "GET", route: "/api/app/workspace/v1/*", status: 200 },
    ]);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("workspace document requires trusted identity and isolates bootstrap by request", async () => {
  const server = createWorkspaceHttpServer({
    async handle(request) {
      assert.equal(new URL(request.url).pathname, "/api/app/workspace/v1/bootstrap");
      const userId = request.headers.get("x-antnest-principal-id");
      return Response.json({ principal: { userId }, agents: [{ name: `Agent ${userId}` }] });
    },
  }, {
    async renderDocument(output, input) {
      output.end(JSON.stringify({ bootstrap: input.bootstrap, route: input.route }));
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/workspace/?agent=agent-1`;
    assert.equal((await fetch(base)).status, 401);
    for (const userId of ["user-one", "user-two"]) {
      const response = await fetch(base, { headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": userId,
        "x-antnest-administrator": "false",
      } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self' 'nonce-/);
      const html = await response.text();
      assert.match(html, new RegExp(`Agent ${userId}`));
      assert.doesNotMatch(html, new RegExp(`Agent user-${userId === "user-one" ? "two" : "one"}`));
      assert.equal(JSON.parse(html).route.agentId, "agent-1");
    }
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("slow authorized bootstrap renders a generic shell within its wait budget", async () => {
  const server = createWorkspaceHttpServer({
    async handle() { return new Promise<Response>(() => {}); },
  }, {
    async renderDocument(output, input) {
      output.end(input.bootstrap === undefined ? "generic-shell" : "private-bootstrap");
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/workspace/`, { headers: {
      "x-antnest-organization-id": "org-1",
      "x-antnest-principal-id": "user-1",
      "x-antnest-administrator": "false",
    } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "generic-shell");
    assert.ok(performance.now() - started < 1000);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
