import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");

const fixture = JSON.parse(
  readFileSync(new URL("./policy-v2-handoff.json", import.meta.url), "utf8"),
);
const egressSchema = JSON.parse(
  readFileSync(
    new URL("../../../contracts/egress/policy.schema.json", import.meta.url),
    "utf8",
  ),
);
const controllerSchema = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/agent-controller/control-api.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const adminContract = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/admin-console/admin-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const {
  decodeNetworkPolicy,
  decodeNetworkAssignment,
  readPendingNetwork,
  savePendingNetwork,
  canonicalNetworkSpec,
} =
  await import("../../../services/admin-console/web/src/lib/network-policy.ts");

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("shared handoff fixture satisfies Egress and Controller v2 contracts", () => {
  const ajv = new Ajv2020({ formats: { "date-time": true, uri: true } });
  assert.equal(
    ajv.compile(egressSchema)(fixture.spec),
    true,
    "spec must satisfy the Egress v2 schema",
  );
  const request = {
    request_id: "request-handoff-1",
    organization_id: fixture.organization_id,
    actor_principal_id: fixture.actor_principal_id,
    expected_resource_version: fixture.expected_resource_version,
    spec: fixture.spec,
  };
  const setter = ajv.compile({
    ...controllerSchema,
    $ref: "#/$defs/set_agent_network_policy_request",
  });
  assert.equal(
    setter(request),
    true,
    "spec-only tuple must satisfy the Controller request schema",
  );
  const v1 = ajv.compile(egressSchema);
  assert.equal(v1({ schema_version: 1, action: "allow_all" }), true);
});

test("frozen reference and metadata ack match the canonical derivation recipe", () => {
  const canonical = JSON.stringify([
    fixture.organization_id,
    fixture.agent_id,
    fixture.spec,
  ]);
  assert.equal(
    fixture.policy_id,
    `custom/${sha256Hex(Buffer.from(canonical))}`,
  );
  assert.equal(fixture.revision, 1);
  const ack = fixture.egress_put_ack;
  assert.deepEqual(
    Object.keys(ack).sort(),
    ["digest", "policy_id", "revision", "schema_version"],
    "the Egress PUT ack must stay metadata-only",
  );
  assert.equal(ack.policy_id, fixture.policy_id);
  assert.equal(ack.revision, 1);
  assert.equal(ack.schema_version, fixture.spec.schema_version);
  assert.equal(
    ack.digest,
    `sha256:${sha256Hex(Buffer.from(JSON.stringify(fixture.spec)))}`,
    "digest must be sha256 over the canonical spec bytes",
  );
  assert.equal(fixture.assignment.policy_id, fixture.policy_id);
  assert.equal(fixture.assignment.revision, 1);
  assert.equal(fixture.assignment.resource_version, 2);
});

test("browser codec round-trips the frozen v2 projection and pending intent", () => {
  const projection = {
    agent_id: fixture.agent_id,
    spec: fixture.spec,
    resource_version: fixture.assignment.resource_version,
    attachment: { state: "closed", resource_version: 1 },
  };
  const decoded = decodeNetworkPolicy(projection, fixture.agent_id);
  assert.equal(
    canonicalNetworkSpec(decoded.spec),
    JSON.stringify(fixture.spec),
  );
  assert.equal(decoded.resource_version, 2);

  assert.equal(fixture.fixture_version, 1);
  assert.equal(fixture.assignment.agent_id, fixture.agent_id);
  const pending = {
    spec: fixture.spec,
    expected_resource_version: fixture.expected_resource_version,
    idempotency_key: "handoff-request-key",
  };
  const values = new Map();
  const storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const scope = JSON.stringify(["org-1", "user-admin"]);
  savePendingNetwork(storage, scope, fixture.agent_id, pending);
  const restored = readPendingNetwork(storage, scope, fixture.agent_id);
  assert.equal(
    canonicalNetworkSpec(restored.spec),
    canonicalNetworkSpec(fixture.spec),
  );
  const ack = decodeNetworkAssignment(
    {
      agent_id: fixture.agent_id,
      spec: fixture.spec,
      resource_version: fixture.assignment.resource_version,
    },
    fixture.agent_id,
    pending,
  );
  assert.equal(canonicalNetworkSpec(ack.spec), JSON.stringify(fixture.spec));
  assert.equal(
    readPendingNetwork(
      storage,
      JSON.stringify(["org-2", "user-admin"]),
      fixture.agent_id,
    ),
    undefined,
    "pending intent must not leak across scopes",
  );
  assert.throws(() =>
    decodeNetworkAssignment(
      {
        agent_id: fixture.agent_id,
        spec: { ...fixture.spec, default: "allow" },
        resource_version: 2,
      },
      fixture.agent_id,
      pending,
    ),
  );
  assert.throws(
    () =>
      decodeNetworkAssignment(
        {
          agent_id: fixture.agent_id,
          spec: fixture.spec,
          resource_version: 2,
          policy_id: fixture.policy_id,
          digest: fixture.egress_put_ack.digest,
        },
        fixture.agent_id,
        pending,
      ),
    "Controller-internal fields must never reach the browser ack",
  );
  assert.equal(adminContract.version, 60);
  assert.equal(
    adminContract.response_policy.agent_network_policy.spec_only_v2_status,
    "implemented",
  );
});
