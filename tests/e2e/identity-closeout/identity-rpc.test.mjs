import assert from "node:assert/strict";
import test from "node:test";
import { serviceClient } from "../../support/service-grants.mjs";
import { identityFixture } from "./identity-rpc.mjs";

function harness() {
  const requests = [];
  const services = serviceClient({
    readCredential: (grant) => grant[0].repeat(43),
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ path: new URL(url).pathname, init, body });
      const method = new URL(url).pathname.split("/").at(-1);
      const replies = {
        "local-login": {
          access_token: `session-${body.organization_slug}`,
          principal: { user_id: "user_1", organization_id: "org_a" },
        },
        "resolve-access-token": {
          caller_context: `cct-${body.access_token}`,
        },
        "create-organization": { organization: { id: "org_b" } },
        "add-organization-membership": { membership: { id: "membership_1" } },
        "revoke-access-token": { revoked: true },
      };
      return Response.json(replies[method]);
    },
  });
  return { requests, identity: identityFixture(services) };
}

test("sessions sign in as edge-gateway and resolve a Console caller context", async () => {
  const { requests, identity } = harness();
  const session = await identity.signIn({
    organization_slug: "stage3",
    email: "admin@example.com",
    password: "synthetic",
  });
  assert.deepEqual(session, {
    principal: { user_id: "user_1", organization_id: "org_a" },
    context: "cct-session-stage3",
  });
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/rpc/identity/local-login", "/rpc/identity/resolve-access-token"],
  );
  for (const r of requests) {
    assert.equal(
      r.init.headers["Antnest-Service-Authorization"],
      `Bearer ${"g".repeat(43)}`,
    );
    assert.equal(r.init.headers["Antnest-Caller-Context"], undefined);
  }
  assert.match(requests[0].body.request_id, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(requests[1].body, {
    access_token: "session-stage3",
    profile: "console",
  });
});

test("directory commands carry the Console grant, caller context and actor", async () => {
  const { requests, identity } = harness();
  const session = await identity.signIn({ organization_slug: "stage3" });
  const created = await identity.admin(session, "create-organization", {
    slug: "access-b",
  });
  assert.deepEqual(created, { organization: { id: "org_b" } });
  const command = requests.at(-1);
  assert.equal(command.path, "/rpc/identity/create-organization");
  assert.equal(
    command.init.headers["Antnest-Service-Authorization"],
    `Bearer ${"c".repeat(43)}`,
  );
  assert.equal(
    command.init.headers["Antnest-Caller-Context"],
    "cct-session-stage3",
  );
  assert.equal(command.body.actor_principal_id, "user_1");
  assert.equal(command.body.slug, "access-b");
  assert.match(command.body.request_id, /^[0-9a-f-]{36}$/u);
});

test("a signed-in Gateway browser runs directory commands without the fixture owning its session", async () => {
  const { requests, identity } = harness();
  const session = await identity.browserSession("browser-token", {
    user_id: "user_2",
  });
  assert.deepEqual(session, {
    principal: { user_id: "user_2" },
    context: "cct-browser-token",
  });
  await identity.admin(session, "add-organization-membership", {
    organization_id: "org_a",
  });
  assert.deepEqual(requests[0].body, {
    access_token: "browser-token",
    profile: "console",
  });
  assert.equal(
    requests[1].init.headers["Antnest-Caller-Context"],
    "cct-browser-token",
  );
  assert.equal(requests[1].body.actor_principal_id, "user_2");
  await identity.close();
  assert.equal(requests.length, 2, "browser session stays with its owner");
});

test("close revokes every session the fixture opened, once", async () => {
  const { requests, identity } = harness();
  await identity.signIn({ organization_slug: "stage3" });
  await identity.signIn({ organization_slug: "access-b" });
  await identity.close();
  await identity.close();
  const revoked = requests
    .filter((r) => r.path === "/rpc/identity/revoke-access-token")
    .map((r) => r.body);
  assert.deepEqual(revoked, [
    { access_token: "session-stage3" },
    { access_token: "session-access-b" },
  ]);
});
