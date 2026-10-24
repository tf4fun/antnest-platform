import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const root = new URL("../../../", import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const schemaID =
  "https://antnest.dev/contracts/agent-acp/owner-incarnation.schema.json";
const schemaPath = "contracts/agent-acp/owner-incarnation.schema.json";
const manifestPath = "contracts/agent-acp/owner-incarnation-contract.json";
const controlSchemaPath =
  "services/runtime-controller/api/control-api.schema.json";
const controlContractPath =
  "services/runtime-controller/api/control-contract.json";
const controlAliases = {
  acp_register_request: "register_request",
  acp_registration: "registration",
  acp_inspection: "inspection",
  acp_registration_id: "registration_id",
  acp_incarnation_error: "error",
};
const memberID = "acp-a";
const incarnationID = "01234567-89ab-4cde-8fab-0123456789ab";
const registrationID = "12345678-9abc-4def-9abc-123456789abc";
const receiptID = "23456789-abcd-4ef0-abcd-23456789abcd";
const nonce = "0123456789abcdef".repeat(4);
const timestamp = "2026-10-23T12:34:56.123456789Z";

const errors = {
  service_unauthenticated: { http_status: 401, retryable: false },
  caller_not_allowed: { http_status: 403, retryable: false },
  invalid_request: { http_status: 400, retryable: false },
  unsupported_media_type: { http_status: 415, retryable: false },
  request_too_large: { http_status: 413, retryable: false },
  acp_member_not_allowed: { http_status: 403, retryable: false },
  acp_incarnation_unverified: { http_status: 403, retryable: false },
  acp_incarnation_conflict: { http_status: 409, retryable: false },
  acp_probe_intent_mismatch: { http_status: 409, retryable: false },
  route_not_found: { http_status: 404, retryable: false },
  method_not_allowed: { http_status: 405, retryable: false },
  acp_registration_unavailable: { http_status: 503, retryable: true },
  acp_registry_unavailable: { http_status: 503, retryable: true },
  deadline_exceeded: { http_status: 504, retryable: true },
  internal_error: { http_status: 500, retryable: true },
};

const registration = () => ({
  registration_id: registrationID,
  member_id: memberID,
  incarnation_id: incarnationID,
});
const probe = () => ({
  member_id: memberID,
  incarnation_id: incarnationID,
  registration_nonce: nonce,
  challenge: "fedcba9876543210".repeat(4),
});
const stopped = () => ({
  state: "stopped",
  ...registration(),
  stop_receipt: {
    receipt_id: receiptID,
    reason: "container_stopped",
    observed_at: timestamp,
  },
});
const samples = {
  register_request: () => ({
    member_id: memberID,
    incarnation_id: incarnationID,
    registration_nonce: nonce,
  }),
  registration,
  probe_request: probe,
  probe_response: probe,
  running: () => ({
    state: "running",
    ...registration(),
    observed_at: timestamp,
  }),
  unknown: () => ({
    state: "unknown",
    registration_id: registrationID,
    reason: "unregistered",
  }),
  stopped,
  error: () => ({
    code: "invalid_request",
    message: "Invalid incarnation request",
    retryable: false,
  }),
};
const definitionFor = (name) =>
  ["running", "unknown", "stopped"].includes(name) ? "inspection" : name;
const objectCases = [
  ...Object.entries(samples).map(([name, make]) => ({
    name,
    definition: definitionFor(name),
    make,
    wrap: (value) => value,
  })),
  {
    name: "stop_receipt",
    definition: "inspection",
    make: () => stopped().stop_receipt,
    wrap: (value) => ({ ...stopped(), stop_receipt: value }),
  },
];

function validators() {
  const schema = read(schemaPath);
  assert.equal(schema.$id, schemaID);
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  ajv.addSchema(schema);
  const definitions = [
    "member_id",
    "incarnation_id",
    "registration_id",
    "receipt_id",
    "nonce",
    "timestamp",
    ...new Set(objectCases.map(({ definition }) => definition)),
  ];
  return Object.fromEntries(
    definitions.map((name) => [
      name,
      ajv.compile({ $ref: `${schemaID}#/$defs/${name}` }),
    ]),
  );
}

function controlValidators() {
  const schema = read(controlSchemaPath);
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateFormats: false,
  });
  for (const path of [
    schemaPath,
    "contracts/runtime/tunnel-bootstrap.schema.json",
    "contracts/runtime/instance-connection.schema.json",
    "contracts/runtime/managed-mcp.schema.json",
    "contracts/runtime/runtime-spec.schema.json",
    "contracts/skill-registry/runtime-delivery.schema.json",
    "services/runtime-controller/api/runtime-deployment.schema.json",
  ])
    ajv.addSchema(read(path));
  ajv.addSchema(schema);
  return Object.fromEntries(
    Object.keys(controlAliases).map((alias) => [
      alias,
      ajv.compile({ $ref: `${schema.$id}#/$defs/${alias}` }),
    ]),
  );
}

function check(validators, definition, value, valid, label) {
  const before = structuredClone(value);
  const validate = validators[definition];
  assert.equal(typeof validate, "function", definition);
  assert.equal(
    validate(value),
    valid,
    `${label}: ${JSON.stringify(validate.errors)}`,
  );
  assert.deepEqual(value, before, `${label}: validation must not mutate input`);
}

test("incarnation DTOs accept their complete independent wire samples", () => {
  const v = validators();
  for (const { name, definition, make, wrap } of objectCases)
    check(v, definition, wrap(make()), true, name);
});

test("every object has an exact required field set without nullable or defaults", () => {
  const schema = read(schemaPath);
  assert.equal(schema.$id, schemaID);
  assert.equal(schema.$defs.inspection.oneOf.length, 3);
  const visit = (value, path) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    assert.equal(Object.hasOwn(value, "default"), false, `${path}: default`);
    assert.equal(Object.hasOwn(value, "nullable"), false, `${path}: nullable`);
    if (value.type === "object") {
      assert.equal(value.additionalProperties, false, path);
      assert.deepEqual(
        [...value.required].sort(),
        Object.keys(value.properties).sort(),
        `${path}: every property must be required`,
      );
    }
    for (const [key, item] of Object.entries(value))
      visit(item, `${path}/${key}`);
  };
  visit(schema, "schema");
});

test("every DTO and nested receipt rejects missing fields, null and wrong types", () => {
  const v = validators();
  for (const { name, definition, make, wrap } of objectCases) {
    for (const invalid of [null, false, 1, "object", []])
      check(v, definition, wrap(invalid), false, `${name}: object required`);
    for (const [field, original] of Object.entries(make())) {
      const missing = make();
      delete missing[field];
      check(v, definition, wrap(missing), false, `${name}: missing ${field}`);
      const invalidTypes =
        typeof original === "boolean"
          ? [null, "false", 0, {}, []]
          : typeof original === "object"
            ? [null, false, 1, "object", []]
            : [null, false, 1, {}, []];
      for (const value of invalidTypes)
        check(
          v,
          definition,
          wrap({ ...make(), [field]: value }),
          false,
          `${name}: wrong type for ${field}`,
        );
    }
  }
});

test("private selectors, credentials and substitute execution proof are forbidden at every object layer", () => {
  const v = validators();
  const forbidden = {
    unknown_field: "extra",
    Member_id: memberID,
    url: "https://untrusted.invalid/probe",
    endpoint: "https://untrusted.invalid/probe",
    selector: "container-name",
    container_id: "a".repeat(64),
    engine_id: "engine-1",
    started_at: timestamp,
    credential: { token: "SYNTHETIC-NON-CREDENTIAL" },
    caller_context: "SYNTHETIC-NON-CONTEXT",
    workload: "agent-acp-service",
    epoch: 2,
    quiescent: true,
  };
  for (const { name, definition, make, wrap } of objectCases)
    for (const [field, value] of Object.entries(forbidden))
      check(
        v,
        definition,
        wrap({ ...make(), [field]: value }),
        false,
        `${name}: rejects ${field}`,
      );
});

test("member labels retain the frozen one-to-64 lowercase catalog-label bounds", () => {
  const v = validators();
  for (const value of ["a", "0", "acp-a", "a".repeat(64)])
    check(v, "member_id", value, true, "valid member label");
  for (const value of [
    "",
    "a".repeat(65),
    "ACP-a",
    "acp.a",
    "acp_a",
    "-acp",
    "acp-",
    "acp a",
    "acp\ta",
    "acp\na",
    "acp\u0000a",
    "运行",
    null,
    1,
    false,
    {},
    [],
  ])
    check(v, "member_id", value, false, "invalid member label");
});

test("incarnation, registration and receipt identities require lowercase UUIDv4", () => {
  const v = validators();
  for (const definition of [
    "incarnation_id",
    "registration_id",
    "receipt_id",
  ]) {
    for (const variant of ["8", "9", "a", "b"])
      check(
        v,
        definition,
        `01234567-89ab-4cde-${variant}fab-0123456789ab`,
        true,
        `${definition}: UUIDv4 variant`,
      );
    for (const value of [
      "",
      incarnationID.toUpperCase(),
      "01234567-89ab-1cde-8fab-0123456789ab",
      "01234567-89ab-7cde-8fab-0123456789ab",
      "01234567-89ab-4cde-7fab-0123456789ab",
      "01234567-89ab-4cde-cfab-0123456789ab",
      "01234567-89ab-4cde-8fab-0123456789ag",
      incarnationID.replaceAll("-", ""),
      `{${incarnationID}}`,
      `${incarnationID}0`,
      ` ${incarnationID}`,
      `${incarnationID} `,
      null,
      1,
      false,
      {},
      [],
    ])
      check(v, definition, value, false, `${definition}: invalid UUIDv4`);
  }
});

test("nonce encoding requires exactly 32 bytes of lowercase hexadecimal", () => {
  const v = validators();
  // Encoding vectors do not establish the producer's runtime randomness.
  for (const value of [nonce, "0".repeat(64), "f".repeat(64)])
    check(v, "nonce", value, true, "valid nonce encoding");
  for (const value of [
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    `0x${nonce}`,
    ` ${nonce}`,
    `${nonce}\n`,
    null,
    1,
    false,
    {},
    [],
  ])
    check(v, "nonce", value, false, "invalid nonce encoding");
});

test("timestamps require UTC seconds with an optional one-to-nine-digit fraction", () => {
  const v = validators();
  for (const value of [
    "2026-10-23T12:34:56Z",
    "2026-10-23T12:34:56.1Z",
    timestamp,
  ])
    check(v, "timestamp", value, true, "valid timestamp encoding");
  for (const value of [
    "",
    "2026-10-23",
    "2026-10-23T12:34Z",
    "2026-10-23 12:34:56Z",
    "2026-10-23T12:34:56",
    "2026-10-23T12:34:56+00:00",
    "2026-10-23T12:34:56.Z",
    "2026-10-23T12:34:56.1234567890Z",
    ` ${timestamp}`,
    `${timestamp}\n`,
    null,
    1,
    false,
    {},
    [],
  ])
    check(v, "timestamp", value, false, "invalid timestamp encoding");
});

test("inspection keeps running, unknown and durable stopped receipt shapes distinct", () => {
  const v = validators();
  for (const reason of [
    "unregistered",
    "platform_unavailable",
    "engine_changed",
    "membership_unavailable",
  ])
    check(v, "inspection", { ...samples.unknown(), reason }, true, reason);
  for (const reason of [
    "container_stopped",
    "container_restarted",
    "container_removed",
  ])
    check(
      v,
      "inspection",
      { ...stopped(), stop_receipt: { ...stopped().stop_receipt, reason } },
      true,
      reason,
    );
  for (const name of ["running", "unknown"])
    check(
      v,
      "inspection",
      { ...samples[name](), stop_receipt: stopped().stop_receipt },
      false,
      `${name}: no stop receipt`,
    );
  for (const reason of ["stopped", "container_removed", "", "UNREGISTERED"])
    check(
      v,
      "inspection",
      { ...samples.unknown(), reason },
      false,
      "invalid unknown reason",
    );
  for (const reason of ["unregistered", "platform_unavailable", "", "STOPPED"])
    check(
      v,
      "inspection",
      { ...stopped(), stop_receipt: { ...stopped().stop_receipt, reason } },
      false,
      "invalid stop reason",
    );
  for (const state of ["", "stopping", "quiescent", "STOPPED", "removed"])
    for (const name of ["running", "unknown", "stopped"])
      check(
        v,
        "inspection",
        { ...samples[name](), state },
        false,
        "unknown inspection state",
      );
  for (const field of ["member_id", "incarnation_id", "observed_at"])
    check(
      v,
      "inspection",
      { ...samples.unknown(), [field]: samples.running()[field] },
      false,
      `unknown cannot claim ${field}`,
    );
});

test("errors bind the exact code to retryability and bound the public message", () => {
  const v = validators();
  for (const [code, { retryable }] of Object.entries(errors)) {
    const value = { code, message: "Request failed", retryable };
    check(v, "error", value, true, code);
    check(
      v,
      "error",
      { ...value, retryable: !retryable },
      false,
      `${code}: flipped retryability`,
    );
  }
  for (const code of ["", "unknown_error", "ECONNREFUSED", "INTERNAL_ERROR"])
    check(
      v,
      "error",
      { ...samples.error(), code },
      false,
      "unknown error code",
    );
  for (const message of ["m", "m".repeat(512)])
    check(
      v,
      "error",
      { ...samples.error(), message },
      true,
      "message boundary",
    );
  for (const message of ["", "m".repeat(513)])
    check(
      v,
      "error",
      { ...samples.error(), message },
      false,
      "message boundary",
    );
});

test("the planned manifest freezes three narrow operations and the error HTTP mapping", () => {
  const manifest = read(manifestPath);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.status, "planned");
  assert.equal(manifest.issue, 49);
  const operations = {
    register: {
      receiver: "runtime-controller",
      method: "POST",
      path: "/internal/acp-incarnations/register",
      callers: ["agent-acp-service"],
      request: "register_request",
      response: "registration",
    },
    inspect: {
      receiver: "runtime-controller",
      method: "GET",
      path: "/internal/acp-incarnations/{registration_id}",
      callers: ["agent-acp-service"],
      response: "inspection",
    },
    probe: {
      receiver: "agent-acp-service",
      listener: "owner-private",
      method: "POST",
      path: "/internal/acp-owner/incarnation/probe",
      callers: ["runtime-controller"],
      request: "probe_request",
      response: "probe_response",
    },
  };
  assert.deepEqual(Object.keys(manifest.operations).sort(), [
    "inspect",
    "probe",
    "register",
  ]);
  for (const [name, expected] of Object.entries(operations))
    for (const [field, value] of Object.entries(expected))
      assert.deepEqual(
        manifest.operations[name][field],
        value,
        `${name}.${field}`,
      );
  assert.deepEqual(
    Object.keys(manifest.errors).sort(),
    Object.keys(errors).sort(),
  );
  for (const [code, expected] of Object.entries(errors))
    for (const [field, value] of Object.entries(expected))
      assert.equal(manifest.errors[code][field], value, `${code}.${field}`);
});

test("RC grants and the private ACP probe allow only their owning workload callers", () => {
  const catalog = read("services/runtime-controller/api/callers.json");
  for (const [method, path, body] of [
    ["POST", "/internal/acp-incarnations/register", "json"],
    ["GET", "/internal/acp-incarnations/{registration_id}", "none"],
  ]) {
    assert.deepEqual(catalog.routes[`${method} ${path}`], {
      callers: ["agent-acp-service"],
      authentication: "workload",
      caller_context: { "agent-acp-service": "none" },
      request_body: body,
    });
    assert.deepEqual(catalog.routes[`* ${path}`], {
      callers: [],
      authentication: "deny",
      caller_context: {},
      request_body: "none",
    });
  }
  const acp = read("contracts/agent-acp/callers.json");
  const probePath = "/internal/acp-owner/incarnation/probe";
  const probeRoute = `POST ${probePath}`;
  const deny = {
    callers: [],
    authentication: "deny",
    caller_context: {},
    request_body: "none",
  };
  assert.deepEqual(acp.routes[probeRoute], {
    callers: ["runtime-controller"],
    authentication: "workload",
    caller_context: { "runtime-controller": "none" },
    request_body: "json",
  });
  assert.deepEqual(acp.routes[`* ${probePath}`], deny);
  for (const [route, policy] of Object.entries(acp.routes)) {
    if (route.endsWith(` ${probePath}`) && route !== probeRoute)
      assert.deepEqual(policy, deny, `ACP: ${route}`);
    for (const path of [
      "/internal/acp-incarnations/register",
      "/internal/acp-incarnations/{registration_id}",
    ])
      assert.equal(route.endsWith(` ${path}`), false, `ACP: ${route}`);
  }
  for (const route of Object.keys(catalog.routes))
    assert.equal(route.endsWith(` ${probePath}`), false, `RC: ${route}`);
  assert.equal(read(manifestPath).status, "planned");
});

test("RC revision 21 binds registration and inspection to the frozen shared wire", () => {
  const contract = read(controlContractPath);
  const manifest = read(manifestPath);
  assert.equal(contract.revision, 21);
  for (const [name, operationID, responseAlias] of [
    ["register", "registerAcpIncarnation", "acp_registration"],
    ["inspect", "inspectAcpIncarnation", "acp_inspection"],
  ]) {
    const wire = manifest.operations[name];
    const matches = contract.routes.filter(
      (route) => route.method === wire.method && route.path === wire.path,
    );
    assert.equal(matches.length, 1, `${name}: one exact active route`);
    const [route] = matches;
    assert.equal(route.operation_id, operationID);
    assert.deepEqual(route.required_headers, ["Antnest-Service-Authorization"]);
    assert.equal(route.cache_control, "no-store");
    assert.equal(route.cache_control, wire.cache_control);
    assert.equal(route.response_bytes_max, 8192);
    assert.equal(route.response_bytes_max, wire.response_bytes_max);
    assert.equal(route.deadline_ms, 10000);
    assert.equal(route.deadline_ms, wire.deadline_ms);
    assert.deepEqual(Object.keys(route.query_parameters ?? {}), []);
    assert.deepEqual(route.responses, {
      200: {
        content_type: "application/json",
        body: `control-api.schema.json#/$defs/${responseAlias}`,
      },
    });
    assert.deepEqual([...route.errors].sort(), [...wire.errors].sort());
    for (const code of wire.errors) {
      assert.equal(
        contract.errors[code]?.status,
        manifest.errors[code].http_status,
      );
      assert.equal(
        contract.errors[code]?.retryable,
        manifest.errors[code].retryable,
      );
    }
    if (name === "register") {
      assert.equal(
        route.request_body,
        "control-api.schema.json#/$defs/acp_register_request",
      );
      assert.equal(route.request_bytes_max, 4096);
      assert.equal(route.request_bytes_max, wire.request_bytes_max);
      assert.deepEqual(Object.keys(route.path_parameters ?? {}), []);
    } else {
      assert.equal(Object.hasOwn(route, "request_body"), false);
      assert.deepEqual(route.path_parameters, {
        registration_id: "control-api.schema.json#/$defs/acp_registration_id",
      });
    }
  }
});

test("RC local aliases execute the shared closed DTO grammar without coercion or defaults", () => {
  const schema = read(controlSchemaPath);
  for (const [alias, definition] of Object.entries(controlAliases))
    assert.deepEqual(schema.$defs[alias], {
      $ref: `${schemaID}#/$defs/${definition}`,
    });
  const v = controlValidators();
  for (const { name, definition, make, wrap } of objectCases) {
    const alias = Object.keys(controlAliases).find(
      (key) => controlAliases[key] === definition,
    );
    if (!alias) continue;
    check(v, alias, wrap(make()), true, `${alias}: ${name}`);
    for (const invalid of [null, false, 1, "object", []])
      check(
        v,
        alias,
        wrap(invalid),
        false,
        `${alias}: ${name} object required`,
      );
    for (const field of Object.keys(make())) {
      const missing = make();
      delete missing[field];
      check(v, alias, wrap(missing), false, `${alias}: missing ${field}`);
      const original = make()[field];
      const invalidTypes =
        typeof original === "boolean"
          ? [null, "false", 0, {}, []]
          : typeof original === "object"
            ? [null, false, 1, "object", []]
            : [null, false, 1, {}, []];
      for (const invalid of invalidTypes)
        check(
          v,
          alias,
          wrap({ ...make(), [field]: invalid }),
          false,
          `${alias}: invalid ${field}`,
        );
      check(
        v,
        alias,
        wrap({ ...make(), [field.toUpperCase()]: make()[field] }),
        false,
        `${alias}: case alias for ${field}`,
      );
    }
    check(
      v,
      alias,
      wrap({ ...make(), private_selector: "untrusted-container" }),
      false,
      `${alias}: extra private field`,
    );
  }
  check(v, "acp_registration_id", registrationID, true, "registration UUIDv4");
  for (const invalid of [
    null,
    false,
    1,
    {},
    [],
    "",
    registrationID.toUpperCase(),
    "12345678-9abc-1def-9abc-123456789abc",
    `${registrationID}\n`,
  ])
    check(
      v,
      "acp_registration_id",
      invalid,
      false,
      "invalid registration UUIDv4",
    );
  for (const invalid of [
    { ...samples.unknown(), stop_receipt: stopped().stop_receipt },
    { ...samples.running(), state: "stopped" },
    {
      ...stopped(),
      stop_receipt: { ...stopped().stop_receipt, reason: "unknown" },
    },
  ])
    check(
      v,
      "acp_inspection",
      invalid,
      false,
      "inspection states stay distinct",
    );
  check(
    v,
    "acp_incarnation_error",
    {
      code: "acp_registry_unavailable",
      message: "Registry unavailable",
      retryable: true,
    },
    true,
    "retryable registry failure",
  );
  check(
    v,
    "acp_incarnation_error",
    { ...samples.error(), retryable: true },
    false,
    "error retryability remains bound to its code",
  );
});

test("scalar identities and actual DTO fields reject trailing line terminators", () => {
  const v = validators();
  const scalars = {
    member_id: "a",
    incarnation_id: incarnationID,
    registration_id: registrationID,
    receipt_id: receiptID,
    nonce,
    timestamp: "2026-10-23T12:34:56Z",
  };
  for (const [definition, value] of Object.entries(scalars)) {
    check(v, definition, value, true, `${definition}: valid base`);
    for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"])
      check(
        v,
        definition,
        value + suffix,
        false,
        `${definition}: trailing ${JSON.stringify(suffix)}`,
      );
  }
  check(
    v,
    "register_request",
    { ...samples.register_request(), registration_nonce: `${nonce}\n` },
    false,
    "register_request.registration_nonce: trailing LF",
  );
  for (const field of ["registration_nonce", "challenge"])
    check(
      v,
      "probe_request",
      { ...probe(), [field]: `${probe()[field]}\n` },
      false,
      `probe_request.${field}: trailing LF`,
    );
  for (const field of ["registration_id", "observed_at"])
    check(
      v,
      "inspection",
      { ...samples.running(), [field]: `${samples.running()[field]}\n` },
      false,
      `inspection.${field}: trailing LF`,
    );
});

// Schemas do not establish request/response identity equality, calendar validity,
// nonce randomness, platform 404 facts, durable idempotency or authentication.
// Those require the later owning-service producer and consumer acceptance tests.
