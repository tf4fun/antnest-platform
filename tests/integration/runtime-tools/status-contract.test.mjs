import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const contractRoot = new URL("../../../contracts/runtime/", import.meta.url);
const contract = JSON.parse(
  await readFile(new URL("contract.json", contractRoot), "utf8"),
);
const schema = JSON.parse(
  await readFile(new URL("runtime-status.schema.json", contractRoot), "utf8"),
);
const validate = new Ajv2020({ strict: true }).compile(schema);

test("Runtime status contract identifies the schema and a feature-free release", () => {
  assert.equal(contract.status_schema, "runtime-status.schema.json");
  assert.deepEqual(contract.status.test_features, []);
  assert(validate(contract.status), JSON.stringify(validate.errors));
});

test("status accepts compiled E2E features and preserves them while unavailable", () => {
  for (const status of ["ready", "unavailable"])
    assert(
      validate({
        ...contract.status,
        status,
        test_features: ["skill-maintenance-e2e-gate"],
      }),
      JSON.stringify(validate.errors),
    );
});

test("status requires an array of test feature names and rejects other shapes", () => {
  const { test_features: _omitted, ...missing } = contract.status;
  for (const value of [
    missing,
    { ...contract.status, test_features: null },
    { ...contract.status, test_features: "skill-maintenance-e2e-gate" },
    { ...contract.status, test_features: [true] },
    { ...contract.status, test_features: [""] },
    { ...contract.status, status: "booting" },
    { ...contract.status, allow_test_features: true },
  ])
    assert.equal(validate(value), false, JSON.stringify(value));
});
