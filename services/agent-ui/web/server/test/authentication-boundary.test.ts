import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { createWorkspaceHttpServer } from "../src/http/node-server.ts";
import { testAuthentication, workloadHeaders, testContext } from "./support/auth-fixture.ts";
import { readWorkspacePrincipal } from "../src/http/workspace-principal.ts";

test("forged identity headers cannot enter the real Workspace HTTP boundary", async () => {
  let calls = 0;
  const server = createWorkspaceHttpServer({
    async handle() { calls++; return Response.json({ sessions: [] }); },
  }, { authentication: testAuthentication() });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/app/workspace/v1/agents/agent-1/sessions`, {
      headers: {
        "x-antnest-organization-id": "org-1",
        "x-antnest-principal-id": "user-1",
        "x-antnest-agent-id": "agent-1",
        "x-antnest-administrator": "true",
      },
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="antnest-service"');
    assert.equal(calls, 0);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

async function withServer(work: (origin: string, calls: () => number) => Promise<void>) {
  let calls = 0;
  const server = createWorkspaceHttpServer({ async handle() { calls++; return Response.json({ ok: true }); } },
    { authentication: testAuthentication() });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await work(`http://127.0.0.1:${address.port}`, () => calls);
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
}

test("Gateway workload and signed Agent context are both required before dispatch", async () => {
  await withServer(async (origin, calls) => {
    const path = `${origin}/api/app/workspace/v1/agents/agent-1/sessions`;
    const valid = testContext({ agt: "agent-1" }).token;
    for (const [headers, status, code] of [
      [workloadHeaders("admin-console"), 403, "caller_not_allowed"],
      [workloadHeaders(), 401, "caller_context_required"],
      [{ ...workloadHeaders(), "Antnest-Caller-Context": "" }, 401, "caller_context_invalid"],
      [{ ...workloadHeaders(), "Antnest-Caller-Context": "bad" }, 401, "caller_context_invalid"],
      [{ ...workloadHeaders(), "Antnest-Caller-Context": testContext({ agt: "other" }).token }, 401, "caller_context_invalid"],
      [{ ...workloadHeaders(), "Antnest-Caller-Context": testContext({ agt: "agent-1", aud: ["agent-acp-service"] }).token }, 401, "caller_context_invalid"],
      [{ ...workloadHeaders(), "Antnest-Caller-Context": testContext({ agt: "agent-1", iat: 1, exp: 61 }).token }, 401, "caller_context_invalid"],
    ] as const) {
      const response = await fetch(path, { headers }); assert.equal(response.status, status);
      assert.equal((await response.json()).code, code); assert.equal(calls(), 0);
    }
    const accepted = await fetch(path, { headers: { ...workloadHeaders(), "Antnest-Caller-Context": valid,
      "x-antnest-administrator": "true", "x-antnest-organization-id": "forged" } });
    assert.equal(accepted.status, 200); assert.equal(calls(), 1);
  });
});

test("duplicate raw authentication and context fields fail before normalized Headers", async () => {
  await withServer(async (origin, calls) => {
    const token = testContext({ agt: "agent-1" }).token;
    const base = Object.entries({ ...workloadHeaders(), "Antnest-Caller-Context": token }).flat();
    for (const duplicate of ["Antnest-Service-Authorization", "Antnest-Caller-Context"]) {
      const value = duplicate === "Antnest-Caller-Context" ? token : workloadHeaders()["Antnest-Service-Authorization"];
      const result = await new Promise<{ status: number; code: string }>((resolve, reject) => {
        const request = httpRequest(`${origin}/api/app/workspace/v1/agents/agent-1/sessions`,
          { headers: ["Host", new URL(origin).host, ...base, duplicate.toLowerCase(), value] }, response => {
            const chunks: Buffer[] = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () => resolve({ status: response.statusCode!, code: JSON.parse(Buffer.concat(chunks).toString()).code }));
          });
        request.on("error", reject); request.end();
      });
      assert.equal(result.status, 401);
      assert.equal(result.code, duplicate === "Antnest-Caller-Context" ? "caller_context_invalid" : "service_unauthenticated");
      assert.equal(calls(), 0);
    }
  });
});

test("JSON media, UTF-8 and decoded duplicate-member checks run before business effects", async () => {
  await withServer(async (origin, calls) => {
    const headers = { ...workloadHeaders(), "Antnest-Caller-Context": testContext({ agt: "agent-1" }).token };
    for (const [type, body, status] of [
      ["text/plain", "{}", 415], ["application/jsonp", "{}", 415],
      ["application/json; charset=latin1", "{}", 415], ["application/json; charset=utf-8; charset=utf-8", "{}", 415],
      ["application/json", '{"a":1,"\\u0061":2}', 400],
      ["application/json", '{"nested":{"a":1,"a":2}}', 400],
      ["application/json", Buffer.from([0xff]), 400], ["application/json", "\uFEFF{}", 400],
      ["application/json", "{}{}", 400], ["application/json", "[]", 400],
    ] as const) {
      const response = await fetch(`${origin}/api/app/workspace/v1/agents/agent-1/sessions`,
        { method: "POST", headers: { ...headers, "content-type": type }, body });
      assert.equal(response.status, status, `${type}: ${String(body)}`); assert.equal(calls(), 0);
    }
    const response = await fetch(`${origin}/api/app/workspace/v1/agents/agent-1/sessions`,
      { method: "POST", headers: { ...headers, "content-type": "application/json; charset=utf-8" }, body: "{}" });
    assert.equal(response.status, 200); assert.equal(calls(), 1);
  });
});

test("assets require Gateway workload but no user context; health has no business effects", async () => {
  await withServer(async (origin, calls) => {
    for (const health of ["/live", "/status"]) assert.equal((await fetch(origin + health)).status, 200);
    assert.equal(calls(), 0);
    assert.equal((await fetch(origin + "/workspace/assets/missing.js")).status, 401);
    assert.equal((await fetch(origin + "/workspace/assets/missing.js", { headers: workloadHeaders() })).status, 404);
    assert.equal(calls(), 0);
    assert.equal((await fetch(origin + "/unlisted", { headers: workloadHeaders() })).status, 404);
    assert.equal(calls(), 0);
  });
});

test("signed claims determine bootstrap authority and credentials never enter the browser projection", async () => {
  const server = createWorkspaceHttpServer({ async handle(request) {
    assert.equal(request.headers.has("cookie"), false); assert.equal(request.headers.has("authorization"), false);
    assert.equal(request.headers.has("antnest-caller-context"), false);
    assert.equal(request.headers.has("antnest-service-authorization"), false);
    assert.equal(request.headers.has("x-antnest-organization-id"), false);
    return Response.json(readWorkspacePrincipal(request.headers));
  } }, { authentication: testAuthentication() });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/app/workspace/v1/bootstrap`, { headers: {
      ...workloadHeaders(), "Antnest-Caller-Context": testContext({ sub: "用户,一", org: "组织,一" }).token,
      "x-antnest-organization-id": "forged", "x-antnest-principal-id": "forged", "x-antnest-administrator": "true",
      "x-antnest-organization-slug": "ZW5naW5lZXJpbmc", "x-antnest-organization-name": "RW5naW5lZXJpbmc",
      cookie: "browser-private", authorization: "Bearer browser-private",
    } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { userId: "用户,一", organizationId: "组织,一",
      organizationSlug: "engineering", organizationName: "Engineering", administrator: false });
  } finally { server.closeAllConnections(); server.close(); await once(server, "close"); }
});
