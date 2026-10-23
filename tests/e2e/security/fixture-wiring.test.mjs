import assert from "node:assert/strict";
import test from "node:test";
import { composeConfig } from "../../support/compose-config.mjs";
import { fixtureEnvironment } from "../../support/authenticated-e2e.mjs";
import * as matrix from "./run.mjs";
import { productionOverlay } from "./stack.mjs";

test("the complete matrix overlay keeps selected images and the matching RC preparer", () => {
  const selection = matrix.matrixImageSelection({
    ANTNEST_C4_AGENT_CONTROLLER_IMAGE:
      "antnest/agent-controller:matrix-candidate",
    ANTNEST_C4_EDGE_GATEWAY_IMAGE: "antnest/edge-gateway:matrix-candidate",
    ANTNEST_E2E_PROPAGATION_RC_IMAGE:
      "antnest/runtime-controller:matrix-candidate",
  });
  const env = fixtureEnvironment(
    {},
    { project: "antnest-lifecycle-1234abcd", octet: 45 },
  );
  const files = [
    "compose.yaml",
    "compose.debug.yaml",
    "compose.stage3.yaml",
    "tests/e2e/lifecycle-closeout/compose.yaml",
    ...productionOverlay.filter((value) => value !== "-f"),
  ];
  const config = composeConfig(files, {
    ...env,
    ...selection.environment,
    ANTNEST_POSTGRES_HOST_PORT: "55432",
    ANTNEST_JAEGER_UI_HOST_PORT: "16686",
    ANTNEST_LIFECYCLE_MODEL_HOST_PORT: "18088",
    ANTNEST_C4_CONTROL_DYNAMIC_RANGE: "10.242.45.128/25",
    ANTNEST_C4_RUNTIME_DYNAMIC_RANGE: "10.243.45.128/25",
  });
  for (const [service, ref] of Object.entries(selection.services))
    assert.equal(config.services[service].image, ref, service);
  assert.equal(
    config.services["runtime-controller"].environment
      .ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE,
    selection.services["runtime-controller"],
  );
});

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

test("the full owner matrix keeps its private member file, UID and isolated listener in the final overlay", () => {
  const env = fixtureEnvironment(
    {},
    { project: "antnest-lifecycle-1234abcd", octet: 45 },
  );
  const config = composeConfig(
    [
      "compose.yaml",
      "compose.debug.yaml",
      "compose.stage3.yaml",
      "tests/e2e/lifecycle-closeout/compose.yaml",
      ...productionOverlay.filter((value) => value !== "-f"),
      "tests/e2e/security/owner.compose.yaml",
    ],
    {
      ...env,
      ANTNEST_POSTGRES_HOST_PORT: "55432",
      ANTNEST_JAEGER_UI_HOST_PORT: "16686",
      ANTNEST_LIFECYCLE_MODEL_HOST_PORT: "18088",
      ANTNEST_C4_CONTROL_DYNAMIC_RANGE: "10.242.45.128/25",
      ANTNEST_C4_RUNTIME_DYNAMIC_RANGE: "10.243.45.128/25",
      ...matrix.matrixImageSelection({}).environment,
      ANTNEST_E2E_ACP_MEMBERS_FILE: "/never-mounted-owner-members.json",
      ANTNEST_SERVICE_AUTH_UID: "12345",
      ANTNEST_SERVICE_AUTH_GID: "23456",
    },
  );
  const rc = config.services["runtime-controller"],
    acp = config.services["agent-acp-service"];
  assert.equal(rc.user, "12345:23456");
  assert.equal(
    rc.environment.ANTNEST_RUNTIME_ACP_MEMBERS_FILE,
    "/etc/antnest/acp-members.json",
  );
  assert.equal(rc.networks.edge, undefined);
  assert.equal(acp.environment.ANTNEST_ACP_OWNER_LISTEN, "10.244.45.53:8085");
  assert.equal(
    acp.environment.ANTNEST_ACP_RUNTIME_CONTROLLER_URL,
    "http://runtime-controller:8080",
  );
  assert.equal(
    acp.depends_on["runtime-controller"].condition,
    "service_healthy",
  );
  const mount = rc.volumes.find(
    (v) => v.target === "/etc/antnest/acp-members.json",
  );
  assert.equal(mount.source, "/never-mounted-owner-members.json");
  assert.equal(mount.read_only, true);
  assert.equal(mount.bind.create_host_path, false);
});
