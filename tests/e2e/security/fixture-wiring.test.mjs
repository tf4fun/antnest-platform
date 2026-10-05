import assert from "node:assert/strict";
import test from "node:test";
import { composeConfig } from "../../support/compose-config.mjs";
import { fixtureEnvironment } from "../../support/authenticated-e2e.mjs";

test("the deterministic-model overlay requires an explicit test-only destination opt-in", () => {
  const files = [
    "compose.yaml",
    "compose.debug.yaml",
    "compose.stage3.yaml",
    "tests/e2e/lifecycle-closeout/compose.yaml",
  ];
  const env = fixtureEnvironment(
    {},
    { project: "antnest-lifecycle-1234abcd", octet: 45 },
  );
  Object.assign(env, {
    ANTNEST_POSTGRES_HOST_PORT: "55432",
    ANTNEST_JAEGER_UI_HOST_PORT: "16686",
    ANTNEST_LIFECYCLE_MODEL_HOST_PORT: "18088",
  });
  for (const enabled of ["false", "true"]) {
    const config = composeConfig(files, {
      ...env,
      ANTNEST_E2E_ALLOW_PRIVATE_PROVIDER_ENDPOINTS: enabled,
    });
    assert.equal(
      config.services["agent-controller"].environment
        .ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS,
      enabled,
    );
    assert.equal(
      config.services["agent-acp-service"].environment
        .ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS,
      enabled,
    );
    for (const [service, retired] of [
      [
        "agent-controller",
        "ANTNEST_AGENT_CONTROLLER_ALLOW_PRIVATE_PROVIDER_ENDPOINTS",
      ],
      ["agent-acp-service", "ANTNEST_ACP_ALLOW_PRIVATE_PROVIDER_ENDPOINTS"],
    ])
      assert.equal(
        Object.hasOwn(config.services[service].environment, retired),
        false,
      );
    assert.equal(
      config.services["runtime-controller"].environment
        .ANTNEST_RUNTIME_IMAGE_REPOSITORIES,
      undefined,
    );
    assert(
      config.services["diagnostic-relay"].ports.every((port) =>
        [5432, 16686].includes(port.target),
      ),
    );
    assert.equal(config.networks.development, undefined);
  }
});
