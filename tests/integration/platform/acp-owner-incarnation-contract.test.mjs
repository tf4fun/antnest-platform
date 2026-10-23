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

test("planned operations do not expand either current active caller catalog", () => {
  const routes = [
    "POST /internal/acp-incarnations/register",
    "GET /internal/acp-incarnations/{registration_id}",
    "POST /internal/acp-owner/incarnation/probe",
  ];
  for (const path of [
    "services/runtime-controller/api/callers.json",
    "contracts/agent-acp/callers.json",
  ]) {
    const catalog = read(path);
    for (const route of routes)
      assert.equal(
        Object.hasOwn(catalog.routes, route),
        false,
        `${path}: ${route}`,
      );
  }
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
