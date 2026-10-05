import assert from "node:assert/strict";
import test from "node:test";
import { fixtureEnvironment } from "./authenticated-e2e.mjs";

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
    "ANTNEST_IDENTITY_ENCRYPTION_KEY",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
  ])
    assert.equal(env[key], undefined, key);
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

test("fixture scope and subnet must be valid before preparing credentials", () => {
  for (const project of ["", "antnest", "antnest-lifecycle-*", "../retained"])
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
