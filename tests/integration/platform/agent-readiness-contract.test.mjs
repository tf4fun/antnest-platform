import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const root = new URL("../../../contracts/", import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, root), "utf8"));
const schema = read("agent-controller/control-api.schema.json");
const fixtures = read("agent-controller/readiness-fixtures.json");
const proofIdentityFields = [
  "organization_id",
  "agent_spec_revision_id",
  "execution_revision_id",
  "runtime_revision",
];
const proofNames = ["runtime-bound-v2", "acknowledged-agent-ready-v2"];
const event = (name) => {
  const matching = fixtures.event_vectors.filter((row) => row.name === name);
  assert.equal(matching.length, 1, name);
  return structuredClone(matching[0].value);
};

function validators({ useDefaults = false } = {}) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, useDefaults });
  ajv.addFormat("uri", {
    type: "string",
    validate: (value) => URL.canParse(value),
  });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        value,
      ) && Number.isFinite(Date.parse(value)),
  });
  ajv.addSchema(
    read("runtime/managed-mcp.schema.json"),
    new URL("../runtime/managed-mcp.schema.json", schema.$id).href,
  );
  ajv.addSchema(schema);
  return Object.fromEntries(
    ["agent", "agent_event", "event_list"].map((name) => [
      name,
      ajv.compile({ $ref: schema.$id + "#/$defs/" + name }),
    ]),
  );
}

const wire = validators();
function check(validate, value, valid, label) {
  assert.equal(
    validate(value),
    valid,
    label + " " + JSON.stringify(validate.errors),
  );
}
function checkEvent(value, valid, label) {
  check(wire.agent_event, value, valid, label);
  check(
    wire.event_list,
    {
      events: [structuredClone(value)],
      next_sequence: value?.global_sequence ?? 1,
    },
    valid,
    label + " in event list",
  );
}

test("readiness fixtures retain the historical event set and complete v2 proof shapes", () => {
  assert.equal(fixtures.version, 1);
  assert.equal(fixtures.maximum_revision, Number.MAX_SAFE_INTEGER);
  assert.equal(fixtures.legacy_event_types.length, 20);
  assert.equal(new Set(fixtures.legacy_event_types).size, 20);
  assert(fixtures.legacy_event_types.includes("agent_ready"));
  assert(!fixtures.legacy_event_types.includes("runtime_bound"));
  for (const name of proofNames) {
    const value = event(name),
      expected = [...proofIdentityFields, "ready_after_revision"];
    if (value.event_type === "agent_ready") expected.push("applied_revision");
    assert.deepEqual(Object.keys(value.data).sort(), expected.sort());
    assert.equal(value.schema_version, 2);
  }
});

test("a legacy Agent remains valid and receives no readiness default", () => {
  const original = structuredClone(fixtures.legacy_agent),
    value = structuredClone(original),
    defaulting = validators({ useDefaults: true });
  assert.equal(Object.hasOwn(original, "readiness"), false);
  check(wire.agent, value, true, "legacy Agent");
  check(defaulting.agent, value, true, "legacy Agent with defaults enabled");
  assert.deepEqual(value, original);
  assert.equal(Object.hasOwn(value, "readiness"), false);
});

for (const vector of fixtures.readiness_vectors)
  test(`Agent readiness accepts only the frozen values: ${vector.name}`, () => {
    check(
      wire.agent,
      { ...structuredClone(fixtures.legacy_agent), readiness: vector.value },
      vector.valid,
      vector.name,
    );
  });

test("adding readiness does not admit unknown Agent projection fields", () => {
  check(
    wire.agent,
    {
      ...structuredClone(fixtures.legacy_agent),
      unexpected_readiness: "ready",
    },
    false,
    "unknown Agent field",
  );
});

for (const type of fixtures.legacy_event_types)
  test(`historical schema_version 1 remains valid without ACK fields: ${type}`, () => {
    const value = { ...event("legacy-agent-ready"), event_type: type };
    for (const field of [
      "organization_id",
      "ready_after_revision",
      "applied_revision",
    ])
      assert.equal(Object.hasOwn(value.data, field), false);
    checkEvent(value, true, "historical " + type);
    checkEvent({ ...value, data: {} }, true, "historical empty data " + type);
    checkEvent(
      { ...value, data: { legacy_detail: { state: "retained" } } },
      true,
      "historical payload remains unrestricted " + type,
    );
  });

for (const vector of fixtures.event_vectors)
  test(`readiness event wire accepts the complete fixture: ${vector.name}`, () => {
    checkEvent(structuredClone(vector.value), vector.valid, vector.name);
  });

test("schema_version 1 cannot claim the new runtime_bound event", () => {
  checkEvent(
    { ...event("runtime-bound-v2"), schema_version: 1 },
    false,
    "legacy version cannot express runtime_bound",
  );
});

test("historical event compatibility still rejects unknown envelope fields, versions and event types", () => {
  checkEvent(
    { ...event("legacy-agent-ready"), unexpected: "extra" },
    false,
    "unknown legacy envelope field",
  );
  for (const schema_version of [0, 3, 1.5, "1", null])
    checkEvent(
      { ...event("legacy-agent-ready"), schema_version },
      false,
      "unsupported legacy version",
    );
  for (const event_type of ["unknown_readiness_event", "agent_runtime_bound"])
    checkEvent(
      { ...event("legacy-agent-ready"), event_type },
      false,
      "unknown legacy event type",
    );
});

for (const name of proofNames) {
  test(`every v2 proof field is required: ${name}`, () => {
    const original = event(name);
    for (const field of Object.keys(original.data)) {
      const value = structuredClone(original);
      delete value.data[field];
      checkEvent(value, false, name + " missing " + field);
    }
    const missingData = structuredClone(original);
    delete missingData.data;
    checkEvent(missingData, false, name + " missing data");
    for (const data of [null, false, 1, "proof", [], {}])
      checkEvent({ ...original, data }, false, name + " requires proof object");
  });

  test(`v2 proof identities use the existing Controller ID bounds: ${name}`, () => {
    for (const field of proofIdentityFields) {
      for (const identity of ["x", "id.valid_1-2", "x".repeat(200)]) {
        const value = event(name);
        value.data[field] = identity;
        checkEvent(value, true, name + " valid " + field);
      }
      for (const identity of [
        "",
        "x".repeat(201),
        " padded",
        "padded ",
        "two words",
        "tab\tid",
        "line\nid",
        "id/other",
        "id:other",
        "运行",
        null,
        1,
        true,
        {},
        [],
      ]) {
        const value = event(name);
        value.data[field] = identity;
        checkEvent(value, false, name + " invalid " + field);
      }
    }
  });

  test(`v2 proof revisions require positive JavaScript-safe integers: ${name}`, () => {
    const fields = ["ready_after_revision"];
    if (event(name).event_type === "agent_ready")
      fields.push("applied_revision");
    for (const field of fields)
      for (const vector of fixtures.revision_vectors) {
        const value = event(name);
        value.data[field] = structuredClone(vector.value);
        checkEvent(value, vector.valid, name + " " + field + " " + vector.name);
      }
  });

  test(`v2 proof and event envelopes reject unknown or private fields: ${name}`, () => {
    for (const field of [
      "unexpected",
      "runtime_execution_id",
      "mcp_endpoint",
      "credential",
    ]) {
      const value = event(name);
      value.data[field] = "synthetic-extra-field";
      checkEvent(value, false, name + " unknown proof field " + field);
      const envelope = event(name);
      envelope[field] = "synthetic-extra-field";
      checkEvent(envelope, false, name + " unknown envelope field " + field);
    }
  });

  test(`v2 events reject unsupported versions and event types: ${name}`, () => {
    for (const schema_version of [0, 3, 1.5, "2", null])
      checkEvent(
        { ...event(name), schema_version },
        false,
        name + " unsupported version",
      );
    for (const event_type of [
      "unknown_readiness_event",
      "agent_runtime_bound",
      ...fixtures.legacy_event_types.filter((type) => type !== "agent_ready"),
    ])
      checkEvent(
        { ...event(name), event_type },
        false,
        name + " unsupported v2 type " + event_type,
      );
  });
}

test("runtime_bound has no applied acknowledgement field", () => {
  const value = event("runtime-bound-v2");
  value.data.applied_revision = 8;
  checkEvent(value, false, "runtime_bound cannot carry an ACK");
});

// These validators freeze wire structure only. Revision ordering, matching
// organizations/current bindings, authorization and atomic event deduplication
// remain the responsibility of the later Controller transaction component tests.
