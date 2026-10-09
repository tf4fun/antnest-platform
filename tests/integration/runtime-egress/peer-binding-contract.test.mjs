import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { test } from "node:test";

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const read = (path) =>
  JSON.parse(
    readFileSync(new URL("../../../" + path, import.meta.url), "utf8"),
  );
const ajv = new Ajv2020({
  strict: true,
  formats: {
    ipv4: (value) => isIP(value) === 4,
    uri: true,
    "date-time": true,
  },
});

test("attachment open requires a peer IPv4; close removes its peer binding", () => {
  const validate = ajv.compile(
    read("contracts/egress/attachment-state-request.schema.json"),
  );
  const request = {
    state: "open",
    expected_resource_version: 1,
    tunnel_key_id: "rtk_" + "a".repeat(32),
  };
  assert(validate({ ...request, runtime_endpoint: "10.243.1.20" }));
  for (const value of [
    undefined,
    null,
    "",
    "runtime",
    "http://10.243.1.20:8093/mcp",
    "10.243.1.20:8092",
    "010.243.1.20",
    "::1",
    " 10.243.1.20 ",
  ])
    assert.equal(validate({ ...request, runtime_endpoint: value }), false);
  assert(validate({ state: "closed", expected_resource_version: 1 }));
  assert(
    validate({
      state: "closed",
      expected_resource_version: 1,
      runtime_endpoint: null,
    }),
  );
  assert.equal(
    validate({ ...request, state: "closed", runtime_endpoint: "10.243.1.20" }),
    false,
  );
});

test("RC reports the Docker management address separately from the MCP endpoint", () => {
  const schema = read(
    "services/runtime-controller/api/control-api.schema.json",
  );
  const validate = ajv.compile({
    ...schema,
    $ref: "#/$defs/runtime_inspection",
  });
  const inspection = {
    agent_id: "agent-1",
    runtime_revision: "rtv_00000000000000000000000000000001",
    lifecycle_state: "provisioned",
    phase: "running",
    health: "starting",
    restart_count: 0,
    observed_at: "2026-10-06T10:00:00Z",
    runtime_endpoint: "10.243.1.20",
  };
  assert(validate(inspection), JSON.stringify(validate.errors));
  for (const value of [
    "runtime",
    "http://runtime:8093/mcp",
    "::1",
    " 10.243.1.20 ",
  ])
    assert.equal(validate({ ...inspection, runtime_endpoint: value }), false);
});
