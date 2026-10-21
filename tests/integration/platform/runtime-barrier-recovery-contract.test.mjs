import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const schemaID =
  "https://antnest.local/contracts/agent-acp/runtime-barrier-recovery.schema.json";
const schemaURL = new URL(
  "../../../contracts/agent-acp/runtime-barrier-recovery.schema.json",
  import.meta.url,
);
const request = () => ({
  organization_id: "org-1",
  agent_id: "agent-1",
  expected_runtime_revision: "runtime-1",
});
const barrier = () => ({
  barrier_id: "barrier-1",
  reason: "runtime_barrier_required",
  runtime_execution_id: "execution-1",
});
const result = () => ({
  organization_id: "org-1",
  agent_id: "agent-1",
  runtime_revision: "runtime-1",
  barrier: barrier(),
});
const fixtures = { request, result, barrier };
const identityFields = {
  request: ["organization_id", "agent_id", "expected_runtime_revision"],
  result: ["organization_id", "agent_id", "runtime_revision"],
  barrier: ["barrier_id", "runtime_execution_id"],
};

function validators() {
  const schema = JSON.parse(readFileSync(schemaURL, "utf8"));
  assert.equal(schema.$id, schemaID);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(schema);
  return {
    root: ajv.getSchema(schemaID),
    ...Object.fromEntries(
      Object.keys(fixtures).map((name) => [
        name,
        ajv.compile({ $ref: `${schemaID}#/$defs/${name}` }),
      ]),
    ),
  };
}

function check(validators, definition, value, expected, label) {
  const checks = [[validators[definition], value]];
  if (definition === "result") checks.push([validators.root, value]);
  if (definition === "barrier") {
    const nested = { ...result(), barrier: value };
    checks.push([validators.result, nested], [validators.root, nested]);
  }
  for (const [validate, input] of checks) {
    assert.equal(typeof validate, "function");
    assert.equal(validate(input), expected, label);
  }
}

test("barrier recovery accepts the frozen request, null result and original barrier result", () => {
  const v = validators();
  check(v, "request", request(), true, "complete request");
  check(
    v,
    "result",
    { ...result(), barrier: null },
    true,
    "no actionable barrier",
  );
  check(v, "result", result(), true, "original barrier result");
  check(v, "barrier", barrier(), true, "complete nested barrier");
  assert.equal(
    v.root(request()),
    false,
    "the default schema validates a result, not a request",
  );
});

test("every layer requires its complete frozen field set", () => {
  const v = validators();
  for (const [definition, make] of Object.entries(fixtures)) {
    for (const field of Object.keys(make())) {
      const value = make();
      delete value[field];
      check(v, definition, value, false, `${definition} missing ${field}`);
    }
    check(v, definition, {}, false, `${definition} cannot be empty`);
  }
});

test("barrier recovery identities retain opaque non-whitespace strings within the wire bounds", () => {
  const v = validators();
  for (const [definition, fields] of Object.entries(identityFields)) {
    for (const field of fields) {
      for (const identity of ["x", "org:Agent/运行-1", "x".repeat(200)]) {
        const value = fixtures[definition]();
        value[field] = identity;
        check(
          v,
          definition,
          value,
          true,
          `${definition}.${field} valid identity`,
        );
      }
    }
  }
});

test("identity length, type and whitespace rejection applies at every layer", () => {
  const v = validators();
  const invalid = [
    ["empty", ""],
    ["too long", "x".repeat(201)],
    ["leading whitespace", " agent"],
    ["trailing whitespace", "agent "],
    ["embedded whitespace", "agent one"],
    ["tab", "agent\tone"],
    ["newline", "agent\none"],
    ["Unicode whitespace", "agent\u00a0one"],
    ["null", null],
    ["number", 1],
    ["boolean", true],
    ["object", {}],
    ["array", ["agent"]],
  ];
  for (const [definition, fields] of Object.entries(identityFields)) {
    for (const field of fields) {
      for (const [label, identity] of invalid) {
        const value = fixtures[definition]();
        value[field] = identity;
        check(v, definition, value, false, `${definition}.${field} ${label}`);
      }
    }
  }
});

test("only the fixed runtime barrier reason is accepted", () => {
  const v = validators();
  for (const reason of [
    "",
    "runtime_barrier_required ",
    "agent_unavailable",
    "settled",
    "RUNTIME_BARRIER_REQUIRED",
    null,
    false,
    1,
    {},
    [],
  ])
    check(
      v,
      "barrier",
      { ...barrier(), reason },
      false,
      "invalid barrier reason",
    );
});

test("wire envelopes and non-null barriers must be objects", () => {
  const v = validators();
  for (const definition of Object.keys(fixtures)) {
    for (const value of [false, 0, "barrier", [], [barrier()]])
      check(v, definition, value, false, `${definition} requires an object`);
  }
  check(v, "request", null, false, "null request");
  check(v, "result", null, false, "null result");
});

test("unknown fields and private authority or execution payloads cannot enter any wire layer", () => {
  const v = validators();
  const forbidden = [
    ["unknown_field", "extra"],
    ["Organization_id", "org-1"],
    ["caller_context", "PRIVATE-CCT-CANARY"],
    ["cct", "PRIVATE-CCT-CANARY"],
    ["workload", "agent-controller"],
    ["endpoint", "http://private-runtime.invalid/mcp"],
    ["credential", { token: "PRIVATE-CREDENTIAL-CANARY" }],
    ["run", { input: "PRIVATE-RUN-CONTENT-CANARY" }],
    ["tool", { arguments: { command: "PRIVATE-TOOL-CONTENT-CANARY" } }],
    ["ready", true],
    ["settled", true],
  ];
  for (const [definition, make] of Object.entries(fixtures)) {
    for (const [field, payload] of forbidden)
      check(
        v,
        definition,
        { ...make(), [field]: payload },
        false,
        `${definition} rejects ${field}`,
      );
  }
});

// Scope equality across requests, stable barrier identity, stale-fact rejection,
// authentication and Rebuild idempotency require later owning-service tests.
