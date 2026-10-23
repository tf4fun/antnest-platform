import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

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
function validator(definition) {
  const ajv = new Ajv2020({ strict: true });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value) => Number.isFinite(Date.parse(value)),
  });
  ajv.addSchema(read("agent-controller/runtime-barrier-recovery.schema.json"));
  const document = read("admin-console/runtime-recovery.schema.json");
  ajv.addSchema(document);
  return ajv.compile({ $ref: `${document.$id}#/$defs/${definition}` });
}
const recovery = () => ({
  barrier_id: "opaque\u0000barrier",
  reason: "runtime_barrier_required",
  runtime_revision: "runtime-1",
  policy_revision: 0,
  mode: "manual",
  cooldown_ms: 300000,
  rebuild_request_id: "rebuild_original",
  notification_id: "notification_original",
  cooldown_until: null,
});
const input = () => ({
  template_id: "template-1",
  template_revision: 1,
  recovery: {
    barrier_id: "opaque\u0000barrier",
    expected_runtime_revision: "runtime-1",
  },
});

test("Console freezes an administrator-only recovery extension on the existing Rebuild route", () => {
  const contract = read("admin-console/admin-contract.json");
  assert.equal(contract.version, 57);
  const route = contract.routes.rebuild_agent;
  assert.equal(route.method, "POST");
  assert.equal(route.path, "/agents/{agent_id}/rebuild");
  assert.equal(
    route.recovery_request_schema,
    "runtime-recovery.schema.json#/$defs/rebuild_request",
  );
  assert.equal(
    route.recovery_idempotency_key,
    "projected_rebuild_request_id_forwarded_unchanged",
  );
  const policy = contract.response_policy.runtime_barrier_recovery;
  assert.equal(
    policy.authorization,
    "verified_organization_scoped_administrator",
  );
  assert.equal(
    policy.projection,
    "runtime-recovery.schema.json#/$defs/runtime_recovery",
  );
  assert.equal(
    policy.authority,
    "agent_controller_validates_original_tuple_receipt_target_and_cooldown",
  );
  assert.equal(
    policy.ordinary_rebuild,
    "unchanged_lifecycle_key_hash_and_template_selection",
  );
  assert.equal(
    policy.unknown_response,
    "query_original_request_before_explicit_same_tuple_retry",
  );
});

test("recovery browser body carries only the frozen Template and original barrier/runtime tuple", () => {
  const validate = validator("rebuild_request");
  assert(validate(input()));
  for (const key of ["template_id", "template_revision", "recovery"]) {
    const changed = input();
    delete changed[key];
    assert(!validate(changed), key);
  }
  for (const key of [
    "request_id",
    "organization_id",
    "actor_principal_id",
    "runtime_execution_id",
    "reason",
  ])
    assert(!validate({ ...input(), [key]: "forged" }), key);
  for (const recovery of [
    null,
    {},
    { barrier_id: "barrier" },
    { expected_runtime_revision: "runtime" },
    { ...input().recovery, execution_id: "private" },
  ])
    assert(!validate({ ...input(), recovery }));
  for (const revision of [0, -1, 1.5, "1", null])
    assert(!validate({ ...input(), template_revision: revision }));
});

test("Console preserves opaque barrier codepoints and rejects whitespace without normalization", () => {
  const validate = validator("rebuild_request");
  for (const barrier_id of [
    "a\u0000b",
    "é",
    "e\u0301",
    "<>&",
    "😀".repeat(200),
    "a\u0085b",
  ])
    assert(
      validate({ ...input(), recovery: { ...input().recovery, barrier_id } }),
      JSON.stringify(barrier_id),
    );
  for (const barrier_id of ["", " ", "a\nb", "a\ufeffb", "😀".repeat(201)])
    assert(
      !validate({ ...input(), recovery: { ...input().recovery, barrier_id } }),
      JSON.stringify(barrier_id),
    );
});

test("Console exposes exactly the nine safe recovery fields without execution or authority metadata", () => {
  const validate = validator("runtime_recovery");
  assert(validate(recovery()));
  for (const key of Object.keys(recovery())) {
    const changed = recovery();
    delete changed[key];
    assert(!validate(changed), key);
  }
  for (const key of [
    "organization_id",
    "actor_principal_id",
    "runtime_execution_id",
    "endpoint",
    "access_revision",
  ])
    assert(!validate({ ...recovery(), [key]: "private" }), key);
  assert(
    validate({ ...recovery(), cooldown_until: "2026-10-23T00:00:00.123456Z" }),
  );
  for (const changed of [
    { reason: "other" },
    { mode: "other" },
    { policy_revision: -1 },
    { policy_revision: Number.MAX_SAFE_INTEGER + 1 },
    { cooldown_ms: 59999 },
    { cooldown_ms: 86400001 },
    { cooldown_until: "2026-10-23T00:00:00+08:00" },
  ])
    assert(!validate({ ...recovery(), ...changed }));
});
