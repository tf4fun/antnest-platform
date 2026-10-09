import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixtureEnvironment,
  shellEnvironment,
  shellExports,
} from "./authenticated-e2e.mjs";

test("an E2E deployment cannot inherit retained credentials, providers or topology", () => {
  const env = fixtureEnvironment(
    {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      ANTNEST_SERVICE_AUTH_DIRECTORY: "/retained/credentials",
      ANTNEST_ACP_ALLOW_PRIVATE_PROVIDER_ENDPOINTS: "true",
      ANTNEST_SKILL_REGISTRY_API_TOKEN: "retained-token",
      ANTNEST_IDENTITY_ENCRYPTION_KEY: "retained-key",
      COMPOSE_PROJECT_NAME: "retained",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://retained.example",
    },
    { project: "antnest-lifecycle-1234abcd", octet: 45 },
  );
  assert.equal(env.PATH, "/fixture/bin");
  assert.equal(env.HOME, "/fixture/home");
  assert.equal(env.COMPOSE_PROJECT_NAME, "antnest-lifecycle-1234abcd");
  for (const key of [
    "ANTNEST_SERVICE_AUTH_DIRECTORY",
    "ANTNEST_SKILL_REGISTRY_API_TOKEN",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
  ])
    assert.equal(env[key], undefined, key);
  assert.equal(env.ANTNEST_ALLOW_PUBLIC_DEV_SECRETS, "true");
  assert.equal(
    env.ANTNEST_IDENTITY_ENCRYPTION_KEY,
    Buffer.alloc(32).toString("base64"),
  );
  assert.equal(env.ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS, "false");
  assert.equal(env.ANTNEST_SERVICE_NETWORK_PREFIX, "10.244.45");
  assert.equal(env.ANTNEST_RUNTIME_CONTROLLER_MANAGEMENT_IPV4, "10.243.45.5");
  assert.equal(env.ANTNEST_ACP_MANAGEMENT_IPV4, "10.243.45.6");
  assert.equal(env.ANTNEST_AGENT_CONTROLLER_CONTROL_IPV4, "10.242.45.4");
  assert.equal(env.ANTNEST_RUNTIME_MANAGEMENT_IP_RANGE, "10.243.45.128/25");
  assert.equal(
    env.ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT,
    "http://10.243.45.4:4318",
  );
  assert.equal(env.ANTNEST_JAEGER_RUNTIME_IPV4, undefined);
});

test("Stage 3 shell projects use the same fixture topology", () => {
  const env = fixtureEnvironment(
    { PATH: "/fixture/bin" },
    { project: "antnest-stage3-e2e-4242", octet: 7 },
  );
  assert.equal(env.COMPOSE_PROJECT_NAME, "antnest-stage3-e2e-4242");
  assert.equal(env.ANTNEST_RUNTIME_CONTROLLER_SCOPE, "antnest-stage3-e2e-4242");
  assert.equal(env.ANTNEST_RUNTIME_OTLP_INGRESS_IPV4, "10.243.7.4");
});

test("shell exports quote every value and reject unsafe names", () => {
  const script = shellExports({
    A: "plain",
    B_2: `it's {"json": "$HOME"}`,
    EMPTY: "",
  });
  assert.equal(
    script,
    `export A='plain'\nexport B_2='it'\\''s {"json": "$HOME"}'\nexport EMPTY=''\n`,
  );
  const result = spawnSync(
    "sh",
    ["-c", `eval "$1"; printf '%s' "$B_2"`, "sh", script],
    { encoding: "utf8" },
  );
  assert.equal(result.stdout, `it's {"json": "$HOME"}`);
  for (const name of ["", "1A", "A-B", "A;B", "a"])
    assert.throws(() => shellExports({ [name]: "x" }));
});

test("fixture scope and subnet must be valid before preparing credentials", () => {
  for (const project of [
    "",
    "antnest",
    "antnest-lifecycle-*",
    "../retained",
    "antnest-stage3-e2e-",
    "antnest-stage3-e2e-01",
    "antnest-stage3-e2e-12a",
  ])
    assert.throws(() => fixtureEnvironment({}, { project, octet: 45 }));
  for (const octet of [0, 201, 1.5, NaN])
    assert.throws(() =>
      fixtureEnvironment(
        {},
        {
          project: "antnest-lifecycle-1234abcd",
          octet,
        },
      ),
    );
});

test("Stage 3 shell credentials give Egress its root-owned bootstrap files", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const name = `antnest-stage3-e2e-${process.pid}`;
  const calls = [];
  try {
    const script = await shellEnvironment(name, 7, root, async (args) => {
      calls.push(args);
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "run");
    for (const file of ["callers.json", "tunnel-master.key"])
      assert(
        calls[0].some((argument) =>
          argument.endsWith(`/runtime-egress/${file},dst=/auth/${file}`),
        ),
        file,
      );
    assert.match(script, /^export ANTNEST_SERVICE_AUTH_DIRECTORY='/mu);
    assert.match(script, /^export COMPOSE_PROJECT_NAME='antnest-stage3-e2e-/mu);
  } finally {
    rmSync(resolve(root, "artifacts/verification/authenticated-e2e", name), {
      recursive: true,
      force: true,
    });
  }
});
