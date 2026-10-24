import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const contracts = new URL("../../../contracts/", import.meta.url);
const read = (path) =>
  JSON.parse(readFileSync(new URL(path, contracts), "utf8"));
const schemaPath = "agent-controller/model-call-policy.schema.json";
const schemaId = `https://antnest.local/contracts/${schemaPath}`;

function validators() {
  const schema = read(schemaPath);
  assert.equal(schema.$id, schemaId);
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  ajv.addSchema(schema);
  return (definition) => ajv.getSchema(`${schemaId}#/$defs/${definition}`);
}

test("planned model-call policy golden vectors retain closed, non-mutating wire shapes", () => {
  const validate = validators();
  const fixtures = read("agent-controller/model-call-policy-fixtures.json");
  assert.ok(fixtures.valid.length >= 8);
  assert.ok(fixtures.invalid.length >= 20);
  const seen = new Set();
  for (const [expected, rows] of [
    [true, fixtures.valid],
    [false, fixtures.invalid],
  ]) {
    for (const { name, definition, value } of rows) {
      assert.ok(!seen.has(name), `duplicate golden: ${name}`);
      seen.add(name);
      const before = structuredClone(value);
      const check = validate(definition);
      assert.equal(typeof check, "function", definition);
      assert.equal(
        check(value),
        expected,
        `${name}: ${JSON.stringify(check.errors)}`,
      );
      assert.deepEqual(value, before, `${name}: validator mutated its input`);
    }
  }
});

test("omitted policy fields preserve legacy configuration without injecting defaults", () => {
  const validate = validators();
  const value = {};
  assert.equal(validate("template_policy")(value), true);
  assert.deepEqual(value, {});
  const explicit = {
    model_retry: { max: 0, base_ms: 200, cap_ms: 30000 },
    failover: "never",
    run_budget: {},
  };
  assert.equal(validate("template_policy")(explicit), true);
  assert.deepEqual(explicit.run_budget, {});
});

test("organization policy identifiers retain the existing Controller wire boundary", () => {
  assert.deepEqual(
    read(schemaPath).$defs.identity,
    read("agent-controller/control-api.schema.json").$defs.id,
  );
  const check = validators()("policy_query");
  for (const organization_id of ["org-1", "org.team_owner-1", "x".repeat(200)])
    assert.equal(check({ organization_id }), true);
  for (const organization_id of [
    "",
    null,
    "x".repeat(201),
    "org/team+owner@example.test",
  ])
    assert.equal(check({ organization_id }), false);
});

test("token and monetary limits include zero and reject unsafe or fractional accounting", () => {
  const check = validators()("run_budget");
  for (const field of [
    "max_input_tokens",
    "max_output_tokens",
    "max_cost_usd_micros",
  ]) {
    for (const value of [0, 1, Number.MAX_SAFE_INTEGER])
      assert.equal(check({ [field]: value }), true, `${field}=${value}`);
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null])
      assert.equal(check({ [field]: value }), false, `${field}=${value}`);
  }
});

test("shape acceptance cannot substitute for policy ordering or candidate semantics", () => {
  const validate = validators();
  const retry = { max: 2, base_ms: 2000, cap_ms: 1000 };
  const caps = { soft_cost_usd_micros: 20, hard_cost_usd_micros: 10 };
  assert.equal(validate("model_retry")(retry), true);
  assert.equal(validate("period_caps")(caps), true);
  const contract = read("agent-controller/model-call-policy.json");
  assert.deepEqual(contract.semantic_checks, [
    "retry_base_lte_cap",
    "soft_lte_hard",
    "same_organization_candidate_references",
    "required_capabilities_preserved",
    "atomic_budget_reservations",
    "original_attempt_cleanup_before_retry",
  ]);
});

test("the planned boundary reuses budget_exceeded and does not advertise live routes", () => {
  const contract = read("agent-controller/model-call-policy.json");
  assert.equal(contract.status, "planned");
  assert.equal(contract.revision, 1);
  assert.deepEqual(contract.amount, {
    currency: "USD",
    wire_unit: "integer_microdollars",
    maximum: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(contract.compatibility.default_retry, {
    max: 0,
    base_ms: 200,
    cap_ms: 30000,
  });
  assert.equal(contract.compatibility.default_failover, "never");
  assert.equal(contract.compatibility.default_unknown_cost, "allow");
  assert.equal(contract.compatibility.absent_limits, "unlimited");
  assert.deepEqual(contract.delivery_defaults?.model_retry, {
    max: 2,
    base_ms: 200,
    cap_ms: 30000,
  });
  assert.equal(contract.delivery_defaults.failover, "before_output");
  const active = read("agent-controller/control-contract.json");
  for (const operations of Object.values(active.resources))
    for (const route of Object.values(operations))
      assert.notEqual(route.path, contract.policy_path);
  const errors = read("agent-acp/errors.json");
  assert.equal(contract.budget_error.code, "budget_exceeded");
  const row = errors.errors.budget_exceeded;
  assert.ok(row, "reuse the existing budget_exceeded error");
  for (const field of ["json_rpc_code", "http_status", "retryable"])
    assert.equal(contract.budget_error[field], row[field]);
});
