import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const api = JSON.parse(
  readFileSync(
    new URL(
      "../../../services/runtime-controller/api/control-api.schema.json",
      import.meta.url,
    ),
  ),
);
const contract = JSON.parse(
  readFileSync(
    new URL(
      "../../../services/runtime-controller/api/control-contract.json",
      import.meta.url,
    ),
  ),
);
const validate = new Ajv2020({ strict: true }).compile(api.$defs.readiness);
const ready = {
  status: "ready",
  live: true,
  ready: true,
  database_ready: true,
  platform_ready: true,
  observation_ready: true,
  monitor_ready: true,
};

test("the current RC contract retains revision 14's required monitor boolean", () => {
  assert(contract.revision >= 14);
  assert(validate(ready), JSON.stringify(validate.errors));
  const unavailable = {
    ...ready,
    status: "not_ready",
    ready: false,
    monitor_ready: false,
  };
  assert(validate(unavailable), JSON.stringify(validate.errors));
  for (const response of [ready, unavailable]) {
    for (const value of [undefined, null, "false", 0]) {
      assert.equal(validate({ ...response, monitor_ready: value }), false);
    }
    assert.equal(
      validate({ ...response, monitor_failure: "raw Docker response" }),
      false,
    );
  }
});
