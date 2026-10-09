import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const policy = JSON.parse(
  readFileSync(
    join(root, "contracts/platform/development-secrets.json"),
    "utf8",
  ),
);
const fields = [
  ...policy.password_variables,
  ...policy.encryption_key_variables,
];
const rotatingKeys = new Set([
  "ANTNEST_IDENTITY_ENCRYPTION_KEY",
  "ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY",
]);
const composeEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:ANTNEST_|COMPOSE_|OTEL_)/u.test(name),
    ),
  ),
  COMPOSE_DISABLE_ENV_FILE: "1",
  ANTNEST_SERVICE_AUTH_DIRECTORY: "/never-mounted-secret-contract",
  ANTNEST_SERVICE_AUTH_UID: "65532",
  ANTNEST_SERVICE_AUTH_GID: "65532",
  ANTNEST_DOCKER_SOCKET_GID: "998",
  ANTNEST_IDENTITY_CCT_SIGNING_KID: "secret-contract-unused",
};
function render(env) {
  return spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-name",
      "secret-contract",
      "-f",
      join(root, "compose.yaml"),
      "--profile",
      "stage3",
      "config",
      "--quiet",
    ],
    { env, encoding: "utf8", timeout: 30000 },
  );
}

test("Compose rejects missing fixed secrets and forwards optional encryption modes for startup validation", () => {
  const empty = render(composeEnvironment);
  assert.notEqual(empty.status, 0);
  // Compose traverses YAML maps without promising which missing field is first.
  assert(
    fields.some((name) => empty.stderr.includes(name)),
    empty.stderr,
  );
  const valid = {
    ...composeEnvironment,
    ...Object.fromEntries(
      policy.password_variables.map((name) => [name, "a".repeat(48)]),
    ),
    ...Object.fromEntries(
      policy.encryption_key_variables.map((name) => [
        name,
        Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
      ]),
    ),
  };
  assert.equal(render(valid).status, 0);
  for (const name of fields)
    for (const emptyValue of [undefined, ""]) {
      const env = { ...valid, [name]: emptyValue };
      if (emptyValue === undefined) delete env[name];
      const result = render(env);
      if (rotatingKeys.has(name)) {
        assert.equal(
          result.status,
          0,
          `${name} is validated by its owner before startup`,
        );
        continue;
      }
      assert.notEqual(result.status, 0, name);
      assert(result.stderr.includes(name), name);
      assert.equal(result.stdout, "");
    }
});
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-dev-secrets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, ".env");
  const run = (...args) =>
    spawnSync(
      "sh",
      [join(root, "scripts/generate-dev-env.sh"), "--output", output, ...args],
      {
        env: { ...process.env, ANTNEST_DOCKER_SOCKET_GID: "", ...overrides },
        encoding: "utf8",
        timeout: 10000,
      },
    );
  return { directory, output, run };
}

test("public example leaves every deployment secret empty and has no opt-in", () => {
  const example = parseEnv(readFileSync(join(root, ".env.example"), "utf8"));
  for (const name of fields) assert.equal(example[name], "", name);
  assert.equal(example[policy.opt_in_variable], undefined);
  for (const file of ["compose.yaml", "compose.stage3.yaml"]) {
    const source = readFileSync(join(root, file), "utf8");
    assert(
      !source.includes(policy.opt_in_variable),
      "standard Compose must not enable the exception",
    );
    for (const name of fields) {
      if (file === "compose.yaml" && rotatingKeys.has(name)) {
        const ring = `${name}S`;
        assert(
          source.includes(`\${${name}:-}`),
          `${name} has no public fallback`,
        );
        assert(
          source.includes(`\${${ring}:-}`),
          `${ring} has no public fallback`,
        );
        continue;
      }
      assert(!source.includes(`\${${name}:-`), name);
      if (file === "compose.yaml")
        assert(source.includes(`\${${name}:?`), `${name} must fail closed`);
    }
  }
});

test("generator fills only secret placeholders independently, privately and without overwriting", (t) => {
  const f = fixture(t),
    first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const content = readFileSync(f.output, "utf8"),
    env = parseEnv(content);
  assert.equal(statSync(f.output).mode & 0o777, 0o600);
  assert.equal(new Set(fields.map((name) => env[name])).size, fields.length);
  for (const name of fields) {
    assert(env[name], name);
    assert(!policy.published_values.includes(env[name]), name);
  }
  for (const name of policy.password_variables)
    assert.match(env[name], /^[a-f0-9]{48}$/u);
  for (const name of policy.encryption_key_variables) {
    const bytes = Buffer.from(env[name], "base64");
    assert.equal(bytes.length, 32);
    assert.equal(bytes.toString("base64"), env[name]);
    assert(new Set(bytes).size > 1);
  }
  assert.equal(
    first.stdout.trim(),
    `Bootstrap administrator password: ${env.ANTNEST_BOOTSTRAP_ADMIN_PASSWORD}`,
  );
  for (const name of fields.filter(
    (name) => name !== "ANTNEST_BOOTSTRAP_ADMIN_PASSWORD",
  ))
    assert(!first.stdout.includes(env[name]));
  const source = parseEnv(readFileSync(join(root, ".env.example"), "utf8"));
  for (const [name, value] of Object.entries(source))
    if (!fields.includes(name)) assert.equal(env[name], value, name);
  const existing = f.run();
  assert.notEqual(existing.status, 0);
  assert.equal(existing.stdout, "");
  assert.equal(readFileSync(f.output, "utf8"), content);
  const forced = f.run("--force");
  assert.equal(forced.status, 0, forced.stderr);
  assert.notEqual(readFileSync(f.output, "utf8"), content);
  assert.equal(statSync(f.output).mode & 0o777, 0o600);
});

test("generator refuses symlinks even when forced and preserves their targets", (t) => {
  const f = fixture(t),
    target = join(f.directory, "retained.env");
  writeFileSync(target, "retained secret\n", { mode: 0o600 });
  symlinkSync(target, f.output);
  const result = f.run("--force");
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(target, "utf8"), "retained secret\n");
});

test("the secret generator preserves an explicit socket group without Docker", (t) => {
  const f = fixture(t, { ANTNEST_DOCKER_SOCKET_GID: "998" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    parseEnv(readFileSync(f.output, "utf8")).ANTNEST_DOCKER_SOCKET_GID,
    "998",
  );
});

test("the secret generator rejects malformed socket groups before writing", (t) => {
  for (const gid of ["-1", "01", "1\nINJECTED=value", "4294967295"]) {
    const f = fixture(t, { ANTNEST_DOCKER_SOCKET_GID: gid });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ANTNEST_DOCKER_SOCKET_GID/u);
    assert.equal(result.stdout, "");
  }
});
