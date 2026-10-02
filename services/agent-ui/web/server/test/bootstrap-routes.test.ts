import assert from "node:assert/strict";
import { test } from "node:test";
import { createBootstrapHandler } from "../src/http/bootstrap-routes.ts";

const path = "http://localhost/api/app/workspace/v1/bootstrap";
const headers = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-administrator": "true", "x-antnest-organization-slug": "ZW5naW5lZXJpbmc", "x-antnest-organization-name": "RW5naW5lZXJpbmc",
};

test("bootstrap returns the trusted principal and only safe Controller Agent facts", async () => {
  const scopes: unknown[] = [];
  const handler = createBootstrapHandler({
    epoch: "epoch-1",
    now: () => 1_700_000_000_000,
    discover: async (scope) => {
      scopes.push(scope);
      return [{
        agent_id: "agent-1", name: "Research", lifecycle_state: "created",
        activation_state: "enabled", runtime_state: "available",
        secret: "not browser safe",
      }];
    },
  });
  const response = await handler(new Request(path, { headers }));
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("cache-control"), "no-store");
  assert.deepEqual(scopes, [{ organizationId: "org-1", principalId: "user-1" }]);
  assert.deepEqual(await response?.json(), {
    principal: { organizationSlug: "engineering", organizationName: "Engineering", userId: "user-1", organizationId: "org-1", administrator: true },
    agents: [{
      agentId: "agent-1", name: "Research", lifecycle: "created",
      activation: "enabled", runtime: "available",
    }],
    renderedAt: new Date(1_700_000_000_000).toISOString(),
    bridgeEpoch: "epoch-1",
  });
});

test("bootstrap rejects missing or malformed trusted administrator context before discovery", async () => {
  let contacted = 0;
  const handler = createBootstrapHandler({
    epoch: "epoch-1", now: Date.now,
    discover: async () => { contacted++; return []; },
  });
  for (const requestHeaders of [
    {},
    { ...headers, "x-antnest-administrator": "" },
    { ...headers, "x-antnest-administrator": "yes" },
    { ...headers, "x-antnest-principal-id": "other, forged" },
  ]) {
    const response = await handler(new Request(path, { headers: requestHeaders }));
    assert.equal(response?.status, 401);
  }
  assert.equal(contacted, 0);
});

test("bootstrap rejects invalid Controller data instead of publishing a partial directory", async () => {
  const handler = createBootstrapHandler({
    epoch: "epoch-1", now: Date.now,
    discover: async () => [{ agent_id: "agent-1", name: " ", lifecycle_state: "created", activation_state: "enabled", runtime_state: "available" }],
  });
  const response = await handler(new Request(path, { headers }));
  assert.equal(response?.status, 503);
  assert.equal((await response?.json()).code, "workspace_unavailable");
});
