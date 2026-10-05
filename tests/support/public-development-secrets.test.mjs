import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseEnv } from "node:util";
import { publicDevelopmentSecrets } from "./public-development-secrets.mjs";

test("fixed disposable secrets explicitly opt in and stay within the shared rejection contract", () => {
  const policy = JSON.parse(
    readFileSync(
      new URL(
        "../../contracts/platform/development-secrets.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const values = publicDevelopmentSecrets();
  assert.deepEqual(
    parseEnv(
      readFileSync(
        new URL("./public-development-secrets.sh", import.meta.url),
        "utf8",
      ),
    ),
    values,
  );
  assert.equal(values[policy.opt_in_variable], "true");
  for (const name of policy.password_variables)
    assert(policy.published_values.includes(values[name]), name);
  for (const name of policy.encryption_key_variables) {
    const key = Buffer.from(values[name], "base64");
    assert.equal(key.length, 32);
    assert.equal(new Set(key).size, 1);
  }
  assert.deepEqual(
    Object.keys(values).sort(),
    [
      policy.opt_in_variable,
      ...policy.password_variables,
      ...policy.encryption_key_variables,
    ].sort(),
  );
});
