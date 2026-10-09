import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const base = new URL("../../../contracts/egress/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, base), "utf8"));

test("Egress revision 7 preserves Controller workload admission and the packet framing", () => {
  const contract = read("control-contract.json");
  assert.equal(contract.revision, 7);
  assert.equal(
    contract.trust_boundary,
    "verified-controller-or-runtime-controller-workload",
  );
  assert.equal(contract.transport, "json-over-http");
  assert.deepEqual(contract.status_values, ["ready", "degraded"]);
  assert.equal(contract.schemas.packet, "../runtime/packet-contract.json");
  assert.equal(
    contract.schemas.service_token,
    "../platform/service-token-callers.schema.json",
  );
  for (const code of [
    "service_unauthenticated",
    "caller_not_allowed",
    "unsupported_media_type",
  ])
    assert(contract.error_codes.includes(code), code);
  assert(existsSync(new URL("service-authentication.md", base)));
});

test("Egress lifecycle routes use Controller operations and private keys use RC operations and Ensure has no JSON body", () => {
  const catalog = read("callers.json");
  assert.equal(catalog.status, "enforced");
  assert.deepEqual(catalog.implementation_issues, [32]);
  for (const [route, policy] of Object.entries(catalog.routes)) {
    if (route === "GET /status") {
      assert.equal(policy.authentication, "health");
      assert.deepEqual(policy.callers, ["local-healthcheck"]);
      continue;
    }
    assert.equal(policy.authentication, "workload", route);
    if (route === "PUT /internal/agent-tunnel-keys/{agent_id}") {
      assert.deepEqual(policy.callers, ["runtime-controller"]);
      assert.deepEqual(policy.caller_context, {
        "runtime-controller": "operation",
      });
      continue;
    }
    assert.deepEqual(policy.callers, ["agent-controller"], route);
    assert.deepEqual(
      policy.caller_context,
      { "agent-controller": "operation" },
      route,
    );
  }
  assert.equal(
    catalog.routes["PUT /internal/agent-networks/{agent_id}"].request_body,
    "none",
  );
  const json = Object.entries(catalog.routes)
    .filter(([, policy]) => policy.request_body === "json")
    .map(([route]) => route)
    .sort();
  assert.deepEqual(json, [
    "POST /internal/agent-networks/{agent_id}/release",
    "PUT /internal/agent-network-attachments/{agent_id}",
    "PUT /internal/agent-policy-assignments/{agent_id}",
    "PUT /internal/agent-tunnel-keys/{agent_id}",
    "PUT /internal/policies/{policy_id}/revisions/{revision}",
  ]);
});
