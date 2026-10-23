import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { snapshotSession, resumeSession } from "./browser-session.mjs";

const principal = (actor) => ({
  user_id: actor,
  organization_id: "org-readiness",
  membership_id: `membership-${actor}`,
  organization_role: actor === "admin" ? "admin" : "member",
  system_role: "user",
  active: true,
});

async function fixture(
  t,
  { failureStatus, activityStatus, changedPrincipal } = {},
) {
  const calls = [],
    logins = new Map();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    calls.push({ method: request.method, path: request.url });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/session/login") {
      const actor = JSON.parse(text).email;
      logins.set(actor, (logins.get(actor) ?? 0) + 1);
      if (logins.get(actor) > 10) {
        response.writeHead(429).end('{"code":"login_rate_limited"}');
        return;
      }
      response.setHeader("Set-Cookie", [
        `__Host-antnest_session=${actor}-token; Secure; HttpOnly; Path=/`,
        `__Host-antnest_csrf=${actor}-csrf; Secure; Path=/`,
      ]);
      response.end(JSON.stringify({ principal: principal(actor) }));
      return;
    }
    const actor = request.headers.cookie?.includes("admin-token")
      ? "admin"
      : "member";
    if (!request.headers.cookie?.includes(`${actor}-token`) || failureStatus) {
      response.writeHead(failureStatus ?? 401).end('{"code":"private-canary"}');
      return;
    }
    if (request.url === "/api/session" && request.method === "GET") {
      response.end(
        JSON.stringify({ principal: changedPrincipal ?? principal(actor) }),
      );
      return;
    }
    if (request.url === "/api/session/activity" && request.method === "POST") {
      if (
        request.headers["x-antnest-csrf-token"] !== `${actor}-csrf` ||
        text !== "{}"
      ) {
        response.writeHead(403).end("{}");
        return;
      }
      if (activityStatus) {
        response.writeHead(activityStatus).end('{"code":"private-canary"}');
        return;
      }
      response.end(
        JSON.stringify({
          expires_at: new Date(Date.now() + 43200000).toISOString(),
          idle_expires_at: new Date(Date.now() + 1800000).toISOString(),
          activity_interval_ms: 30000,
        }),
      );
      return;
    }
    response.writeHead(404).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { base: `http://127.0.0.1:${server.address().port}`, calls, logins };
}

async function login(base, actor) {
  const client = new GatewayClient(base);
  const { body } = await client.request("/api/session/login", {
    body: { email: actor },
  });
  return snapshotSession(client, body.principal);
}

test("100 fresh command clients reuse the two original password sessions with bound CSRF", async (t) => {
  const server = await fixture(t);
  const sessions = {
    admin: await login(server.base, "admin"),
    member: await login(server.base, "member"),
  };
  const original = structuredClone(sessions);
  for (let index = 0; index < 100; index++) {
    for (const actor of ["admin", "member", "admin"]) {
      const client = new GatewayClient(server.base);
      assert.deepEqual(
        await resumeSession(client, sessions[actor]),
        principal(actor),
      );
      assert.equal(client.requests, 2);
    }
  }
  assert.deepEqual(
    [...server.logins],
    [
      ["admin", 1],
      ["member", 1],
    ],
  );
  assert.equal(
    server.calls.filter((call) => call.path === "/api/session/activity").length,
    300,
  );
  assert.deepEqual(sessions, original);
});

for (const failureStatus of [401, 403, 429, 503]) {
  test(`session HTTP ${failureStatus} stops without password login or a request retry`, async (t) => {
    const server = await fixture(t, { failureStatus });
    const session = await login(server.base, "member");
    await assert.rejects(
      resumeSession(new GatewayClient(server.base), session),
      new RegExp(`HTTP ${failureStatus}`),
    );
    assert.deepEqual(
      server.calls.map((call) => call.path),
      ["/api/session/login", "/api/session"],
    );
  });
}

for (const activityStatus of [401, 403, 429, 503]) {
  test(`activity HTTP ${activityStatus} stops after identity verification without relogin or retry`, async (t) => {
    const server = await fixture(t, { activityStatus });
    const session = await login(server.base, "member");
    await assert.rejects(
      resumeSession(new GatewayClient(server.base), session),
      new RegExp(`HTTP ${activityStatus}`),
    );
    assert.deepEqual(
      server.calls.map((call) => call.path),
      ["/api/session/login", "/api/session", "/api/session/activity"],
    );
  });
}

for (const changed of [
  { user_id: "another-user" },
  { organization_id: "another-org" },
  { membership_id: "another-membership" },
  { organization_role: "admin" },
  { system_role: "administrator" },
  { active: false },
]) {
  test(`changed session identity ${Object.keys(changed)[0]} cannot reach activity or business`, async (t) => {
    const server = await fixture(t, {
      changedPrincipal: { ...principal("member"), ...changed },
    });
    const session = await login(server.base, "member");
    await assert.rejects(
      resumeSession(new GatewayClient(server.base), session),
    );
    assert.equal(server.calls.length, 2);
  });
}
