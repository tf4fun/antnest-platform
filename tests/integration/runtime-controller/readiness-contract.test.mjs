import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import commonIDs from "../../../contracts/common/ids.schema.json" with { type: "json" };

const requireAcp = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = requireAcp("ajv/dist/2020.js");
const api = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/runtime-controller/control-api.ids-v2.schema.json",
      import.meta.url,
    ),
  ),
);
const contract = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/runtime-controller/control-contract.json",
      import.meta.url,
    ),
  ),
);
const __idsAjv = new Ajv2020({ strict: true });
__idsAjv.addSchema(commonIDs);
const validate = __idsAjv.compile(api.$defs.readiness);

const ready = {
  status: "ready",
  live: true,
  ready: true,
  database_ready: true,
  platform_ready: true,
  observation_ready: true,
  monitor_ready: true,
  disk_quota_enforced: false,
  runtime_capacity: 0,
  runtime_count: 0,
  runtime_capacity_known: false,
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

test("disk_quota_enforced is a required capability boolean, never a readiness blocker", () => {
  const unavailable = {
    ...ready,
    status: "not_ready",
    ready: false,
    monitor_ready: false,
  };
  for (const response of [ready, unavailable]) {
    for (const value of [false, true]) {
      assert(
        validate({ ...response, disk_quota_enforced: value }),
        `disk_quota_enforced=${value} must validate: ${JSON.stringify(validate.errors)}`,
      );
    }
    for (const value of [undefined, null, "false", 0]) {
      assert.equal(
        validate({ ...response, disk_quota_enforced: value }),
        false,
        `disk_quota_enforced=${JSON.stringify(value)} must not validate`,
      );
    }
  }
  assert(validate(ready), "an unbounded local backend must not fail readiness");
});

test("capacity snapshot fields are required nonnegative integers and a boolean", () => {
  const unavailable = {
    ...ready,
    status: "not_ready",
    ready: false,
    monitor_ready: false,
  };
  for (const snapshot of [
    { runtime_capacity: 0, runtime_count: 0, runtime_capacity_known: false },
    { runtime_capacity: 251, runtime_count: 2, runtime_capacity_known: true },
    { runtime_capacity: 0, runtime_count: 0, runtime_capacity_known: true },
  ]) {
    for (const response of [ready, unavailable]) {
      assert(
        validate({ ...response, ...snapshot }),
        `capacity snapshot must validate: ${JSON.stringify(validate.errors)}`,
      );
    }
  }
  const required = api.$defs.readiness.required;
  for (const field of [
    "runtime_capacity",
    "runtime_count",
    "runtime_capacity_known",
  ]) {
    assert(required.includes(field), `${field} must be required`);
  }
  for (const field of ["runtime_capacity", "runtime_count"]) {
    assert.equal(api.$defs.readiness.properties[field].type, "integer");
    assert.equal(api.$defs.readiness.properties[field].minimum, 0);
  }
  assert.equal(
    api.$defs.readiness.properties.runtime_capacity_known.type,
    "boolean",
  );
  for (const field of ["runtime_capacity", "runtime_count"]) {
    for (const response of [ready, unavailable]) {
      const without = {
        ...response,
        runtime_capacity: 5,
        runtime_count: 1,
        runtime_capacity_known: true,
      };
      delete without[field];
      assert.equal(validate(without), false);
      assert(
        validate.errors.some(
          (error) =>
            error.keyword === "required" &&
            error.params.missingProperty === field,
        ),
        `deleting ${field} must surface its required error`,
      );
      for (const value of [undefined, null, "0", true, -1, 0.5]) {
        assert.equal(
          validate({
            ...response,
            runtime_capacity: 5,
            runtime_count: 1,
            runtime_capacity_known: true,
            [field]: value,
          }),
          false,
          `${field}=${JSON.stringify(value)} must be invalid`,
        );
      }
      for (const value of [0, 251]) {
        assert(
          validate({
            ...response,
            runtime_count: 1,
            runtime_capacity_known: true,
            [field]: value,
          }),
          `${field}=${value} must validate`,
        );
      }
    }
  }
  for (const response of [ready, unavailable]) {
    for (const value of [true, false]) {
      assert(
        validate({
          ...response,
          runtime_capacity: 5,
          runtime_count: 1,
          runtime_capacity_known: value,
        }),
        `runtime_capacity_known=${value} must validate`,
      );
    }
    const without = { ...response, runtime_capacity: 5, runtime_count: 1 };
    delete without.runtime_capacity_known;
    assert.equal(validate(without), false);
    assert(
      validate.errors.some(
        (error) =>
          error.keyword === "required" &&
          error.params.missingProperty === "runtime_capacity_known",
      ),
    );
    for (const value of [null, "false", 0, 1]) {
      assert.equal(
        validate({
          ...response,
          runtime_capacity: 5,
          runtime_count: 1,
          runtime_capacity_known: value,
        }),
        false,
        `runtime_capacity_known=${JSON.stringify(value)} must be invalid`,
      );
    }
  }
});
