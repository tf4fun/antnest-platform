import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const root = new URL("../../../contracts/", import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

const cancelPath = "/internal/agents/{agent_id}/lifecycle-operation/cancel";
const quarantinePath = "/internal/agents/{agent_id}/lifecycle-quarantine/clear";
const cancelRoute = `POST ${cancelPath}`;
const quarantineRoute = `POST ${quarantinePath}`;
const lifecycleEventTypes = [
  "agent_lifecycle_cancelled",
  "agent_lifecycle_quarantine_cleared",
  "agent_gc_scheduled",
];
const failureCodes = [
  "phase_deadline_exceeded",
  "lifecycle_cancelled",
  "lifecycle_invariant_failed",
];
const operationStates = ["running", "completed", "failed"];
const maximumSequence = 9007199254740991;

const samples = {
  cancel_lifecycle_operation_request: () => ({
    organization_id: "org-1",
    actor_principal_id: "admin-1",
    operation_request_id: "operation-request-1",
  }),
  clear_lifecycle_quarantine_request: () => ({
    organization_id: "org-1",
    actor_principal_id: "admin-1",
    expected_aggregate_sequence: 1,
  }),
};
const requestIdentities = {
  cancel_lifecycle_operation_request: [
    "organization_id",
    "actor_principal_id",
    "operation_request_id",
  ],
  clear_lifecycle_quarantine_request: ["organization_id", "actor_principal_id"],
};

function utcTimestamp(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}

function controlApiValidators() {
  const schema = read("agent-controller/control-api.schema.json");
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    useDefaults: true,
  });
  ajv.addFormat("date-time", { type: "string", validate: utcTimestamp });
  ajv.addFormat("uri", {
    type: "string",
    validate: (value) => URL.canParse(value),
  });
  ajv.addSchema(
    read("runtime/managed-mcp.schema.json"),
    new URL("../runtime/managed-mcp.schema.json", schema.$id).href,
  );
  ajv.addSchema(read("agent-controller/runtime-barrier-recovery.schema.json"));
  ajv.addSchema(schema);
  return Object.fromEntries(
    [
      "cancel_lifecycle_operation_request",
      "clear_lifecycle_quarantine_request",
      "agent",
      "operation",
      "agent_event",
      "event_list",
    ].map((name) => [
      name,
      ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }),
    ]),
  );
}

function checkActive(validators, definition, value, valid, label) {
  const before = structuredClone(value);
  assert.equal(typeof validators[definition], "function", definition);
  assert.equal(validators[definition](value), valid, label);
  assert.deepEqual(value, before, label + " cannot mutate input");
}

function checkActiveEvent(validators, value, valid, label) {
  checkActive(validators, "agent_event", value, valid, label);
  checkActive(
    validators,
    "event_list",
    {
      events: [structuredClone(value)],
      next_sequence: value?.global_sequence ?? 1,
    },
    valid,
    label + " in event list",
  );
}

test("the control contract declares lifecycle cancel and quarantine-clear routes", () => {
  const contract = read("agent-controller/control-contract.json");
  const agents = contract.resources?.agents ?? {};
  assert.deepEqual(agents.cancel_lifecycle_operation, {
    method: "POST",
    path: cancelPath,
    request:
      "control-api.schema.json#/$defs/cancel_lifecycle_operation_request",
    success_status: 202,
    response: "control-api.schema.json#/$defs/operation",
  });
  assert.deepEqual(agents.clear_lifecycle_quarantine, {
    method: "POST",
    path: quarantinePath,
    request:
      "control-api.schema.json#/$defs/clear_lifecycle_quarantine_request",
    success_status: 200,
    response: "control-api.schema.json#/$defs/agent",
  });
});

test("the lifecycle routes keep admin-console as the only workload caller", () => {
  const callers = read("agent-controller/callers.json");
  for (const route of [cancelRoute, quarantineRoute])
    assert.deepEqual(callers.routes[route], {
      callers: ["admin-console"],
      authentication: "workload",
      caller_context: { "admin-console": "required" },
      request_body: "json",
    });
});

test("lifecycle request definitions are strict inline objects over shared identities", () => {
  const schema = read("agent-controller/control-api.schema.json");
  const cancel = schema.$defs.cancel_lifecycle_operation_request ?? {};
  assert.equal(cancel.type, "object");
  assert.equal(cancel.additionalProperties, false);
  assert.deepEqual([...(cancel.required ?? [])].sort(), [
    "actor_principal_id",
    "operation_request_id",
    "organization_id",
  ]);
  assert.deepEqual(cancel.properties, {
    organization_id: { $ref: "#/$defs/id" },
    actor_principal_id: { $ref: "#/$defs/id" },
    operation_request_id: { $ref: "#/$defs/id" },
  });
  const clear = schema.$defs.clear_lifecycle_quarantine_request ?? {};
  assert.equal(clear.type, "object");
  assert.equal(clear.additionalProperties, false);
  assert.deepEqual([...(clear.required ?? [])].sort(), [
    "actor_principal_id",
    "expected_aggregate_sequence",
    "organization_id",
  ]);
  assert.deepEqual(clear.properties, {
    organization_id: { $ref: "#/$defs/id" },
    actor_principal_id: { $ref: "#/$defs/id" },
    expected_aggregate_sequence: {
      type: "integer",
      minimum: 1,
      maximum: maximumSequence,
    },
  });
});

test("the cancel request rejects missing, empty and malformed identities", () => {
  const validators = controlApiValidators();
  const definition = "cancel_lifecycle_operation_request";
  checkActive(
    validators,
    definition,
    samples[definition](),
    true,
    "complete cancel request",
  );
  for (const field of requestIdentities[definition]) {
    const missing = samples[definition]();
    delete missing[field];
    checkActive(
      validators,
      definition,
      missing,
      false,
      "cancel request requires " + field,
    );
    for (const value of ["", "invalid identity", 1, null, {}, []])
      checkActive(
        validators,
        definition,
        { ...samples[definition](), [field]: value },
        false,
        "cancel request rejects " + field + " " + JSON.stringify(value),
      );
  }
  for (const value of [null, false, 1, "cancel", []])
    checkActive(
      validators,
      definition,
      value,
      false,
      "cancel request rejects non-object " + JSON.stringify(value),
    );
  for (const field of [
    "unknown_field",
    "expected_aggregate_sequence",
    "credential",
  ])
    checkActive(
      validators,
      definition,
      { ...samples[definition](), [field]: "synthetic-private-field" },
      false,
      "cancel request rejects field " + field,
    );
});

test("the quarantine-clear request bounds the expected aggregate sequence", () => {
  const validators = controlApiValidators();
  const definition = "clear_lifecycle_quarantine_request";
  for (const expected_aggregate_sequence of [1, 42, maximumSequence])
    checkActive(
      validators,
      definition,
      {
        ...samples[definition](),
        expected_aggregate_sequence,
      },
      true,
      "clear request accepts sequence " + expected_aggregate_sequence,
    );
  for (const field of [
    "organization_id",
    "actor_principal_id",
    "expected_aggregate_sequence",
  ]) {
    const missing = samples[definition]();
    delete missing[field];
    checkActive(
      validators,
      definition,
      missing,
      false,
      "clear request requires " + field,
    );
    checkActive(
      validators,
      definition,
      { ...samples[definition](), [field]: null },
      false,
      "clear request rejects null " + field,
    );
  }
  for (const field of requestIdentities[definition])
    for (const value of ["", "invalid identity", 1, {}, []])
      checkActive(
        validators,
        definition,
        { ...samples[definition](), [field]: value },
        false,
        "clear request rejects " + field + " " + JSON.stringify(value),
      );
  for (const expected_aggregate_sequence of [
    0,
    -1,
    1.5,
    maximumSequence + 1,
    "1",
    true,
    {},
    [],
  ])
    checkActive(
      validators,
      definition,
      {
        ...samples[definition](),
        expected_aggregate_sequence,
      },
      false,
      "clear request rejects sequence " +
        JSON.stringify(expected_aggregate_sequence),
    );
  for (const value of [null, false, 1, "clear", []])
    checkActive(
      validators,
      definition,
      value,
      false,
      "clear request rejects non-object " + JSON.stringify(value),
    );
  for (const field of ["unknown_field", "operation_request_id", "credential"])
    checkActive(
      validators,
      definition,
      { ...samples[definition](), [field]: "synthetic-private-field" },
      false,
      "clear request rejects field " + field,
    );
});

test("event catalogs add lifecycle terminal types while operation states stay unchanged", () => {
  const contract = read("agent-controller/control-contract.json");
  const schema = read("agent-controller/control-api.schema.json");
  for (const eventTypes of [
    contract.enums?.event_type ?? [],
    schema.$defs.agent_event?.properties?.event_type?.enum ?? [],
  ])
    for (const eventType of lifecycleEventTypes)
      assert.equal(
        eventTypes.filter((type) => type === eventType).length,
        1,
        "event type " + eventType,
      );
  assert.deepEqual(contract.enums?.operation_state, operationStates);
  assert.deepEqual(
    schema.$defs.operation?.properties?.state?.enum,
    operationStates,
  );
  const errorCode = schema.$defs.operation?.properties?.error_code ?? {};
  assert.equal(errorCode.type, "string");
  assert.equal(
    Object.hasOwn(errorCode, "enum"),
    false,
    "error_code must stay open for lifecycle_cancelled",
  );
});

test("compiled agent events accept the lifecycle terminal types in envelopes and lists", () => {
  const validators = controlApiValidators();
  for (const event_type of lifecycleEventTypes)
    checkActiveEvent(
      validators,
      {
        event_id: "event-1",
        global_sequence: 1,
        aggregate_sequence: 1,
        schema_version: 1,
        agent_id: "agent-1",
        event_type,
        occurred_at: "2026-10-29T00:00:00Z",
        data: {},
      },
      true,
      event_type,
    );
});

test("the contract pins lifecycle deadlines, failure codes, retention and cancel update", () => {
  const contract = read("agent-controller/control-contract.json");
  const reliability = contract.lifecycle_reliability ?? {};
  const deadlines = reliability.phase_deadlines_seconds ?? {};
  assert.equal(deadlines.network_ensure, 600);
  assert.equal(deadlines.runtime_initialize, 1800);
  assert.equal(deadlines.publish, 600);
  assert.equal(deadlines.default, 600);
  for (const code of failureCodes)
    assert.ok(
      (reliability.failure_codes ?? []).includes(code),
      "failure code " + code,
    );
  assert.equal(reliability.failed_create_ttl_seconds, 604800);
  assert.equal(reliability.cancel_update, "cancel_lifecycle_operation");
});
