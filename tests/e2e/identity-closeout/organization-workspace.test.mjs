import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertWorkspaceBootstrap,
  assertWorkspaceDocument,
} from "./organization-workspace.mjs";

const organization = { slug: "engineering", name: "研发 · Équipe 🚀" };
const principal = {
  user_id: "user-1",
  organization_id: "org-1",
  system_role: "user",
  organization_role: "member",
};
const bootstrap = () => ({
  principal: {
    userId: "user-1",
    organizationId: "org-1",
    organizationSlug: organization.slug,
    organizationName: organization.name,
    administrator: false,
  },
  agents: [
    {
      agentId: "agent-1",
      name: "Research",
      lifecycle: "created",
      activation: "enabled",
      runtime: "available",
    },
  ],
  renderedAt: "2026-10-02T00:00:00Z",
  bridgeEpoch: "epoch-1",
});

test("actual bootstrap verifier checks the shared schema, frontend decoder and Identity row together", () => {
  assert.equal(
    assertWorkspaceBootstrap(bootstrap(), principal, organization, ["agent-1"])
      .principal.organizationName,
    organization.name,
  );
  const admin = { ...principal, organization_role: "admin" };
  const payload = bootstrap();
  payload.principal.administrator = true;
  assert.equal(
    assertWorkspaceBootstrap(payload, admin, organization, ["agent-1"])
      .principal.administrator,
    true,
  );
});

test("the integration verifier cannot pass with stale, forged, missing or credential-bearing metadata", () => {
  for (const mutate of [
    (value) => {
      delete value.principal.organizationName;
    },
    (value) => {
      value.principal.organizationName = " \t";
    },
    (value) => {
      value.principal.organizationName = "Organization workspace";
    },
    (value) => {
      value.principal.organizationSlug = "other";
    },
    (value) => {
      value.principal.organizationId = "org-2";
    },
    (value) => {
      value.principal.administrator = true;
    },
    (value) => {
      value.agents[0].agentId = "foreign-agent";
    },
    (value) => {
      value.principal.access_token = "synthetic-private-token";
    },
  ]) {
    const payload = bootstrap();
    mutate(payload);
    assert.throws(() =>
      assertWorkspaceBootstrap(payload, principal, organization, ["agent-1"]),
    );
  }
  assert.throws(
    () =>
      assertWorkspaceBootstrap(
        bootstrap(),
        principal,
        organization,
        ["agent-1"],
        [organization.name],
      ),
    /secret credential/,
  );
});

test("SSR evidence requires the same complete hydration payload and rejects fallback or unsafe evidence", () => {
  const document = `<main>研发 · Équipe 🚀</main><script id="workspace-bootstrap" type="application/json">${JSON.stringify({ bootstrap: bootstrap() })}</script>`;
  assertWorkspaceDocument(document, principal, organization, ["agent-1"]);
  for (const invalid of [
    document.replace('id="workspace-bootstrap"', 'id="other"'),
    document + 'data-ssr="fallback"',
    document + "Organization workspace",
  ])
    assert.throws(() =>
      assertWorkspaceDocument(invalid, principal, organization, ["agent-1"]),
    );
  assert.throws(
    () =>
      assertWorkspaceDocument(
        document + "synthetic-private-token",
        principal,
        organization,
        ["agent-1"],
        ["synthetic-private-token"],
      ),
    /secret credential/,
  );
});

test("credential scans reject an opaque Identity access token even without knowing its value", () => {
  const token = "ant_api_synthetic-unexpected-access-token";
  const payload = bootstrap();
  payload.bridgeEpoch = token;
  assert.throws(
    () =>
      assertWorkspaceBootstrap(payload, principal, organization, ["agent-1"]),
    /access credential/,
  );
  const document = `<main>${token}</main><script id="workspace-bootstrap" type="application/json">${JSON.stringify({ bootstrap: bootstrap() })}</script>`;
  assert.throws(
    () =>
      assertWorkspaceDocument(document, principal, organization, ["agent-1"]),
    /access credential/,
  );
});
