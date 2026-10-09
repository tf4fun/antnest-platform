import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../scripts/development-secret-admission.sh", import.meta.url),
);
const policy = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/platform/development-secrets.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const admin = "ANTNEST_POSTGRES_ADMIN_PASSWORD";
const temporal = "ANTNEST_TEMPORAL_POSTGRES_PASSWORD";
function run(values = {}, variables = [admin], shell = "sh") {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("ANTNEST_"),
    ),
  );
  const result = spawnSync(shell, [script, ...variables], {
    env: { ...env, ...values },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  for (const value of policy.published_values)
    assert(!(result.stdout + result.stderr).includes(value), "secret leaked");
  return result;
}

test("shell published-value list cannot drift from the shared contract", () => {
  const source = readFileSync(script, "utf8");
  const list = source.match(/case "\$value" in\s+([\s\S]+?)\)/u);
  assert(list, "published-value case is missing");
  const values = list[1].replace(/[\s\\"]/gu, "").split("|");
  assert.equal(new Set(values).size, values.length);
  assert.deepEqual(values.sort(), [...policy.published_values].sort());
});

test("every published value is rejected for either dependency variable without opt-in", () => {
  for (const variable of [admin, temporal])
    for (const value of policy.published_values) {
      const result = run({ [variable]: value }, [variable]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, new RegExp(variable, "u"));
      assert.match(result.stderr, /published development value/u);
    }
});

test("random and shell-special values pass silently without opt-in", () => {
  for (const value of [
    randomBytes(32).toString("hex"),
    "$(exit 91) ' ; * \\ \n",
  ]) {
    const result = run({ [admin]: value });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
  }
});

test("exact opt-in allows published values with one WARN per variable, including repeated checks", () => {
  for (const value of policy.published_values) {
    const result = run(
      { [admin]: value, [temporal]: value, [policy.opt_in_variable]: "true" },
      [admin, temporal, admin, temporal],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    const lines = result.stderr.trim().split("\n");
    assert.equal(lines.length, 2);
    for (const [index, variable] of [admin, temporal].entries()) {
      assert.match(lines[index], /^WARN /u);
      assert(lines[index].includes(variable));
    }
  }
});

test("enabled gate produces no WARN for private, unset or empty values", () => {
  for (const value of [undefined, "", randomBytes(32).toString("hex")]) {
    const result = run({ [admin]: value, [policy.opt_in_variable]: "true" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
  }
});

test("invalid opt-ins fail even without a published or configured password", () => {
  for (const optIn of [...policy.invalid_values, "FALSE", "\ntrue", "true\n"])
    for (const value of [undefined, "private", policy.published_values[0]]) {
      const result = run({ [admin]: value, [policy.opt_in_variable]: optIn });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert(result.stderr.includes(policy.opt_in_variable));
      assert.match(result.stderr, /must be exactly true or false/u);
      assert.equal(
        result.stderr,
        `${policy.opt_in_variable} must be exactly true or false\n`,
      );
    }
});

test("unset, empty and false opt-ins disable the exception", () => {
  for (const optIn of [undefined, ...policy.disabled_values]) {
    const rejected = run({
      [admin]: policy.published_values[0],
      [policy.opt_in_variable]: optIn,
    });
    assert.notEqual(rejected.status, 0);
    assert(rejected.stderr.includes(admin));
    const accepted = run({
      [admin]: "private",
      [policy.opt_in_variable]: optIn,
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.stdout + accepted.stderr, "");
  }
});

test("unset and empty variables match CheckValue; required configuration is the caller's responsibility", () => {
  for (const value of [undefined, ""]) {
    const result = run({ [admin]: value });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
  }
});

test("variable names are validated before indirect expansion", () => {
  for (const variable of ["", "1SECRET", "SECRET; exit 0", "SECRET$(exit 0)"]) {
    const result = run({}, [variable]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid variable name/u);
  }
});

test("admission also runs under Debian's POSIX dash shell", () => {
  for (const optIn of [
    undefined,
    ...policy.disabled_values,
    policy.enabled_value,
    ...policy.invalid_values,
  ]) {
    const result = run(
      { [admin]: policy.published_values[0], [policy.opt_in_variable]: optIn },
      [admin],
      "dash",
    );
    assert.equal(result.status === 0, optIn === policy.enabled_value);
    assert.equal(result.stdout, "");
    if (optIn === policy.enabled_value) assert.match(result.stderr, /^WARN /u);
    else
      assert(
        result.stderr.includes(
          policy.invalid_values.includes(optIn)
            ? policy.opt_in_variable
            : admin,
        ),
      );
  }
  const result = run(
    { [admin]: randomBytes(32).toString("hex") },
    [admin],
    "dash",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, "");
});
