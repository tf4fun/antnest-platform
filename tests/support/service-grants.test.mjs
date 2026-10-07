import assert from "node:assert/strict";
import test from "node:test";
import { grantContainerArgs, serviceClient } from "./service-grants.mjs";

const config = {
  project: "antnest-stage3-e2e-42",
  credentials: "/work/credentials",
  env: { ANTNEST_SERVICE_AUTH_UID: "1234", ANTNEST_SERVICE_AUTH_GID: "5678" },
};

test("grants add each receiver network once and mount credentials read-only", () => {
  const { networks, args } = grantContainerArgs(config, [
    "controller-runtime",
    "console-controller",
    "acp-controller",
  ]);
  assert.deepEqual(networks, ["controller-runtime", "controller-clients"]);
  assert.deepEqual(args.slice(0, 2), ["--user", "1234:5678"]);
  assert(
    args.includes(
      "/work/credentials/agent-controller/tokens/runtime-controller:/run/auth/controller-runtime:ro",
    ),
  );
});

test("Admin Console directory grants reach Identity on its client network", () => {
  const { networks, args } = grantContainerArgs(config, [
    "gateway-identity",
    "console-identity",
  ]);
  assert.deepEqual(networks, ["identity-clients"]);
  assert(
    args.includes(
      "/work/credentials/admin-console/tokens/identity-service:/run/auth/console-identity:ro",
    ),
  );
});

test("no grants means no user override and no mounts", () => {
  assert.deepEqual(grantContainerArgs(config), { networks: [], args: [] });
  assert.throws(() => grantContainerArgs(config, ["admin-everything"]));
});

function harness(responses) {
  const requests = [];
  const client = serviceClient({
    readCredential: (grant) => grant[0].repeat(43),
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      const next = responses.shift();
      return new Response(JSON.stringify(next.body), { status: next.status });
    },
  });
  return { client, requests };
}

test("json accepts an expected non-200 status and names failures by code", async () => {
  const { client } = harness([
    { status: 403, body: { error: { code: "organization_mismatch" } } },
    { status: 500, body: { code: "internal" } },
  ]);
  const denied = await client.json(
    "http://agent-controller:8080/internal/agents/a?organization_id=o",
    "console-controller",
    { method: "GET", status: 403 },
  );
  assert.equal(denied.error.code, "organization_mismatch");
  await assert.rejects(
    client.json(
      "http://runtime-controller:8080/internal/runtimes/a",
      "controller-runtime",
      { method: "GET" },
    ),
    (error) => {
      assert.equal(error.message, "/internal/runtimes/a: HTTP 500 internal");
      assert(!error.message.includes("c".repeat(43)));
      return true;
    },
  );
});

test("caller contexts come from Identity through the gateway grant", async () => {
  const principal = { organization_id: "org_1", user_id: "user_1" };
  const { client, requests } = harness([
    { status: 200, body: { access_token: "session", principal } },
    { status: 200, body: { caller_context: "cct" } },
  ]);
  const issued = await client.callerContext(
    { organization_slug: "o", email: "e", password: "p" },
    "agent_1",
  );
  assert.deepEqual(issued, { context: "cct", principal });
  assert.equal(
    requests[0].headers["Antnest-Service-Authorization"],
    `Bearer ${"g".repeat(43)}`,
  );
  assert.deepEqual(JSON.parse(requests[1].body), {
    access_token: "session",
    profile: "console",
    agent_id: "agent_1",
  });
});

test("authorization builds a validated header for callers outside json", () => {
  const { client } = harness([]);
  assert.deepEqual(client.authorization("controller-runtime"), {
    "Antnest-Service-Authorization": `Bearer ${"c".repeat(43)}`,
  });
  const invalid = serviceClient({
    readCredential: () => "not a token",
    fetch: async () => assert.fail("must not send"),
  });
  assert.throws(
    () => invalid.authorization("controller-runtime"),
    /invalid disposable credential/u,
  );
});

test("credentials must be disposable token encodings", async () => {
  const client = serviceClient({
    readCredential: () => "not a token",
    fetch: async () => assert.fail("must not send"),
  });
  await assert.rejects(
    client.send("http://identity-service:8080/x", "gateway-identity"),
    /invalid disposable credential/u,
  );
});
