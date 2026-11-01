import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const root = new URL("../../../contracts/", import.meta.url);
const readRaw = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const proposal = readRaw("agent-controller/live-model-semantics-proposal.json");
const activeRevision = readRaw(
  "agent-controller/control-contract.json",
).revision;

const usagePath = "/internal/model-profiles/{model_profile_id}/usage";
const eventsPath = "/internal/model-profiles/{model_profile_id}/events";
const usageRoute = `GET ${usagePath}`;
const eventsRoute = `GET ${eventsPath}`;
const eventType = "model_profile_revised";
const maximumSafeInteger = 9007199254740991;
const pinFields = [
  "model_profile_revision",
  "model_profile_revision_id",
  "pinned_model_profile_revision",
  "model_profile_pin",
];

function read(path) {
  const value = readRaw(path);
  if (activeRevision !== proposal.base_control_revision) return value;
  if (path === "agent-controller/control-contract.json") {
    value.revision = proposal.target_control_revision;
    Object.assign(
      value.resources[proposal.route_resource],
      structuredClone(proposal.routes),
    );
    value.live_model_semantics = structuredClone(proposal.live_model_semantics);
  } else if (path === "agent-controller/callers.json") {
    for (const route of Object.values(proposal.routes))
      value.routes[`${route.method} ${route.path}`] = structuredClone(
        proposal.caller_policy,
      );
  } else if (path === "agent-controller/control-api.schema.json") {
    Object.assign(value.$defs, structuredClone(proposal.schema_definitions));
    Object.assign(
      value.$defs.agent.properties,
      structuredClone(proposal.agent_properties),
    );
  }
  return value;
}

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

const fragmentNames = () => [
  ...Object.keys(proposal.schema_definitions),
  ...Object.keys(proposal.agent_properties),
  ...Object.keys(proposal.publication.schema_definitions),
  ...Object.keys(proposal.acp.schema_definitions),
];

function proposalValidators() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addFormat("date-time", { type: "string", validate: utcTimestamp });
  const $id =
    "https://antnest.local/agent-controller/live-model-semantics-proposal.schema.json";
  ajv.addSchema({
    $id,
    $defs: {
      ...structuredClone(proposal.shared_defs),
      ...structuredClone(proposal.schema_definitions),
      ...structuredClone(proposal.agent_properties),
      ...structuredClone(proposal.publication.schema_definitions),
      ...structuredClone(proposal.acp.schema_definitions),
    },
  });
  return Object.fromEntries(
    fragmentNames().map((name) => [
      name,
      ajv.compile({ $ref: `${$id}#/$defs/${name}` }),
    ]),
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
  return {
    agent: ajv.compile({ $ref: `${schema.$id}#/$defs/agent` }),
  };
}

function check(validators, definition, value, valid, label) {
  const before = structuredClone(value);
  assert.equal(typeof validators[definition], "function", definition);
  assert.equal(validators[definition](value), valid, label);
  assert.deepEqual(value, before, label + " cannot mutate input");
}

test("the proposal stays separate until the owning producer publishes its target revision", () => {
  assert.equal(
    proposal.contract,
    "antnest.agent-controller.live-model-semantics.proposal",
  );
  assert.equal(proposal.revision, 1);
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.base_control_revision, 47);
  assert.equal(proposal.target_control_revision, 48);
  assert.equal(proposal.route_resource, "model_profiles");
  assert([47, 48, 49].includes(activeRevision), "unknown publication revision");
  const contract = readRaw("agent-controller/control-contract.json");
  const callers = readRaw("agent-controller/callers.json");
  const schema = readRaw("agent-controller/control-api.schema.json");
  assert.deepEqual(proposal.shared_defs.id, schema.$defs.id);
  assert.deepEqual(proposal.shared_defs.timestamp, schema.$defs.timestamp);
  if (activeRevision === proposal.base_control_revision) {
    assert.equal(contract.live_model_semantics, undefined);
    for (const [name, route] of Object.entries(proposal.routes)) {
      assert.equal(contract.resources.model_profiles[name], undefined);
      assert.equal(callers.routes[`${route.method} ${route.path}`], undefined);
    }
    for (const name of Object.keys(proposal.schema_definitions))
      assert.equal(schema.$defs[name], undefined);
    for (const name of Object.keys(proposal.agent_properties))
      assert.equal(schema.$defs.agent.properties[name], undefined);
  } else {
    assert.deepEqual(
      contract.live_model_semantics,
      proposal.live_model_semantics,
    );
    for (const [name, route] of Object.entries(proposal.routes)) {
      assert.deepEqual(contract.resources.model_profiles[name], route);
      assert.deepEqual(
        callers.routes[`${route.method} ${route.path}`],
        proposal.caller_policy,
      );
    }
    for (const [name, definition] of Object.entries(
      proposal.schema_definitions,
    ))
      assert.deepEqual(schema.$defs[name], definition);
    for (const [name, definition] of Object.entries(proposal.agent_properties))
      assert.deepEqual(schema.$defs.agent.properties[name], definition);
  }
});

test("the control contract declares model profile usage and event routes", () => {
  const contract = read("agent-controller/control-contract.json");
  const profiles = contract.resources?.model_profiles ?? {};
  assert.deepEqual(profiles.usage, {
    method: "GET",
    path: usagePath,
    query: ["organization_id"],
    success_status: 200,
    response: "control-api.schema.json#/$defs/model_profile_usage",
  });
  assert.deepEqual(profiles.events, {
    method: "GET",
    path: eventsPath,
    query: ["organization_id", "after_revision", "limit"],
    success_status: 200,
    response: "control-api.schema.json#/$defs/model_profile_event_list",
  });
});

test("the live-model routes keep admin-console as the only workload caller", () => {
  const callers = read("agent-controller/callers.json");
  for (const route of [usageRoute, eventsRoute])
    assert.deepEqual(callers.routes[route], {
      callers: ["admin-console"],
      authentication: "workload",
      caller_context: { "admin-console": "required" },
      request_body: "none",
    });
});

test("the usage response is a strict pair of nonnegative integers", () => {
  const validators = proposalValidators();
  const definition = "model_profile_usage";
  for (const value of [
    { templates: 0, agents: 0 },
    { templates: 3, agents: 12 },
    { templates: maximumSafeInteger, agents: 1 },
  ])
    check(validators, definition, value, true, JSON.stringify(value));
  for (const value of [
    { agents: 0 },
    { templates: 0 },
    { templates: -1, agents: 0 },
    { templates: 0, agents: -2 },
    { templates: 1.5, agents: 0 },
    { templates: 0, agents: 0.25 },
    { templates: "3", agents: 0 },
    { templates: 0, agents: true },
    { templates: 0, agents: 0, extra: 1 },
    { templates: 0, agents: 0, truncated: false },
    null,
    [],
    "usage",
  ])
    check(validators, definition, value, false, JSON.stringify(value));
});

test("effective_models entries carry an opaque id and a positive current revision", () => {
  const validators = proposalValidators();
  const definition = "effective_models";
  check(
    validators,
    definition,
    [
      { model_profile_id: "profile-1", revision: 4 },
      { model_profile_id: "profile-2", revision: maximumSafeInteger },
    ],
    true,
    "primary plus fallback entries",
  );
  for (const value of [
    [],
    [{ model_profile_id: "profile-1", revision: 0 }],
    [{ model_profile_id: "profile-1", revision: -1 }],
    [{ model_profile_id: "profile-1", revision: 1.5 }],
    [{ model_profile_id: "profile-1", revision: "4" }],
    [{ model_profile_id: "profile-1" }],
    [{ revision: 4 }],
    [{ model_profile_id: "", revision: 4 }],
    [{ model_profile_id: "profile-1", revision: 4, extra: true }],
    [{ model_profile_id: "profile-1", revision: 4, revision_id: "r-1" }],
    null,
    "models",
    { model_profile_id: "profile-1", revision: 4 },
  ])
    check(validators, definition, value, false, JSON.stringify(value));
});

test("the agent detail envelope carries effective_models without touching frozen lineage", () => {
  const validators = controlApiValidators();
  const agent = () => ({
    agent_id: "agent-1",
    organization_id: "org-1",
    owner_user_id: "user-1",
    name: "Agent",
    desired_state: "enabled",
    lifecycle_state: "created",
    activation_state: "enabled",
    runtime_state: "waiting",
    access_revision: "revision-1",
    aggregate_sequence: 0,
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
  });
  const valid = agent();
  valid.effective_models = [
    { model_profile_id: "profile-1", revision: 2 },
    { model_profile_id: "profile-9", revision: 7 },
  ];
  check(validators, "agent", valid, true, "agent detail with effective_models");
  const absent = agent();
  check(
    validators,
    "agent",
    absent,
    true,
    "agent detail without a spec omits it",
  );
  for (const effective_models of [
    [],
    [{ model_profile_id: "profile-1", revision: 0 }],
    [{ model_profile_id: "profile-1", revision: "2" }],
    [{ model_profile_id: "profile-1", revision: 2, settings: {} }],
  ]) {
    const candidate = agent();
    candidate.effective_models = effective_models;
    check(
      validators,
      "agent",
      candidate,
      false,
      "agent rejects effective_models " + JSON.stringify(effective_models),
    );
  }
  const unknown = agent();
  unknown.effective_model_revisions = [
    { model_profile_id: "p-1", revision: 1 },
  ];
  check(validators, "agent", unknown, false, "agent rejects unknown fields");
});

test("the revised event is a strict journal record without credentials or settings", () => {
  const validators = proposalValidators();
  const event = () => ({
    event_type: eventType,
    request_id: "request-1",
    organization_id: "org-1",
    model_profile_id: "profile-1",
    revision_id: "revision-9",
    previous_revision: 8,
    revision: 9,
    occurred_at: "2026-10-30T00:00:00Z",
  });
  check(
    validators,
    "model_profile_revised_event",
    event(),
    true,
    "valid event",
  );
  for (const field of [
    "event_type",
    "request_id",
    "organization_id",
    "model_profile_id",
    "revision_id",
    "previous_revision",
    "revision",
    "occurred_at",
  ]) {
    const missing = event();
    delete missing[field];
    check(
      validators,
      "model_profile_revised_event",
      missing,
      false,
      "event requires " + field,
    );
  }
  for (const [field, value] of [
    ["event_type", "agent_rebuilt"],
    ["event_type", "model_profile_created"],
    ["previous_revision", 0],
    ["previous_revision", -1],
    ["previous_revision", 1.5],
    ["previous_revision", "8"],
    ["revision", 0],
    ["revision", 1],
    ["revision", 2.5],
    ["occurred_at", "not-a-timestamp"],
    ["occurred_at", "2026-13-40T00:00:00Z"],
    ["request_id", ""],
    ["organization_id", 42],
  ]) {
    const candidate = { ...event(), [field]: value };
    check(
      validators,
      "model_profile_revised_event",
      candidate,
      false,
      "event rejects " + field + " " + JSON.stringify(value),
    );
  }
  for (const field of ["credential", "settings", "model", "api_key", "extra"]) {
    const candidate = { ...event(), [field]: "synthetic-private-field" };
    check(
      validators,
      "model_profile_revised_event",
      candidate,
      false,
      "event rejects field " + field,
    );
  }
  check(
    validators,
    "model_profile_event_list",
    { items: [event()], next_after_revision: 9 },
    true,
    "event list with cursor",
  );
  check(
    validators,
    "model_profile_event_list",
    { items: [], next_after_revision: null },
    true,
    "empty event list",
  );
  for (const value of [
    { items: [event()] },
    { items: [event()], next_after_revision: 0 },
    { items: [event()], next_after_revision: "9" },
    { items: [event()], next_after_revision: null, extra: 1 },
    {
      items: [{ ...event(), previous_revision: 0 }],
      next_after_revision: null,
    },
    { next_after_revision: null },
    null,
    [],
  ])
    check(
      validators,
      "model_profile_event_list",
      value,
      false,
      JSON.stringify(value),
    );
});

test("the publication revision fragment is an optional positive safe integer", () => {
  const validators = proposalValidators();
  for (const value of [1, 2, 42, maximumSafeInteger])
    check(
      validators,
      "model_profile_revision",
      value,
      true,
      "revision " + value,
    );
  for (const value of [0, -1, 1.5, "3", true, null, {}, []])
    check(
      validators,
      "model_profile_revision",
      value,
      false,
      "revision " + JSON.stringify(value),
    );
  check(
    validators,
    "published_model",
    { model_profile_id: "profile-1" },
    true,
    "legacy snapshot model without the field stays valid",
  );
  check(
    validators,
    "published_model",
    { model_profile_id: "profile-1", model_profile_revision: 5 },
    true,
    "published model with current revision",
  );
  for (const value of [
    { model_profile_revision: 5 },
    { model_profile_id: "profile-1", model_profile_revision: 0 },
    { model_profile_id: "profile-1", model_profile_revision: 1.5 },
    { model_profile_id: "profile-1", model_profile_revision: "5" },
    { model_profile_id: "profile-1", model_profile_revision: 5, extra: 1 },
    {
      model_profile_id: "profile-1",
      model_profile_revision: 5,
      model_profile_revision_pin: 5,
    },
    null,
    "model",
  ])
    check(validators, "published_model", value, false, JSON.stringify(value));
});

test("the persisted snapshot, candidate and audit fragments freeze admission revisions", () => {
  const validators = proposalValidators();
  check(
    validators,
    "persisted_snapshot_model",
    { modelProfileId: "profile-1" },
    true,
    "persisted snapshot without revision stays valid",
  );
  check(
    validators,
    "persisted_snapshot_model",
    { modelProfileId: "profile-1", modelProfileRevision: 11 },
    true,
    "persisted snapshot with frozen revision",
  );
  for (const value of [
    { modelProfileId: "profile-1", modelProfileRevision: 0 },
    { modelProfileId: "profile-1", modelProfileRevision: 2.5 },
    { modelProfileId: "profile-1", modelProfileRevision: "11" },
    { modelProfileId: "profile-1", modelProfileRevision: 11, extra: true },
    { modelProfileRevision: 11 },
  ])
    check(
      validators,
      "persisted_snapshot_model",
      value,
      false,
      JSON.stringify(value),
    );
  const candidate = () => ({
    modelProfileId: "profile-1",
    providerConnectionId: "connection-1",
    modelProfileRevision: 3,
    model: { name: "model-x" },
  });
  check(validators, "model_candidate", candidate(), true, "primary candidate");
  const legacy = candidate();
  delete legacy.modelProfileRevision;
  check(
    validators,
    "model_candidate",
    legacy,
    true,
    "fallback or compactor candidate may omit the field",
  );
  for (const value of [
    { ...candidate(), modelProfileRevision: 0 },
    { ...candidate(), modelProfileRevision: -4 },
    { ...candidate(), modelProfileRevision: "3" },
    { ...candidate(), modelProfileRevision: 3, credential: "secret" },
  ])
    check(validators, "model_candidate", value, false, JSON.stringify(value));
  for (const value of [null, 1, 6, maximumSafeInteger])
    check(
      validators,
      "audit_model_profile_revision",
      value,
      true,
      "audit revision " + JSON.stringify(value),
    );
  for (const value of [0, -1, 1.5, "6", true, {}, []])
    check(
      validators,
      "audit_model_profile_revision",
      value,
      false,
      "audit revision " + JSON.stringify(value),
    );
  check(
    validators,
    "audit_detail_model_revision",
    { run_id: "run-1" },
    true,
    "audit detail may omit the field",
  );
  check(
    validators,
    "audit_detail_model_revision",
    { run_id: "run-1", model_profile_revision: null },
    true,
    "audit detail marks unknown historical snapshots null",
  );
  check(
    validators,
    "audit_detail_model_revision",
    { run_id: "run-1", model_profile_revision: 4 },
    true,
    "audit detail records the admitted primary revision",
  );
  for (const value of [
    { run_id: "run-1", model_profile_revision: 0 },
    { run_id: "run-1", model_profile_revision: "4" },
    { run_id: "run-1", model_profile_revision: 4, extra: true },
    { model_profile_revision: 4 },
  ])
    check(
      validators,
      "audit_detail_model_revision",
      value,
      false,
      JSON.stringify(value),
    );
});

test("the model profile journal stays outside the Agent event_type enum", () => {
  const contract = read("agent-controller/control-contract.json");
  const schema = read("agent-controller/control-api.schema.json");
  assert.equal(contract.live_model_semantics.event_type, eventType);
  assert.equal(contract.live_model_semantics.events_default_limit, 50);
  assert.equal(contract.live_model_semantics.events_max_limit, 100);
  assert.equal(contract.live_model_semantics.usage_counts_complete, true);
  assert.equal(contract.live_model_semantics.usage_truncated, false);
  for (const eventTypes of [
    contract.enums?.event_type ?? [],
    schema.$defs.agent_event?.properties?.event_type?.enum ?? [],
  ])
    assert.equal(
      eventTypes.filter((type) => type === eventType).length,
      0,
      "model_profile_revised is not an Agent event",
    );
});

test("the proposal introduces no optional model revision pinning", () => {
  const schema = read("agent-controller/control-api.schema.json");
  for (const name of [
    "create_template_request",
    "revise_template_request",
    "create_agent_request",
    "rebuild_agent_request",
    "agent_configuration",
    "agent_template",
  ]) {
    const properties = schema.$defs[name]?.properties ?? {};
    for (const field of pinFields)
      assert.equal(
        Object.hasOwn(properties, field),
        false,
        name + " must not gain " + field,
      );
  }
  assert.equal(proposal.optional_model_pinning, false);
});
