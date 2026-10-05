import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const base = new URL("../../../contracts/runtime/", import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, base), "utf8"));

test("private Runtime connection contract fixes ownership, admission and delivery order", () => {
  const contract = read("instance-connection-contract.json");
  assert.equal(contract.version, 1);
  assert.equal(contract.credential_issuer, "runtime-controller");
  assert.equal(
    contract.credential_scope,
    "controller-scope/agent/compute-generation/caller",
  );
  assert.deepEqual(contract.runtime_callers, [
    "runtime-controller",
    "agent-acp-service",
  ]);
  assert.deepEqual(contract.resolve.callers, ["agent-controller"]);
  assert.equal(contract.resolve.method, "POST");
  assert.equal(
    contract.resolve.path,
    "/internal/runtimes/{agent_id}/connection",
  );
  assert.equal(contract.resolve.capture_payload, false);
  assert.deepEqual(contract.delivery_batches, [
    "runtime-controller",
    "antnest-runtime",
    "agent-controller",
    "agent-acp-service",
    "integration",
  ]);
  assert.equal(contract.status.full.authentication, "instance-workload");
  assert.equal(contract.status.live.path, "/status/live");
  assert.equal(contract.status.live.authentication, "none");
  assert.equal(contract.token_header, "Antnest-Service-Authorization");
  assert.equal(contract.invalid_token.code, "runtime_unauthorized");
  assert.equal(contract.invalid_token.status, 401);
  assert.equal(contract.executor_credentials, "none");
});

test("Runtime reference, private handoff and liveness shapes reject authority leaks", () => {
  const schema = read("instance-connection.schema.json");
  const fixtures = read("instance-connection-fixtures.json");
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(schema);
  for (const vector of fixtures.schema_vectors) {
    const validate = ajv.compile({
      $ref: schema.$id + "#/$defs/" + vector.target,
    });
    assert.equal(
      validate(vector.value),
      vector.valid,
      vector.name + " " + JSON.stringify(validate.errors),
    );
  }
  for (const target of [
    "public_reference",
    "private_connection",
    "resolve_request",
    "live_status",
  ])
    assert(
      fixtures.schema_vectors.some(
        (vector) => vector.target === target && vector.valid,
      ),
    );
  assert(
    fixtures.schema_vectors.some(
      (vector) => vector.name === "public-reference-rejects-token",
    ),
  );
  assert(
    fixtures.schema_vectors.some(
      (vector) => vector.name === "live-status-rejects-execution-id",
    ),
  );
});

test("Runtime handoff uses the canonical token profile and keeps per-instance identities distinct", () => {
  const fixtures = read("instance-connection-fixtures.json");
  const canonical = (token) => {
    const bytes = Buffer.from(token, "base64url");
    return (
      /^[A-Za-z0-9_-]{43,86}$/u.test(token) &&
      bytes.length >= 32 &&
      bytes.length <= 64 &&
      bytes.toString("base64url") === token
    );
  };
  for (const vector of fixtures.token_vectors)
    assert.equal(canonical(vector.token), vector.valid, vector.name);
  const acceptance = read("instance-connection-contract.json").acceptance;
  for (const scenario of [
    "wrong-agent",
    "wrong-generation",
    "wrong-caller",
    "credential-not-in-environment",
    "executor-cannot-read",
    "restart-retains-credential",
    "rebuild-rotates-credential",
    "private-publication-not-in-audit",
    "no-proxy-or-redirect",
    "host-header-rejection",
  ])
    assert(acceptance.includes(scenario), scenario);
});
