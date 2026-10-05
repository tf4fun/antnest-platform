import assert from "node:assert/strict";
import { createAccessCatalog } from "../identity-closeout/catalog.mjs";
import { applicationServices } from "./deployment.mjs";
import { composeArgs } from "./docker.mjs";

export async function setupFoundation(admin, image) {
  const { model, template } = await createAccessCatalog(admin, {
    name: "Lifecycle fixture",
    baseURL: "http://stage3-model:8080/v1",
    modelName: "stage3-model",
    credential: "stage3-model-secret",
    systemPrompt: "Synthetic lifecycle test",
    maxModelRequests: 8,
    runtimeImage: image,
  });
  return {
    template,
    templateBody: {
      name: "Lifecycle fixture",
      model_profile_id: model.model_profile_id,
      system_prompt: "Synthetic lifecycle test",
      max_model_requests: 8,
      runtime: { image_ref: image },
    },
  };
}
export function configureFoundation(config) {
  const tag = config.env.ANTNEST_ADMISSION_TAG;
  if (tag !== undefined) assert.match(tag, /^shell-[a-f0-9]{8}$/u);
  config.images = Object.fromEntries(
    applicationServices.map((service) => [
      service,
      `antnest/${service}:${tag ?? "local"}`,
    ]),
  );
  config.controllerImage = tag
    ? config.images["agent-controller"]
    : (config.env.ANTNEST_E2E_CONTROLLER_IMAGE ??
      "antnest/agent-controller:local");
  config.runtimeControllerImage = tag
    ? config.images["runtime-controller"]
    : (config.env.ANTNEST_E2E_RUNTIME_CONTROLLER_IMAGE ??
      "antnest/runtime-controller:local");
  config.images["agent-controller"] = config.controllerImage;
  config.images["runtime-controller"] = config.runtimeControllerImage;
  for (const [source, target] of [
    [
      "ANTNEST_EGRESS_CONTROL_SUBNET",
      "ANTNEST_LIFECYCLE_CONTROL_DYNAMIC_RANGE",
    ],
    [
      "ANTNEST_RUNTIME_MANAGEMENT_SUBNET",
      "ANTNEST_LIFECYCLE_RUNTIME_DYNAMIC_RANGE",
    ],
  ]) {
    assert.match(config.env[source], /^10\.24[23]\.\d+\.0\/24$/);
    config.env[target] = config.env[source].replace(".0/24", ".128/25");
  }
  config.env.ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT = "false";
  config.compose = (args) =>
    composeArgs(config.project, [
      "-f",
      "tests/e2e/lifecycle-closeout/foundation.compose.yaml",
      ...(tag
        ? ["-f", "tests/integration/deployment/compose.admission.yaml"]
        : []),
      ...args,
    ]);
}
export function inspectFoundationDeployment(rows, config) {
  const service = (r) => r.Config.Labels["com.docker.compose.service"];
  const required = [
    ...applicationServices,
    "postgres",
    "temporal",
    "jaeger",
    "stage3-model",
    "diagnostic-relay",
    "runtime-telemetry-ingress",
  ];
  assert.deepEqual(rows.map(service).sort(), required.sort());
  for (const row of rows) {
    const name = service(row);
    assert.equal(
      row.Config.Labels["com.docker.compose.project"],
      config.project,
    );
    assert.equal(row.State.Running, true);
    if (name !== "jaeger") assert.equal(row.State.Health?.Status, "healthy");
    const ports = Object.values(row.HostConfig.PortBindings ?? {}).flat();
    assert.equal(
      ports.length,
      name === "diagnostic-relay"
        ? 2
        : ["edge-gateway", "stage3-model"].includes(name)
          ? 1
          : 0,
      `${name} host exposure`,
    );
    for (const port of ports) assert.equal(port.HostIp, "127.0.0.1");
  }
  const peers = rows.filter((r) => service(r) === "stage3-model");
  assert.equal(peers.length, 1);
  const model = peers[0];
  assert.equal(
    model.Config.Labels["com.docker.compose.project"],
    config.project,
  );
  assert.equal(model.State.Running, true);
  assert.equal(model.State.Health.Status, "healthy");
  const bindings = Object.values(model.HostConfig.PortBindings ?? {}).flat();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].HostIp, "127.0.0.1");
  return {
    status: "deployment_passed",
    services: rows.length,
    gateway_only_application_ingress: true,
    loopback_diagnostics: true,
  };
}
