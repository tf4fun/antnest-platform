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
const schemaID =
  "https://antnest.local/agent-controller/runtime-barrier-recovery.schema.json";
const policyPath = "/internal/runtime-barrier-recovery-policy";
const rebuildRoute = "POST /internal/agents/{agent_id}/rebuild";
const maximumRevision = Number.MAX_SAFE_INTEGER;

const samples = {
  policy: () => ({
    organization_id: "org-1",
    revision: 0,
    mode: "manual",
    cooldown_ms: 300000,
  }),
  policy_query: () => ({ organization_id: "org-1" }),
  policy_update_request: () => ({
    request_id: "policy-request-1",
    organization_id: "org-1",
    actor_principal_id: "admin-1",
    expected_revision: 0,
    mode: "auto",
    cooldown_ms: 300000,
  }),
  recovery_request: () => ({
    barrier_id: "barrier-1",
    expected_runtime_revision: "runtime-1",
  }),
  rebuild_agent_request: () => ({
    request_id: "rebuild-request-1",
    organization_id: "org-1",
    actor_principal_id: "admin-1",
    template_id: "template-1",
    template_revision: 1,
  }),
  runtime_recovery: () => ({
    barrier_id: "barrier-1",
    reason: "runtime_barrier_required",
    runtime_revision: "runtime-1",
    policy_revision: 0,
    mode: "manual",
    cooldown_ms: 300000,
    rebuild_request_id: "rebuild-request-1",
    notification_id: "notification-1",
    cooldown_until: null,
  }),
  notification_data: () => ({
    organization_id: "org-1",
    barrier_id: "barrier-1",
    runtime_revision: "runtime-1",
    reason: "runtime_barrier_required",
    policy_revision: 0,
  }),
};
const objectDefinitions = Object.keys(samples);
const controllerIdentities = {
  policy: ["organization_id"],
  policy_query: ["organization_id"],
  policy_update_request: [
    "request_id",
    "organization_id",
    "actor_principal_id",
  ],
  recovery_request: ["expected_runtime_revision"],
  rebuild_agent_request: [
    "request_id",
    "organization_id",
    "actor_principal_id",
    "template_id",
  ],
  runtime_recovery: [
    "runtime_revision",
    "rebuild_request_id",
    "notification_id",
  ],
  notification_data: ["organization_id", "runtime_revision"],
};
const barrierDefinitions = [
  "recovery_request",
  "runtime_recovery",
  "notification_data",
];

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

function pendingValidators({ useDefaults = false } = {}) {
  const schema = read("agent-controller/runtime-barrier-recovery.schema.json");
  assert.equal(schema.$id, schemaID);
  const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults });
  ajv.addFormat("date-time", { type: "string", validate: utcTimestamp });
  ajv.addSchema(schema);
  return {
    schema,
    root: ajv.getSchema(schemaID),
    ...Object.fromEntries(
      Object.keys(schema.$defs).map((name) => [
        name,
        ajv.compile({ $ref: `${schemaID}#/$defs/${name}` }),
      ]),
    ),
  };
}

function activeValidators() {
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
  ajv.addSchema(schema);
  return Object.fromEntries(
    ["agent", "rebuild_agent_request"].map((name) => [
      name,
      ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }),
    ]),
  );
}

function check(validators, definition, value, valid, label) {
  assert.equal(typeof validators[definition], "function", definition);
  assert.equal(validators[definition](value), valid, label);
  if (definition === "policy")
    assert.equal(validators.root(value), valid, label + " at the schema root");
}

test("pending recovery declares only future policy routes with administrator authority", () => {
  const manifest = read("agent-controller/runtime-barrier-recovery.json");
  assert.deepEqual(Object.keys(manifest).sort(), [
    "activation",
    "authentication",
    "manual",
    "notification",
    "owner",
    "policy",
    "recovery",
    "routes",
    "status",
    "version",
  ]);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.status, "pending");
  assert.equal(manifest.owner, "agent-controller");
  assert.equal(manifest.activation, "owning_controller_service_batch");
  assert.deepEqual(manifest.routes, [
    {
      method: "GET",
      path: policyPath,
      request: "policy_query",
      response: "policy",
      success: 200,
    },
    {
      method: "PUT",
      path: policyPath,
      request: "policy_update_request",
      response: "policy",
      success: 200,
    },
  ]);
  assert.deepEqual(manifest.authentication, {
    caller: "admin-console",
    cct: "required",
    audience: "agent-controller",
    role: "system_or_organization_administrator",
    organization: "signed_org",
    actor: "signed_sub",
  });
});

test("pending recovery declares defaults, replay ordering and durable recovery rules", () => {
  const manifest = read("agent-controller/runtime-barrier-recovery.json");
  // These declarations do not execute CAS, transactions, timers or recovery.
  assert.deepEqual(manifest.policy, {
    default_mode: "manual",
    default_revision: 0,
    default_cooldown_ms: 300000,
    first_persisted_revision: 1,
    replay_before_cas: true,
    receipt_atomic_with_policy: true,
    replay_returns_original: true,
  });
  assert.deepEqual(manifest.recovery, {
    deduplication: ["organization_id", "agent_id", "barrier_id"],
    cooldown_origin: "operation_accepted_at",
    cooldown_frozen_at_acceptance: true,
    notification_deduplication_independent: true,
    replay_original_prompt: false,
    replay_original_tool: false,
    read_failure_clears_reason: false,
  });
});

test("pending manual recovery and notifications reuse existing lifecycle and event transports", () => {
  const manifest = read("agent-controller/runtime-barrier-recovery.json");
  assert.deepEqual(manifest.manual, {
    route: rebuildRoute,
    extension: "recovery_request",
    reuse_existing_grant: true,
    target: "current_configured_template_revision",
  });
  assert.deepEqual(manifest.notification, {
    event_type: "agent_runtime_barrier_required",
    schema_version: 1,
    data: "notification_data",
    transport: "existing_agent_event_list_watch",
    starts_rebuild: false,
  });
});

test("pending policy endpoints stay out of active catalogs and Rebuild retains its caller", () => {
  const active = read("agent-controller/control-contract.json");
  const callers = read("agent-controller/callers.json");
  for (const operations of Object.values(active.resources))
    for (const route of Object.values(operations))
      assert.notEqual(
        route.path,
        policyPath,
        "pending policy is not activated",
      );
  for (const route of Object.keys(callers.routes))
    assert.notEqual(
      route.slice(route.indexOf(" ") + 1),
      policyPath,
      "pending policy has no active caller grant",
    );
  assert.deepEqual(callers.routes[rebuildRoute], {
    callers: ["admin-console"],
    authentication: "workload",
    caller_context: { "admin-console": "required" },
    request_body: "json",
  });
});

test("pending wire has exactly its closed field sets and a policy root", () => {
  const v = pendingValidators();
  assert.equal(v.schema.$ref, "#/$defs/policy");
  assert.deepEqual(
    Object.keys(v.schema.$defs).sort(),
    [
      ...objectDefinitions,
      "id",
      "barrier_id",
      "revision",
      "cooldown_ms",
      "mode",
    ].sort(),
  );
  for (const [name, make] of Object.entries(samples)) {
    const definition = v.schema.$defs[name];
    const required = Object.keys(make());
    const properties = [...required];
    if (name === "rebuild_agent_request") properties.push("recovery");
    assert.equal(definition.type, "object", name);
    assert.equal(definition.additionalProperties, false, name);
    assert.deepEqual([...definition.required].sort(), required.sort(), name);
    assert.deepEqual(
      Object.keys(definition.properties).sort(),
      properties.sort(),
      name,
    );
    check(v, name, make(), true, name + " complete wire");
  }
  assert.equal(v.root(samples.policy_query()), false);
});

test("Controller IDs stay compatible while barrier IDs retain the ACP opaque identity", () => {
  const v = pendingValidators();
  const active = read("agent-controller/control-api.schema.json");
  const acp = read("agent-acp/runtime-barrier-recovery.schema.json");
  assert.deepEqual(v.schema.$defs.id, active.$defs.id);
  assert.deepEqual(v.schema.$defs.barrier_id, acp.$defs.identity);
  for (const value of ["a", "Agent-1.a_b", "a".repeat(200)])
    check(v, "id", value, true, "Controller identity boundary");
  for (const value of ["", "a".repeat(201), " a", "a b", "a\n", 1, null])
    check(v, "id", value, false, "invalid Controller identity");
  for (const [name, fields] of Object.entries(controllerIdentities))
    for (const field of fields) {
      assert.equal(v.schema.$defs[name].properties[field].$ref, "#/$defs/id");
      check(
        v,
        name,
        { ...samples[name](), [field]: "a".repeat(200) },
        true,
        name + " identity limit",
      );
      check(
        v,
        name,
        { ...samples[name](), [field]: "invalid identity" },
        false,
        name + " identity whitespace",
      );
    }
  for (const name of barrierDefinitions) {
    assert.equal(
      v.schema.$defs[name].properties.barrier_id.$ref,
      "#/$defs/barrier_id",
    );
    for (const barrier_id of ["屏障:原执行/1?x=@!", "x".repeat(200)])
      check(
        v,
        name,
        { ...samples[name](), barrier_id },
        true,
        name + " opaque barrier",
      );
    for (const barrier_id of [
      "",
      "x".repeat(201),
      " barrier",
      "barrier ",
      "barrier\nid",
      "屏障 id",
      null,
      1,
    ])
      check(
        v,
        name,
        { ...samples[name](), barrier_id },
        false,
        name + " invalid barrier",
      );
  }
});

test("policy and projection revisions are nonnegative JavaScript safe integers", () => {
  const v = pendingValidators();
  for (const value of [0, 1, maximumRevision])
    check(v, "revision", value, true, "revision boundary");
  for (const value of [-1, 0.5, maximumRevision + 1, "1", null])
    check(v, "revision", value, false, "invalid revision");
  for (const [name, field] of [
    ["policy", "revision"],
    ["policy_update_request", "expected_revision"],
    ["runtime_recovery", "policy_revision"],
    ["notification_data", "policy_revision"],
  ]) {
    for (const value of [0, maximumRevision])
      check(
        v,
        name,
        { ...samples[name](), [field]: value },
        true,
        name + " revision boundary",
      );
    check(
      v,
      name,
      { ...samples[name](), [field]: maximumRevision + 1 },
      false,
      name + " unsafe revision",
    );
  }
});

test("cooldown and mode retain the exact policy and projection boundaries", () => {
  const v = pendingValidators();
  for (const value of [60000, 300000, 86400000])
    check(v, "cooldown_ms", value, true, "cooldown boundary");
  for (const value of [59999, 86400001, 60000.5, "300000", null])
    check(v, "cooldown_ms", value, false, "invalid cooldown");
  for (const value of ["auto", "notify", "manual"])
    check(v, "mode", value, true, "policy mode");
  for (const value of ["AUTO", "", "automatic", null])
    check(v, "mode", value, false, "invalid policy mode");
  for (const name of ["policy", "policy_update_request", "runtime_recovery"]) {
    for (const cooldown_ms of [60000, 86400000])
      check(
        v,
        name,
        { ...samples[name](), cooldown_ms },
        true,
        name + " cooldown boundary",
      );
    check(
      v,
      name,
      { ...samples[name](), cooldown_ms: 59999 },
      false,
      name + " cooldown bound",
    );
    for (const mode of ["auto", "notify", "manual"])
      check(v, name, { ...samples[name](), mode }, true, name + " mode");
    check(
      v,
      name,
      { ...samples[name](), mode: "AUTO" },
      false,
      name + " mode case",
    );
  }
});

test("all required wire fields remain required and objects cannot become null or arrays", () => {
  const v = pendingValidators();
  for (const [name, make] of Object.entries(samples)) {
    for (const field of Object.keys(make())) {
      const value = make();
      delete value[field];
      check(v, name, value, false, name + " missing " + field);
    }
    for (const value of [null, [], "object"])
      check(v, name, value, false, name + " object boundary");
  }
});

test("no pending schema default fills a missing policy or recovery input", () => {
  const v = pendingValidators({ useDefaults: true });
  for (const [name, field] of [
    ["policy", "mode"],
    ["policy", "cooldown_ms"],
    ["policy", "revision"],
    ["policy_update_request", "mode"],
    ["policy_update_request", "expected_revision"],
    ["runtime_recovery", "cooldown_until"],
  ]) {
    const value = samples[name]();
    delete value[field];
    const before = structuredClone(value);
    check(v, name, value, false, name + " missing " + field);
    assert.deepEqual(value, before, "validation cannot insert a default");
  }
  const value = samples.policy();
  check(v, "policy", value, true, "explicit historical default receipt");
  assert.deepEqual(value, samples.policy());
});

test("unknown fields and private authority or execution payloads stay outside every wire object", () => {
  const v = pendingValidators();
  const extras = {
    unknown_field: true,
    Organization_id: "org-1",
    cct: "PRIVATE-CCT-CANARY",
    credential: { token: "PRIVATE-CREDENTIAL-CANARY" },
    endpoint: "http://private-runtime.invalid/mcp",
    runtime_execution_id: "execution-1",
    run: { input: "PRIVATE-RUN-CONTENT-CANARY" },
    tool: { arguments: "PRIVATE-TOOL-CONTENT-CANARY" },
  };
  for (const [name, make] of Object.entries(samples))
    for (const [field, value] of Object.entries(extras))
      check(
        v,
        name,
        { ...make(), [field]: value },
        false,
        name + " rejects " + field,
      );
  for (const name of [
    "policy_update_request",
    "recovery_request",
    "rebuild_agent_request",
  ])
    check(
      v,
      name,
      { ...samples[name](), reason: "runtime_barrier_required" },
      false,
      name + " rejects client reason",
    );
  for (const name of ["runtime_recovery", "notification_data"])
    check(
      v,
      name,
      { ...samples[name](), reason: "runtime_unhealthy" },
      false,
      name + " fixed barrier reason",
    );
});

test("pending Rebuild preserves all existing fields and allows only a complete recovery extension", () => {
  const v = pendingValidators();
  const activeSchema = read("agent-controller/control-api.schema.json");
  const active = activeValidators();
  const legacy = samples.rebuild_agent_request();
  assert.equal(active.rebuild_agent_request(legacy), true);
  check(v, "rebuild_agent_request", legacy, true, "legacy Rebuild");
  assert.deepEqual(
    v.schema.$defs.rebuild_agent_request.required,
    activeSchema.$defs.rebuild_agent_request.required,
  );
  for (const field of Object.keys(legacy))
    assert.deepEqual(
      v.schema.$defs.rebuild_agent_request.properties[field],
      activeSchema.$defs.rebuild_agent_request.properties[field],
      "existing Rebuild field " + field,
    );
  assert.equal(
    v.schema.$defs.rebuild_agent_request.properties.recovery.$ref,
    "#/$defs/recovery_request",
  );
  check(
    v,
    "rebuild_agent_request",
    { ...legacy, recovery: samples.recovery_request() },
    true,
    "complete recovery extension",
  );
  for (const recovery of [
    null,
    {},
    { barrier_id: "barrier-1" },
    { expected_runtime_revision: "runtime-1" },
    { ...samples.recovery_request(), reason: "runtime_barrier_required" },
    { ...samples.recovery_request(), runtime_execution_id: "execution-1" },
  ])
    check(
      v,
      "rebuild_agent_request",
      { ...legacy, recovery },
      false,
      "incomplete or extended recovery",
    );
  for (const template_revision of [0, 1.5, "1"])
    check(
      v,
      "rebuild_agent_request",
      { ...legacy, template_revision },
      false,
      "invalid Template revision",
    );
});

test("cooldown_until accepts only null or an actual Z UTC calendar timestamp", () => {
  const v = pendingValidators();
  for (const cooldown_until of [
    null,
    "2026-10-22T00:00:00Z",
    "2024-02-29T23:59:59.123456789Z",
    "2000-02-29T00:00:00Z",
  ])
    check(
      v,
      "runtime_recovery",
      { ...samples.runtime_recovery(), cooldown_until },
      true,
      "UTC cooldown timestamp",
    );
  for (const cooldown_until of [
    "2026-10-22T00:00:00+00:00",
    "2026-10-22T08:00:00+08:00",
    "2026-10-22T00:00:00",
    "2026-10-22",
    "2026-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-10-22T24:00:00Z",
    "2026-10-22T00:60:00Z",
    "2026-10-22T00:00:00Z ",
    "not-a-timestamp",
    0,
  ])
    check(
      v,
      "runtime_recovery",
      { ...samples.runtime_recovery(), cooldown_until },
      false,
      "invalid UTC cooldown timestamp",
    );
});

test("legacy Agent validation never inserts a runtime_recovery projection", () => {
  const active = activeValidators();
  const fixtures = read("agent-controller/readiness-fixtures.json");
  const value = structuredClone(fixtures.legacy_agent);
  const before = structuredClone(value);
  assert.equal(Object.hasOwn(value, "runtime_recovery"), false);
  assert.equal(active.agent(value), true);
  assert.deepEqual(value, before);
  assert.equal(Object.hasOwn(value, "runtime_recovery"), false);
});

test("synthetic fixture vectors validate their declared wire definitions without simulating a service", () => {
  const fixtures = read(
    "agent-controller/runtime-barrier-recovery-fixtures.json",
  );
  assert.deepEqual(Object.keys(fixtures).sort(), [
    "purpose",
    "schema_vectors",
    "version",
  ]);
  assert.equal(fixtures.version, 1);
  assert.equal(typeof fixtures.purpose, "string");
  assert(fixtures.purpose.trim().length > 0);
  assert(Array.isArray(fixtures.schema_vectors));
  assert(fixtures.schema_vectors.length > 0);
  const names = new Set();
  const v = pendingValidators();
  for (const row of fixtures.schema_vectors) {
    assert.deepEqual(Object.keys(row).sort(), [
      "definition",
      "name",
      "valid",
      "value",
    ]);
    assert.equal(typeof row.name, "string");
    assert(row.name.trim().length > 0);
    assert(!names.has(row.name), "fixture names must be unique");
    names.add(row.name);
    assert.equal(typeof row.valid, "boolean");
    assert(
      Object.hasOwn(v.schema.$defs, row.definition),
      "known fixture definition",
    );
    const before = structuredClone(row.value);
    check(v, row.definition, row.value, row.valid, row.name);
    assert.deepEqual(
      row.value,
      before,
      "fixture validation cannot mutate input",
    );
  }
});
