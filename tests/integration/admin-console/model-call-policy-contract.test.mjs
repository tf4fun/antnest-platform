import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { withCommonErrorSchema } from "../../support/common-error-schema.mjs";
import { test } from "node:test";

const root = new URL("../../..", import.meta.url);
const contract = JSON.parse(
  readFileSync(
    new URL("contracts/admin-console/admin-contract.json", root),
    "utf8",
  ),
);
const callers = JSON.parse(
  readFileSync(new URL("contracts/admin-console/callers.json", root), "utf8"),
);
const schema = JSON.parse(
  readFileSync(
    new URL("contracts/admin-console/model-call-policy.schema.json", root),
    "utf8",
  ),
);
const controller = JSON.parse(
  readFileSync(
    new URL("contracts/agent-controller/model-call-policy.schema.json", root),
    "utf8",
  ),
);

test("admin contract version 61 publishes both policy routes", () => {
  assert.equal(contract.version, 61);
  assert.deepEqual(contract.routes.get_model_call_policy, {
    request_schema:
      "admin-api.schema.json#/$defs/get_model_call_policy_request",
    response_schema:
      "admin-api.schema.json#/$defs/get_model_call_policy_response",
    request_body: { kind: "none", input: "query_and_path" },
    response_body: {
      kind: "json",
      schema: "admin-api.schema.json#/$defs/get_model_call_policy_response",
    },
    method: "GET",
    path: "/model-call-policy",
    response: "model-call-policy.schema.json#/$defs/model_call_policy",
  });
  assert.deepEqual(contract.routes.set_model_call_policy, {
    request_schema:
      "admin-api.schema.json#/$defs/set_model_call_policy_request",
    response_schema:
      "admin-api.schema.json#/$defs/set_model_call_policy_response",
    request_body: {
      kind: "json",
      schema: "admin-api.schema.json#/$defs/set_model_call_policy_request",
    },
    response_body: {
      kind: "json",
      schema: "admin-api.schema.json#/$defs/set_model_call_policy_response",
    },
    method: "PUT",
    path: "/model-call-policy",
    requires: ["Idempotency-Key"],
    request:
      "model-call-policy.schema.json#/$defs/set_model_call_policy_request",
    response: "model-call-policy.schema.json#/$defs/model_call_policy",
  });
});

test("caller grants require the edge gateway caller context", () => {
  for (const [route, body] of [
    ["GET /api/admin/model-call-policy", "none"],
    ["PUT /api/admin/model-call-policy", "json"],
  ]) {
    assert.deepEqual(
      callers.routes[route],
      {
        callers: ["edge-gateway"],
        authentication: "workload",
        caller_context: { "edge-gateway": "required" },
        request_body: body,
      },
      route,
    );
  }
});

test("browser policy response carries exactly five contracted members", () => {
  const policy = schema.$defs.model_call_policy;
  assert.deepEqual(policy.required.sort(), [
    "daily",
    "monthly",
    "revision",
    "run_caps",
    "unknown_cost",
  ]);
  assert.equal(policy.additionalProperties, false);
  assert.equal("organization_id" in policy.properties, false);
});

test("replacement request requires the CAS and principal precondition", () => {
  const request = schema.$defs.set_model_call_policy_request;
  assert.deepEqual(request.required.sort(), [
    "daily",
    "expected_principal",
    "monthly",
    "run_caps",
    "unknown_cost",
  ]);
  assert.equal(request.additionalProperties, false);
  assert.equal(request.properties.expected_revision.deprecated, true);
  assert.deepEqual(request.not.required, [
    "expected_version",
    "expected_revision",
  ]);
  assert.equal(
    request.properties.expected_version.allOf[0].$ref,
    "../common/precondition.schema.json#/$defs/expected_version",
  );
  assert.equal(request.properties.expected_principal.minItems, 2);
  assert.equal(request.properties.expected_principal.maxItems, 2);
  assert.equal(request.properties.expected_principal.items.minLength, 1);
});

test("shared cap shapes match the canonical Controller definitions", () => {
  for (const name of ["run_budget", "period_caps", "model_retry"]) {
    assert.deepEqual(
      schema.$defs[name],
      controller.$defs?.[name] ?? controller.definitions?.[name],
      name,
    );
  }
});

test("canonical policy precondition compiles with strict string constraints", () => {
  const require = createRequire(
    new URL(
      "../../../services/agent-acp-service/package.json",
      import.meta.url,
    ),
  );
  const { Ajv2020 } = require("ajv/dist/2020.js");
  const ajv = withCommonErrorSchema(
    new Ajv2020({ strict: true, validateFormats: false }),
  );
  ajv.addSchema(schema);
  const validate = ajv.compile({
    $id: "https://schemas.antnest.dev/admin-console/policy-precondition-test.json",
    $ref: "model-call-policy.schema.json#/$defs/set_model_call_policy_request/properties/expected_version",
  });
  assert(validate("0"));
  assert(validate("7"));
  for (const value of [0, null, "", "01", "-1", "1.0", "1".repeat(21)])
    assert.equal(validate(value), false);
});
