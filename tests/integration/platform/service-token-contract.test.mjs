import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const root = new URL("../../../contracts/platform/", import.meta.url);
const challenge = 'Bearer realm="antnest-service"';

function read(name) {
  const file = new URL(name, root);
  assert(existsSync(file), `missing shared token contract: ${name}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

// Fixture oracles only. Owning Go/TypeScript/Rust service batches must consume
// these vectors using their real startup parsers and authentication boundaries.
function parseCallers(raw) {
  const value = JSON.parse(raw);
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/gu) ?? [];
  const members = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].startsWith('"') && tokens[i + 1] === ":") {
      const name = JSON.parse(tokens[i]);
      if (members.has(name)) throw new Error("duplicate caller member");
      members.add(name);
    }
  }
  return value;
}

function validCallers(value, validate, receiver, selfAllowed) {
  if (!validate(value)) return false;
  if (!selfAllowed && Object.hasOwn(value, receiver)) return false;
  const hashes = Object.values(value).flat();
  return new Set(hashes).size === hashes.length;
}

function validToken(token) {
  if (!/^[A-Za-z0-9_-]{43,86}$/u.test(token)) return false;
  const bytes = Buffer.from(token, "base64url");
  return (
    bytes.length >= 32 &&
    bytes.length <= 64 &&
    bytes.toString("base64url") === token
  );
}

function headerOutcome(vector, fixtures) {
  const reject = () => ({
    code: "service_unauthenticated",
    http_status: 401,
    caller: null,
    www_authenticate: challenge,
  });
  const fields = vector.fields.filter(
    (field) => field.name.toLowerCase() === "antnest-service-authorization",
  );
  if (fields.length !== 1) return reject();
  const value = fields[0].value;
  if (value.slice(0, 7).toLowerCase() !== "bearer ") return reject();
  const token = value.slice(7);
  if (!validToken(token)) return reject();
  const presented = createHash("sha256").update(token, "ascii").digest();
  const matches = [];
  for (const [caller, hashes] of Object.entries(
    fixtures.receiver_configurations[vector.configuration],
  )) {
    for (const hash of hashes)
      if (timingSafeEqual(presented, Buffer.from(hash.slice(7), "hex")))
        matches.push(caller);
  }
  if (matches.length !== 1) return reject();
  const caller = matches[0];
  return {
    code: vector.allowed_callers.includes(caller) ? null : "caller_not_allowed",
    http_status: vector.allowed_callers.includes(caller) ? 200 : 403,
    caller,
    www_authenticate: null,
  };
}

test("receiver schema and semantic checks share explicit configuration vectors", () => {
  const validate = new Ajv2020({ strict: true }).compile(
    read("service-token-callers.schema.json"),
  );
  const fixtures = read("service-token-fixtures.json");
  assert.equal(fixtures.version, 1);
  for (const vector of fixtures.configuration_vectors) {
    let schemaValid = false;
    let valid = false;
    try {
      const value = parseCallers(vector.callers_json);
      schemaValid = validate(value);
      valid = validCallers(
        value,
        validate,
        vector.receiver,
        vector.self_allowed,
      );
    } catch {
      // Invalid JSON and duplicate decoded member names fail startup too.
    }
    assert.equal(schemaValid, vector.schema_valid, vector.name);
    assert.equal(valid, vector.valid, vector.name);
    assert.equal(
      vector.expected_error,
      valid ? null : "invalid_configuration",
      vector.name,
    );
  }
  for (const value of Object.values(fixtures.receiver_configurations))
    assert(validCallers(value, validate, "runtime-controller", false));
  const catalog = read("service-callers.schema.json");
  assert.deepEqual(
    validate.schema.propertyNames.enum,
    catalog.properties.service.enum,
    "token callers must use the catalog's exact service identities",
  );
});

test("token files contain exact canonical base64url bytes without newline repair", () => {
  const fixtures = read("service-token-fixtures.json");
  for (const vector of fixtures.token_vectors)
    assert.equal(validToken(vector.token), vector.valid, vector.name);
  for (const sample of Object.values(fixtures.public_tokens)) {
    assert(validToken(sample.token));
    assert.equal(
      `sha256:${createHash("sha256").update(sample.token, "ascii").digest("hex")}`,
      sample.hash,
    );
  }
});

test("each uncombined header vector has exactly one workload authentication outcome", () => {
  const fixtures = read("service-token-fixtures.json");
  const names = new Set();
  const validateError = new Ajv2020({ strict: true }).compile(
    read("service-authentication-error.schema.json"),
  );
  for (const vector of fixtures.header_vectors) {
    assert(!names.has(vector.name), `duplicate vector name: ${vector.name}`);
    names.add(vector.name);
    assert(
      Object.hasOwn(fixtures.receiver_configurations, vector.configuration),
    );
    assert.deepEqual(
      headerOutcome(vector, fixtures),
      vector.expected,
      vector.name,
    );
    if (vector.expected.code !== null)
      assert(
        validateError({
          code: vector.expected.code,
          http_status: vector.expected.http_status,
          retryable: false,
        }),
        vector.name,
      );
  }
  for (const name of [
    "missing-header",
    "empty-header",
    "duplicate-identical-lines",
    "duplicate-mixed-case-lines",
    "comma-joined-values",
    "wrong-scheme",
    "lowercase-scheme",
    "mixed-case-scheme",
    "extra-separator-space",
    "leading-value-space",
    "trailing-token-space",
    "invalid-token-character",
    "unconfigured-token",
    "caller-not-on-route",
    "next-token-accepted",
    "old-token-after-removal",
    "standard-authorization-does-not-authenticate-service",
  ])
    assert(
      names.has(name),
      `missing header rejection/rotation vector: ${name}`,
    );
});

test("mode selection is explicit and insecure transport requires exact true", () => {
  const fixtures = read("service-token-fixtures.json");
  for (const vector of fixtures.mode_vectors) {
    const valid =
      ["token", "mtls"].includes(vector.mode) &&
      [null, "false", "true"].includes(vector.allow_insecure_transport) &&
      (vector.mode === "mtls"
        ? vector.transport === "https" &&
          vector.allow_insecure_transport !== "true"
        : vector.transport === "https" ||
          (vector.transport === "http" &&
            vector.allow_insecure_transport === "true"));
    assert.equal(valid, vector.valid, vector.name);
  }
});

test("the integration branch uses service-local commits and final cross-service acceptance", () => {
  const rollout = read("service-authentication-rollout.json");
  assert.equal(rollout.delivery.branch, "feat/service-authentication");
  assert.equal(rollout.delivery.service_owners_per_commit, 1);
  assert.equal(rollout.delivery.pull_requests, "final-integration-only");
  assert.equal(rollout.delivery.service_gates, "before-each-service-commit");
  assert.equal(
    rollout.delivery.cross_service_e2e,
    "final-integration-before-main-merge",
  );
  assert.deepEqual(rollout.batches[0].issues, [32, 101]);
  assert.equal(rollout.token_provisioning.owner, "deployment");
  assert.equal(rollout.token_provisioning.status, "admitted");
  assert(rollout.token_provisioning.admission.unit_contract_component);
  assert(rollout.token_provisioning.admission.docker);
  assert.equal(rollout.token_provisioning.ignore_before_generation, true);
  assert(rollout.token_provisioning.service_test_credentials);
  assert(
    rollout.batches
      .find((batch) => batch.owner === "deployment")
      .deliverables.includes("development service-token provisioning helper"),
  );
});
