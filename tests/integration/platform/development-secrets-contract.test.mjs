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
  assert.equal(contract.revision, 2);
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

test("dependency owners cover every platform entrypoint that consumes admin or Temporal passwords", () => {
  assert.deepEqual(contract.dependency_owners, {
    postgres: ["ANTNEST_POSTGRES_ADMIN_PASSWORD"],
    "temporal-databases": [
      "ANTNEST_POSTGRES_ADMIN_PASSWORD",
      "ANTNEST_TEMPORAL_POSTGRES_PASSWORD",
    ],
    "temporal-schema": ["ANTNEST_TEMPORAL_POSTGRES_PASSWORD"],
    temporal: ["ANTNEST_TEMPORAL_POSTGRES_PASSWORD"],
    "skill-registry-database-init": ["ANTNEST_POSTGRES_ADMIN_PASSWORD"],
  });
  for (const variables of Object.values(contract.dependency_owners))
    for (const variable of variables)
      assert(contract.password_variables.includes(variable), variable);
});
