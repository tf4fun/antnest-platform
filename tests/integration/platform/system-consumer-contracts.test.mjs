import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { withCommonErrorSchema } from "../../support/common-error-schema.mjs";
import { assertRestoredBinding } from "../../e2e/service-authentication/identity/external-identities-flow.mjs";
import { linkingProvider } from "../../e2e/edge-gateway/scim-lifecycle-flow.mjs";
import { networkPolicyFixture } from "../../e2e/service-authentication/console/network-policy-fixture.mjs";
import { executionPeers } from "../../e2e/service-authentication/controller/execution-fixture.mjs";
import { validateGolden } from "../../support/contracts/golden.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const read = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../contracts/${name}`, import.meta.url),
      "utf8",
    ),
  );
const identity = read("identity/identity-contract.json");
function compiler() {
  const ajv = new Ajv2020({
    strict: true,
    strictRequired: false,
    strictTypes: false,
  });
  ajv.addKeyword({ keyword: "secret", schemaType: "boolean" });
  for (const name of ["date-time", "uri", "email"]) ajv.addFormat(name, true);
  return withCommonErrorSchema(ajv);
}
function identityPage(method, page) {
  const validate = compiler().compile({
    $id: "https://schemas.antnest.dev/identity/identity-contract.json",
    definitions: identity.definitions,
    ...identity.methods[method].response,
  });
  assert(validate(page), JSON.stringify(validate.errors));
  return page;
}
const binding = {
  id: "binding-1",
  provider_id: "provider-1",
  provider_name: "linking-acceptance",
  provider_display_name: "Linking",
  organization_id: "org-1",
  organization_slug: "engineering",
  organization_name: "Engineering",
  membership_id: "member-1",
  subject: "  opaque é 😀  ",
  method: "admin",
  provider_enabled: true,
  created_at: "2026-11-06T01:00:00Z",
  bound_at: "2026-11-06T02:00:00Z",
  revoked_at: null,
};
const { provider_enabled, bound_at, revoked_at, ...noticeFields } = binding;
const notice = { ...noticeFields, id: "notice-new", binding_id: binding.id };

test("Identity restart acceptance reads canonical items and retains exact restored binding and unacknowledged notice", () => {
  const page = identityPage("list_external_identities", {
    items: [binding],
    next_cursor: null,
    notices: [notice],
  });
  assertRestoredBinding(page, binding, notice);
  for (const invalid of [
    { ...page, items: [{ ...binding, subject: "wrong-subject" }] },
    { ...page, notices: [] },
    { ...page, notices: [notice, { ...notice, id: "notice-already-acked" }] },
  ])
    assert.throws(() => assertRestoredBinding(invalid, binding, notice));
});

test("SCIM lifecycle chooses the exact linking provider from the canonical limited chooser", () => {
  const provider = {
    id: "provider-1",
    name: "linking-acceptance",
    display_name: "Linking",
    enabled: true,
    link_policy: "none",
    link_domains: [],
    authoritative: false,
    link_policy_review_required: false,
  };
  const page = identityPage("list_external_identity_providers", {
    items: [{ ...provider, id: "decoy", name: "other" }, provider],
    next_cursor: null,
  });
  assert.deepEqual(linkingProvider(page), provider);
  assert.throws(
    () => linkingProvider({ items: [], next_cursor: null }),
    /existing linking fixture/,
  );
});

function peer() {
  return {
    network: {
      action: "deny_all",
      assignmentVersion: 7,
      attachment: { state: "pending", resource_version: 2 },
      calls: [],
    },
    r: { method: "PUT", url: "/internal/agents/agent-1/network-policy" },
    claims: { sub: "user-admin", org: "org-1", agt: "agent-1" },
    token: "synthetic-context",
    w: {},
    json(_response, body) {
      return body;
    },
  };
}
const command = {
  request_id: "network-policy-test",
  actor_principal_id: "user-admin",
  organization_id: "org-1",
  policy_id: "builtin/allow-all",
  revision: 1,
  expected_version: "7",
};

test("Console system Controller double accepts the canonical string CAS without opening a pending attachment", () => {
  const control = read("agent-controller/control-api.schema.json");
  const validate = compiler().compile({
    $id: control.$id,
    $defs: control.$defs,
    $ref: "#/$defs/set_agent_network_policy_request",
  });
  assert(validate(command), JSON.stringify(validate.errors));
  const run = peer();
  const result = networkPolicyFixture({ ...run, body: command });
  assert.equal(result.resource_version, 8);
  assert.equal(run.network.assignmentVersion, 8);
  assert.equal(run.network.action, "allow_all");
  assert.deepEqual(run.network.attachment, {
    state: "pending",
    resource_version: 2,
  });
  assert.deepEqual(
    run.network.calls.map(({ method, assignmentVersion }) => [
      method,
      assignmentVersion,
    ]),
    [["PUT", 7]],
  );
});

test("Console system double rejects stale CAS, wrong wire type and unsigned scope before changing the assignment", () => {
  const { expected_version, ...legacy } = command;
  for (const body of [
    { ...command, expected_version: "6" },
    { ...command, expected_version: 7 },
    { ...legacy, expected_resource_version: 7 },
    { ...command, organization_id: "other" },
  ]) {
    const run = peer();
    assert.throws(() => networkPolicyFixture({ ...run, body }));
    assert.equal(run.network.assignmentVersion, 7);
    assert.equal(run.network.action, "deny_all");
    assert.deepEqual(run.network.attachment, {
      state: "pending",
      resource_version: 2,
    });
  }
});

function executionPeer() {
  const stats = {};
  let result;
  const peers = executionPeers({}, stats, (_response, value) => {
    result = structuredClone(value);
  });
  return {
    stats,
    setRuntimePhase: peers.setRuntimePhase,
    call(service, method, path, body = {}) {
      assert.equal(
        peers.handle(
          service,
          { method, headers: { "idempotency-key": "contract-test" } },
          {},
          path,
          body,
        ),
        true,
      );
      return result;
    },
  };
}

const networkPath = "/internal/agent-networks/agent-1";
const attachmentPath = "/internal/agent-network-attachments/agent-1";
const runtimePath = "/internal/runtimes/agent-1";
const attachmentSchema = "egress/attachment-state-request.schema.json";
const revisionSchema =
  "runtime-controller/control-api.schema.json#/$defs/revision_request";

test("Controller system Egress double accepts schema-valid canonical CAS through pending, open and close", async () => {
  const peer = executionPeer();
  peer.call("runtime-controller", "POST", `${runtimePath}/initialize`);
  peer.setRuntimePhase("starting");
  const runtime = peer.call("runtime-controller", "GET", runtimePath);
  let network = peer.call("runtime-egress", "PUT", networkPath);
  for (const state of ["pending", "open", "closed"]) {
    const body = {
      state,
      expected_version: String(network.attachment_resource_version),
      ...(state === "open"
        ? {
            runtime_endpoint: "10.243.1.20",
            tunnel_key_id: runtime.tunnel_key_id,
          }
        : {}),
    };
    await validateGolden(attachmentSchema, body);
    const before = network.attachment_resource_version;
    network = peer.call("runtime-egress", "PUT", attachmentPath, body);
    assert.equal(network.attachment_state, state);
    assert.equal(network.attachment_resource_version, before + 1);
    assert.equal(network.runtime_endpoint, body.runtime_endpoint);
    assert.equal(network.tunnel_key_id, body.tunnel_key_id);
  }
});

test("Controller system Egress double rejects stale and noncanonical CAS before mutation", async () => {
  const peer = executionPeer();
  const before = peer.call("runtime-egress", "PUT", networkPath);
  const stale = { state: "pending", expected_version: "2" };
  await validateGolden(attachmentSchema, stale);
  for (const body of [
    stale,
    { state: "pending", expected_version: 1 },
    { state: "pending", expected_resource_version: 1 },
  ]) {
    assert.throws(() =>
      peer.call("runtime-egress", "PUT", attachmentPath, body),
    );
    assert.deepEqual(peer.call("runtime-egress", "GET", networkPath), before);
  }
});

test("Controller system RC double accepts schema-valid canonical disable and preserves completion semantics", async () => {
  const peer = executionPeer();
  const created = peer.call(
    "runtime-controller",
    "POST",
    `${runtimePath}/initialize`,
  );
  const body = { expected_version: created.target_revision };
  await validateGolden(revisionSchema, body);
  const disabled = peer.call(
    "runtime-controller",
    "POST",
    `${runtimePath}/disable`,
    body,
  );
  assert.equal(disabled.kind, "disable_runtime");
  assert.equal(disabled.state, "completed");
  assert.equal(disabled.effect, "completed");
  assert.notEqual(disabled.target_revision, created.target_revision);
  assert.equal(disabled.inspection.lifecycle_state, "disabled");
  assert.equal(disabled.inspection.runtime_execution_id, "");
  assert.equal(disabled.inspection.mcp_endpoint, "");
  assert.equal(disabled.inspection.runtime_endpoint, undefined);
  assert.equal(disabled.inspection.tunnel_key_id, undefined);
});

test("Controller system RC double rejects stale and noncanonical CAS before disabling", async () => {
  const peer = executionPeer();
  const created = peer.call(
    "runtime-controller",
    "POST",
    `${runtimePath}/initialize`,
  );
  const stale = { expected_version: `rtv_${"0".repeat(32)}` };
  await validateGolden(revisionSchema, stale);
  const before = peer.call("runtime-controller", "GET", runtimePath);
  for (const body of [
    stale,
    { expected_version: 1 },
    { expected_revision: created.target_revision },
  ]) {
    assert.throws(() =>
      peer.call("runtime-controller", "POST", `${runtimePath}/disable`, body),
    );
    const after = peer.call("runtime-controller", "GET", runtimePath);
    // Observation timestamps are sampled on each read.
    after.observed_at = before.observed_at;
    assert.deepEqual(after, before);
  }
});
