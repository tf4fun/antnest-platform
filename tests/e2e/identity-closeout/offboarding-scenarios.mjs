import assert from "node:assert/strict";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { GatewayClient } from "./support.mjs";
import { assertUnchanged } from "./agent-access-evidence.mjs";
import { addPeerMembership, oidcOwner } from "./offboarding-oidc.mjs";
import { controllerCheckpoint } from "./offboarding-checkpoint.mjs";
import {
  agentDetail,
  agentEvents,
  sentinel,
  waitOperation,
  waitOffboarding,
  explicitEnable,
  remainsDisabled,
} from "./offboarding-client.mjs";

async function createAgent(admin, template, owner, organization) {
  const { body } = await admin.request("/api/admin/agents", {
    status: 202,
    body: {
      owner_user_id: owner,
      name: `Offboarding ${owner}`,
      template_id: template.template_id,
      template_revision: template.revision,
    },
  });
  const item = { admin, agent: body.agent.agent_id, organization };
  await waitOperation(item, body.operation.request_id);
  await waitForAgentReady(() => agentDetail(item));
  await sentinel(item, "write");
  return item;
}

export async function deniedEnable(item) {
  const before = await agentEvents(item);
  const { body } = await item.admin.request(
    `/api/admin/agents/${item.agent}/enable`,
    { body: {}, status: 404 },
  );
  assert.equal(body.code, "reference_not_found");
  assertUnchanged(before, await agentEvents(item));
}

export async function globalAndSCIMOffboarding({
  gateway,
  seed,
  resources,
  secrets,
  snapshot,
  modelState,
  run,
  replayHistory,
}) {
  const system = new GatewayClient(gateway);
  secrets.push("stage3-admin-password");
  const systemLogin = await system.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  secrets.push(...system.cookies.values());
  const [a, b] = [{ ...resources[0], admin: system }, resources[1]];
  const other = await createAgent(
    b.admin,
    b.template,
    seed.b.user.id,
    b.organization,
  );
  const unaffected = {
    agent: await agentDetail(other),
    events: await agentEvents(other),
  };
  const before = await snapshot(),
    calls = await modelState();
  const prior = [await agentEvents(a), await agentEvents(b)];
  await controllerCheckpoint("controller-offline");
  const response = await system.request(
    `/api/admin/directory/users/${seed.a.user.id}/active`,
    { body: { active: false } },
  );
  await controllerCheckpoint("controller-online");
  const evidence = [];
  for (const [index, item] of [a, b].entries()) {
    evidence.push(
      await waitOffboarding(
        item,
        prior[index],
        response,
        "user_deactivated",
        secrets,
      ),
    );
    await deniedEnable(item);
  }
  assertUnchanged(before, await snapshot());
  assertUnchanged(calls, await modelState());
  assertUnchanged(unaffected, {
    agent: await agentDetail(other),
    events: await agentEvents(other),
  });
  await system.request(`/api/admin/directory/users/${seed.a.user.id}/active`, {
    body: { active: true },
  });
  for (const item of [a, b]) {
    await remainsDisabled(item);
    await explicitEnable(item);
  }
  assertUnchanged(before, await snapshot());
  for (const [browser, slug, email] of [
    [resources[0].admin, "stage3", "access-admin@example.com"],
    [resources[1].owner, "access-b", "shared-member@example.com"],
  ]) {
    await browser.request("/api/session/login", {
      body: {
        organization_slug: slug,
        email,
        password: "synthetic-access-password-a",
      },
    });
    secrets.push(...browser.cookies.values());
  }
  await run(resources[0], "offboard-global-a");
  await run(resources[1], "offboard-global-b");

  const { body: token } = await b.admin.request(
    "/api/admin/provisioning/scim-tokens",
    {
      body: {
        name: "Offboarding integration",
        scopes: ["scim:read", "scim:write"],
      },
    },
  );
  secrets.push(token.credential);
  const protocol = new GatewayClient(gateway);
  const scim = (path, options = {}) =>
    protocol.request(`/scim/v2/${path}`, {
      ...options,
      headers: {
        "content-type": "application/scim+json",
        Authorization: `Bearer ${token.credential}`,
      },
    });
  const input = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    userName: "oidc-scim@example.com",
    externalId: "offboarding-scim",
    displayName: "SCIM offboarding",
    active: true,
  };
  const { body: created } = await scim("Users", { body: input, status: 201 });
  const directory = (await b.admin.request("/api/admin/directory")).body.users;
  const user = directory.find(
    (entry) => entry.membership.id === created.id,
  )?.user;
  assert(user, "SCIM owner missing in directory");
  const managed = await createAgent(
    b.admin,
    b.template,
    user.id,
    b.organization,
  );
  const systemB = new GatewayClient(gateway);
  await systemB.request("/api/session/login", {
    body: {
      organization_slug: "access-b",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  secrets.push(...systemB.cookies.values());
  const managedOwner = await oidcOwner(systemB, "access-b", secrets);
  managed.owner = managedOwner.browser;
  const session = await run(managed, "offboard-scim-before-b");
  await addPeerMembership(
    systemLogin.body.principal.user_id,
    a.organization,
    user.id,
  );
  const peer = await createAgent(system, a.template, user.id, a.organization);
  peer.owner = (await oidcOwner(system, "stage3", secrets)).browser;
  const beforeDelete = await snapshot();
  const priorSCIM = await agentEvents(managed);
  const stable = [];
  for (const item of [a, b, other, peer])
    stable.push({
      agent: await agentDetail(item),
      events: await agentEvents(item),
    });
  const deleted = await scim(`Users/${created.id}`, {
    method: "DELETE",
    status: 204,
  });
  evidence.push(
    await waitOffboarding(
      managed,
      priorSCIM,
      deleted,
      "membership_deleted",
      secrets,
    ),
  );
  await deniedEnable(managed);
  assertUnchanged(beforeDelete, await snapshot());
  const afterDelete = [];
  for (const item of [a, b, other, peer])
    afterDelete.push({
      agent: await agentDetail(item),
      events: await agentEvents(item),
    });
  assertUnchanged(stable, afterDelete);
  await sentinel(peer, "read");
  await run(peer, "offboard-scim-peer-a");
  const beforeRestore = await snapshot();
  await scim(`Users/${created.id}`, { status: 404 });
  const { body: restored } = await scim("Users", { body: input, status: 201 });
  assert.notEqual(
    restored.id,
    created.id,
    "SCIM tombstone was silently reused",
  );
  const rebound = (
    await b.admin.request("/api/admin/directory")
  ).body.users.find((entry) => entry.membership.id === restored.id);
  assert.equal(
    rebound?.user.id,
    user.id,
    "SCIM reprovision changed stable User ownership",
  );
  await remainsDisabled(managed);
  await explicitEnable(managed);
  assertUnchanged(beforeRestore, await snapshot());
  await managedOwner.login();
  await replayHistory(managed, session, "offboard-scim-before-b");
  await run(managed, "offboard-scim-restored-b");
  await systemB.request("/api/session", { method: "DELETE", status: 204 });
  await system.request("/api/session", { method: "DELETE", status: 204 });
  return evidence;
}
