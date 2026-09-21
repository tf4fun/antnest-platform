import assert from "node:assert/strict";
import { test } from "node:test";
import {
  setupFoundation,
  configureFoundation,
  inspectFoundationDeployment,
} from "./foundation-setup.mjs";

test("foundation setup uses stable Model IDs and actual Template revision", async () => {
  const calls = [];
  const api = {
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === "/api/admin/provider-connections")
        return { body: { connection_id: "provider" } };
      if (path === "/api/admin/model-profiles")
        return {
          body: {
            items: [
              { provider_connection_id: "provider", model_profile_id: "model" },
            ],
          },
        };
      if (path === "/api/admin/templates")
        return {
          body: { template_id: "template", revision: 7, ...options.body },
        };
      throw new Error("unexpected API");
    },
  };
  const result = await setupFoundation(api, "sha256:runtime");
  assert.equal(result.template.revision, 7);
  assert.equal(result.templateBody.model_profile_id, "model");
  assert.equal(result.templateBody.runtime.image_ref, "sha256:runtime");
  assert.equal(result.templateBody.model_profile_revision_id, undefined);
  assert.equal(calls[0].options.body.credential.api_key, "stage3-model-secret");
  assert(
    calls.every(
      (c) => c.path !== "/api/admin/model-profiles" || c.options === undefined,
    ),
  );
});
test("foundation network allocation reserves static Runtime addresses and private Temporal", () => {
  const config = {
    project: "antnest-lifecycle-01234567",
    env: {
      ANTNEST_EGRESS_CONTROL_SUBNET: "10.242.7.0/24",
      ANTNEST_RUNTIME_MANAGEMENT_SUBNET: "10.243.7.0/24",
    },
  };
  configureFoundation(config);
  assert.equal(config.controllerImage, "antnest/agent-controller:local");
  assert.equal(
    config.runtimeControllerImage,
    "antnest/runtime-controller:local",
  );
  config.env.ANTNEST_E2E_CONTROLLER_IMAGE = "sha256:isolated-candidate";
  config.env.ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE = "sha256:runtime-candidate";
  configureFoundation(config);
  assert.equal(config.controllerImage, "sha256:isolated-candidate");
  assert.equal(config.runtimeControllerImage, "sha256:runtime-candidate");
  assert.equal(
    config.env.ANTNEST_LIFECYCLE_CONTROL_DYNAMIC_RANGE,
    "10.242.7.128/25",
  );
  assert.equal(
    config.env.ANTNEST_LIFECYCLE_RUNTIME_DYNAMIC_RANGE,
    "10.243.7.128/25",
  );
  assert.equal(config.env.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT, "false");
  assert(
    config
      .compose(["config"])
      .includes("scripts/lifecycle-closeout/foundation.compose.yaml"),
  );
});
test("foundation deployment rejects a missing Temporal service or published Temporal port", () => {
  const config = { project: "antnest-lifecycle-01234567" };
  const rows = [
    "postgres",
    "jaeger",
    "edge-gateway",
    "temporal",
    "runtime-controller",
    "agent-acp-service",
    "identity-service",
    "agent-controller",
    "admin-console",
    "agent-ui",
    "runtime-egress",
    "stage3-model",
  ].map((name) => ({
    Config: {
      Labels: {
        "com.docker.compose.project": config.project,
        "com.docker.compose.service": name,
      },
    },
    State: { Running: true, Health: { Status: "healthy" } },
    HostConfig: {
      PortBindings: [
        "postgres",
        "jaeger",
        "edge-gateway",
        "stage3-model",
      ].includes(name)
        ? { "80/tcp": [{ HostIp: "127.0.0.1" }] }
        : {},
    },
  }));
  assert.equal(inspectFoundationDeployment(rows, config).services, 12);
  assert.throws(() =>
    inspectFoundationDeployment(
      rows.filter(
        (r) => r.Config.Labels["com.docker.compose.service"] !== "temporal",
      ),
      config,
    ),
  );
  rows.find(
    (r) => r.Config.Labels["com.docker.compose.service"] === "temporal",
  ).HostConfig.PortBindings = { "7233/tcp": [{ HostIp: "127.0.0.1" }] };
  assert.throws(() => inspectFoundationDeployment(rows, config));
});
