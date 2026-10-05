import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contract = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/platform/development-secrets.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("secret admission has an exact independent opt-in and complete deployment variables", () => {
  assert.equal(contract.revision, 1);
  assert.equal(contract.opt_in_variable, "ANTNEST_ALLOW_PUBLIC_DEV_SECRETS");
  assert.deepEqual(contract.disabled_values, ["", "false"]);
  assert.equal(contract.enabled_value, "true");
  assert.equal(contract.password_variables.length, 9);
  assert.equal(contract.encryption_key_variables.length, 3);
  for (const values of [
    contract.password_variables,
    contract.encryption_key_variables,
    contract.published_values,
  ])
    assert.equal(new Set(values).size, values.length);
  assert(contract.published_values.includes("antnest-admin-dev"));
  assert(
    contract.published_values.includes(
      "antnest-skill-registry-local-development-token",
    ),
  );
  for (const value of contract.invalid_values)
    assert(
      ![...contract.disabled_values, contract.enabled_value].includes(value),
    );
});
