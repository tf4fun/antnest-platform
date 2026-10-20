import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const read = (name) =>
  JSON.parse(
    readFileSync(
      new URL("../../../contracts/agent-controller/" + name, import.meta.url),
    ),
  );

test("Controller exposes pending attachment without claiming traffic or readiness", () => {
  assert(read("control-contract.json").revision >= 40);
  const schema = read("control-api.schema.json");
  const validate = new Ajv2020({
    formats: { "date-time": true, uri: true },
  }).compile({
    ...schema,
    $ref: "#/$defs/agent_network_policy",
  });
  const value = {
    agent_id: "agent-1",
    policy: {
      policy_id: "builtin/allow-all",
      revision: 1,
      resource_version: 1,
      spec: { schema_version: 1, action: "allow_all" },
      digest: "sha256:" + "a".repeat(64),
    },
    attachment: { state: "pending", resource_version: 2 },
  };
  assert(validate(value), JSON.stringify(validate.errors));
  for (const attachment of [
    { state: "waiting", resource_version: 2 },
    { state: "pending", resource_version: 0 },
    { ...value.attachment, runtime_endpoint: "10.20.0.9" },
    { ...value.attachment, tunnel_key_id: "rtk_" + "a".repeat(32) },
  ])
    assert.equal(validate({ ...value, attachment }), false);
});
