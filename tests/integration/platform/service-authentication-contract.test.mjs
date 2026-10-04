import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const root = new URL("../../../contracts/platform/", import.meta.url);

function read(name) {
  const file = new URL(name, root);
  assert(existsSync(file), `missing shared authentication contract: ${name}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function validator(name) {
  return new Ajv2020({ strict: true }).compile(read(name));
}

test("CCT claims and protected headers share language-neutral rejection vectors", () => {
  const claims = validator("caller-context-claims.schema.json");
  const header = validator("caller-context-header.schema.json");
  const fixtures = read("caller-context-fixtures.json");
  for (const vector of fixtures.schema_vectors) {
    const validate = vector.target === "claims" ? claims : header;
    assert.equal(validate(vector.value), vector.valid, vector.name);
  }
  assert(fixtures.schema_vectors.some((item) => item.name === "unknown-role"));
  assert(fixtures.schema_vectors.some((item) => item.name === "blank-kid"));
  assert(
    fixtures.schema_vectors.some((item) => item.name === "duplicate-audience"),
  );
});

test("CCT public keys exclude private material and use an explicit Ed25519 curve", () => {
  const validate = validator("caller-context-jwks.schema.json");
  const fixtures = read("caller-context-fixtures.json");
  assert(validate(fixtures.jwks), JSON.stringify(validate.errors));
  const key = fixtures.jwks.keys[0];
  for (const value of [
    { keys: [{ ...key, d: key.x }] },
    { keys: [{ ...key, crv: "X25519" }] },
    { keys: [{ ...key, alg: "HS256" }] },
    { keys: [{ ...key, use: "enc" }] },
    { keys: [] },
  ])
    assert.equal(validate(value), false, JSON.stringify(value));
});

// Independent fixture oracle only; services must implement their own verified
// principal boundary and run these vectors in their owning delivery batches.
function parseObject(raw) {
  const value = JSON.parse(raw);
  const tokens =
    raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/gu) ?? [];
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const names = stack.at(-1);
      const name = JSON.parse(token);
      if (names?.has(name)) throw new Error("duplicate JSON member");
      names?.add(name);
    }
  }
  return value;
}

function acceptsVector(vector, fixtures, claimsSchema, headerSchema) {
  try {
    if (
      vector.token.length > 8192 ||
      vector.tolerance < 0 ||
      vector.tolerance > 30
    )
      return false;
    const parts = vector.token.split(".");
    if (parts.length !== 3) return false;
    const decoded = parts.map((part) => {
      if (!/^[A-Za-z0-9_-]+$/u.test(part))
        throw new Error("invalid JWS segment");
      const bytes = Buffer.from(part, "base64url");
      if (bytes.toString("base64url") !== part)
        throw new Error("noncanonical base64url");
      return bytes;
    });
    if (decoded[2].length !== 64) return false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const header = parseObject(decoder.decode(decoded[0]));
    const claims = parseObject(decoder.decode(decoded[1]));
    if (!headerSchema(header) || !claimsSchema(claims)) return false;
    const keys = fixtures.jwks.keys.filter((key) => key.kid === header.kid);
    if (keys.length !== 1) return false;
    const key = createPublicKey({ key: keys[0], format: "jwk" });
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, decoded[2]))
      return false;
    return (
      claims.exp > claims.iat &&
      claims.exp - claims.iat <= 60 &&
      claims.iat <= vector.now + vector.tolerance &&
      vector.now < claims.exp + vector.tolerance &&
      claims.aud.includes(vector.consumer) &&
      claims.org === vector.organization &&
      claims.agt === vector.agent &&
      !("act" in claims)
    );
  } catch {
    return false;
  }
}

test("signed vectors independently prove signature, scope, audience and temporal outcomes", () => {
  const fixtures = read("caller-context-fixtures.json");
  const claims = validator("caller-context-claims.schema.json");
  const header = validator("caller-context-header.schema.json");
  for (const vector of fixtures.verification_vectors)
    assert.equal(
      acceptsVector(vector, fixtures, claims, header),
      vector.valid,
      vector.name,
    );
  assert.equal(
    acceptsVector(
      fixtures.verification_vectors[0],
      {
        ...fixtures,
        jwks: { keys: [fixtures.jwks.keys[0], fixtures.jwks.keys[0]] },
      },
      claims,
      header,
    ),
    false,
    "ambiguous kid must be rejected",
  );
});

test("authentication failures have stable codes, HTTP statuses and no retry", () => {
  const validate = validator("service-authentication-error.schema.json");
  for (const [code, http_status] of [
    ["service_unauthenticated", 401],
    ["caller_not_allowed", 403],
    ["caller_context_required", 401],
    ["caller_context_invalid", 401],
  ]) {
    const value = { code, http_status, retryable: false };
    assert(validate(value), JSON.stringify(validate.errors));
    assert.equal(validate({ ...value, retryable: true }), false);
    assert.equal(validate({ ...value, http_status: 500 }), false);
  }
  assert.equal(
    validate({ code: "ECONNREFUSED", http_status: 401, retryable: false }),
    false,
  );
});

test("the rollout records admitted producers while keeping consumer and integration work pending", () => {
  const rollout = read("service-authentication-rollout.json");
  assert.equal(rollout.status, "service-batches");
  assert.deepEqual(rollout.batches[0].issues, [32, 101]);
  assert.equal(rollout.batches[0].owner, "platform-contracts");
  const identity = rollout.batches.find(
    (batch) => batch.owner === "identity-service",
  );
  assert.equal(identity.status, "service-admitted");
  assert(identity.admission.unit_contract_component);
  assert(identity.admission.postgres);
  assert(identity.admission.docker);
  assert.deepEqual(identity.admission.pending_consumers, []);
  const gateway = rollout.batches.find(
    (batch) => batch.owner === "edge-gateway",
  );
  assert.equal(gateway.status, "service-admitted");
  assert(gateway.admission.unit_contract_component);
  assert(gateway.admission.docker);
  assert.deepEqual(gateway.admission.pending_consumers, []);
  const consoleBatch = rollout.batches.find(
    (batch) => batch.owner === "admin-console",
  );
  assert.equal(consoleBatch.status, "service-admitted");
  assert(consoleBatch.admission.unit_contract_component);
  assert(consoleBatch.admission.docker);
  assert.deepEqual(consoleBatch.admission.pending_consumers, [
    "skill-registry",
  ]);
  const acp = rollout.batches.find(
    (batch) => batch.owner === "agent-acp-service",
  );
  assert.equal(acp.status, "service-admitted");
  assert(acp.admission.unit_contract_component);
  assert(acp.admission.postgres);
  assert(acp.admission.docker);
  assert.deepEqual(acp.admission.pending_consumers, ["skill-registry"]);
  assert(acp.admission.pending_runtime_client.includes("#29/#30"));
  assert(acp.admission.pending_provider_policy.includes("#28"));
  const ui = rollout.batches.find((batch) => batch.owner === "agent-ui");
  assert.equal(ui.status, "service-admitted");
  assert(ui.admission.unit_contract_component);
  assert(ui.admission.docker);
  assert.deepEqual(ui.admission.pending_consumers, []);
  const controller = rollout.batches.find(
    (batch) => batch.owner === "agent-controller",
  );
  assert.equal(controller.status, "service-admitted");
  assert(controller.admission.unit_contract_component);
  assert(controller.admission.postgres);
  assert(controller.admission.docker);
  assert(controller.admission.pending_provider_discovery.includes("#28"));
  assert.deepEqual(controller.admission.pending_dependencies, [
    "runtime-egress",
    "skill-registry",
  ]);
  const rc = rollout.batches.find(
    (batch) => batch.owner === "runtime-controller",
  );
  assert.equal(rc.status, "service-admitted");
  assert(rc.admission.unit_contract_component);
  assert(rc.admission.postgres);
  assert(rc.admission.docker);
  assert(rc.admission.pending_runtime_client.includes("#30"));
  assert.deepEqual(rc.admission.pending_dependencies, ["skill-registry"]);
  const runtime = rollout.batches.find(
    (batch) => batch.owner === "antnest-runtime",
  );
  assert.equal(runtime.status, "service-admitted");
  assert(runtime.admission.unit_contract_component);
  assert(runtime.admission.docker);
  assert.deepEqual(runtime.admission.pending_consumers, [
    "agent-controller",
    "agent-acp-service",
  ]);
  for (const owner of [
    "skill-registry",
    "runtime-egress",
    "deployment",
    "integration",
  ]) {
    assert.equal(
      rollout.batches.find((batch) => batch.owner === owner).status,
      "pending",
      owner,
    );
  }
  assert.equal(
    rollout.runtime_instance_connection.status,
    "rc-runtime-admitted-consumers-pending",
  );
  assert.deepEqual(
    rollout.runtime_instance_connection.pending_service_batches,
    ["agent-controller", "agent-acp-service"],
  );
  const pending = new Set(rollout.batches.flatMap((batch) => batch.issues));
  for (let issue = 25; issue <= 31; issue++) assert(pending.has(issue));
  assert(rollout.batches.some((batch) => batch.owner === "integration"));
});

test("the complete Workspace wire contract is represented by the caller catalog", () => {
  const wire = JSON.parse(
    readFileSync(new URL("../agent-ui/workspace-api.json", root), "utf8"),
  );
  const callers = JSON.parse(
    readFileSync(new URL("../agent-ui/callers.json", root), "utf8"),
  );
  for (const endpoint of Object.values(wire.routes))
    assert(
      callers.routes[`${endpoint.method} ${wire.base_path}${endpoint.path}`],
      endpoint.path,
    );
});
