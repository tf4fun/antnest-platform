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

test("Runtime publication distinguishes executable authority from closed fence-only bindings", () => {
  const schema = read("agent-acp/execution-snapshot.schema.json");
  const fixtures = read("agent-acp/runtime-publication-fixtures.json");
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addFormat("uri", {
    type: "string",
    validate: (value) => URL.canParse(value),
  });
  const validate = ajv.compile(schema.properties.agents.items);
  for (const vector of fixtures.vectors) {
    const agent = {
      agent_id: "agent-1",
      principal_ids: ["owner-1"],
      access_revision: "access-1",
      unavailable_reason: vector.accepting_runs ? null : "agent_unavailable",
      operation_id: vector.accepting_runs ? null : "operation-1",
      default_model_profile_id: "model-1",
      default_authorization: { mode: "auto", tool_rules: [] },
      authorization_revision: 1,
      agent_spec_revision: "spec-1",
      execution_revision: "execution-revision-1",
      system_prompt: "",
      context_policy_version: "context-v1",
      skill_instructions: [],
      max_model_requests: 16,
      accepting_runs: vector.accepting_runs,
      runtime: vector.runtime,
    };
    assert.equal(
      validate(agent),
      vector.valid,
      vector.name + " " + JSON.stringify(validate.errors),
    );
  }
  for (const name of [
    "executable-private-connection",
    "closed-fence-without-credentials",
    "closed-fence-with-known-connection",
    "closed-unbuilt",
    "executable-requires-credential",
    "executable-requires-connection-id",
    "closed-must-not-transfer-credentials",
    "wrong-caller",
    "padded-token",
    "unknown-private-field",
  ]) {
    assert(
      fixtures.vectors.some((vector) => vector.name === name),
      name,
    );
  }
});

test("private publication uses the frozen instance credential rules without public authority", () => {
  const snapshot = read("agent-acp/execution-snapshot.schema.json");
  const runtime = snapshot.properties.agents.items.properties.runtime.anyOf[0];
  const instance = read("runtime/instance-connection.schema.json");
  assert.deepEqual(
    runtime.properties.connection_id,
    instance.$defs.connection_id,
  );
  assert.equal(runtime.properties.credential.additionalProperties, false);
  assert.deepEqual(runtime.properties.credential.required, ["caller", "token"]);
  assert.deepEqual(runtime.properties.credential.properties.caller, {
    type: "string",
    const: "agent-acp-service",
  });
  assert.deepEqual(
    runtime.properties.credential.properties.token,
    instance.$defs.token,
  );
  const contract = read("runtime/instance-connection-contract.json");
  assert.equal(contract.controller_relay.capture_payload, false);
  assert.equal(
    contract.controller_relay.closed_binding,
    "fence-only-no-resolve-no-credential",
  );
  assert.equal(
    contract.controller_relay.executable_binding,
    "verified-private-connection-required",
  );
  assert.equal(contract.controller_relay.persist_token, false);
});
